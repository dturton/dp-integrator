import {
  app,
  type InvocationContext,
} from '@azure/functions';
import {
  dedupKey as dedupKeyString,
  type Connection,
  type ConnectionsRepo,
  type DedupKeyParts,
  type Environment,
  type ErrorClass,
  type ErrorStore,
  type OrderAttemptInput,
  type OrderAttemptOutcome,
  type OrderAttemptStore,
  type OrderSyncLogInput,
  type OrderSyncLogStore,
  type PayloadStore,
  type XrefStore,
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
import { classifyHandlerError, shouldRetry } from './error-classification.js';
import type { Telemetry } from '../telemetry.js';
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
  /**
   * M2-C: when present, every park / transient throw also writes an
   * `error_records` row so failures surface on the admin console — not just
   * the xref status. Optional so test deps can omit it; bootstrap supplies
   * `PostgresErrorStore` when PG is wired.
   */
  readonly errorStore?: ErrorStore;
  /**
   * Per-order ledger (one row per terminal outcome — imported / parked /
   * ignored_by_eligibility). Carries a snapshot of Shopify totals + NS link
   * + park reason so `dpi recent` and reconciliation reports don't need to
   * re-fetch from either system.
   */
  readonly orderSyncLog?: OrderSyncLogStore;
  /**
   * Per-Service-Bus-delivery audit trail (slice M2-D). When wired the handler
   * emits one row per delivery — including short-circuit redeliveries
   * (`already_synced` / `already_claimed`) so the timeline explains every
   * SB callback. Optional so tests / pre-D bootstraps omit it.
   */
  readonly orderAttemptStore?: OrderAttemptStore;
  /**
   * Outbound NS-payload archive (slice M2-D). When wired, the final
   * NS-bound JSON is written to blob storage just before the upsert call
   * and the returned URI is stamped onto the attempt row's
   * `outbound_payload_uri`. Blob-write failures are swallowed — debug fuel
   * must never block the NS upsert.
   */
  readonly outboundPayloadStore?: PayloadStore;
  /**
   * App Insights telemetry surface. Counts imports / parks / ignored,
   * tracks time-to-NS, and emits `dpi.auth_error` customEvents so Azure
   * Monitor alerts can fire on credential failures. Optional — tests use
   * the no-op stub from `getTelemetry()`.
   */
  readonly telemetry?: Telemetry;
}

/**
 * Service-Bus-delivery context the runtime threads in (slice M2-D). The
 * handler uses it to stamp `delivery_count` + timing onto the attempt row
 * and to partition outbound-payload blobs by attempt number.
 */
export interface AttemptContext {
  readonly deliveryCount: number;
  readonly sbMessageId?: string;
  readonly sbSessionId?: string;
  readonly startedAt: Date;
}

export type OrderHandlerOutcome =
  | { readonly kind: 'imported'; readonly connectionId: string; readonly orderGid: string; readonly targetId: string; readonly created: boolean; readonly customer: CustomerResolution }
  | { readonly kind: 'parked'; readonly connectionId: string; readonly orderGid: string; readonly stage: 'fetch' | 'mapping' | 'balancing' | 'item_resolution' | 'external_call'; readonly detail: string; readonly errorClass?: ErrorClass }
  | { readonly kind: 'ignored_by_eligibility'; readonly connectionId: string; readonly orderGid: string; readonly reason: EligibilityReason; readonly detail?: string }
  | { readonly kind: 'already_synced'; readonly connectionId: string; readonly orderGid: string }
  | { readonly kind: 'already_claimed'; readonly connectionId: string; readonly orderGid: string }
  | { readonly kind: 'ignored'; readonly connectionId: string; readonly orderGid: string }
  | { readonly kind: 'rejected'; readonly reason: 'bad_message_shape' | 'unknown_connection' | 'env_mismatch'; readonly detail: string };

