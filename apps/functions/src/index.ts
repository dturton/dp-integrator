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
import { registerOrderCatchupPoller } from './triggers/order-catchup-poller.js';
import { registerOrderDlqHandler } from './triggers/order-dlq-handler.js';
import { registerOrderImportHandler } from './triggers/order-import-handler.js';
import { registerShopifyWebhook } from './triggers/shopify-webhook.js';

registerShopifyWebhook(() => getAppContext());

// Diagnostic-only trigger. Off by default; enable intentionally when
// debugging NetSuite connectivity from the deployed function host.
if (process.env['ENABLE_NS_DIAGNOSTIC'] === 'true') {
  registerNsDiagnostic(() => {
    const ctx = getAppContext();
    return {
      ns: ctx.ns,
      nsAccountId:
        process.env['NS_DIAGNOSTIC_ACCOUNT_ID'] ??
        (() => {
          throw new Error('ENABLE_NS_DIAGNOSTIC=true requires NS_DIAGNOSTIC_ACCOUNT_ID');
        })(),
      nsSubsidiary:
        process.env['NS_DIAGNOSTIC_SUBSIDIARY'] ??
        (() => {
          throw new Error('ENABLE_NS_DIAGNOSTIC=true requires NS_DIAGNOSTIC_SUBSIDIARY');
        })(),
      allowWrites: process.env['ENABLE_NS_DIAGNOSTIC_WRITES'] === 'true',
    };
  });
}

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
    ...(ctx.errorStore ? { errorStore: ctx.errorStore } : {}),
    ...(ctx.orderSyncLog ? { orderSyncLog: ctx.orderSyncLog } : {}),
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

// M2-B: DLQ → quarantine. Listens to orders-in/order-import/$DeadLetterQueue
// and writes one error_records row per dead-lettered envelope so a message
// that exhausts maxDeliveryCount becomes visible to ops rather than vanishing.
registerOrderDlqHandler(() => {
  const ctx = getAppContext();
  return {
    environment: ctx.environment,
    connections: ctx.connections,
    errorStore: ctx.errorStore,
  };
});

// M3-A: catch-up poller. Periodically asks Shopify for orders with
// updatedAt >= watermark for each enabled connection and republishes any
// the xref doesn't already know about — recovers from webhooks Shopify
// dropped (outage, our host down). Watermark + idempotency claim absorb
// any overlap between this and the live receiver.
registerOrderCatchupPoller(() => {
  const ctx = getAppContext();
  return {
    environment: ctx.environment,
    connections: ctx.connections,
    xrefStore: ctx.xrefStore,
    watermarkStore: ctx.watermarkStore,
    shopify: ctx.shopify,
    queue: ctx.orderQueue,
  };
});
