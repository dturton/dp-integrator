import {
  app,
  type InvocationContext,
} from '@azure/functions';
import type {
  Connection,
  ConnectionsRepo,
  DedupKeyParts,
  Environment,
  XrefStore,
} from '@dpi/core';
import type { LookupResolver, MapDeriveRegistry } from '@dpi/mapping-engine';
import {
  applyBalancing,
  applyTaxPayloadHeader,
  buildOrderPayload,
  defaultDeriveRegistry,
  netsuiteOrderRecordType,
  resolveItemReferences,
  strategyFor,
  type NetSuiteGateway,
  type NsOrderPayload,
} from '@dpi/netsuite-client';
import { OrderNotFoundError, type ShopifyGateway, type ShopifyOrder } from '@dpi/shopify-client';
import { checkEligibility, type EligibilityReason } from '@dpi/mapping-engine';
import {
  resolveCustomer,
  type CustomerResolution,
} from '../activities/customer-resolver.js';
import type { OrderWebhookMessage } from '../messages.js';

/**
 * M1 order-import handler. Slice D5 wires the full pipeline:
 *
 *   1. Parse + validate message envelope
 *   2. Resolve connection (reject env mismatch / unknown / disabled)
 *   3. xrefStore.claim — brief invariant 1 idempotency
 *      → already_synced / already_claimed / ignored: short-circuit
 *      → claimed: proceed
 *   4. shopify.getOrder — brief invariant 3 re-fetch
 *   5. checkEligibility — test/fraud/voided/pending/no-lines → markIgnored
 *   6. resolveCustomer — match or create on NS
 *   7. buildOrderPayload — mapping-engine evaluator + line-item / shipping
 *      derives (Slice D1). On park → recordFailure + outcome 'parked'.
 *   8. tax strategy (Slice D2): apply header tax fields to the payload
 *   9. applyBalancing (Slice D3) — ensure NS total reconciles to Shopify
 *      total within tolerance. On over-tolerance park → recordFailure +
 *      outcome 'parked'.
 *   10. ns.upsertByExternalId — write the SO / Cash Sale to NS keyed on the
 *       Shopify order GID. Idempotent on NS's side.
 *   11. xrefStore.recordSuccess — flip the row to status='synced' with the
 *       NS internal id.
 *
 * Throws from any I/O (Shopify, NS, Postgres) cause SB to redeliver up to
 * maxDeliveryCount=10, then DLQ. Redeliveries short-circuit on the claim
 * via 'already_claimed' (pending) or 'already_synced' (if recordSuccess
 * landed before the retry).
 */

export interface OrderHandlerDeps {
  readonly environment: Environment;
  readonly connections: ConnectionsRepo;
  readonly xrefStore: XrefStore;
  readonly shopify: ShopifyGateway;
  readonly ns: NetSuiteGateway;
  readonly guestCustomerInternalId: string;
  /** Per-handler lookups resolver (mapping engine). In prod: PostgresLookupResolver bound to the connection. */
  readonly lookupsFor: (connection: Connection) => LookupResolver;
  /** Optional derive registry override (defaults to the netsuite-client default). */
  readonly derives?: MapDeriveRegistry;
}

export type OrderHandlerOutcome =
  | { readonly kind: 'imported'; readonly connectionId: string; readonly orderGid: string; readonly targetId: string; readonly created: boolean; readonly customer: CustomerResolution }
  | { readonly kind: 'parked'; readonly connectionId: string; readonly orderGid: string; readonly stage: 'fetch' | 'mapping' | 'balancing' | 'item_resolution'; readonly detail: string }
  | { readonly kind: 'ignored_by_eligibility'; readonly connectionId: string; readonly orderGid: string; readonly reason: EligibilityReason; readonly detail?: string }
  | { readonly kind: 'already_synced'; readonly connectionId: string; readonly orderGid: string }
  | { readonly kind: 'already_claimed'; readonly connectionId: string; readonly orderGid: string }
  | { readonly kind: 'ignored'; readonly connectionId: string; readonly orderGid: string }
  | { readonly kind: 'rejected'; readonly reason: 'bad_message_shape' | 'unknown_connection' | 'env_mismatch'; readonly detail: string };

