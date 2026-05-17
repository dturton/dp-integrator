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
import { registerOrderImportHandler } from './triggers/order-import-handler.js';
import { registerShopifyWebhook } from './triggers/shopify-webhook.js';

registerShopifyWebhook(() => getAppContext());

// Slice B+: drain the Service Bus topic into the order handler. The handler
// refuses to run if the bootstrap didn't supply an xrefStore (Postgres not
// configured), so trigger registration is conditional on context shape.
registerOrderImportHandler(() => {
  const ctx = getAppContext();
  if (!ctx.xrefStore) {
    throw new Error(
      'order-import handler invoked but bootstrap has no XrefStore — POSTGRES_HOST / POSTGRES_DATABASE / POSTGRES_MI_USER (or WEBSITE_SITE_NAME) not set',
    );
  }
  return {
    environment: ctx.environment,
    connections: ctx.connections,
    xrefStore: ctx.xrefStore,
  };
});
