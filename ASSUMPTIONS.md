# Assumptions & decisions log

Decisions made during the build that are not explicitly nailed in `claude-code-build-brief-v1.md`
or the v2 architecture spec. These are reversible; flag any that conflict with intent.

## M0 — toolchain & repo

- **Package manager:** pnpm 9.12.0 (pinned via `packageManager` in `package.json`).
- **Node version:** 20 (matches `netsuite-sdk` engines and Azure Functions isolated worker).
- **Module system:** ESM throughout (`"type": "module"`, `module: "NodeNext"`). Functions
  isolated worker supports ESM; `netsuite-sdk` ships both CJS and ESM exports.
- **TypeScript:** `~5.5.4` (matches `netsuite-sdk` devDep range).
- **Test framework:** Vitest 2.1.x. No real network in any test.
- **CI:** GitHub Actions (single workflow: typecheck + build + test + `bicep build`).
- **netsuite-sdk version:** **pinned to `0.1.33`** (current latest as of 2026-05-16). Per the brief,
  this is David's own package — treated as a trusted internal dependency. Bump deliberately, not
  via caret range.

## M0 — governor

- The brief mandates a **shared, cross-instance per-NS-account governor**. M0 ships:
  - `GovernorBackingStore` interface (`tryAcquire`, `release`, `inFlight`)
  - `SharedInMemoryGovernorStore` — single instance multiple clients can share (correct behavior)
  - `PerProcessGovernorStore` — wraps the SDK's `RateLimiter` per client instance (the trap)
- A real **`SqlGovernorBackingStore` is interface-only in M0**; the SQL implementation lands when
  M1/M2 first need a real deploy. Justification: the in-memory `Shared` store proves the contract
  for tests; the SQL impl is mechanical once we have a live DB.
- The middleware sits on top of `client.use(...)` and acquires *before* the request, releases
  *after*. The SDK's internal transport retries (`maxRetries`, default 3) **re-enter the middleware
  chain** — each retried call consumes a slot. The burst test asserts this.

## M0 — Bicep / infra

- **Scope:** subscription-scoped Bicep (`targetScope = 'subscription'`); the template creates the
  resource group. Per the user's choice, M0 ships deployable Bicep (not just a skeleton).
- **Parameters file:** `infra/parameters/dev.bicepparam` exists with placeholder values. Real values
  (SQL admin password, subscription/RG names) come from CI secrets or a `.bicepparam` override.
- **What's deployed:** Function App on Flex Consumption, Service Bus namespace (one topic, one
  subscription with `requiresSession=true`, DLQ enabled), Azure SQL server + DB, Key Vault,
  Application Insights + Log Analytics workspace.
- **What's NOT in M0:** Durable Functions task hub config, real triggers, Service Bus auth rules
  beyond defaults. These land in M1 alongside the actual function code.

## M0 — schema

- `entity_xref.entity_type` enum already includes future values (`refund`, `cancellation`,
  `fulfillment`, `item`) so M2+ adds no migration.
- `lookup_*` tables are created in M0 (per brief §5) even though only M1/M2 exercise them.
- `ns_governor_slots` table (migration 0003) backs the future SQL governor store; the M0 in-memory
  governor does not touch it.

## M0 — tests

- The "in-process limiter fails the burst test" requirement is implemented as an **asserting test**
  (we measure aggregate concurrency under two `PerProcessGovernorStore` instances and assert it
  exceeds the per-account budget). Test passes by *demonstrating the bug* — keeps CI green and the
  intent explicit in the output.
- Burst sizes: 500 simulated requests (per brief), per-account budget = 10, 2 client instances.
  Below the SDK's own concurrency limits but enough to make the trap visible.

## M1 Slice A — webhook receiver + deploy pipeline

- **Webhook secret vs API access token.** Brief §5 listed only
  `shopify_app_token_ref`, but Shopify custom apps issue two distinct secrets:
  an Admin API access token (used by `ShopifyGateway.getOrder` in Slice C+) and
  the **API secret key** used to HMAC-sign webhooks. Added a new
  `shopifyWebhookSecretRef` field on `Connection` and a SQL column via migration
  `0004_webhook_secret_ref.sql`. The two refs point at independent Key Vault
  secrets so an admin-token rotation never breaks webhook intake.