export async function handleOrderMessage(
  deps: OrderHandlerDeps,
  message: unknown,
): Promise<OrderHandlerOutcome> {
  // 1. Parse + validate
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

  // 2. Idempotency claim
  const dedupKey: DedupKeyParts = {
    environment: msg.environment,
    connectionId: connection.connectionId,
    entityType: 'order',
    sourceSystem: 'shopify',
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

  // 3. Re-fetch authoritative order
  let order: ShopifyOrder;
  try {
    order = await deps.shopify.getOrder(connection, msg.orderGid);
  } catch (err) {
    if (err instanceof OrderNotFoundError) {
      // Order was acknowledged at the receiver (HMAC valid, headers present)
      // but no longer exists in the store — most commonly a synthetic test
      // webhook or an order deleted before we got to import it. SB retries
      // would never recover, so park instead of throwing.
      await deps.xrefStore.recordFailure(dedupKey);
      return {
        kind: 'parked',
        connectionId: connection.connectionId,
        orderGid: msg.orderGid,
        stage: 'fetch',
        detail: err.message,
      };
    }
    throw err;
  }

  // 4. Eligibility predicate
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

  // 5. Customer match/create
  const customer = await resolveCustomer(
    { ns: deps.ns },
    connection,
    order.customer,
    { guestCustomerInternalId: deps.guestCustomerInternalId },
  );

  // 6. Build NS payload (mapping engine + derives)
  const lookups = deps.lookupsFor(connection);
  const payloadResult = await buildOrderPayload({
    connection,
    order,
    customerInternalId: customer.internalId,
    lookups,
    ...(deps.derives ? { derives: deps.derives } : { derives: defaultDeriveRegistry() }),
  });
  if (!payloadResult.ok) {
    await deps.xrefStore.recordFailure(dedupKey);
    return {
      kind: 'parked',
      connectionId: connection.connectionId,
      orderGid: msg.orderGid,
      stage: 'mapping',
      detail: payloadResult.parked.detail,
    };
  }
  const draft: NsOrderPayload = payloadResult.payload;

  // 7. Tax strategy → apply header tax fields to the draft payload
  const tax = strategyFor(connection).buildOrderTax(connection, order);
  // Note: we apply tax onto a *copy* so the draft object isn't mutated in
  // place — keeps the payload-builder output reusable across retries / tests.
  const taxApplied: NsOrderPayload = { ...draft };
  applyTaxPayloadHeader(taxApplied as Record<string, unknown>, tax);

  // 8. Balancing line
  const balanced = applyBalancing(taxApplied, order);
  if (!balanced.ok) {
    await deps.xrefStore.recordFailure(dedupKey);
    return {
      kind: 'parked',
      connectionId: connection.connectionId,
      orderGid: msg.orderGid,
      stage: 'balancing',
      detail: balanced.parked.detail,
    };
  }
  const balancedPayload = balanced.payload.payload;

  // 9. Item-id resolution — translate Shopify SKUs / shipping titles into
  //    NS internal ids via the gateway's cached SuiteQL lookup. Unmapped
  //    items park the order so operators can register the missing item in
  //    NS (or fix the source) instead of silently failing at NS write.
  const resolved = await resolveItemReferences(balancedPayload, deps.ns, connection.nsAccountId);
  if (!resolved.ok) {
    await deps.xrefStore.recordFailure(dedupKey);
    return {
      kind: 'parked',
      connectionId: connection.connectionId,
      orderGid: msg.orderGid,
      stage: 'item_resolution',
      detail: resolved.parked.detail,
    };
  }
  const finalPayload = resolved.payload;

  // 10. NS upsert keyed on Shopify order GID
  const recordType = netsuiteOrderRecordType(connection);
  const upserted = await deps.ns.upsertByExternalId({
    nsAccountId: connection.nsAccountId,
    recordType: recordType as Parameters<NetSuiteGateway['upsertByExternalId']>[0]['recordType'],
    externalId: msg.orderGid,
    payload: finalPayload as Record<string, unknown>,
  });

  // 10. recordSuccess → xref status = 'synced' with the NS internal id
  await deps.xrefStore.recordSuccess(dedupKey, upserted.internalId, msg.orderGid);

  return {
    kind: 'imported',
    connectionId: connection.connectionId,
    orderGid: msg.orderGid,
    targetId: upserted.internalId,
    created: upserted.created,
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
    case 'imported':
      return `connection=${o.connectionId} order=${o.orderGid} ns=${o.targetId} created=${o.created} customer=${o.customer.internalId}`;
    case 'parked':
      return `connection=${o.connectionId} order=${o.orderGid} stage=${o.stage} detail="${o.detail}"`;
    case 'ignored_by_eligibility':
      return `connection=${o.connectionId} order=${o.orderGid} reason=${o.reason}${o.detail ? ` detail="${o.detail}"` : ''}`;
    case 'rejected':
      return `reason=${o.reason} detail="${o.detail}"`;
    default:
      return `connection=${o.connectionId} order=${o.orderGid}`;
  }
}
