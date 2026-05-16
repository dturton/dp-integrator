# Shopify ↔ NetSuite Integration — Architecture Spec

**Purpose:** A self-hosted, TypeScript/Azure-native replacement for Celigo's Shopify–NetSuite connector, designed for a multi-portfolio-company environment.

**Audience:** This document is the build brief handed to Claude Code. Sections marked `OPEN DECISION` need a human answer before the affected code is generated; everything else is the recommended default.

**Revision note (v2):** adds order-sync eligibility, financial-line fidelity, order lifecycle/edge cases, payout reconciliation depth, inventory ownership, customer dedup, Celigo migration/cutover, NetSuite governance, security/PII, and environment/testing strategy — the areas where homegrown Shopify–NetSuite builds fail in production.

---

## 1. Goals & non-goals

**Goals**
- Replace Celigo for the Shopify↔NetSuite use case only (not a general iPaaS).
- Bidirectional order-to-cash + inventory + catalog sync with correct financials.
- Multi-tenant: many Shopify stores → many NetSuite subsidiaries, **across multiple NetSuite accounts**.
- First-class idempotency, error console, replay, and reconciliation.
- Operable by a small team: config-as-code, strong observability, no per-record babysitting.
- A defensible cost/operability case vs. the Celigo license it replaces.

**Non-goals (v1)**
- No general-purpose mapping UI / drag-drop flow builder. Config is code/JSON, versioned in the repo.
- No marketplace channels beyond Shopify (Amazon SP-API is a separate effort).
- No GL-level reconciliation automation beyond Shopify Payments payouts.

---

## 2. Integration surface (flows)

Mirrors the standard Celigo Shopify–NetSuite connector. Each flow is independently togglable per connection.

### Shopify → NetSuite
| # | Flow | Source event | NS target | Notes |
|---|------|--------------|-----------|-------|
| 1 | Order import | `orders/create`, `orders/updated` | Sales Order **or** Cash Sale | Subject to sync-eligibility (§2.1). Customer match/create sub-step. |
| 2 | Order edit | `orders/edited` | Update SO lines | Most builds ignore this and silently drift. Mandatory. |
| 3 | Cancellation | `orders/cancelled` | Close/void SO | Restock implications feed inventory. |
| 4 | Refund import | `refunds/create` | Credit Memo / Cash Refund | Partial, with/without restock, shipping-only. Links to source txn. |
| 5 | Customer upsert | embedded in order, or `customers/*` | Customer | Dedup strategy is critical (§7). |
| 6 | Payout reconciliation | Shopify Payments payout (polled) | Deposit + fee journal + clearing | Per-transaction match incl. disputes (§6). |

### NetSuite → Shopify
| # | Flow | Source trigger | Shopify target | Notes |
|---|------|----------------|----------------|-------|
| 7 | Fulfillment / tracking | NS Item Fulfillment created | Fulfillment + tracking via **fulfillment orders** model | Partial fulfillments, multi-package. |
| 8 | Inventory levels | NS inventory change | `inventoryLevel` per location | Delta-only, buffered, loop-safe (§8). |
| 9 | Item / product sync | NS Item create/update | Product + variants | Phase-gated; OPEN DECISION 1. |
| 10 | Pricing | NS price change | Variant price / price list | Usually coupled with #9. |

### 2.1 Order sync eligibility (core concept)

Orders are **not** synced on creation by default. Each connection defines a sync-eligibility predicate, e.g.: `financial_status` in an allowed set (`paid`, optionally `partially_paid`/`authorized`); not on fraud/manual hold; `test == false` (Shopify test orders must never reach NS); not fully refunded/cancelled before first sync; optional minimum age to debounce rapid edits. Ineligible orders are tracked (`entity_xref.status = pending`) and re-evaluated by the reconciliation poller, never dropped. Wrong eligibility logic is the #1 way to book bad revenue.

### 2.2 Financial-line fidelity

