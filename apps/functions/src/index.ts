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
import { registerOrderImportHandler } from './triggers/order-import-handler.js';
import { registerShopifyWebhook } from './triggers/shopify-webhook.js';

registerShopifyWebhook(() => getAppContext());

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
