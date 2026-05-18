import {
  app,
  type InvocationContext,
  type Timer,
} from '@azure/functions';
import type {
  ConnectionsRepo,
  Environment,
  QueueProducer,
  SyncWatermarkStore,
  XrefStore,
} from '@dpi/core';
import type { ShopifyGateway } from '@dpi/shopify-client';
import type { OrderWebhookMessage } from '../messages.js';

/**
 * Slice M3-A — catch-up poller.
 *
 * Every N minutes (timer trigger), for each enabled connection in the
 * environment:
 *
 *   1. Read the connection's `order-catchup` watermark (an ISO timestamp).
 *      On first run for this connection, bootstrap to `now - lookbackHours`.
 *   2. Ask Shopify for orders with `updatedAt >= watermark`, ascending.
 *   3. For each order in the page, look up the xref. If the row exists
 *      and `status='synced'`, skip — the webhook already imported it. If
 *      the row doesn't exist OR is in a non-terminal state, publish an
 *      `OrderWebhookMessage` to the Service Bus topic so the regular
 *      order handler picks it up. Idempotency at the handler's claim
 *      step absorbs any overlap.
 *   4. Advance the watermark to the latest `updatedAt` observed (or to
 *      `now - overlapSeconds` when no orders matched, so the lookback
 *      doesn't grow indefinitely between sparse polls).
 *
 * The brief's M3 acceptance: "dropped-webhook order appears in NS via
 * poller." That works because the handler is the same `shopifyOrderHandler`
 * either path lands at — the receiver and the poller are two producers on
 * the same SB topic. The brief invariant 1 (idempotency claim) means the
 * order can't be double-imported regardless of which producer wins.
 */

export interface CatchupDeps {
  readonly environment: Environment;
  readonly connections: ConnectionsRepo;
  readonly xrefStore: XrefStore | undefined;
  readonly watermarkStore: SyncWatermarkStore | undefined;
  readonly shopify: ShopifyGateway;
  readonly queue: QueueProducer<OrderWebhookMessage>;
  /** Defaults to `new Date()` — injectable for tests. */
  readonly now?: () => Date;
}

export interface CatchupConfig {
  /** Cron expression for the timer trigger (passed to bicep / function host). */
  readonly schedule: string;
  /** Bootstrap window when no watermark exists yet. */
  readonly bootstrapLookbackHours: number;
  /** When no orders matched on a poll, advance the watermark to `now - overlap`. */
  readonly overlapSecondsOnEmpty: number;
  /** Page size sent to Shopify. */
  readonly pageSize: number;
}

export const DEFAULT_CATCHUP_CONFIG: CatchupConfig = {
  schedule: '0 */10 * * * *', // every 10 minutes
  bootstrapLookbackHours: 24,
  overlapSecondsOnEmpty: 60,
  pageSize: 50,
};

export const CATCHUP_FLOW = 'order-catchup';

export type ConnectionCatchupOutcome =
  | { readonly kind: 'polled'; readonly connectionId: string; readonly observed: number; readonly enqueued: number; readonly fromCursor: string; readonly newCursor: string }
  | { readonly kind: 'skipped'; readonly connectionId: string; readonly reason: 'not_ready' };

export interface CatchupOutcome {
  readonly perConnection: ReadonlyArray<ConnectionCatchupOutcome>;
}

export async function pollCatchup(
  deps: CatchupDeps,
  config: CatchupConfig = DEFAULT_CATCHUP_CONFIG,
): Promise<CatchupOutcome> {
  const enabledConnections = await deps.connections.listEnabled(deps.environment);
  const results: ConnectionCatchupOutcome[] = [];
  for (const connection of enabledConnections) {
    if (!deps.xrefStore || !deps.watermarkStore) {
      results.push({ kind: 'skipped', connectionId: connection.connectionId, reason: 'not_ready' });
      continue;
    }
    results.push(await pollOneConnection(deps, config, connection.connectionId));
  }
  return { perConnection: results };
}

