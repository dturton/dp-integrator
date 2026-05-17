# dp-integrator

Self-hosted, TypeScript/Azure-native replacement for Celigo's Shopify → NetSuite connector.
Multi-portfolio-company, multi-NetSuite-account, multi-tenant from day one.

**v1 scope:** Shopify → NetSuite **order import** only (Sales Order **or** Cash Sale per connection).
Refunds, cancellations, edits, fulfillment, inventory, payouts, B2B, FX, POS, subscriptions, kits,
and gift cards are **explicitly out of v1** (see `claude-code-build-brief-v1.md`).

## Repo layout

```
packages/
  core              gateway interfaces, in-memory impls, governor abstraction,
                    xref store, error store, secret provider, queue, types
  shopify-client    typed Order model, ShopifyGateway interface + fake (M0)
  netsuite-client   wraps `netsuite-sdk` behind NetSuiteGateway:
                    multi-account factory, governor middleware (shared per-account
                    state — NOT the SDK's in-process RateLimiter), externalId
                    upsert helper, error → ErrorClass mapping, tax strategy stubs,
                    in-memory fake
  mapping-engine    primitive types (M0); evaluator + rounding/balancing land in M1
apps/
  functions         Azure Functions isolated worker (host.json + skeleton; real
                    HTTP/queue/Durable triggers added in M1)
  admin             CLI entrypoint stub for replay (M2 fills it out)
infra/
  main.bicep        deployable Bicep — Function App (Flex), Service Bus
                    (topic + session sub + DLQ), Azure SQL, Key Vault, App Insights
  db/migrations     Azure SQL DDL (entity_xref, connections, watermarks,
                    error_records, lookups, governor slots, reconciliation)
config/             versioned JSONC: connections + field maps (per connection)
migration/          PLACEHOLDER — Celigo backfill (future, not in v1)
```

## Quick start

```bash
pnpm install
pnpm typecheck && pnpm build && pnpm test
```

CI runs the same three commands plus `bicep build infra/main.bicep`.

## Milestone status

- **M0 — Scaffolding & contracts** — done
- **M1 — Order import happy path** — in progress, sliced as follows:
  - **Slice A** (current) — webhook receiver deploys end-to-end: HMAC verify
    per connection, envelope persisted to blob, Service Bus enqueue with
    `${connectionId}:${orderGid}` session key, fast 200. **Enough to deploy
    and confirm orders are arriving.** No order handler yet.
  - Slice B — Service Bus session-aware queue handler + Durable orchestration
    scaffold + xref-claim idempotency (stub handler).
  - Slice C — Real `ShopifyHttpGateway.getOrder` (Admin GraphQL), eligibility
    predicate, customer match/create, mapping evaluator.
  - Slice D — SuiteTax + Legacy tax strategies, NS upsert wiring, two-account
    isolation test.
  - Slice E — M1 acceptance: redelivery idempotency, totals reconcile within
    tolerance, both SO + Cash Sale paths, both tax strategies.
- M2 — Failure handling, REST + CLI replay
- M3 — Catch-up poller, daily reconciliation sweep

See `claude-code-build-brief-v1.md` for milestone acceptance criteria
and `ASSUMPTIONS.md` for decisions made during the build.

## Deploying (Slice A onward)

One-time setup per Azure subscription:

1. **Entra app + federated credential** for GitHub OIDC. The app needs
   `Contributor` on the target subscription (or RG) so it can run subscription-scoped
   Bicep + Function App deploys.
2. **GitHub Environment** per target (`dev`, `sandbox`) with secrets:
   - `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`
   - `POSTGRES_ADMIN_PASSWORD` — Postgres Flex admin password (one-time bootstrap;
     Function App MI gets Entra auth in Slice B)
   - `KEY_VAULT_ADMIN_PRINCIPAL_ID` — object ID of the deploying principal,
     granted `Key Vault Secrets Officer` so post-deploy scripts can write secrets
   - `DPI_CONNECTIONS_JSON` — JSON array of `Connection` records
     (see `config/connections.example.jsonc`). **No raw secrets** — only KV
     refs. Receiver hot-reloads on next cold start.