export async function handleOrderMessage(
  deps: OrderHandlerDeps,
  message: unknown,
  attemptCtx?: AttemptContext,
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

  // Short-circuit redeliveries still get an attempt row — operators looking at
  // the timeline want to see "delivery 2 happened, did nothing because already
  // synced." Cheap and disambiguates webhook duplicate floods from real
  // retries.
  if (claim.outcome === 'already_synced') {
    const o: OrderHandlerOutcome = { kind: 'already_synced', connectionId: connection.connectionId, orderGid: msg.orderGid };
    await recordAttempt(deps, attemptCtx, msg, connection, o, undefined, undefined, undefined, undefined, undefined);
    return o;
  }
  if (claim.outcome === 'already_claimed') {
    const o: OrderHandlerOutcome = { kind: 'already_claimed', connectionId: connection.connectionId, orderGid: msg.orderGid };
    await recordAttempt(deps, attemptCtx, msg, connection, o, undefined, undefined, undefined, undefined, undefined);
    return o;
  }
  if (claim.outcome === 'ignored') {
    const o: OrderHandlerOutcome = { kind: 'ignored', connectionId: connection.connectionId, orderGid: msg.orderGid };
    await recordAttempt(deps, attemptCtx, msg, connection, o, undefined, undefined, undefined, undefined, undefined);
    return o;
  }
  // claim.outcome === 'claimed' — proceed. Everything from here on is wrapped
  // in classifyAndPark below so that unhandled throws are routed through the
  // brief's transient/data/auth/unknown taxonomy (Slice M2-C) instead of all
  // collapsing into SB redelivery loops.
  //
  // `order` lives outside the try so the catch's classifier can snapshot it
  // into the sync log when the throw happened after getOrder returned.
  //
  // M2-D: the post-claim body is wrapped in a try/finally so every terminal
  // path (return *or* re-throw via classifyAndRoute) writes exactly one
  // `order_attempt` row. `outcome` is set as each return path resolves;
  // `throwErr` captures the rethrown error for transient/auth paths.
  let order: ShopifyOrder | undefined;
  let outcome: OrderHandlerOutcome | undefined;
  let throwErr: unknown;
  let outboundPayloadUri: string | undefined;
  let nsResponseUri: string | undefined;
  let nsResponseStatus: number | undefined;
  let payloadDigest: Record<string, unknown> | undefined;
  const finish = (o: OrderHandlerOutcome): OrderHandlerOutcome => (outcome = o);
  try {
    // 3. Re-fetch authoritative order
    order = await deps.shopify.getOrder(connection, msg.orderGid);

    // 4. Eligibility predicate
    const elig = checkEligibility(order, msg.topic);
    if (!elig.eligible) {
      await deps.xrefStore.markIgnored(dedupKey);
      await writeSyncLog(deps, connection, msg, {
        status: 'ignored',
        order,
        ignoredReason: elig.reason,
        attemptCtx,
      });
      deps.telemetry?.trackIgnored({
        environment: msg.environment,
        connectionId: connection.connectionId,
        reason: elig.reason,
      });
      return finish({
        kind: 'ignored_by_eligibility',
        connectionId: connection.connectionId,
        orderGid: msg.orderGid,
        reason: elig.reason,
        ...(elig.detail ? { detail: elig.detail } : {}),
      });
    }

    // 5. Customer match/create. Pass the order's billing/shipping addresses
    //    through so the resolver writes them back to the NS customer record's
    //    addressbook (slice D9 — overwrite semantics per the connection
    //    choice; same address on both sides collapses to one entry).
    const customer = await resolveCustomer(
      { ns: deps.ns },
      connection,
      order.customer,
      { guestCustomerInternalId: deps.guestCustomerInternalId },
      {
        ...(order.billingAddress ? { billing: order.billingAddress } : {}),
        ...(order.shippingAddress ? { shipping: order.shippingAddress } : {}),
      },
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
      return finish(await parkOutcome(deps, dedupKey, connection, msg, {
        stage: 'mapping',
        detail: payloadResult.parked.detail,
        errorClass: 'unmapped_construct',
        order,
        attemptCtx,
      }));
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
      return finish(await parkOutcome(deps, dedupKey, connection, msg, {
        stage: 'balancing',
        detail: balanced.parked.detail,
        errorClass: 'data',
        order,
        attemptCtx,
      }));
    }
    const balancedPayload = balanced.payload.payload;

    // 9. Item-id resolution — translate Shopify SKUs / shipping titles into
    //    NS internal ids via the gateway's cached SuiteQL lookup. Unmapped
    //    items park the order so operators can register the missing item in
    //    NS (or fix the source) instead of silently failing at NS write.
    const resolved = await resolveItemReferences(balancedPayload, deps.ns, connection.nsAccountId, {
      ...(connection.defaultItemId !== undefined
        ? { fallbackItemInternalId: connection.defaultItemId }
        : {}),
    });
    if (!resolved.ok) {
      return finish(await parkOutcome(deps, dedupKey, connection, msg, {
        stage: 'item_resolution',
        detail: resolved.parked.detail,
        errorClass: 'unmapped_construct',
        order,
        attemptCtx,
      }));
    }
    const finalPayload = resolved.payload;

    // 9b (M2-D). Archive the outbound NS payload + build the inline digest
    // BEFORE the upsert so the artifact survives even if NS subsequently
    // throws. Blob put failures are swallowed — debug fuel must never block
    // the source-of-truth write.
    const recordType = netsuiteOrderRecordType(connection);
    if (deps.outboundPayloadStore && attemptCtx) {
      outboundPayloadUri = await deps.outboundPayloadStore
        .put(finalPayload as Record<string, unknown>, {
          environment: msg.environment,
          connectionId: connection.connectionId,
          shopifyOrderGid: msg.orderGid,
          deliveryCount: attemptCtx.deliveryCount,
          nsAccountId: connection.nsAccountId,
          nsRecordType: recordType,
          attemptStartedAt: attemptCtx.startedAt,
        })
        .catch(() => undefined);
    }
    payloadDigest = buildPayloadDigest(finalPayload as Record<string, unknown>);

    // 10. NS upsert keyed on Shopify order GID
    const upserted = await deps.ns.upsertByExternalId({
      nsAccountId: connection.nsAccountId,
      recordType: recordType as Parameters<NetSuiteGateway['upsertByExternalId']>[0]['recordType'],
      externalId: msg.orderGid,
      payload: finalPayload as Record<string, unknown>,
    });

    // 10b. Archive the raw NS response so the admin UI can show it (body is
    // typically empty for 204 No Content; metadata + Location header are
    // still useful evidence of what NS returned). Same best-effort pattern
    // as the outbound archive — never block the SB ack on debug fuel.
    if (upserted.rawResponse !== undefined) {
      nsResponseStatus = upserted.rawResponse.status;
      if (deps.outboundPayloadStore && attemptCtx) {
        nsResponseUri = await deps.outboundPayloadStore
          .put(upserted.rawResponse as unknown as Record<string, unknown>, {
            environment: msg.environment,
            connectionId: connection.connectionId,
            shopifyOrderGid: msg.orderGid,
            deliveryCount: attemptCtx.deliveryCount,
            nsAccountId: connection.nsAccountId,
            nsRecordType: recordType,
            attemptStartedAt: attemptCtx.startedAt,
            kind: 'ns_response',
          })
          .catch(() => undefined);
      }
    }

    // 11. recordSuccess → xref status = 'synced' with the NS internal id
    await deps.xrefStore.recordSuccess(dedupKey, upserted.internalId, msg.orderGid);

    // 11a. Telemetry — count this import and record claim→ns latency so
    //      dashboards (and SLOs) can be built without KQL-parsing the
    //      handler log line. Time delta is measured from the SB delivery
    //      start when available, falls back to now otherwise.
    const now = new Date();
    const durationMs = attemptCtx
      ? Math.max(0, now.getTime() - attemptCtx.startedAt.getTime())
      : 0;
    deps.telemetry?.trackImport({
      environment: msg.environment,
      connectionId: connection.connectionId,
      durationMs,
    });

    // 11b. Sync-log row: the per-order ledger for `dpi recent` /
    //      reconciliation. Snapshot the Shopify totals + NS link so we
    //      don't have to re-fetch from either system later.
    await writeSyncLog(deps, connection, msg, {
      status: 'imported',
      order,
      nsAccountId: connection.nsAccountId,
      nsRecordType: recordType,
      nsInternalId: upserted.internalId,
      syncedAt: now,
      attemptCtx,
      lastOutboundPayloadUri: outboundPayloadUri,
    });

    // 12. (slice E2) Optional NS→Shopify write-back: tag the Shopify order
    //     with the NS internal id so storefront-side ops can see which
    //     orders have been imported. Gated per-connection because it's a
    //     scope-bumping write surface; brief v1 is otherwise read-only on
    //     Shopify.
    //
    //     A failure here does NOT roll back the import — the xref is
    //     already 'synced' and NS holds the source of truth. We record to
    //     error_records as a low-severity data-class so ops can replay
    //     just the tagging step later.
    if (connection.writeTagsOnImport === true) {
      const tag = `netsuite-${upserted.internalId}`;
      try {
        await deps.shopify.tagOrder(connection, msg.orderGid, [tag]);
      } catch (tagErr) {
        if (deps.errorStore) {
          await deps.errorStore.record({
            environment: msg.environment,
            connectionId: connection.connectionId,
            flow: 'order-tag-writeback',
            dedupKey: dedupKeyString(dedupKey),
            errorClass: classifyHandlerError(tagErr),
            message:
              `tagOrder('${tag}') failed for ${msg.orderGid}: ` +
              (tagErr instanceof Error ? tagErr.message : String(tagErr)),
            ...(tagErr instanceof Error && tagErr.stack !== undefined ? { stack: tagErr.stack } : {}),
            envelope: { orderGid: msg.orderGid, tag, targetId: upserted.internalId },
          });
        }
        // Swallow — the import succeeded, the tag is opportunistic.
      }
    }

    return finish({
      kind: 'imported',
      connectionId: connection.connectionId,
      orderGid: msg.orderGid,
      targetId: upserted.internalId,
      created: upserted.created,
      customer,
    });
  } catch (err) {
    // If NS handed us a structured error body (decorateNsError attached it
    // as `rawNsResponse`), archive it before the classifier decides what to
    // do with the throw. NS error bodies are the most-debug-valuable artifact
    // a parked order can carry — preserving them verbatim avoids the
    // truncation that `park_detail` applies to fit the column width.
    const rawNs = (err as { rawNsResponse?: { status?: number; body?: unknown } }).rawNsResponse;
    if (rawNs) {
      if (rawNs.status !== undefined) nsResponseStatus = rawNs.status;
      if (deps.outboundPayloadStore && attemptCtx) {
        nsResponseUri = await deps.outboundPayloadStore
          .put(rawNs as unknown as Record<string, unknown>, {
            environment: msg.environment,
            connectionId: connection.connectionId,
            shopifyOrderGid: msg.orderGid,
            deliveryCount: attemptCtx.deliveryCount,
            nsAccountId: connection.nsAccountId,
            attemptStartedAt: attemptCtx.startedAt,
            kind: 'ns_response',
          })
          .catch(() => undefined);
      }
    }
    try {
      return finish(await classifyAndRoute(deps, dedupKey, connection, msg, err, order, attemptCtx));
    } catch (rethrown) {
      throwErr = rethrown;
      throw rethrown;
    }
  } finally {
    await recordAttempt(
      deps,
      attemptCtx,
      msg,
      connection,
      outcome,
      throwErr,
      outboundPayloadUri,
      payloadDigest,
      nsResponseUri,
      nsResponseStatus,
    );
  }
}

