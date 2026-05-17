/**
 * Azure Functions isolated-worker entry. The Function host loads this module
 * once at startup; the imported trigger module calls `app.http(...)` to
 * register routes. The `getAppContext` callback lazy-builds Azure clients on
 * first invocation so we don't connect at startup (faster cold start, and
 * tests don't need live env vars to import this module).
 *
 * Slice A registers only the Shopify webhook receiver. Slice B adds the
 * Service Bus session-triggered order handler + Durable orchestration; M3
 * adds the catch-up poller (timer) and reconciliation sweep.
 */
import { getAppContext } from './bootstrap.js';
import { PostgresLookupResolver } from './adapters/index.js';
import { registerAdminReplay } from './triggers/admin-replay.js';
import { registerNsDiagnostic } from './triggers/ns-diagnostic.js';
import { registerOrderImportHandler } from './triggers/order-import-handler.js';
import { registerShopifyWebhook } from './triggers/shopify-webhook.js';

registerShopifyWebhook(() => getAppContext());

// Diagnostic-only trigger (dev). Hit GET /api/ns-diagnostic to probe NS
// reads + writes from the function-host network path. Remove once NS writes
// stabilize.
registerNsDiagnostic(() => {
  const ctx = getAppContext();
  // Pick the first non-'pending' connection's NS account for the probe.
  // Synchronous lookup OK because connections are seeded at boot.
  return {
    ns: ctx.ns,
    nsAccountId: '11541804_SB1',
    nsSubsidiary: '1',
  };
});

// Slice D5: full pipeline. The handler claims xref, re-fetches the order,
// runs eligibility, resolves customer, builds the NS payload via the mapping
// engine, applies tax + balancing, calls ns.upsertByExternalId, and records
// success. PostgresLookupResolver is constructed per-connection on demand so
// the same pg.Pool services multiple tenants.
registerOrderImportHandler(() => {
  const ctx = getAppContext();
  if (!ctx.xrefStore) {
    throw new Error(
      'order-import handler invoked but bootstrap has no XrefStore — POSTGRES_HOST / POSTGRES_DATABASE / POSTGRES_MI_USER (or WEBSITE_SITE_NAME) not set',
    );
  }
  const pool = ctx.pgPool;
  if (!pool) {
    throw new Error('order-import handler invoked but bootstrap has no pgPool');
  }
  return {
    environment: ctx.environment,
    connections: ctx.connections,
    xrefStore: ctx.xrefStore,
    shopify: ctx.shopify,
    ns: ctx.ns,
    guestCustomerInternalId: ctx.guestCustomerInternalId,
    lookupsFor: (connection) => new PostgresLookupResolver(pool, connection),
  };
});

// M2-A: REST admin replay surface. Reuses the AppContext's xrefStore + the
// existing SB topic producer; `requestReplay` is the shared primitive.
registerAdminReplay(() => {
  const ctx = getAppContext();
  return {
    environment: ctx.environment,
    connections: ctx.connections,
    xrefStore: ctx.xrefStore,
    queue: ctx.orderQueue,
  };
});