Run **Deploy** from the Actions tab. The workflow:

- Installs deps, typechecks, runs tests, builds.
- Logs into Azure with OIDC.
- Deploys `infra/main.bicep` (Function App on Flex, Service Bus topic + session
  subscription, SQL, Key Vault, App Insights, blob container `inbound-webhooks`,
  MI role assignments).
- Packages the Function App via `pnpm deploy --prod` and ships it to Azure.
- Prints the **webhook URL** in the run summary.

Webhook URL pattern:

```
https://<functionAppName>.azurewebsites.net/api/webhooks/shopify/orders
```

### Per-shop Shopify secrets

For each connection in `DPI_CONNECTIONS_JSON`:

1. In the Shopify store admin, create a custom app and copy the **API secret key**
   (this is the webhook HMAC shared secret — distinct from the Admin API access
   token).
2. Write it to Key Vault using the ref name from the connection's
   `shopifyWebhookSecretRef` field:

   ```bash
   az keyvault secret set --vault-name <vaultName> \
     --name shopify-webhook-secret-acme-us --value shpss_xxx
   ```
3. Also write the Admin API access token to the ref named in
   `shopifyAppTokenRef` — unused in Slice A but needed for Slice C.
4. In the Shopify admin, register webhooks for `orders/create` and
   `orders/updated` pointing at the function URL.

### Verifying delivery

- **App Insights** — Function invocations log `shopifyOrderWebhook outcome=…`
  per request; query traces for `outcome=enqueued`.
- **Blob storage** — open the `inbound-webhooks` container; envelopes land at
  `<env>/<connectionId>/<topic>/<yyyy>/<mm>/<dd>/<orderId>-<ts>.json`.
- **Service Bus** — namespace metrics show messages on the `orders-in` topic
  / `order-import` subscription (will sit there until Slice B's handler runs).
- Shopify admin → webhook log shows 200s.

## Ops CLI (`dpi`)

A terminal-only status board for the integration. Run from your machine
against any deployed environment.

```bash
# One-time: build the workspace
pnpm install && pnpm build

# Set environment for the CLI. Add these to ~/.zshrc / ~/.bashrc to make
# them sticky. Your Entra principal must already be a Postgres admin
# (granted in Slice B1).
export DPI_PG_HOST="dpi-pg-dev-<suffix>.postgres.database.azure.com"
export DPI_PG_DATABASE="dpi_dev"
export DPI_PG_USER="you@yourorg.com"
export DPI_AI_APP_ID="<app-insights-component-appId>"
export DPI_ENVIRONMENT="dev"

# One-screen overview: backlog counts + recent xref activity + last-hour
# handler outcomes.
node apps/admin/dist/cli.js status

# Parked rows (xref status='error') with the most recent park reason
# pulled from App Insights logs.
node apps/admin/dist/cli.js parked --limit 30
```

To retry a parked row after fixing the underlying issue:

```sql
DELETE FROM entity_xref WHERE source_id = 'gid://shopify/Order/<id>';
```

Then redeliver the webhook (Shopify admin → webhook log → resend, or `curl`
with a signed body). M2 will add a `dpi replay <gid>` verb that does both
atomically.

## Working with the NetSuite SDK

This monorepo depends on the first-party `netsuite-sdk` package (pinned). It is the **only** package
that should import `netsuite-sdk` directly:

- All other packages depend on the `NetSuiteGateway` interface from `@dpi/netsuite-client`.
- Tests fake the gateway, not the SDK.
- The shared governor middleware sits on top of the SDK's transport (`client.use(...)`); the SDK's
  bundled `RateLimiter` is **not** used (per-process only — see the burst test for why).

## Infra deploys

`make infra-plan ENV=dev` is a dry-run (`az deployment sub what-if`). `make infra-deploy ENV=dev`
asks you to type the environment name to confirm before applying. Defaults to subscription-scoped
deploys; resource group is created by the template if missing.
