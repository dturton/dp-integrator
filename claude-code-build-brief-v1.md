# Claude Code Build Brief — Shopify → NetSuite Order Integration (v1)

You are building **v1 of a self-hosted, TypeScript/Azure-native replacement for Celigo's Shopify→NetSuite connector**, for a multi-portfolio-company environment. A companion architecture spec (v2) exists and is the source of truth for design rationale; this brief is the executable v1 slice. Build exactly this slice — no more.

---

## 0. Locked decisions (do not relitigate; ask if any conflict with the build)

1. **Scope:** Orders only, **Shopify → NetSuite**, one direction. v1 is **order import (create)** only.
2. **Tenancy:** Multi-tenant data model **from day one** (many Shopify stores → many NS subsidiaries).
3. **NetSuite:** **Multiple NS accounts**, per-account credential model. The standard access layer is the **first-party `netsuite-sdk`** package (`github.com/dturton/netsuite-sdk`, npm `netsuite-sdk`) — TBA / OAuth 1.0a. Instantiate one `NetSuiteClient` per NS account. **Do not hand-roll SuiteQL, REST record, RESTlet, or OAuth signing — the SDK provides all of it.** Do not add OAuth2/M2M; auth is TBA only.
4. **Order target:** **Selectable per connection** — Sales Order *or* Cash Sale. Both implemented.
5. **Latency:** **Webhook-driven** (real-time), plus a catch-up poller as backstop.
6. **State store:** **Azure SQL**.
7. **Admin/replay surface:** **REST + CLI** for v1. No web UI in v1.
8. **NS tax engine:** Unknown / varies per account → **abstract behind a strategy interface** (`SuiteTax` and `Legacy Tax` implementations). Engine is per-connection config. Add a Phase 0 task to confirm engine per account; never assume one.
9. **Shopify B2B:** Out of scope. Do not build the company/location customer model.
10. **Shopify auth:** **Custom app per store** (Admin API access token created in each store's admin). No public-app OAuth, no mandatory GDPR compliance webhooks.
11. **Scope applicability (multi-currency, POS, subscriptions, kits/assemblies, gift cards):** Unknown → **not in v1 scope**, but see the "park, don't guess" invariant. Do not silently handle them.

---

## 1. v1 scope — in / explicitly out

**In scope (build this):**
- Shopify webhook receiver (`orders/create`, `orders/updated`) with HMAC verification → enqueue only.
- Order import handler: re-fetch order from Shopify → eligibility check → customer match/create → map → create/update NS Sales Order **or** Cash Sale (per connection) → record xref.
- Idempotency via `entity_xref` (env-scoped) + NS `externalId = Shopify order GID`.
- Financial-line fidelity for **standard product orders**: line items, line/order discounts, shipping (as its own line + tax), tax (via tax strategy), and a **rounding/balancing line** so the NS total reconciles to the Shopify order total within tolerance.
- Multi-tenant connection config (per Shopify store → NS account/subsidiary/location).
- Multi-NS-account NetSuite client with a **global per-NS-account concurrency governor**.
- Error store + classification + retry/backoff + DLQ → quarantine; **REST + CLI replay**.
- Catch-up poller (Shopify Bulk/GraphQL by `updated_at` watermark) for missed webhooks.
- Daily reconciliation/audit sweep (count + money totals Shopify vs NS per connection per day).
- Observability: structured tracing keyed on the dedup id; sync-health metrics.

**Explicitly OUT of v1 (do not build; do not stub silently — design so it slots in later):**
- Refunds, cancellations, order *edits*.
- All NetSuite → Shopify flows (fulfillment/tracking, inventory, items, pricing).
- Payout reconciliation.
- Shopify B2B, multi-currency/FX, POS-specific handling, subscriptions, kits/assemblies, gift-card liability/tender logic.
- Web admin UI.
- Celigo backfill/cutover tooling (separate effort; do not block on it, but `entity_xref` must be backfill-safe — keyed on source IDs and carrying NS `externalId`).

---

## 2. Non-negotiable engineering invariants

These override convenience. If meeting them is unclear, stop and ask.

1. **Idempotency first.** Claim the `entity_xref` row before any NS write. Dedup key = `(environment, connection_id, entity_type, source_system, source_id)`. A redelivered webhook must never create a second NS transaction. Set NS `externalId` = Shopify order GID on every record, and perform the NS write via the SDK's external-id upsert — `client.records.upsert(<recordType>, 'externalId', <Shopify order GID>, payload)` — so create-vs-update is atomic on NetSuite's side. Do **not** implement get-then-create/update branching; `upsert` is the mechanism.
2. **Park, don't guess.** If an order contains a tax construct, tender type, currency, discount shape, or line type the connection is **not configured to handle**, do **not** improvise a mapping. Write the full envelope to `error_records` with class `unmapped_construct`, status `open`, and stop. Mis-booked revenue is worse than a parked order.
3. **Webhook receiver only enqueues.** Verify HMAC, persist the raw envelope, return 200 fast. Re-fetch the authoritative order from the Shopify API inside the handler — never trust the webhook body as source of truth.
4. **Env-scoped state.** Every `entity_xref` / watermark / config row is scoped by `environment`. A sandbox run must never resolve to a prod NS internal id.
5. **NS governor is mandatory.** All NS calls pass through a global token-bucket limiter **keyed per NS account**, sized below that account's SuiteTalk/REST concurrency governance. A burst of orders must never starve the *other* integrations running on that NS account — treat this as a safety requirement, not a perf tweak. **Implementation trap (do not fall into it):** install the governor as `netsuite-sdk` middleware (`client.use(...)`), but its counter/budget MUST be shared per NS account across **all Azure Function instances** (backed by Azure SQL or a distributed store). The SDK's bundled in-process `RateLimiter` is per-client-instance only; relying on it means N horizontally-scaled instances each get a full budget and collectively blow the account ceiling — the exact failure this invariant exists to prevent. Also: the SDK performs its own internal transport retries (5xx/timeout/network) and a retried call still consumes a slot — size the budget accordingly.
6. **No live external calls in build/test.** You will not have real Shopify/NetSuite credentials. Put both systems behind narrow typed **gateway interfaces** owned by this codebase (`NetSuiteGateway`, `ShopifyGateway`). `netsuite-sdk` is a real dependency wrapped *behind* `NetSuiteGateway` — the rest of the system never imports the SDK directly, and tests fake the gateway, not the SDK. Provide in-memory fakes and fixture-based tests. Integration tests are gated behind env config the user supplies later.
7. **Secrets only via Key Vault abstraction.** Never hardcode or log credentials. A `SecretProvider` interface (Key Vault impl + local-dev impl reading env). One credential set per connection / per NS account.
8. **Stop at milestone boundaries for review.** Do not run ahead past the current milestone's acceptance criteria without checking in.

---

## 3. Tech stack (pinned)

TypeScript (strict), Node 20, Azure Functions isolated worker. Azure Service Bus (topic + per-flow subscription + sessions for per-order FIFO + DLQ). Durable Functions for the order orchestration. Azure SQL for state. Key Vault for secrets. Application Insights for telemetry. Bicep for IaC. pnpm workspaces monorepo. Vitest (or Jest) for tests. Webhook receiver runs on Flex Consumption with always-ready instances (cold start must not break Shopify webhook delivery). **NetSuite access:** first-party `netsuite-sdk` (pin an exact version in `package.json`; it is David's own package — treat as a trusted internal dependency, not arbitrary npm). Shopify access: hand-built client (no equivalent first-party SDK in scope).

---

## 4. Repo structure

```
/packages
  /core              queue abstraction, xref store, error store, idempotency,
                     reconciliation, NS governor, config loader, secret provider
  /shopify-client    Admin GraphQL/REST + Bulk, rate limiting, typed order model,
                     interface + fake + fixture tests
  /netsuite-client   thin wrapper OVER `netsuite-sdk` (do not reimplement it):
                     - multi-account client factory (ns_account_id → NetSuiteClient,
                       creds from SecretProvider; sandbox "_SB1" form supported)
                     - governor middleware (client.use) backed by SHARED per-account
                       state, not the SDK's in-process RateLimiter
                     - tax strategy (SuiteTax|legacy) building the record payload
                     - NetSuiteError → error-class mapping (isRetryable/isAuthError)
                     - externalId-upsert helper for SO / Cash Sale / customer
                     - NetSuiteGateway interface + in-memory fake
  /mapping-engine    field-map primitives (direct|constant|lookup|derive|conditional),
                     rounding/balancing, "unmapped construct" detection
/apps
  /functions         webhook receiver, queue-trigger order handler,
                     Durable order orchestration, catch-up poller,
                     reconciliation sweep
  /admin             replay REST endpoints + CLI
/infra               Bicep: Function App (Flex), Service Bus, Azure SQL,
                     Key Vault, App Insights
/config              connections + field maps (versioned JSONC)
/migration           PLACEHOLDER ONLY (Celigo backfill, future) — do not implement
```

---

## 5. Core data model (Azure SQL — implement these in v1)

- **`connections`** — `connection_id, environment, shopify_store, shopify_app_token_ref, ns_account_id, ns_subsidiary, ns_location, base_currency, tax_engine (suitetax|legacy), order_target (sales_order|cash_sale), eligibility_rule (json), map_version, enabled (bool)`.
- **`entity_xref`** — `environment, connection_id, entity_type, source_system, source_id, target_system, target_id (nullable), target_external (Shopify GID), source_hash, status (pending|synced|error|ignored), last_synced_at`. Unique on the dedup key.
- **`sync_watermarks`** — `environment, connection_id, flow, last_cursor, updated_at`.
- **`error_records`** — `id, environment, connection_id, flow, dedup_key, error_class, message, stack, envelope (json), retry_count, status (open|retrying|resolved|ignored|quarantined), created_at, updated_at`.
- **`lookup_*`** — payment method → NS account/payment item; ship method → NS ship item; tax → NS tax code/detail; Shopify location → NS location; currency. Per connection.
- **`reconciliation_snapshots`** — `environment, connection_id, business_date, shopify_order_count, ns_txn_count, shopify_total, ns_total, discrepancy (json), created_at`.

`entity_type` enum must include the future values (`refund, cancellation, fulfillment, item`) even though only `order` and `customer` are exercised in v1 — so later phases need no schema migration.

---

## 6. Build order (milestones — each ends with a review checkpoint)

**M0 — Scaffolding & contracts.** Monorepo, packages, gateway interfaces (`ShopifyGateway`, `NetSuiteGateway`, secret provider, queue, xref store), fakes, Azure SQL schema + migrations, Bicep skeleton, CI running unit tests. `netsuite-sdk` wired behind `NetSuiteGateway` with the multi-account factory; governor installed as SDK middleware with shared per-account state. *Acceptance:* CI green; governor proven under a simulated 500-order burst driven from **multiple concurrent client instances sharing one per-account budget** (aggregate in-flight concurrency never exceeds the configured per-account ceiling — an in-process limiter must visibly fail this test); a fake end-to-end order flows in tests.

**M1 — Order import happy path.** Webhook receiver (HMAC, enqueue, fast 200) → Durable orchestration → re-fetch order → eligibility predicate → customer match/create → map standard product order (lines, line/order discount, shipping+tax via tax strategy, rounding/balancing line) → create NS Sales Order **or** Cash Sale per connection → write `entity_xref` with `externalId`. Multi-tenant: two fake connections to two fake NS accounts proven isolated. *Acceptance:* same webhook delivered twice → exactly one NS transaction; NS total reconciles to Shopify total within tolerance; SO and Cash Sale paths both pass; both tax strategies have passing fixture tests.

**M2 — Failure handling & replay.** Error classification (transient → backoff+jitter retry; data/`unmapped_construct` → park; auth → alert), DLQ → quarantine on max attempts, REST + CLI replay (idempotent), structured tracing on dedup id, sync-health metrics to App Insights. *Acceptance:* injected transient error auto-recovers; an order with an unconfigured tender parks as `unmapped_construct` and is replayable after config fix without dup.

**M3 — Resilience nets.** Catch-up poller (Shopify watermark) recovers a deliberately dropped webhook; daily reconciliation sweep writes snapshots and flags a seeded discrepancy as drift (distinct from failure). *Acceptance:* dropped-webhook order appears in NS via poller; seeded mismatch surfaces in the sweep, not as a handler error.

Stop after M3 for a v1 review before any out-of-scope work.

---

## 7. Testing requirements

Unit + fixture tests for: idempotency (redelivery, concurrent delivery), eligibility predicate, every mapping primitive, rounding/balancing, both tax strategies, customer match/create incl. guest fallback, NS governor under burst, error classification, replay idempotency, poller recovery, reconciliation discrepancy detection. No test may call a live Shopify or NetSuite endpoint. Provide a documented path to run real integration tests later behind user-supplied env config.

---

## 8. How to work

- Build strictly v1. If a requirement seems to need an out-of-scope flow (e.g. handling a refund to make a test pass), **stop and ask** rather than expanding scope.
- Do not invent Shopify or NetSuite API behavior. Where a contract is uncertain, code against the interface, write a fixture reflecting the documented shape, and flag the assumption in a `ASSUMPTIONS.md`.
- **`netsuite-sdk` is first-party and in scope to use, not to rebuild.** Use its SuiteQL client (incl. `queryPages` streaming + query builder), `records` API (esp. `upsert` by `externalId`), `restlets`, `NetSuiteError`, and middleware pipeline. Pin an exact version. Wrap it behind `NetSuiteGateway`; never import it outside `/packages/netsuite-client`. If a needed capability is missing from the SDK, stop and ask before working around it (David maintains the SDK and may add it rather than have you patch around it).
- Prefer correctness and the "park, don't guess" rule over coverage of edge cases. A parked order is a success, not a failure.
- Keep connection/account/tax-engine/order-target as configuration, never as branches hardcoded to a portco.
- At each milestone boundary, summarize what was built, what was assumed, and what's parked for review.

Begin with **M0**. Confirm your understanding of scope and the invariants before writing code.