/**
 * M2-C error classification: route any thrown error from the post-claim
 * pipeline through the transient / data / auth / unknown taxonomy.
 *
 *   - `data` / `unmapped_construct` / `unknown` → park gracefully (xref
 *     status='error', error_records row written, parked outcome returned).
 *     SB acks; no retry loop on a permanent failure.
 *   - `auth` → write an error_records row tagged errorClass='auth' so the
 *     ops surface notices, then re-throw so SB retries (a creds rotation
 *     between attempts can recover; alerting is a later slice).
 *   - `transient` → re-throw without recording (SB's redelivery is the
 *     normal recovery path; if it exhausts maxDeliveryCount the DLQ
 *     handler from M2-B records the quarantine row).
 *
 * `OrderNotFoundError` flows through `classifyHandlerError` as 'data' and
 * is parked with the explicit `stage='fetch'` so operators can see why it
 * stopped — preserving the signal Slice E1 introduced.
 */
async function classifyAndRoute(
  deps: OrderHandlerDeps,
  dedupKey: DedupKeyParts,
  connection: Connection,
  msg: OrderWebhookMessage,
  err: unknown,
  order: ShopifyOrder | undefined,
  attemptCtx: AttemptContext | undefined,
): Promise<OrderHandlerOutcome> {
  const errorClass = classifyHandlerError(err);
  const detail = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;

  if (shouldRetry(errorClass)) {
    // Transient or auth — still record auth so it surfaces on the error
    // console (auth being silent-retried is a footgun the brief warns
    // against). Skip recording for transient because every SB redelivery
    // would otherwise multiply rows; the DLQ trigger M2-B catches the
    // permanently-stuck case.
    if (errorClass === 'auth') {
      if (deps.errorStore) {
        await deps.errorStore.record({
          environment: msg.environment,
          connectionId: connection.connectionId,
          flow: 'order-import',
          dedupKey: dedupKeyString(dedupKey),
          errorClass,
          message: detail,
          ...(stack !== undefined ? { stack } : {}),
          envelope: msg,
        });
      }
      // Distinct customEvent (not just a metric) so Azure Monitor alert
      // rules can fire on the event stream — every auth failure should
      // page someone, regardless of how often they happen.
      deps.telemetry?.trackAuthError({
        environment: msg.environment,
        connectionId: connection.connectionId,
        flow: 'order-import',
        message: detail,
      });
    }
    throw err;
  }

  // Park: data / unmapped_construct / unknown.
  const stage = err instanceof OrderNotFoundError ? 'fetch' : 'external_call';
  return parkOutcome(deps, dedupKey, connection, msg, {
    stage,
    detail,
    errorClass,
    ...(stack !== undefined ? { stack } : {}),
    ...(order !== undefined ? { order } : {}),
    attemptCtx,
  });
}