The order→transaction mapping must explicitly handle, per connection:
- **Discounts** — order- vs line-level; allocation method; map to NS discount item / line discount / transaction discount.
- **Shipping** — own NS line + own tax treatment; multiple shipping lines.
- **Taxes** — **SuiteTax vs legacy Tax** (OPEN DECISION 8, per account); tax-inclusive vs exclusive; Shopify native tax vs Avalara-in-Shopify; tax line → NS tax code/detail.
- **Gift cards** — purchase = **liability** (not revenue); redemption = **tender** (not a discount). Two distinct mappings.
- **Tips / surcharges** — dedicated items, not buried in revenue.
- **Rounding & balancing** — Shopify and NS round differently. Define a tolerance and a deterministic **balancing line** so the NS total reconciles to the Shopify order total. A strict `total ==` assertion without this will fail on pennies.

---

## 3. Architecture overview

```
                 ┌─────────────────────────────────────────────────────┐
   Shopify ──────│  Webhook Receiver (HTTP Fn, HMAC verify)             │
   webhooks      │      │ enqueue raw envelope, return 200 fast         │
                 └──────┼──────────────────────────────────────────────┘
                        ▼
                 ┌──────────────────────────────────────────────────────┐
                 │  Service Bus (topic per direction)                    │
                 │  - subscription per flow                              │
                 │  - sessions = FIFO per (connection, orderId)          │
                 │  - DLQ per subscription                               │
                 └──────┬───────────────────────────────────────────────┘
                        ▼
                 ┌──────────────────────────────────────────────────────┐
                 │  Flow handlers (Durable Functions orchestrations)     │
                 │  re-fetch source of truth → eligibility → map →       │
                 │  resolve xref → governed upsert → record result       │
                 └──┬──────────────┬──────────────────┬─────────────────┘
                    ▼              ▼                   ▼
            Shopify client   NetSuite client     State / xref DB (Azure SQL)
            (GraphQL Admin)  (SuiteTalk REST +   - entity_xref (idempotency)
                             SuiteQL + RESTlet)  - watermarks / maps / errors
                             via NS governor     - reconciliation snapshots

   Pollers (Timer Fns): Shopify Bulk reconcile · NS SuiteQL watermark scan
                         · daily reconciliation/audit sweep
   Observability: App Insights traces → Power BI sync-health dashboard
```

### Why these choices
- **Receiver only enqueues.** Shopify webhooks are at-least-once and lossy; never process inline. Re-fetch the full record in the handler — webhook bodies are partial/stale.
- **Service Bus sessions** give per-order FIFO so `refund`/`edit` can't precede its `order`, and redelivery can't race itself.
- **Durable Functions** for the multi-step saga (order → customer upsert → SO → payment → fulfillment link): checkpointing, retry, query/rewind.
- **Pollers are not optional.** Catch-up poller covers dropped webhooks; the reconciliation sweep (§9) catches silent drift; the NS watermark scan exists because NetSuite has no native webhooks (§5).

### 3.1 Runtime decision (resolved — do not relitigate)
Azure substrate (Service Bus + Functions + Durable Functions), not self-hosted Node + Redis/BullMQ. This is financial data; broker durability and dead-lettering must be a managed SLA, not a Redis-HA config a small team owns. The webhook receiver — the one place serverless cold-start hurts — runs on Flex Consumption with always-ready instances (or a tiny always-on Container App for the receiver only). xref/idempotency, error-replay, and NS-can't-push designs are substrate-agnostic regardless.

---

## 4. Idempotency & state (the backbone)

