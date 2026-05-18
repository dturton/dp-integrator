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
import { getTelemetry } from './telemetry.js';
import { registerAdminApi } from './triggers/admin-api.js';
import { registerAdminReplay } from './triggers/admin-replay.js';
import { registerNsDiagnostic } from './triggers/ns-diagnostic.js';
import { registerOrderCatchupPoller } from './triggers/order-catchup-poller.js';
import { registerOrderDlqHandler } from './triggers/order-dlq-handler.js';
import { registerOrderImportHandler } from './triggers/order-import-handler.js';
import { registerReconciliationSweep } from './triggers/reconciliation-sweep.js';
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
    ...(ctx.errorStore ? { errorStore: ctx.errorStore } : {}),
    ...(ctx.orderSyncLog ? { orderSyncLog: ctx.orderSyncLog } : {}),
    ...(ctx.orderAttemptStore ? { orderAttemptStore: ctx.orderAttemptStore } : {}),
    ...(ctx.outboundPayloadStore ? { outboundPayloadStore: ctx.outboundPayloadStore } : {}),
    telemetry: getTelemetry(),
  };
});

// Admin API backing the admin UI (apps/admin-ui). pg.Pool-only — read-mostly
// queries over order_sync_log + reconciliation_snapshots. function-key auth.
registerAdminApi(() => {
  const ctx = getAppContext();
  if (!ctx.pgPool) return undefined;
  return {
    environment: ctx.environment,
    pgPool: ctx.pgPool,
    connections: ctx.connections,
    ...(ctx.blobReader ? { blobReader: ctx.blobReader } : {}),
    ...(ctx.blobAccountUrl ? { blobAccountUrl: ctx.blobAccountUrl } : {}),
    ...(ctx.orderSyncLog && ctx.reconciliationStore
      ? {
          reconciliation: {
            environment: ctx.environment,
            connections: ctx.connections,
            shopify: ctx.shopify,
            orderSyncLog: ctx.orderSyncLog,
            reconciliationStore: ctx.reconciliationStore,
            telemetry: getTelemetry(),
          },
        }
      : {}),
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
    ...(ctx.orderAttemptStore ? { orderAttemptStore: ctx.orderAttemptStore } : {}),
    ...(ctx.orderSyncLog ? { orderSyncLog: ctx.orderSyncLog } : {}),
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
    telemetry: getTelemetry(),
  };
});

// M3-B: daily reconciliation sweep. Runs once a day; compares yesterday's
// Shopify-side count + total (`processed_at` window, non-test orders) to
// the dpi order_sync_log aggregate (status='imported') for the same window.
// Drift surfaces as a `dpi.reconciliation.drift` customEvent + a row in
// `reconciliation_snapshots`.
registerReconciliationSweep(() => {
  const ctx = getAppContext();
  return {
    environment: ctx.environment,
    connections: ctx.connections,
    shopify: ctx.shopify,
    orderSyncLog: ctx.orderSyncLog,
    reconciliationStore: ctx.reconciliationStore,
    telemetry: getTelemetry(),
  };
});