interface ParkInput {
  readonly stage: 'fetch' | 'mapping' | 'balancing' | 'item_resolution' | 'external_call';
  readonly detail: string;
  readonly errorClass: ErrorClass;
  readonly stack?: string;
  /** Available when the throw / mapping-park happened after getOrder; absent for the OrderNotFoundError + pre-fetch paths. */
  readonly order?: ShopifyOrder;
  /** Carries SB-delivery telemetry through to the sync log (M2-D). */
  readonly attemptCtx?: AttemptContext;
}

/**
 * Mark the xref as error AND (when wired) write an error_records row so the
 * failure surfaces on the admin console. Shared by all park paths — the
 * inline mapping/balancing/item_resolution parks and the catch-all
 * classifier path.
 */
async function parkOutcome(
  deps: OrderHandlerDeps,
  dedupKey: DedupKeyParts,
  connection: Connection,
  msg: OrderWebhookMessage,
  park: ParkInput,
): Promise<OrderHandlerOutcome> {
  await deps.xrefStore.recordFailure(dedupKey);
  if (deps.errorStore) {
    await deps.errorStore.record({
      environment: msg.environment,
      connectionId: connection.connectionId,
      flow: 'order-import',
      dedupKey: dedupKeyString(dedupKey),
      errorClass: park.errorClass,
      message: `[${park.stage}] ${park.detail}`,
      ...(park.stack !== undefined ? { stack: park.stack } : {}),
      envelope: msg,
    });
  }
  // Park metric — all five park paths route through here, so this is the
  // single emit site. Stage + errorClass land on the metric's properties
  // so dashboards can split by failure mode.
  deps.telemetry?.trackPark({
    environment: msg.environment,
    connectionId: connection.connectionId,
    stage: park.stage,
    errorClass: park.errorClass,
  });
  await writeSyncLog(deps, connection, msg, {
    status: 'parked',
    ...(park.order !== undefined ? { order: park.order } : {}),
    parkStage: park.stage,
    parkDetail: park.detail,
    parkErrorClass: park.errorClass,
    ...(park.attemptCtx !== undefined ? { attemptCtx: park.attemptCtx } : {}),
  });
  return {
    kind: 'parked',
    connectionId: connection.connectionId,
    orderGid: msg.orderGid,
    stage: park.stage,
    detail: park.detail,
    errorClass: park.errorClass,
  };
}

