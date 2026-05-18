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

  /**
   * Re-fetch a single order by Shopify GID for the given connection.
   *
   * Implementations must throw `OrderNotFoundError` when the order simply
   * does not exist in the store (Shopify GraphQL `data.order === null`).
   * All other failures — HTTP errors, GraphQL errors, transport issues —
   * should propagate as ordinary `Error`s so the SB handler retries them.
   */
  getOrder(connection: Connection, orderGid: string): Promise<ShopifyOrder>;

  /**
   * Add one or more tags to a Shopify order (slice E2). Uses Shopify's
   * `tagsAdd` mutation under the hood — set-add semantics, so re-running
   * with the same tag is a no-op and idempotent under replay.
   *
   * Requires the `write_orders` scope on the custom app. `OrderNotFoundError`
   * is thrown when Shopify returns a not-found userError; other failures
   * propagate as plain Errors (the handler decides whether to retry).
   *
   * Returns the full set of tags now on the order, in case callers want to
   * surface them.
   */
  tagOrder(connection: Connection, orderGid: string, tags: readonly string[]): Promise<readonly string[]>;

  /**
   * Page through orders with `updatedAt >= since`, oldest-first, for the
   * catch-up poller (slice M3-A). The poller asks Shopify "what changed
   * since the last watermark?" and enqueues anything the xref doesn't
   * already know about — recovers from webhooks the receiver missed
   * (Shopify outage, network blip, our function host down).
   *
   * Implementations should:
   *   - cap the result at `limit` (default 250, the GraphQL max page) and
   *     order ascending by `updatedAt` so the watermark advances
   *     monotonically;
   *   - honor `after` as an opaque page cursor when present;
   *   - return only the minimum the handler needs — id (GID), updatedAt,
   *     and the topic-ish flavor — because the handler re-fetches the
   *     full order from `getOrder` anyway (brief invariant 3).
   *
   * Returns a single page with cursor info; the poller loops while
   * `hasNextPage` is true.
   */
  listOrdersUpdatedSince(
    connection: Connection,
    args: { since: string; limit?: number; after?: string },
  ): Promise<OrderSummaryPage>;
}

/** Minimum order shape the catch-up poller needs. */
export interface OrderSummary {
  readonly id: string;
  readonly updatedAt: string;
}

export interface OrderSummaryPage {
  readonly items: ReadonlyArray<OrderSummary>;
  readonly hasNextPage: boolean;
  readonly endCursor?: string;
}

/**
 * Thrown by `ShopifyGateway.getOrder` when Shopify reports the order as
 * missing. Distinct from generic errors because the handler treats it as a
 * permanent park (no point retrying) rather than a transient failure.
 */
export class OrderNotFoundError extends Error {
  readonly orderGid: string;
  readonly shopDomain: string;
  constructor(orderGid: string, shopDomain: string) {
    super(`order '${orderGid}' not found on ${shopDomain}`);
    this.name = 'OrderNotFoundError';
    this.orderGid = orderGid;
    this.shopDomain = shopDomain;
  }
}

/**
 * Thrown when Shopify says the order exists but the requested sublists were
 * truncated by the query limits (line items, shipping lines, or transactions).
 * We park these orders rather than importing partial financial data.
 */
export class OrderTruncatedError extends Error {
  readonly orderGid: string;
  readonly shopDomain: string;
  readonly truncatedFields: readonly string[];

  constructor(orderGid: string, shopDomain: string, truncatedFields: readonly string[]) {
    super(
      `order '${orderGid}' on ${shopDomain} exceeds query limits for ${truncatedFields.join(', ')}`,
    );
    this.name = 'OrderTruncatedError';
    this.orderGid = orderGid;
    this.shopDomain = shopDomain;
    this.truncatedFields = truncatedFields;
  }
}
