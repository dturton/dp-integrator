import {
  app,
  type InvocationContext,
} from '@azure/functions';
import type {
  Connection,
  ConnectionsRepo,
  Environment,
  XrefStore,
} from '@dpi/core';
import type { OrderWebhookMessage } from '../messages.js';

/**
 * Slice B handler: drains Service Bus messages and claims an `entity_xref`
 * row to lock the order against redelivery duplicates. Does NOT yet call
 * NetSuite — that's Slice C/D.
 *
 * Idempotency contract (brief invariant 1):
 *   - First delivery → claim() returns 'claimed' → handler proceeds (today: stub).
 *   - Redelivery of the same order → claim() returns 'already_synced' → no-op.
 *   - Concurrent delivery on a parallel session → claim() returns 'already_claimed'
 *     → no-op (other worker has it). Service Bus sessions actually prevent this
 *     for the same `{connectionId}:{orderGid}` key, but the claim is the
 *     definitive guard either way.
 *
 * On any throw, the SB host returns the message to the subscription with
 * incremented deliveryCount; after maxDeliveryCount (10 in our infra) it
 * dead-letters. Slice B handler doesn't throw — it logs + completes.
 */

export interface OrderHandlerDeps {
  readonly environment: Environment;
  readonly connections: ConnectionsRepo;
  readonly xrefStore: XrefStore;
}

export type OrderHandlerOutcome =
  | { readonly kind: 'claimed'; readonly connectionId: string; readonly orderGid: string }
  | { readonly kind: 'already_synced'; readonly connectionId: string; readonly orderGid: string }
  | { readonly kind: 'already_claimed'; readonly connectionId: string; readonly orderGid: string }
  | { readonly kind: 'ignored'; readonly connectionId: string; readonly orderGid: string }
  | { readonly kind: 'rejected'; readonly reason: 'bad_message_shape' | 'unknown_connection' | 'env_mismatch'; readonly detail: string };

export async function handleOrderMessage(
  deps: OrderHandlerDeps,
  message: unknown,
): Promise<OrderHandlerOutcome> {
  const parsed = parseOrderWebhookMessage(message);
  if (!parsed.ok) {
    return { kind: 'rejected', reason: 'bad_message_shape', detail: parsed.error };
  }
  const msg = parsed.value;

  if (msg.environment !== deps.environment) {
    return {
      kind: 'rejected',
      reason: 'env_mismatch',
      detail: `message env=${msg.environment}, handler env=${deps.environment}`,
    };
  }

  const connection = await deps.connections.findById({
    environment: msg.environment,
    connectionId: msg.connectionId,
  });
  if (!connection || !connection.enabled) {
    return {
      kind: 'rejected',
      reason: 'unknown_connection',
      detail: `connectionId=${msg.connectionId}`,
    };
  }

  const claim = await deps.xrefStore.claim({
    environment: msg.environment,
    connectionId: connection.connectionId,
    entityType: 'order',
    sourceSystem: 'shopify',
    sourceId: msg.orderGid,
    targetSystem: 'netsuite',
    targetExternal: msg.orderGid,
  });

  // Slice B stops at claim. Slice C will:
  //   - re-fetch the order from Shopify (per brief invariant 3)
  //   - run eligibility predicate
  //   - resolve customer
  //   - map → NS payload
  // Slice D will:
  //   - call NetSuiteGateway.upsertByExternalId
  //   - xrefStore.recordSuccess
  // For now we just return the claim outcome.
  return {
    kind: claim.outcome,
    connectionId: connection.connectionId,
    orderGid: msg.orderGid,
  };
}

interface ParseSuccess { readonly ok: true; readonly value: OrderWebhookMessage; }
interface ParseFailure { readonly ok: false; readonly error: string; }

function parseOrderWebhookMessage(raw: unknown): ParseSuccess | ParseFailure {
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, error: `expected object, got ${typeof raw}` };
  }
  const m = raw as Record<string, unknown>;
  if (m['schemaVersion'] !== 1) {
    return { ok: false, error: `unsupported schemaVersion: ${String(m['schemaVersion'])}` };
  }
  const requiredStrings = ['environment', 'connectionId', 'shopDomain', 'topic', 'orderGid', 'envelopeBlobUri', 'receivedAt'] as const;
  for (const key of requiredStrings) {
    const v = m[key];
    if (typeof v !== 'string' || v.length === 0) {
      return { ok: false, error: `missing/empty string field '${key}'` };
    }
  }
  return { ok: true, value: m as unknown as OrderWebhookMessage };
}

// Test hook — verifies our connection type isn't unused (TS prunes otherwise).
export function _connectionShapeCheck(c: Connection): string {
  return c.connectionId;
}

/**
 * Register the v4 Service Bus topic trigger. Session-enabled so per-(connection,
 * orderId) ordering is preserved across the queue. Uses identity-based binding
 * — Bicep grants the Function App MI `Service Bus Data Receiver` on the
 * namespace, and the `SERVICE_BUS__fullyQualifiedNamespace` app setting tells
 * the host which namespace to reach.
 */
export function registerOrderImportHandler(getDeps: () => OrderHandlerDeps): void {
  app.serviceBusTopic('shopifyOrderHandler', {
    topicName: 'orders-in',
    subscriptionName: 'order-import',
    connection: 'SERVICE_BUS',
    isSessionsEnabled: true,
    handler: async (message: unknown, context: InvocationContext): Promise<void> => {
      const sessionId = context.triggerMetadata?.['sessionId'] ?? '-';
      const deliveryCount = context.triggerMetadata?.['deliveryCount'] ?? '-';
      const outcome = await handleOrderMessage(getDeps(), message);
      context.log(
        `orderImportHandler outcome=${outcome.kind} ` +
          (outcome.kind === 'rejected'
            ? `reason=${outcome.reason} detail="${outcome.detail}" `
            : `connection=${outcome.connectionId} order=${outcome.orderGid} `) +
          `session=${String(sessionId)} delivery=${String(deliveryCount)}`,
      );
      // Returning normally completes the message. Throw to redeliver — we
      // intentionally don't throw on `rejected` because re-delivering a bad-
      // shape or env-mismatch message just spins. Slice C will surface those
      // via error_records + DLQ once the error store is wired.
    },
  });
}