/**
 * Compose the per-order ledger row for `orderSyncLog`. `order` is optional —
 * absent only on the pre-fetch parked paths (OrderNotFoundError /
 * unparseable message reach the handler). When absent we still emit the
 * minimal row keyed on the GID so reconciliation never silently loses an
 * order.
 */
interface SyncLogShape {
  readonly status: 'imported' | 'parked' | 'ignored';
  readonly order?: ShopifyOrder;
  readonly nsAccountId?: string;
  readonly nsRecordType?: 'salesorder' | 'cashsale';
  readonly nsInternalId?: string;
  readonly nsTranId?: string;
  readonly syncedAt?: Date;
  readonly parkStage?: string;
  readonly parkDetail?: string;
  readonly parkErrorClass?: string;
  readonly ignoredReason?: string;
  /** M2-D — drives the new attempt-count + last-* URI denormalization on order_sync_log. */
  readonly attemptCtx?: AttemptContext;
  /** Last outbound NS payload blob URI for this delivery, if archived. */
  readonly lastOutboundPayloadUri?: string;
}

async function writeSyncLog(
  deps: OrderHandlerDeps,
  connection: Connection,
  msg: OrderWebhookMessage,
  shape: SyncLogShape,
): Promise<void> {
  if (!deps.orderSyncLog) return;
  const o = shape.order;
  const numericTail = /\/(\d+)$/.exec(msg.orderGid)?.[1] ?? msg.orderGid;
  const input: OrderSyncLogInput = {
    environment: msg.environment,
    connectionId: connection.connectionId,
    shopifyOrderGid: msg.orderGid,
    shopifyOrderId: numericTail,
    status: shape.status,
    ...(o?.name !== undefined ? { shopifyOrderName: o.name } : {}),
    ...(o?.createdAt !== undefined ? { shopifyCreatedAt: new Date(o.createdAt) } : {}),
    ...(o?.processedAt !== undefined ? { shopifyProcessedAt: new Date(o.processedAt) } : {}),
    ...(o?.updatedAt !== undefined ? { shopifyUpdatedAt: new Date(o.updatedAt) } : {}),
    ...(o?.customer?.email !== undefined ? { customerEmail: o.customer.email } : {}),
    ...(o?.currencyCode !== undefined ? { currencyCode: o.currencyCode } : {}),
    ...(o?.totalPrice?.amount !== undefined ? { totalPrice: o.totalPrice.amount } : {}),
    ...(o?.subtotalPrice?.amount !== undefined ? { subtotalPrice: o.subtotalPrice.amount } : {}),
    ...(o?.totalTax?.amount !== undefined ? { totalTax: o.totalTax.amount } : {}),
    ...(o?.totalDiscounts?.amount !== undefined ? { totalDiscounts: o.totalDiscounts.amount } : {}),
    ...(o?.totalShippingPrice?.amount !== undefined ? { totalShipping: o.totalShippingPrice.amount } : {}),
    ...(shape.nsAccountId !== undefined ? { nsAccountId: shape.nsAccountId } : {}),
    ...(shape.nsRecordType !== undefined ? { nsRecordType: shape.nsRecordType } : {}),
    ...(shape.nsInternalId !== undefined ? { nsInternalId: shape.nsInternalId } : {}),
    ...(shape.nsTranId !== undefined ? { nsTranId: shape.nsTranId } : {}),
    ...(shape.syncedAt !== undefined ? { syncedAt: shape.syncedAt } : {}),
    ...(shape.parkStage !== undefined ? { parkStage: shape.parkStage } : {}),
    ...(shape.parkDetail !== undefined ? { parkDetail: shape.parkDetail } : {}),
    ...(shape.parkErrorClass !== undefined ? { parkErrorClass: shape.parkErrorClass } : {}),
    ...(shape.ignoredReason !== undefined ? { ignoredReason: shape.ignoredReason } : {}),
    ...(shape.attemptCtx !== undefined ? {
      attemptCount: shape.attemptCtx.deliveryCount,
      lastDeliveryCount: shape.attemptCtx.deliveryCount,
    } : {}),
    ...(shape.lastOutboundPayloadUri !== undefined ? { lastOutboundPayloadUri: shape.lastOutboundPayloadUri } : {}),
    ...(msg.envelopeBlobUri !== undefined && msg.envelopeBlobUri.length > 0
      ? { lastInboundEnvelopeUri: msg.envelopeBlobUri }
      : {}),
  };
  await deps.orderSyncLog.upsert(input);
}