**`entity_xref`**
```
connection_id   | string
environment     | enum    (dev | sandbox | prod)  -- xref is env-scoped (§11)
entity_type     | enum    (order, refund, customer, fulfillment, item, ...)
source_system   | enum    (shopify | netsuite)
source_id       | string  (Shopify GID / NS internal id)
target_system   | enum
target_id       | string  (nullable until first successful write)
target_external | string  (NS externalId = Shopify GID — durable join, §7)
source_hash     | string  (hash of mapped meaningful fields)
status          | enum    (pending | synced | error | ignored)
last_synced_at  | datetime
```
- **Dedup key** = `(environment, connection_id, entity_type, source_system, source_id)`. Upsert-first: claim the row before writing the target; if `target_id` exists it's an update, not a create.
- **NS `externalId`** = Shopify GID on every NS record: the NS-native idempotent join and the safe key for backfill (§10).
- **Change detection** via `source_hash` so NS→Shopify floods become no-ops when nothing material changed.

Other state: `connections`, `sync_watermarks`, `field_maps` (versioned), lookup tables (payment method → NS account, ship method → NS ship item, tax → NS tax code, location → NS location, currency), `reconciliation_snapshots`.

`OPEN DECISION 6` — State store. **Recommended: Azure SQL** (relational joins; you operate SQL/Synapse; Power BI reads it natively).

---

## 5. NetSuite is not push-capable

NS has no native outbound webhooks. NS→Shopify flows need:
- **(Recommended) SuiteScript UE/scheduled script** POSTing a lightweight change envelope to an **authenticated** Azure HTTP Function (Function key / shared secret / mTLS — an unauthenticated NS push endpoint is an injection vector), which enqueues it.
- **SuiteQL watermark poller** on `lastmodifieddate` as the backstop even where the SuiteScript path exists.

Use `itemSubsidiaryMap` for item→subsidiary in OneWorld. Reads via SuiteQL; writes via SuiteTalk REST; composite atomic writes (SO + payment + fulfillment) via a purpose-built RESTlet. All NS calls go through the NS governor (§12).

---

## 6. Payout reconciliation

A Shopify Payments payout decomposes into transactions matched individually: **charge** → order's NS payment; **refund** → credit memo/cash refund; **fee** → processor-fee account; **adjustment/reserve** → clearing; **dispute/chargeback** (and reversal) → its own sub-flow (contingent liability → resolution). Pattern: payments land in an **undeposited-funds/clearing account** on order sync; the payout flow sweeps clearing → bank deposit, books fees, reconciles to the payout total within tolerance. Multi-day timing differences are expected and tracked, not errored.

---

## 7. Customer & join strategy

Duplicate customer creation is the most common Shopify–NetSuite defect.
- **Matching** config per connection: Shopify customer GID via NS `externalId` first, then email, then deterministic fallback to a **generic/guest customer** for true guest checkout. Email-only matching fails on guest checkout, shared emails, and B2B.
- **B2B / company locations** use a different model — `OPEN DECISION 9`: does any store use Shopify B2B?
- Every NS transaction/customer carries `externalId = Shopify GID` — backbone of idempotency and the Celigo backfill (§10).

---

## 8. Inventory ownership model

- **System of record per connection** is config. Default: NetSuite owns on-hand; Shopify never writes inventory back to NS (sales decrement is reflected by NS receiving the order).
- **Available-to-sell** to Shopify = NS on-hand minus a configurable **buffer/safety stock**, per item/location.
- **Multi-location**: explicit Shopify location ↔ NS location map; only mapped locations sync.
- **Loop prevention**: inventory writes carry an origin marker; the inbound poller ignores changes whose value matches what this system last pushed.
- Delta-only and throttled — never full-sync the catalog on every change.

---

## 9. Reconciliation & audit (distinct from the catch-up poller)

A scheduled sweep independent of the sync path answering "do Shopify and NS agree?": daily counts and money totals by connection and day (orders, refunds, payouts); spot-checks on high-value orders; writes `reconciliation_snapshots`; surfaces discrepancies as a distinct error class (drift, not failure). This catches *silently wrong* syncs that never threw — the failure mode that erodes trust.

---

## 10. Migration & cutover from Celigo (biggest go-live risk)

