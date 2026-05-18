import {
  app,
  type InvocationContext,
} from '@azure/functions';
import type {
  ConnectionsRepo,
  Environment,
  ErrorStore,
  OrderAttemptStore,
  OrderSyncLogStore,
} from '@dpi/core';
import { dedupKey } from '@dpi/core';
import type { OrderWebhookMessage } from '../messages.js';

/**
 * Slice M2-B safety net. After `maxDeliveryCount=10` (see
 * `infra/modules/service-bus.bicep`) Service Bus moves a message from the
 * `order-import` subscription to its dead-letter queue. Without a listener,
 * messages quietly accumulate there until manually drained.
 *
 * This handler subscribes to the DLQ via the
 * `order-import/$DeadLetterQueue` subscription-name convention the Functions
 * SB extension recognises. For each dead-lettered envelope it writes one
 * `error_records` row with `status='quarantined'` so the operator sees the
 * failure on the admin surface (and so the original payload is preserved for
 * a future `dpi replay` after the root cause is fixed).
 *
 * The DLQ trigger acks the message on success (default Functions SB
 * autoCompleteMessages semantics). If `record()` itself throws, the message
 * stays on the DLQ and the host will retry — at that point it's a Postgres
 * outage, not a per-order issue.
 *
 * Error classification is deliberately minimal in this slice: every DLQ
 * arrival is recorded as `errorClass='unknown'` (the SDK doesn't surface
 * the original handler error past the SB redelivery boundary). A follow-up
 * slice can plumb the last-error annotation through if SB / the bindings
 * expose `DeadLetterReason` / `DeadLetterErrorDescription` to us.
 */

export interface DlqHandlerDeps {
  readonly environment: Environment;
  readonly connections: ConnectionsRepo;
  readonly errorStore: ErrorStore | undefined;
  /**
   * M2-D: when wired, the DLQ handler also writes a final `order_attempt`
   * row with `outcome='quarantined'` so the timeline shows "10 attempts
   * then DLQ" rather than abruptly ending at the last transient. Optional
   * for back-compat with pre-D bootstraps / tests.
   */
  readonly orderAttemptStore?: OrderAttemptStore;
  /**
   * M2-D: when wired, the DLQ handler bumps the sync-log's
   * `attempt_count` to the SB-authoritative deliveryCount so the list
   * view shows the order as "tried Nx then quarantined" even if no
   * order_sync_log row existed (rare; would mean the order parked before
   * sync-log write).
   */
  readonly orderSyncLog?: OrderSyncLogStore;
}

export type DlqOutcome =
  | { readonly kind: 'recorded'; readonly errorId: string; readonly dedup: string }
  | { readonly kind: 'unrecorded'; readonly reason: 'bad_envelope' | 'unknown_connection' | 'no_error_store'; readonly detail: string };

