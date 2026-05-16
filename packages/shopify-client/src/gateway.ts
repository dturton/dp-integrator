import type { Connection } from '@dpi/core';
import type { ShopifyOrder } from './order.js';

/**
 * The only Shopify surface the rest of the system depends on.
 *
 * - The webhook receiver calls `verifyWebhook` (HMAC) and enqueues a thin
 *   envelope. It does NOT trust the webhook body for downstream mapping.
 * - The order handler calls `getOrder` to re-fetch authoritative state from
 *   the Shopify Admin API before mapping. This is invariant 3 in the brief.
 *
 * The real client lives in M1; M0 ships only the interface + an in-memory
 * fake. No package outside this one imports an HTTP client.
 */
export interface ShopifyGateway {
  /**
   * Verify an `orders/create` / `orders/updated` webhook HMAC.
   *
   * Implementations must do constant-time comparison against
   * `Base64(HMAC-SHA256(rawBody, sharedSecret))` and return `false` on any
   * decode failure — never throw on a bad webhook.
   *
   * `secret` is resolved by the caller from `SecretProvider` (per connection).
   */
  verifyWebhook(input: { rawBody: string; hmac: string; secret: string }): boolean;

  /** Re-fetch a single order by Shopify GID for the given connection. */
  getOrder(connection: Connection, orderGid: string): Promise<ShopifyOrder>;
}