- **Backfill `entity_xref`** from existing Celigo state / NS records: for every open/recent order populate `(source_id → target_id, externalId)` so already-synced orders are recognized and never re-created. Match on NS `externalId` where set; otherwise a one-time reconciliation by order number + date + total.
- **Parallel / shadow run**: process in dry-run (map + diff vs. Celigo output, no writes) until diffs are clean.
- **Cutover** per connection: freeze Celigo flow → drain in-flight → flip eligibility live → watch the reconciliation sweep for N days.
- **Rollback** per connection back to Celigo; xref stays valid (keyed on source IDs).

---

## 11. Environments, sandboxes & testing

- `entity_xref.environment` scopes all state; a sandbox sync must never resolve to a prod NS internal id.
- **NS sandbox refresh**: sandbox state (and sandbox-only xref) is wiped/realigned on refresh; the harness re-seeds; prod xref never depends on sandbox IDs.
- **Tests**: contract tests vs. Shopify dev store + NS sandbox; idempotency (replay webhook → zero dupes); refund/edit/cancel lifecycle; rounding/balancing; replay; load test proving the NS governor protects other integrations under a 500-order burst.

---

## 12. NetSuite governance & backpressure (protects your other integrations)

A burst of Shopify orders must not exhaust the NS account's SuiteTalk/REST concurrency and break the *other* integrations on that account.
- A **global NS concurrency limiter per NS account** (token bucket sized below the account's concurrency governance), shared across all flows/connections targeting that account — not just per-request 429 backoff.
- Adaptive backoff on NS concurrency/governance errors; spillback to the queue via visibility timeout, not tight retry loops.
- Bulk reads via paginated SuiteQL; writes batched within governance.

---

## 13. Error management & replay (the real Celigo value)

**`error_records`**: full envelope, connection, flow, error class, stack, retry count, status (`open|retrying|resolved|ignored`), timestamps, dedup key as correlation id.
- **Classification**: transient (network, 429, NS concurrency) → auto-retry exp backoff + jitter; data/validation (missing xref, bad tax code, ineligible) → park for human; auth → alert.
- **Retry path**: handler retry → DLQ → `error_records`. Hard max-attempts → quarantine to stop replay storms.
- **Replay**: admin endpoint re-enqueues one/many parked records after fix; idempotent by construction.
- **Alerting**: App Insights → Teams/Power Automate; daily error + reconciliation digest per portco.

---

## 14. Security, PII & compliance

- **NS push endpoint authenticated** (§5); Shopify HMAC verified on every call.
- **PII**: envelopes/`error_records` hold full customer PII — encrypt at rest, TTL resolved records, redact PII from long-term diagnostics.
- **Secret rotation**: Key Vault per connection (Shopify token, NS creds); documented rotation with in-flight handling.
- `OPEN DECISION 10` — Shopify app model: custom app per store (recommended; internal) vs. app-model (then implement mandatory `customers/data_request`, `customers/redact`, `shop/redact`).

---

## 15. Connectors

**ShopifyClient** — GraphQL Admin API primary, REST where needed, Bulk Operations for large reads, cost-based leaky-bucket rate limiting + 429 backoff, pinned API version with a quarterly upgrade/deprecation checklist. Fulfillment via the **fulfillment orders** model.

**NetSuiteClient** — per-account credentials (multi-account is real), OAuth (TBA/OAuth1 or OAuth2 M2M), secrets in Key Vault via the existing Credentials Vault pattern, SuiteQL reads / REST writes / RESTlet composites, all behind the NS governor (§12).

---

## 16. Mapping / transformation engine

Config-driven, versioned JSONC per connection per flow. Primitives: `direct`, `constant`, `lookup`, `derive`, `conditional`. `source_hash` over the mapped meaningful field set. A connection = `{ shopifyStore, nsAccount, subsidiary, location, currency, taxEngine, enabledFlows[], eligibilityRule, mapVersion }`.

`OPEN DECISION 4` — Order target default per portco: Sales Order (then fulfill + invoice) vs. Cash Sale (immediate). Per-connection config; default must be chosen.

---

## 17. Multi-tenancy model

One **connection** per (Shopify store → NS account/subsidiary/location), fully isolated config/maps/secrets/watermarks.
- `OPEN DECISION 2` — Pilot one portco vs. multi-tenant from day one (recommended: multi-tenant model, single onboard).
- `OPEN DECISION 3` — One OneWorld account vs. multiple NS accounts (assumed: multiple).

---

## 18. Repo layout (pnpm monorepo)

```
/packages
  /core              queueing, xref store, error store, idempotency,
                     reconciliation, NS governor, config loader
  /shopify-client    GraphQL/REST/bulk, rate limiting, typed models
  /netsuite-client   SuiteQL, REST, RESTlet, multi-account auth
  /mapping-engine    field-map primitives + evaluator
/apps
  /functions         HTTP webhook receiver, NS push receiver,
                     queue-trigger handlers, Durable orchestrations,
                     timer pollers + reconciliation sweep
  /admin             replay REST + CLI (UI later phase)
/infra               Bicep (Functions, Service Bus, SQL, Key Vault, App Insights)
/config              connections + field maps (versioned JSONC)
/suitescript         NS UE/scheduled push script + composite RESTlet
/migration           Celigo backfill + parallel-run diff tooling
```
Runtime: Azure Functions, TypeScript, isolated worker, Node 20; Durable Functions; Bicep IaC; CI/CD GitHub Actions or Azure DevOps. Durable orchestration versioning handled on deploy (drain or side-by-side).

---

## 19. Phasing

| Phase | Scope | Exit criteria |
|-------|-------|---------------|
| 0 | Scaffolding: monorepo, both clients + auth, NS governor, env-scoped xref DB, one connection, IaC | Round-trip read each system in CI; governor proven under burst |
| 1 | Order → SO incl. eligibility, financial-line fidelity, customer dedup, idempotency, error store | Redelivery → zero dupes; totals reconcile within tolerance; errors replayable |
| 2 | Order edit/cancel/refund lifecycle; NS Fulfillment → Shopify; Inventory → Shopify (buffered, loop-safe) | Edits/refunds reflected in NS; tracking in Shopify < latency target |
| 3 | Payout reconciliation incl. disputes; reconciliation/audit sweep; Celigo backfill + parallel run | Payout reconciles; sweep green; dry-run diffs clean |
| 4 | Item/pricing NS→Shopify; admin replay UI; multi-connection rollout; Celigo cutover | Second portco onboarded by config only; Celigo retired for connection 1 |

---

## 20. Open decisions — summary

1. **Flow scope for v1** — full bidirectional, or the 80% (Order→SO, lifecycle, Fulfillment→Shopify, Inventory→Shopify) first?
2. **Single portco pilot vs. multi-tenant from day one** (recommended: multi-tenant model, single onboard).
3. **One OneWorld account vs. multiple NS accounts** (assumed: multiple).
4. **Order target**: Sales Order vs. Cash Sale default.
5. **Latency requirement**: webhook real-time required, or is a fast reconciliation poll acceptable for finance?
6. **State store**: Azure SQL (recommended) vs. Cosmos.
7. **Admin/replay surface**: REST+CLI first (recommended) vs. UI up front.
8. **NS tax engine per account**: SuiteTax vs legacy Tax.
9. **Shopify B2B** in scope for any store?
10. **Shopify app model**: custom app per store (recommended) vs. app-model (adds mandatory compliance webhooks).
11. **Scope applicability — which apply to which portcos?** multi-currency/FX · POS orders · subscriptions (Recharge/Shopify) · bundles-kits→NS assemblies · gift cards. Confirm before building or explicitly defer.

---

## 21. Cost / business case (vs. Celigo)

Track: Azure run cost (Functions + Service Bus + SQL + App Insights ≈ low-hundreds/month at portfolio volume) + build/maintenance effort, vs. the displaced Celigo license across connections. The strategic argument is control over financial mapping, no per-record license ceiling, and owned reconciliation; the cost delta is the CFO-facing one.
