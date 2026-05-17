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
import type { NetSuiteGateway } from '@dpi/netsuite-client';
import type { ShopifyGateway, ShopifyOrder } from '@dpi/shopify-client';
import { checkEligibility, type EligibilityReason } from '@dpi/mapping-engine';
import {
  resolveCustomer,
  type CustomerResolution,
} from '../activities/customer-resolver.js';
import type { OrderWebhookMessage } from '../messages.js';

/**
 * M1 order-import handler. Per slice:
 *   - Slice B (shipped): xref-claim idempotency over Service Bus session
 *     trigger; stub everything past claim.
 *   - Slice C (this slice): re-fetch order from Shopify (brief invariant 3),
 *     run eligibility, resolve customer. NS write still deferred.
 *   - Slice D: build NS order payload (mapping engine + tax strategy +
 *     balancing line) and call NetSuiteGateway.upsertByExternalId, then
 *     xrefStore.recordSuccess.
 *
 * Behavior on errors:
 *   - Re-fetch / customer-resolve errors are RE-THROWN so the Service Bus
 *     host returns the message to the subscription for retry (up to
 *     maxDeliveryCount = 10, then dead-letter). The xref row stays `pending`
 *     between retries; redeliveries see `already_claimed` and short-circuit.
 *     M2 adds proper error_records routing + admin replay; for now, DLQ is
 *     the failure escape valve.
 */

export interface OrderHandlerDeps {
  readonly environment: Environment;
  readonly connections: ConnectionsRepo;
  readonly xrefStore: XrefStore;
  readonly shopify: ShopifyGateway;
  readonly ns: NetSuiteGateway;
  /** NS internal id used when a Shopify order has no customer (guest checkout). */
  readonly guestCustomerInternalId: string;
}

export type OrderHandlerOutcome =
  | { readonly kind: 'claimed_pending_ns'; readonly connectionId: string; readonly orderGid: string; readonly customer: CustomerResolution }
  | { readonly kind: 'ignored_by_eligibility'; readonly connectionId: string; readonly orderGid: string; readonly reason: EligibilityReason; readonly detail?: string }
  | { readonly kind: 'already_synced'; readonly connectionId: string; readonly orderGid: string }
  | { readonly kind: 'already_claimed'; readonly connectionId: string; readonly orderGid: string }
  | { readonly kind: 'ignored'; readonly connectionId: string; readonly orderGid: string }
  | { readonly kind: 'rejected'; readonly reason: 'bad_message_shape' | 'unknown_connection' | 'env_mismatch'; readonly detail: string };

export async function handleOrderMessage(
  deps: OrderHandlerDeps,
  message: unknown,
): Promise<OrderHandlerOutcome> {
  // 1. Parse + validate the message envelope.
  const parsed = parseOrderWebhookMessage(message);
  if (!parsed.ok) return { kind: 'rejected', reason: 'bad_message_shape', detail: parsed.error };
  const msg = parsed.value;

  if (msg.environment !== deps.environment) {
    return { kind: 'rejected', reason: 'env_mismatch', detail: `message env=${msg.environment}, handler env=${deps.environment}` };
  }

  const connection = await deps.connections.findById({
    environment: msg.environment,
    connectionId: msg.connectionId,
  });
  if (!connection || !connection.enabled) {
    return { kind: 'rejected', reason: 'unknown_connection', detail: `connectionId=${msg.connectionId}` };
  }

  // 2. Idempotency claim (brief invariant 1). PostgresXrefStore PK serializes
  // concurrent claims across instances — exactly one wins per dedup key.
  const dedupKey = {
    environment: msg.environment,
    connectionId: connection.connectionId,
    entityType: 'order' as const,
    sourceSystem: 'shopify' as const,
    sourceId: msg.orderGid,
  };
  const claim = await deps.xrefStore.claim({
    ...dedupKey,
    targetSystem: 'netsuite',
    targetExternal: msg.orderGid,
  });

  if (claim.outcome === 'already_synced') {
    return { kind: 'already_synced', connectionId: connection.connectionId, orderGid: msg.orderGid };
  }
  if (claim.outcome === 'already_claimed') {
    return { kind: 'already_claimed', connectionId: connection.connectionId, orderGid: msg.orderGid };
  }
  if (claim.outcome === 'ignored') {
    return { kind: 'ignored', connectionId: connection.connectionId, orderGid: msg.orderGid };
  }
  // claim.outcome === 'claimed' — proceed.

  // 3. Re-fetch authoritative order from Shopify (brief invariant 3 —
  // never trust the webhook body for downstream mapping).
  const order: ShopifyOrder = await deps.shopify.getOrder(connection, msg.orderGid);

  // 4. Eligibility predicate. Ineligible → mark ignored + ack.
  const elig = checkEligibility(order, msg.topic);
  if (!elig.eligible) {
    await deps.xrefStore.markIgnored(dedupKey);
    return {
      kind: 'ignored_by_eligibility',
      connectionId: connection.connectionId,
      orderGid: msg.orderGid,
      reason: elig.reason,
      ...(elig.detail ? { detail: elig.detail } : {}),
    };
  }

  // 5. Resolve customer (match-or-create on NS).
  const customer = await resolveCustomer(
    { ns: deps.ns },
    connection,
    order.customer,
    { guestCustomerInternalId: deps.guestCustomerInternalId },
  );

  // Slice D will:
  //   - map the order via the mapping engine + tax strategy + balancing line
  //   - call deps.ns.upsertByExternalId for the SO / Cash Sale record
  //   - deps.xrefStore.recordSuccess(dedupKey, targetId, msg.orderGid)
  // For Slice C, we stop here. The xref row stays `pending` until Slice D
  // ships — redeliveries are no-ops via the already_claimed branch above.
  return {
    kind: 'claimed_pending_ns',
    connectionId: connection.connectionId,
    orderGid: msg.orderGid,
    customer,
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

// Verifies our Connection type isn't unused (TS would prune the import otherwise).
export function _connectionShapeCheck(c: Connection): string {
  return c.connectionId;
}

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
      const summary = describeOutcome(outcome);
      context.log(
        `orderImportHandler outcome=${outcome.kind} ${summary} session=${String(sessionId)} delivery=${String(deliveryCount)}`,
      );
    },
  });
}

function describeOutcome(o: OrderHandlerOutcome): string {
  switch (o.kind) {
    case 'rejected':
      return `reason=${o.reason} detail="${o.detail}"`;
    case 'ignored_by_eligibility':
      return `connection=${o.connectionId} order=${o.orderGid} reason=${o.reason}${o.detail ? ` detail="${o.detail}"` : ''}`;
    case 'claimed_pending_ns':
      return `connection=${o.connectionId} order=${o.orderGid} customer=${o.customer.internalId} guest=${o.customer.isGuest}`;
    default:
      return `connection=${o.connectionId} order=${o.orderGid}`;
  }
}