/**
 * M2-D — write one row per Service Bus delivery into `order_attempt`. Called
 * from every terminal path in `handleOrderMessage`:
 *
 *   - Short-circuits (already_synced / already_claimed / ignored): inline at
 *     the claim branches.
 *   - Post-claim happy path / inline parks / classified parks / re-thrown
 *     transient or auth errors: via the outer `try/finally` in
 *     `handleOrderMessage`.
 *
 * `attemptCtx` absent → no-op (pre-D bootstraps / tests that don't pass it).
 * Store-write failures are swallowed and logged (best-effort observability;
 * must not block the SB ack / NS write path).
 */
async function recordAttempt(
  deps: OrderHandlerDeps,
  attemptCtx: AttemptContext | undefined,
  msg: OrderWebhookMessage,
  connection: Connection,
  outcome: OrderHandlerOutcome | undefined,
  throwErr: unknown,
  outboundPayloadUri: string | undefined,
  payloadDigest: Record<string, unknown> | undefined,
  nsResponseUri: string | undefined,
  nsResponseStatus: number | undefined,
): Promise<void> {
  if (!deps.orderAttemptStore || !attemptCtx) return;
  const finishedAt = new Date();
  const durationMs = Math.max(0, finishedAt.getTime() - attemptCtx.startedAt.getTime());
  const resolved = resolveAttemptOutcome(outcome, throwErr);
  const input: OrderAttemptInput = {
    environment: msg.environment,
    connectionId: connection.connectionId,
    shopifyOrderGid: msg.orderGid,
    deliveryCount: attemptCtx.deliveryCount,
    ...(attemptCtx.sbMessageId ? { sbMessageId: attemptCtx.sbMessageId } : {}),
    ...(attemptCtx.sbSessionId ? { sbSessionId: attemptCtx.sbSessionId } : {}),
    outcome: resolved.outcome,
    ...(resolved.stage ? { stage: resolved.stage } : {}),
    ...(resolved.errorClass ? { errorClass: resolved.errorClass } : {}),
    ...(resolved.detail ? { detail: resolved.detail } : {}),
    ...(msg.envelopeBlobUri && msg.envelopeBlobUri.length > 0
      ? { inboundEnvelopeUri: msg.envelopeBlobUri }
      : {}),
    ...(outboundPayloadUri ? { outboundPayloadUri } : {}),
    ...(nsResponseUri ? { nsResponseUri } : {}),
    ...(nsResponseStatus !== undefined ? { nsResponseStatus } : {}),
    ...(payloadDigest ? { payloadDigest } : {}),
    startedAt: attemptCtx.startedAt,
    finishedAt,
    durationMs,
  };
  try {
    await deps.orderAttemptStore.record(input);
  } catch {
    // Best-effort: an attempt-store outage must not block the handler's
    // SB-ack path. The DLQ handler still catches permanent failures.
  }
}