- **Raw envelope persistence: blob, not SQL.** Brief invariant 3 mandates the
  receiver persist the raw envelope. Slice A writes it to the storage account's
  `inbound-webhooks` container (path
  `<env>/<connectionId>/<topic>/<yyyy>/<mm>/<dd>/<orderId>-<ts>.json`).
  Rationale: blob is durable, infinitely scalable, costs nothing per write at
  this volume, and doesn't require a SQL writer/migration runner to be in place
  before the receiver can ship. A later slice can add a SQL `inbound_webhooks`
  index table that points at the blob URI if querying becomes a pain.
- **Connections source: env-var JSON, not SQL.** Slice A boots the receiver from
  `DPI_CONNECTIONS_JSON` (parsed by `parseConnectionsConfig`, served via
  `InMemoryConnectionsRepo`). Schema for `dbo.connections` exists and now
  includes `shopify_webhook_secret_ref`, but no SQL repo impl yet. Trade-off:
  changing connections requires an app-settings update + cold start (~seconds),
  not a SQL write. Acceptable for v1 onboarding velocity; SQL-backed
  `ConnectionsRepo` lands when the admin REST surface does in M2.
- **Service Bus session key shape (confirmed).** `${connection_id}:${order_gid}`,
  matching the brief's per-(connection, orderId) FIFO requirement. Centralized
  in `apps/functions/src/messages.ts:sessionKeyFor`.
- **Receiver response codes.**
  - `200 enqueued` — HMAC verified, envelope persisted, queued.
  - `401 missing_shopify_headers` / `unknown_or_disabled_shop` / `invalid_hmac`
    — permanent rejection from Shopify's perspective. Shopify retries up to 19
    times over 48h regardless; we accept that small replay cost as the price of
    not silently dropping HMAC failures.
  - `400 body_not_json` / `body_missing_id` — body unparseable.
  - `500 secret_lookup_failed` / `envelope_persist_failed` / `enqueue_failed`
    — transient infra. Shopify retries; the receiver is otherwise stateless so
    a redelivery succeeds. Idempotency in the (Slice B) handler protects
    against duplicate NS writes when both the original and the retry made it to
    the queue.
- **MI RBAC granted in Bicep.** Function App's system-assigned MI gets:
  `Storage Blob Data Contributor` on the storage account (envelopes + Flex
  Consumption deployment package), `Service Bus Data Sender` + `Data Receiver`
  on the SB namespace (Sender for the receiver, Receiver pre-granted for Slice B),
  `Key Vault Secrets User` on the vault. Centralized in
  `infra/modules/role-assignments.bicep` to avoid a function-app ↔ SB/KV cycle.

## Open / deferred

- **Real Azure SQL for tests:** not used in M0 (in-memory stores cover the unit-test surface). A
  later integration test suite will run against `MSSQL_CONNECTION_STRING` env-gated.
- **Tax engine per account:** brief mandates a Phase 0 task to confirm. M0 only defines the
  `TaxStrategy` interface and stub `SuiteTaxStrategy` / `LegacyTaxStrategy`; M1 will fill in
  the per-engine line/tax payload builders against real fixtures.
- **Shopify webhook HMAC algorithm:** the `verifyWebhook` interface signature is in place; the
  real HMAC-SHA256 + base64 implementation is wired up in M1 alongside the receiver function.
- **Service Bus session key shape:** brief says "sessions = FIFO per (connection, orderId)". Likely
  `${connection_id}:${order_gid}`. Confirmed when M1 wires up the receiver.
- **Bicep secrets:** SQL admin password parameter is `@secure` but its source (CI secret vs
  Key Vault reference vs interactive prompt) is left to ops. `infra/parameters/dev.bicepparam`
  ships with a placeholder.

Anything you'd like reversed before M1, flag it.
