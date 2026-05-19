import type { Environment } from '@dpi/core';

/**
 * Body of the Service Bus message produced by the webhook receiver and
 * consumed by the order handler (wired in Slice B).
 *
 * Intentionally narrow: the brief's invariant 3 says the handler re-fetches
 * the order from Shopify rather than trusting the webhook body. The handler
 * only needs enough to identify the order + find the envelope for audit/replay.
 *
 * `schemaVersion` is on the wire so the handler can reject (DLQ) unknown
 * shapes once we evolve this in M2+.
 */
export interface OrderWebhookMessage {
  readonly schemaVersion: 1;
  readonly environment: Environment;
  readonly connectionId: string;
  readonly shopDomain: string;
  /** Shopify webhook topic, e.g. `orders/create` or `orders/updated`. */
  readonly topic: string;
  /** Shopify order GID — `gid://shopify/Order/<id>`. The NS externalId. */
  readonly orderGid: string;
  /** URI of the raw envelope persisted by the receiver (blob storage). */
  readonly envelopeBlobUri: string;
  /** ISO-8601 timestamp the receiver recorded. */
  readonly receivedAt: string;
  /**
   * Origin of the delivery. `webhook` = live Shopify push; `catchup` = poller
   * rescue; `replay` = operator-initiated re-publish. The handler uses this
   * to gate `orders/updated`-for-unknown-order: only `webhook` deliveries are
   * ignored, since catchup/replay are explicit acts that should create when
   * needed. Optional for back-compat with in-flight legacy messages — the
   * handler defaults missing values to `webhook`.
   */
  readonly source?: 'webhook' | 'catchup' | 'replay';
}

/**
 * Service Bus session id for per-order FIFO. Brief mandates ordering per
 * (connection, orderId) so a later refund/edit cannot leapfrog the original
 * order for the same key.
 */
export function sessionKeyFor(args: { connectionId: string; orderGid: string }): string {
  return `${args.connectionId}:${args.orderGid}`;
}