function resolveAttemptOutcome(
  outcome: OrderHandlerOutcome | undefined,
  throwErr: unknown,
): { outcome: OrderAttemptOutcome; stage?: string; errorClass?: string; detail?: string } {
  if (throwErr !== undefined) {
    const errorClass = classifyHandlerError(throwErr);
    return {
      outcome: errorClass === 'auth' ? 'auth_throw' : 'transient_throw',
      errorClass,
      detail: throwErr instanceof Error ? throwErr.message : String(throwErr),
    };
  }
  if (!outcome) {
    // Defensive: should be unreachable since outcome is set on every return.
    return { outcome: 'transient_throw', detail: 'no outcome captured' };
  }
  switch (outcome.kind) {
    case 'imported':
      return { outcome: 'imported' };
    case 'parked':
      return {
        outcome: 'parked',
        stage: outcome.stage,
        ...(outcome.errorClass ? { errorClass: outcome.errorClass } : {}),
        detail: outcome.detail,
      };
    case 'ignored_by_eligibility':
      return {
        outcome: 'ignored_by_eligibility',
        detail: outcome.detail ? `${outcome.reason}: ${outcome.detail}` : outcome.reason,
      };
    case 'already_synced':
      return { outcome: 'already_synced' };
    case 'already_claimed':
      return { outcome: 'already_claimed' };
    case 'ignored':
      return { outcome: 'ignored' };
    case 'rejected':
      return { outcome: 'rejected', errorClass: outcome.reason, detail: outcome.detail };
  }
}