export async function handleDeadLetteredOrder(
  deps: DlqHandlerDeps,
  message: unknown,
  context: InvocationContext,
): Promise<DlqOutcome> {
  if (!deps.errorStore) {
    return {
      kind: 'unrecorded',
      reason: 'no_error_store',
      detail: 'bootstrap missing PG / errorStore',
    };
  }

  const parsed = parseEnvelope(message);
  if (!parsed.ok) {
    // Still note it — without a dedup key we can't correlate, but we keep
    // the raw body for forensics so the message isn't lost.
    await deps.errorStore.record({
      environment: deps.environment,
      connectionId: 'unknown',
      flow: 'order-import',
      dedupKey: 'unparseable',
      errorClass: 'unknown',
      message: `DLQ envelope unparseable: ${parsed.error}`,
      envelope: message,
    });
    return { kind: 'unrecorded', reason: 'bad_envelope', detail: parsed.error };
  }
  const env = parsed.value;

  // Resolve the connection if we can — purely informational. An unknown
  // connection still gets a row (the orphan won't help anyone hidden).
  const connection = await deps.connections.findById({
    environment: env.environment,
    connectionId: env.connectionId,
  });
  if (!connection) {
    await deps.errorStore.record({
      environment: env.environment,
      connectionId: env.connectionId,
      flow: 'order-import',
      dedupKey: dedupKey({
        environment: env.environment,
        connectionId: env.connectionId,
        entityType: 'order',
        sourceSystem: 'shopify',
        sourceId: env.orderGid,
      }),
      errorClass: 'unknown',
      message: `DLQ: connection '${env.connectionId}' not found for env '${env.environment}'`,
      envelope: env,
    });
    return {
      kind: 'unrecorded',
      reason: 'unknown_connection',
      detail: `connectionId=${env.connectionId}`,
    };
  }

  const dedup = dedupKey({
    environment: env.environment,
    connectionId: env.connectionId,
    entityType: 'order',
    sourceSystem: 'shopify',
    sourceId: env.orderGid,
  });

  // Try to surface delivery-count and the last error reason if Functions
  // bindings expose them (SB's DLQ messages carry `DeadLetterReason` and
  // `DeadLetterErrorDescription` application properties). Falls back to a
  // generic message when absent.
  const props =
    (context.triggerMetadata as { applicationProperties?: Record<string, unknown> })
      ?.applicationProperties ?? {};
  const dlqReason = String(props['DeadLetterReason'] ?? '');
  const dlqDetail = String(props['DeadLetterErrorDescription'] ?? '');
  const deliveryCount = Number(
    (context.triggerMetadata as { deliveryCount?: number })?.deliveryCount ?? 0,
  );

  const summary = dlqReason || dlqDetail
    ? `DLQ: ${dlqReason || 'unknown reason'}${dlqDetail ? ` — ${dlqDetail}` : ''}`
    : `DLQ: message exhausted SB redeliveries (deliveryCount=${deliveryCount}); cause not propagated by binding`;

  const row = await deps.errorStore.record({
    environment: env.environment,
    connectionId: env.connectionId,
    flow: 'order-import',
    dedupKey: dedup,
    errorClass: 'unknown',
    message: summary,
    envelope: env,
  });
  // Immediately flip to quarantined — DLQ means "SB has given up." Open
  // is reserved for the eventual non-DLQ failure path (a future slice will
  // wire that in).
  await deps.errorStore.updateStatus(row.id, 'quarantined');

  // M2-D — write a final attempt row so the timeline shows the quarantine.
  // The SB binding's deliveryCount on a DLQ message is the count when it
  // gave up (typically the `maxDeliveryCount`, e.g. 10). Best-effort: a
  // store outage here doesn't block the error-record write that already
  // succeeded.
  if (deps.orderAttemptStore && deliveryCount > 0) {
    const now = new Date();
    try {
      await deps.orderAttemptStore.record({
        environment: env.environment,
        connectionId: env.connectionId,
        shopifyOrderGid: env.orderGid,
        deliveryCount,
        outcome: 'quarantined',
        errorClass: 'unknown',
        detail: summary,
        ...(env.envelopeBlobUri && env.envelopeBlobUri.length > 0
          ? { inboundEnvelopeUri: env.envelopeBlobUri }
          : {}),
        startedAt: now,
        finishedAt: now,
        durationMs: 0,
      });
    } catch {
      // Swallow — error_records already has the quarantine row above.
    }
  }
  // Also bump the sync-log's denormalized attempt count if a row exists, so
  // `dpi recent` shows "tried 10x" on the quarantined order.
  if (deps.orderSyncLog && deliveryCount > 0) {
    try {
      const existing = await deps.orderSyncLog.findByOrderGid({
        environment: env.environment,
        connectionId: env.connectionId,
        shopifyOrderGid: env.orderGid,
      });
      if (existing) {
        const numericTail = /\/(\d+)$/.exec(env.orderGid)?.[1] ?? env.orderGid;
        await deps.orderSyncLog.upsert({
          environment: env.environment,
          connectionId: env.connectionId,
          shopifyOrderGid: env.orderGid,
          shopifyOrderId: numericTail,
          status: existing.status,
          attemptCount: deliveryCount,
          lastDeliveryCount: deliveryCount,
        });
      }
    } catch {
      // Swallow — best-effort denormalization.
    }
  }

  return { kind: 'recorded', errorId: row.id, dedup };
}

interface EnvelopeParseSuccess { readonly ok: true; readonly value: OrderWebhookMessage; }
interface EnvelopeParseFailure { readonly ok: false; readonly error: string; }

function parseEnvelope(raw: unknown): EnvelopeParseSuccess | EnvelopeParseFailure {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: `expected object, got ${typeof raw}` };
  }
  const m = raw as Record<string, unknown>;
  if (m['schemaVersion'] !== 1) {
    return { ok: false, error: `unsupported schemaVersion: ${String(m['schemaVersion'])}` };
  }
  for (const key of ['environment', 'connectionId', 'shopDomain', 'topic', 'orderGid'] as const) {
    if (typeof m[key] !== 'string' || (m[key] as string).length === 0) {
      return { ok: false, error: `missing/empty field '${key}'` };
    }
  }
  return { ok: true, value: m as unknown as OrderWebhookMessage };
}

export function registerOrderDlqHandler(getDeps: () => DlqHandlerDeps): void {
  // The Functions SB extension treats `<subscriptionName>/$DeadLetterQueue`
  // as the dead-letter sub-queue of the named subscription. Same topic name,
  // same connection string — only this path differs.
  app.serviceBusTopic('shopifyOrderDlqHandler', {
    topicName: 'orders-in',
    subscriptionName: 'order-import/$DeadLetterQueue',
    connection: 'SERVICE_BUS',
    handler: async (message: unknown, context: InvocationContext): Promise<void> => {
      const outcome = await handleDeadLetteredOrder(getDeps(), message, context);
      const tail =
        outcome.kind === 'recorded'
          ? `errorId=${outcome.errorId} dedup=${outcome.dedup}`
          : `reason=${outcome.reason} detail="${outcome.detail}"`;
      context.log(`orderDlqHandler outcome=${outcome.kind} ${tail}`);
    },
  });
}
