import type { ConnectionsRepo } from '../connections/connections-repo.js';
import type { Environment } from '../env.js';
import type { QueueProducer } from '../queue/queue.js';
import type { XrefRow, XrefStore } from '../xref/xref-store.js';

/**
 * Inputs for a replay request — the smallest set the caller needs to supply
 * to identify a previously-imported order. `connectionId` is required because
 * the dedup key is `(environment, connection_id, entity_type, source_system,
 * source_id)`: the same Shopify GID across two stores would be two distinct
 * xref rows. Callers that only know the GID can look up the connection via
 * `connectionsRepo.listEnabled()` first.
 */
export interface ReplayRequest {
  readonly environment: Environment;
  readonly connectionId: string;
  readonly orderGid: string;
  /** Webhook topic to stamp on the re-published message. Defaults to `orders/updated`. */
  readonly topic?: string;
  /**
   * When the existing xref status is `synced`, refuse unless `force` is true.
   * The brief's idempotency invariant: a replay must not double-import an
   * order that already lives on NS. Force is the operator's explicit override
   * — e.g. after deleting the NS record manually to redo the import.
   */
  readonly force?: boolean;
  /** Optional clock override for the message's `receivedAt`. */
  readonly now?: () => Date;
}

/**
 * Outcome of a replay. `replayed` means the xref row was deleted and a fresh
 * `OrderWebhookMessage` was published; the SB consumer will run the full
 * import pipeline on the next delivery. Other variants are no-ops on the
 * queue (they either refuse to act or never had work to do).
 */
export type ReplayOutcome =
  | {
      readonly outcome: 'replayed';
      readonly previousStatus: XrefRow['status'] | 'absent';
      readonly sessionId: string;
    }
  | {
      readonly outcome: 'refused_already_synced';
      readonly targetId: string | null;
    }
  | {
      readonly outcome: 'unknown_connection';
      readonly connectionId: string;
    };

/**
 * Service-Bus message body the receiver originally enqueues. Mirrored here
 * (rather than imported from `apps/functions`) so the replay primitive lives
 * in @dpi/core with no app-layer dependency. The fields must stay in sync
 * with `apps/functions/src/messages.ts` — schemaVersion guards future drift.
 */
export interface OrderWebhookMessageBody {
  readonly schemaVersion: 1;
  readonly environment: Environment;
  readonly connectionId: string;
  readonly shopDomain: string;
  readonly topic: string;
  readonly orderGid: string;
  readonly envelopeBlobUri: string;
  readonly receivedAt: string;
}

export interface ReplayDeps {
  readonly xrefStore: XrefStore;
  readonly connections: ConnectionsRepo;
  readonly queue: QueueProducer<OrderWebhookMessageBody>;
}

/**
 * Atomically un-claim a parked / pending xref row and republish the order
 * to the queue so the import pipeline runs again. Used by both the CLI
 * (`dpi replay <gid>`) and the REST admin endpoint.
 *
 * Behavior matrix:
 *   - xref.status='synced' + !force → `refused_already_synced` (no delete,
 *     no publish). Operator must pass `force` or fix NS first.
 *   - xref.status in {pending, error, ignored} → delete + publish; outcome
 *     `replayed` with `previousStatus` set so the caller can report what
 *     was overwritten.
 *   - no xref row at all → publish only; outcome `replayed` with
 *     `previousStatus: 'absent'`. Covers the operator who deleted the row
 *     manually then realized they still need to redeliver.
 *   - connection not found in repo → `unknown_connection`, no side effects.
 *
 * Re-running this verb after a successful replay is safe: the just-published
 * message will eventually flow through, the xref row will be (re-)claimed
 * `pending`, and a second replay then sees `pending` and republishes again
 * — at-least-once-delivery on the SB topic plus the handler's `already_claimed`
 * short-circuit keeps NS writes singleton.
 */
export async function requestReplay(
  deps: ReplayDeps,
  req: ReplayRequest,
): Promise<ReplayOutcome> {
  const connection = await deps.connections.findById({
    environment: req.environment,
    connectionId: req.connectionId,
  });
  if (!connection) {
    return { outcome: 'unknown_connection', connectionId: req.connectionId };
  }

  const dedup = {
    environment: req.environment,
    connectionId: req.connectionId,
    entityType: 'order' as const,
    sourceSystem: 'shopify' as const,
    sourceId: req.orderGid,
  };

  const existing = await deps.xrefStore.lookup(dedup);
  if (existing?.status === 'synced' && !req.force) {
    return { outcome: 'refused_already_synced', targetId: existing.targetId };
  }

  const previousStatus = existing?.status ?? 'absent';
  if (existing) {
    await deps.xrefStore.delete(dedup);
  }

  const sessionId = `${req.connectionId}:${req.orderGid}`;
  const now = (req.now ?? (() => new Date()))();
  const body: OrderWebhookMessageBody = {
    schemaVersion: 1,
    environment: req.environment,
    connectionId: req.connectionId,
    shopDomain: connection.shopifyStore,
    topic: req.topic ?? 'orders/updated',
    orderGid: req.orderGid,
    // No new envelope is captured on replay; mark the source so consumers
    // / log readers can tell this delivery came from replay, not Shopify.
    envelopeBlobUri: `replay://dpi/${req.environment}/${req.connectionId}/${encodeURIComponent(req.orderGid)}/${now.toISOString()}`,
    receivedAt: now.toISOString(),
  };
  await deps.queue.enqueue({ sessionId, body });

  return { outcome: 'replayed', previousStatus, sessionId };
}