/**
 * Small inline preview of the outbound NS payload — what the future admin
 * UI shows on the attempt-detail page before the operator clicks through
 * to fetch the full blob. Header refs are objects like `{ id: '<value>' }`
 * after `wrapNsReferences`; flatten to plain ids for readability.
 */
function buildPayloadDigest(p: Record<string, unknown>): Record<string, unknown> {
  const refId = (v: unknown): unknown =>
    v && typeof v === 'object' && 'id' in (v as Record<string, unknown>)
      ? (v as { id: unknown }).id
      : v;
  const itemBag = p['item'];
  const lineCount =
    itemBag &&
    typeof itemBag === 'object' &&
    Array.isArray((itemBag as { items?: unknown[] }).items)
      ? (itemBag as { items: unknown[] }).items.length
      : 0;
  const digest: Record<string, unknown> = { lineCount };
  if (p['tranId'] !== undefined) digest['tranId'] = p['tranId'];
  if (p['externalId'] !== undefined) digest['externalId'] = p['externalId'];
  if (p['subsidiary'] !== undefined) digest['subsidiaryId'] = refId(p['subsidiary']);
  if (p['entity'] !== undefined) digest['entityId'] = refId(p['entity']);
  if (p['currency'] !== undefined) digest['currencyId'] = refId(p['currency']);
  if (p['orderStatus'] !== undefined) digest['orderStatus'] = refId(p['orderStatus']);
  if (p['tranDate'] !== undefined) digest['tranDate'] = p['tranDate'];
  return digest;
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
      // M2-D — capture the SB delivery telemetry on entry so the handler can
      // emit one `order_attempt` row per delivery (including short-circuits).
      // SB binding surfaces `deliveryCount` as 1-based; first delivery = 1.
      const rawDelivery = context.triggerMetadata?.['deliveryCount'];
      const deliveryCount = typeof rawDelivery === 'number'
        ? rawDelivery
        : Number(rawDelivery ?? 1) || 1;
      const sessionId = context.triggerMetadata?.['sessionId'];
      const messageId = context.triggerMetadata?.['messageId'];
      const attemptCtx: AttemptContext = {
        deliveryCount,
        ...(typeof sessionId === 'string' && sessionId.length > 0 ? { sbSessionId: sessionId } : {}),
        ...(typeof messageId === 'string' && messageId.length > 0 ? { sbMessageId: messageId } : {}),
        startedAt: new Date(),
      };
      const outcome = await handleOrderMessage(getDeps(), message, attemptCtx);
      const summary = describeOutcome(outcome);
      context.log(
        `orderImportHandler outcome=${outcome.kind} ${summary} session=${String(sessionId ?? '-')} delivery=${deliveryCount}`,
      );
    },
  });
}

function describeOutcome(o: OrderHandlerOutcome): string {
  switch (o.kind) {
    case 'imported':
      return `connection=${o.connectionId} order=${o.orderGid} ns=${o.targetId} created=${o.created} customer=${o.customer.internalId}`;
    case 'parked':
      return `connection=${o.connectionId} order=${o.orderGid} stage=${o.stage}${o.errorClass ? ` class=${o.errorClass}` : ''} detail="${o.detail}"`;
    case 'ignored_by_eligibility':
      return `connection=${o.connectionId} order=${o.orderGid} reason=${o.reason}${o.detail ? ` detail="${o.detail}"` : ''}`;
    case 'rejected':
      return `reason=${o.reason} detail="${o.detail}"`;
    default:
      return `connection=${o.connectionId} order=${o.orderGid}`;
  }
}