async function pollOneConnection(
  deps: CatchupDeps,
  config: CatchupConfig,
  connectionId: string,
): Promise<ConnectionCatchupOutcome> {
  // xrefStore and watermarkStore are guaranteed present here by pollCatchup.
  const xrefStore = deps.xrefStore!;
  const watermarkStore = deps.watermarkStore!;
  const now = (deps.now ?? (() => new Date()))();

  // Resolve the connection (need shopifyStore for the message body).
  const connection = await deps.connections.findById({
    environment: deps.environment,
    connectionId,
  });
  if (!connection) {
    // Caller listed it via listEnabled — should never be missing here, but
    // defensive bailout rather than throwing.
    return { kind: 'skipped', connectionId, reason: 'not_ready' };
  }

  const existing = await watermarkStore.get({
    environment: deps.environment,
    connectionId,
    flow: CATCHUP_FLOW,
  });
  const fromCursor =
    existing?.lastCursor ??
    new Date(now.getTime() - config.bootstrapLookbackHours * 3_600_000).toISOString();

  const orders = await deps.shopify.listOrdersUpdatedSince(connection, {
    since: fromCursor,
    limit: config.pageSize,
  });

  let enqueued = 0;
  for (const summary of orders) {
    const existingXref = await xrefStore.lookup({
      environment: deps.environment,
      connectionId,
      entityType: 'order',
      sourceSystem: 'shopify',
      sourceId: summary.id,
    });
    // Skip rows that have already terminally resolved — synced or ignored.
    // pending / error / absent → re-enqueue so the handler picks it up
    // (idempotency at the claim step absorbs double deliveries).
    if (existingXref?.status === 'synced' || existingXref?.status === 'ignored') {
      continue;
    }
    const body: OrderWebhookMessage = {
      schemaVersion: 1,
      environment: deps.environment,
      connectionId,
      shopDomain: connection.shopifyStore,
      topic: 'orders/updated',
      orderGid: summary.id,
      envelopeBlobUri: `catchup://dpi/${deps.environment}/${connectionId}/${encodeURIComponent(
        summary.id,
      )}/${now.toISOString()}`,
      receivedAt: now.toISOString(),
    };
    await deps.queue.enqueue({
      sessionId: `${connectionId}:${summary.id}`,
      body,
    });
    enqueued += 1;
  }

  // Advance the watermark. If we observed orders, use the latest updatedAt
  // (a tiny chance of re-fetch on the next poll if Shopify returns a
  // subsequent order at the same ms — idempotency absorbs it). If empty,
  // jump forward to `now - overlap` so we don't keep replaying the same
  // window indefinitely.
  const newCursor =
    orders.length > 0
      ? orders[orders.length - 1]!.updatedAt
      : new Date(now.getTime() - config.overlapSecondsOnEmpty * 1000).toISOString();
  await watermarkStore.set({
    environment: deps.environment,
    connectionId,
    flow: CATCHUP_FLOW,
    cursor: newCursor,
  });

  return {
    kind: 'polled',
    connectionId,
    observed: orders.length,
    enqueued,
    fromCursor,
    newCursor,
  };
}

export function registerOrderCatchupPoller(
  getDeps: () => CatchupDeps,
  config: CatchupConfig = DEFAULT_CATCHUP_CONFIG,
): void {
  app.timer('orderCatchupPoller', {
    schedule: config.schedule,
    handler: async (_timer: Timer, context: InvocationContext): Promise<void> => {
      const outcome = await pollCatchup(getDeps(), config);
      for (const r of outcome.perConnection) {
        const tail =
          r.kind === 'polled'
            ? `observed=${r.observed} enqueued=${r.enqueued} from=${r.fromCursor} to=${r.newCursor}`
            : `reason=${r.reason}`;
        context.log(`orderCatchupPoller kind=${r.kind} connection=${r.connectionId} ${tail}`);
      }
    },
  });
}
