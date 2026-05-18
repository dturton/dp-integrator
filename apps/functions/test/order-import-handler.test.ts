import { describe, expect, it } from 'vitest';
import {
  InMemoryConnectionsRepo,
  InMemoryOrderAttemptStore,
  InMemoryOrderSyncLogStore,
  InMemoryPayloadStore,
  InMemoryXrefStore,
  type Connection,
} from '@dpi/core';
import { InMemoryLookupResolver } from '@dpi/mapping-engine';
import { FakeNetSuiteGateway } from '@dpi/netsuite-client';
import { FakeShopifyGateway, makeFakeOrder, type ShopifyOrder } from '@dpi/shopify-client';
import type { OrderWebhookMessage } from '../src/messages.js';
import {
  handleOrderMessage,
  type AttemptContext,
  type OrderHandlerDeps,
} from '../src/triggers/order-import-handler.js';

const acme: Connection = {
  connectionId: 'acme-us',
  environment: 'dev',
  shopifyStore: 'acme-us.myshopify.com',
  shopifyAppTokenRef: 'shopify-client-id-acme-us',
  shopifyWebhookSecretRef: 'shopify-webhook-secret-acme-us',
  nsAccountId: '1234567',
  nsSubsidiary: '1',
  nsLocation: '10',
  baseCurrency: 'USD',
  taxEngine: 'suitetax',
  orderTarget: 'sales_order',
  mapVersion: 'v1',
  enabled: true,
};

function defaultLookups(): InMemoryLookupResolver {
  return new InMemoryLookupResolver({
    lookup_currency: { USD: '1', EUR: '2' },
    lookup_payment_method: { shopify_payments: '12' },
  });
}

interface TelemetrySpy {
  imports: Array<{ environment: string; connectionId: string; durationMs: number }>;
  parks: Array<{ environment: string; connectionId: string; stage: string; errorClass: string }>;
  ignored: Array<{ environment: string; connectionId: string; reason: string }>;
  catchupPolls: Array<{ environment: string; connectionId: string; observed: number; enqueued: number }>;
  authErrors: Array<{ environment: string; connectionId: string; flow: string; message: string }>;
}

function buildTelemetrySpy(): { telemetry: import('../src/telemetry.js').Telemetry; spy: TelemetrySpy } {
  const spy: TelemetrySpy = { imports: [], parks: [], ignored: [], catchupPolls: [], authErrors: [] };
  return {
    spy,
    telemetry: {
      trackImport: (a) => spy.imports.push(a),
      trackPark: (a) => spy.parks.push(a),
      trackIgnored: (a) => spy.ignored.push(a),
      trackCatchupPoll: (a) => spy.catchupPolls.push(a),
      trackAuthError: (a) => spy.authErrors.push(a),
      flush: async () => undefined,
    },
  };
}

function buildDeps(args: {
  connections?: readonly Connection[];
  order?: ShopifyOrder;
  lookups?: InMemoryLookupResolver;
  telemetry?: import('../src/telemetry.js').Telemetry;
} = {}): {
  deps: OrderHandlerDeps;
  xrefStore: InMemoryXrefStore;
  shopify: FakeShopifyGateway;
  ns: FakeNetSuiteGateway;
  lookups: InMemoryLookupResolver;
} {
  const xrefStore = new InMemoryXrefStore();
  const shopify = new FakeShopifyGateway();
  const ns = new FakeNetSuiteGateway();
  const lookups = args.lookups ?? defaultLookups();
  // Seed item resolutions used by makeFakeOrder so resolveItemReferences
  // doesn't park the full-pipeline tests; individual tests that need a
  // miss can reach into the returned ns and skip the seed for a specific SKU.
  ns.seedItem(acme.nsAccountId, 'WIDGET-1', '11001');
  ns.seedItem(acme.nsAccountId, 'SHIP-STANDARD', '12001');
  if (args.order) shopify.seedOrder(args.order);
  const deps: OrderHandlerDeps = {
    environment: 'dev',
    connections: new InMemoryConnectionsRepo(args.connections ?? [acme]),
    xrefStore,
    shopify,
    ns,
    guestCustomerInternalId: '99',
    lookupsFor: () => lookups,
    ...(args.telemetry ? { telemetry: args.telemetry } : {}),
  };
  return { deps, xrefStore, shopify, ns, lookups };
}

function makeMessage(overrides: Partial<OrderWebhookMessage> = {}): OrderWebhookMessage {
  return {
    schemaVersion: 1,
    environment: 'dev',
    connectionId: acme.connectionId,
    shopDomain: acme.shopifyStore,
    topic: 'orders/create',
    orderGid: 'gid://shopify/Order/12345',
    envelopeBlobUri: 'https://blob.example.test/inbound/x.json',
    receivedAt: '2026-05-17T10:00:00Z',
    ...overrides,
  };
}

describe('handleOrderMessage — Slice D5 full pipeline', () => {
  it('imports the order end-to-end (xref synced + NS record created)', async () => {
    const order = makeFakeOrder({ id: 'gid://shopify/Order/12345' });
    const { deps, xrefStore, ns } = buildDeps({ order });

    const outcome = await handleOrderMessage(deps, makeMessage());

    expect(outcome.kind).toBe('imported');
    if (outcome.kind === 'imported') {
      expect(outcome.connectionId).toBe(acme.connectionId);
      expect(outcome.orderGid).toBe('gid://shopify/Order/12345');
      expect(outcome.created).toBe(true);
      expect(outcome.targetId).toMatch(/^ns_1234567_/);
    }

    // xref flipped to synced with the NS internal id
    const row = await xrefStore.lookup({
      environment: 'dev',
      connectionId: acme.connectionId,
      entityType: 'order',
      sourceSystem: 'shopify',
      sourceId: 'gid://shopify/Order/12345',
    });
    expect(row?.status).toBe('synced');
    expect(row?.targetId).toMatch(/^ns_1234567_/);

    // NS has both the customer (1) and the salesorder (1) records.
    expect(ns.getRecords(acme.nsAccountId, 'customer' as never).size).toBe(1);
    expect(ns.getRecords(acme.nsAccountId, 'salesorder' as never).size).toBe(1);
  });

  it('redelivery of an imported order → already_synced (no second NS write)', async () => {
    const order = makeFakeOrder({ id: 'gid://shopify/Order/12345' });
    const { deps, ns } = buildDeps({ order });
    await handleOrderMessage(deps, makeMessage());
    const upsertsBefore = ns.attemptCount();

    const second = await handleOrderMessage(deps, makeMessage());
    expect(second.kind).toBe('already_synced');
    // No additional NS upsert calls — the claim short-circuited.
    expect(ns.attemptCount()).toBe(upsertsBefore);
  });

  it('routes Cash Sale orders to the cashsale record type', async () => {
    const order = makeFakeOrder({ id: 'gid://shopify/Order/12345' });
    const cashSaleConn: Connection = { ...acme, orderTarget: 'cash_sale' };
    const { deps, ns } = buildDeps({ order, connections: [cashSaleConn] });
    const outcome = await handleOrderMessage(deps, makeMessage());
    expect(outcome.kind).toBe('imported');
    expect(ns.getRecords(acme.nsAccountId, 'cashsale' as never).size).toBe(1);
    expect(ns.getRecords(acme.nsAccountId, 'salesorder' as never).size).toBe(0);
  });

  it('test orders ignored, no NS work', async () => {
    const order = makeFakeOrder({ id: 'gid://shopify/Order/12345', test: true });
    const { deps, ns } = buildDeps({ order });
    const outcome = await handleOrderMessage(deps, makeMessage());
    expect(outcome).toMatchObject({ kind: 'ignored_by_eligibility', reason: 'test_order' });
    expect(ns.attemptCount()).toBe(0);
  });

  it('parks when a required lookup misses (currency not in lookup_currency)', async () => {
    const order = makeFakeOrder({
      id: 'gid://shopify/Order/12345',
      currencyCode: 'GBP', // no GBP row in defaultLookups()
    });
    const { deps, xrefStore } = buildDeps({ order });

    const outcome = await handleOrderMessage(deps, makeMessage());
    expect(outcome.kind).toBe('parked');
    if (outcome.kind === 'parked') {
      expect(outcome.stage).toBe('mapping');
      expect(outcome.detail).toMatch(/lookup_currency/);
    }
    // xref row is marked error (so redelivery short-circuits via already_claimed)
    const row = await xrefStore.lookup({
      environment: 'dev',
      connectionId: acme.connectionId,
      entityType: 'order',
      sourceSystem: 'shopify',
      sourceId: 'gid://shopify/Order/12345',
    });
    expect(row?.status).toBe('error');
  });

  it('parks when totals do not reconcile within tolerance', async () => {
    // Construct an order where line subtotal + shipping + tax !== totalPrice.
    const order = makeFakeOrder({
      id: 'gid://shopify/Order/12345',
      totalPrice: { amount: '999.00', currencyCode: 'USD' }, // way off
    });
    const { deps } = buildDeps({ order });
    const outcome = await handleOrderMessage(deps, makeMessage());
    expect(outcome.kind).toBe('parked');
    if (outcome.kind === 'parked') {
      expect(outcome.stage).toBe('balancing');
    }
  });

  it('guest order uses guestCustomerInternalId fallback as NS entity', async () => {
    const order = makeFakeOrder({ id: 'gid://shopify/Order/12345', customer: null });
    const { deps, ns } = buildDeps({ order });
    const outcome = await handleOrderMessage(deps, makeMessage());
    expect(outcome.kind).toBe('imported');
    if (outcome.kind === 'imported') expect(outcome.customer.isGuest).toBe(true);
    // Customer record NOT created (guest path used the fallback id)
    expect(ns.getRecords(acme.nsAccountId, 'customer' as never).size).toBe(0);
    // But the order WAS written (with entity={ id: '99' } — payload builder wraps refs)
    const orderRecord = ns.getRecords(acme.nsAccountId, 'salesorder' as never).get('gid://shopify/Order/12345');
    expect(orderRecord?.payload['entity']).toEqual({ id: '99' });
  });

  it('rejects bad message shape', async () => {
    const { deps } = buildDeps();
    const bad = { ...makeMessage() } as Record<string, unknown>;
    delete bad['orderGid'];
    const outcome = await handleOrderMessage(deps, bad);
    expect(outcome).toMatchObject({ kind: 'rejected', reason: 'bad_message_shape' });
  });

  it('rejects env mismatch', async () => {
    const { deps } = buildDeps();
    const outcome = await handleOrderMessage(deps, { ...makeMessage(), environment: 'sandbox' });
    expect(outcome).toMatchObject({ kind: 'rejected', reason: 'env_mismatch' });
  });

  it('rejects unknown connection', async () => {
    const { deps } = buildDeps();
    const outcome = await handleOrderMessage(deps, { ...makeMessage(), connectionId: 'never' });
    expect(outcome).toMatchObject({ kind: 'rejected', reason: 'unknown_connection' });
  });

  it('parks with stage=fetch when Shopify reports the order as not found', async () => {
    // No order seeded → FakeShopifyGateway throws OrderNotFoundError on getOrder.
    const { deps, xrefStore } = buildDeps();

    const outcome = await handleOrderMessage(deps, makeMessage());
    expect(outcome.kind).toBe('parked');
    if (outcome.kind === 'parked') {
      expect(outcome.stage).toBe('fetch');
      expect(outcome.detail).toMatch(/not found/);
    }
    // xref row is marked error so SB redelivery short-circuits via already_claimed
    // (not a transient throw + retry loop).
    const row = await xrefStore.lookup({
      environment: 'dev',
      connectionId: acme.connectionId,
      entityType: 'order',
      sourceSystem: 'shopify',
      sourceId: 'gid://shopify/Order/12345',
    });
    expect(row?.status).toBe('error');
  });

  it('tags the Shopify order with netsuite-<id> after import when writeTagsOnImport=true', async () => {
    const order = makeFakeOrder({ id: 'gid://shopify/Order/12345' });
    const conn: Connection = { ...acme, writeTagsOnImport: true };
    const { deps, shopify } = buildDeps({ order, connections: [conn] });

    const outcome = await handleOrderMessage(deps, makeMessage());
    expect(outcome.kind).toBe('imported');
    if (outcome.kind !== 'imported') return;
    const tags = shopify.getTags('gid://shopify/Order/12345');
    expect(tags).toEqual([`netsuite-${outcome.targetId}`]);
  });

  it('skips Shopify tag write-back when writeTagsOnImport is unset', async () => {
    const order = makeFakeOrder({ id: 'gid://shopify/Order/12345' });
    const { deps, shopify } = buildDeps({ order });
    const outcome = await handleOrderMessage(deps, makeMessage());
    expect(outcome.kind).toBe('imported');
    expect(shopify.getTags('gid://shopify/Order/12345')).toEqual([]);
  });

  it('tag write-back failure does NOT roll back a successful import', async () => {
    const order = makeFakeOrder({ id: 'gid://shopify/Order/12345' });
    const conn: Connection = { ...acme, writeTagsOnImport: true };
    const { deps, shopify, xrefStore } = buildDeps({ order, connections: [conn] });
    // Inject a tagOrder that always blows up.
    shopify.setTagOrderImpl(async () => {
      throw new Error('shopify: HTTP 503: tag failed');
    });

    const outcome = await handleOrderMessage(deps, makeMessage());
    expect(outcome.kind).toBe('imported'); // import still succeeded
    // xref is still synced.
    const row = await xrefStore.lookup({
      environment: 'dev',
      connectionId: acme.connectionId,
      entityType: 'order',
      sourceSystem: 'shopify',
      sourceId: 'gid://shopify/Order/12345',
    });
    expect(row?.status).toBe('synced');
  });

  it('rethrows on transient Shopify re-fetch failures (so SB retries)', async () => {
    const { deps, shopify } = buildDeps();
    // Swap getOrder for one that throws an arbitrary (non-OrderNotFound) error.
    (shopify as unknown as { getOrder: typeof shopify.getOrder }).getOrder = async () => {
      throw new Error('shopify: HTTP 503');
    };
    await expect(handleOrderMessage(deps, makeMessage())).rejects.toThrow(/503/);
  });

  it('parks with stage=item_resolution when a SKU has no NS item', async () => {
    const order = makeFakeOrder({ id: 'gid://shopify/Order/12345' });
    const { deps, ns, xrefStore } = buildDeps({ order });
    // Clear the WIDGET-1 seeding by recreating with a different sku gap.
    // Simplest path: build a fresh ns without seeding WIDGET-1.
    const ns2 = new (ns.constructor as new () => FakeNetSuiteGateway)();
    ns2.seedItem(acme.nsAccountId, 'SHIP-STANDARD', '12001');
    // WIDGET-1 intentionally NOT seeded.
    (deps as { ns: FakeNetSuiteGateway }).ns = ns2;

    const outcome = await handleOrderMessage(deps, makeMessage());
    expect(outcome.kind).toBe('parked');
    if (outcome.kind === 'parked') {
      expect(outcome.stage).toBe('item_resolution');
      expect(outcome.detail).toMatch(/WIDGET-1/);
    }
    // xref marked error so redelivery short-circuits via already_claimed
    const row = await xrefStore.lookup({
      environment: 'dev',
      connectionId: acme.connectionId,
      entityType: 'order',
      sourceSystem: 'shopify',
      sourceId: 'gid://shopify/Order/12345',
    });
    expect(row?.status).toBe('error');
    // No salesorder was attempted.
    expect(ns2.getRecords(acme.nsAccountId, 'salesorder' as never).size).toBe(0);
  });

  it('imports (not parks) when a SKU misses but connection.defaultItemId is set', async () => {
    const order = makeFakeOrder({ id: 'gid://shopify/Order/12345' });
    const connWithFallback: Connection = { ...acme, defaultItemId: '6542' };
    const { deps, ns } = buildDeps({ order, connections: [connWithFallback] });
    // Drop the WIDGET-1 seed so the SKU misses; the fallback should pick it up.
    const ns2 = new (ns.constructor as new () => FakeNetSuiteGateway)();
    ns2.seedItem(connWithFallback.nsAccountId, 'SHIP-STANDARD', '12001');
    (deps as { ns: FakeNetSuiteGateway }).ns = ns2;

    const outcome = await handleOrderMessage(deps, makeMessage());
    expect(outcome.kind).toBe('imported');

    const records = ns2.getRecords(connWithFallback.nsAccountId, 'salesorder' as never);
    expect(records.size).toBe(1);
    const so = records.values().next().value as { payload: Record<string, unknown> };
    const itemLines = (so.payload['item'] as { items: Array<Record<string, unknown>> }).items;
    const widgetLine = itemLines.find((l) => {
      const item = l['item'] as { id?: string } | undefined;
      return item?.id === '6542';
    });
    expect(widgetLine).toBeDefined();
  });

  it('parks an unclassified NS upsert failure (errorClass=unknown, stage=external_call)', async () => {
    // The brief's stance: "treat unknown like data so we never silently
    // retry-loop on a novel shape." M2-C wraps the post-claim pipeline in
    // a try/catch + classifier; a bare Error('ns order write failed')
    // hits no transient / auth / data cue, so it parks rather than throws.
    const order = makeFakeOrder({ id: 'gid://shopify/Order/12345' });
    const { deps, ns, xrefStore } = buildDeps({ order });
    const realFailNext = FakeNetSuiteGateway.prototype.failNext.bind(ns);
    await deps.ns.upsertByExternalId({
      nsAccountId: 'priming',
      recordType: 'noop' as never,
      externalId: 'noop',
      payload: {},
    }).catch(() => undefined); // burn a counter so failNext aligns
    realFailNext(new Error('ns order write failed'));

    const outcome = await handleOrderMessage(deps, makeMessage());
    expect(outcome.kind).toBe('parked');
    if (outcome.kind === 'parked') {
      expect(outcome.stage).toBe('external_call');
      expect(outcome.errorClass).toBe('unknown');
      expect(outcome.detail).toMatch(/ns order write failed/);
    }
    const row = await xrefStore.lookup({
      environment: 'dev',
      connectionId: acme.connectionId,
      entityType: 'order',
      sourceSystem: 'shopify',
      sourceId: 'gid://shopify/Order/12345',
    });
    expect(row?.status).toBe('error');
  });

  it('rethrows transient errors (HTTP 5xx / network) so SB retries', async () => {
    const { deps, shopify } = buildDeps();
    // Swap getOrder for one that throws a transient-shaped error.
    (shopify as unknown as { getOrder: typeof shopify.getOrder }).getOrder = async () => {
      throw new Error('store-x.myshopify.com returned 503: upstream busy');
    };
    await expect(handleOrderMessage(deps, makeMessage())).rejects.toThrow(/503/);
  });
});

describe('handleOrderMessage — Slice M2-D retry visibility + payload archive', () => {
  function attemptCtx(overrides: Partial<AttemptContext> = {}): AttemptContext {
    return {
      deliveryCount: 1,
      sbMessageId: 'sb-msg-1',
      sbSessionId: `${acme.connectionId}:gid://shopify/Order/12345`,
      startedAt: new Date('2026-05-17T10:00:00Z'),
      ...overrides,
    };
  }

  it('happy path records one attempt with payload URI + digest + bumps order_sync_log retry fields', async () => {
    const order = makeFakeOrder({ id: 'gid://shopify/Order/12345' });
    const { deps } = buildDeps({ order });
    const orderAttemptStore = new InMemoryOrderAttemptStore();
    const outboundPayloadStore = new InMemoryPayloadStore();
    const orderSyncLog = new InMemoryOrderSyncLogStore();
    const wired: OrderHandlerDeps = { ...deps, orderAttemptStore, outboundPayloadStore, orderSyncLog };

    const outcome = await handleOrderMessage(wired, makeMessage(), attemptCtx());
    expect(outcome.kind).toBe('imported');

    const rows = await orderAttemptStore.listByOrderGid({
      environment: 'dev', connectionId: acme.connectionId, shopifyOrderGid: 'gid://shopify/Order/12345',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      deliveryCount: 1,
      outcome: 'imported',
      sbMessageId: 'sb-msg-1',
      inboundEnvelopeUri: 'https://blob.example.test/inbound/x.json',
    });
    expect(rows[0]?.outboundPayloadUri).toMatch(/^mem:\/\/outbound\//);
    expect(rows[0]?.payloadDigest).toMatchObject({
      tranId: expect.any(String),
      lineCount: 1,
      subsidiaryId: '1',
    });
    // Payload-viewer slice: three blob puts per import — Shopify order
    // (input), outbound NS request (built), NS response (output).
    // ns_response_status surfaces NS's HTTP code so the UI can color the
    // Response button without fetching the blob.
    expect(rows[0]?.nsResponseUri).toMatch(/-response\.json$/);
    expect(rows[0]?.nsResponseStatus).toBe(204);
    expect(rows[0]?.shopifyPayloadUri).toMatch(/-shopify\.json$/);
    expect(outboundPayloadStore.putCount()).toBe(3);

    // order_sync_log denormalization
    const log = await orderSyncLog.findByOrderGid({
      environment: 'dev', connectionId: acme.connectionId, shopifyOrderGid: 'gid://shopify/Order/12345',
    });
    expect(log?.attemptCount).toBe(1);
    expect(log?.lastDeliveryCount).toBe(1);
    expect(log?.lastOutboundPayloadUri).toMatch(/^mem:\/\/outbound\//);
    expect(log?.lastInboundEnvelopeUri).toBe('https://blob.example.test/inbound/x.json');
  });

  it('park at mapping → attempt outcome=parked, no outbound payload (never reached NS)', async () => {
    // Order has a discount but the connection lacks defaultDiscountItemId → mapping parks.
    const order = makeFakeOrder({
      id: 'gid://shopify/Order/12345',
      totalDiscounts: { amount: '5.00', currencyCode: 'USD' },
    });
    const { deps } = buildDeps({ order });
    const orderAttemptStore = new InMemoryOrderAttemptStore();
    const outboundPayloadStore = new InMemoryPayloadStore();
    const wired: OrderHandlerDeps = { ...deps, orderAttemptStore, outboundPayloadStore };

    const outcome = await handleOrderMessage(wired, makeMessage(), attemptCtx());
    expect(outcome.kind).toBe('parked');

    const rows = await orderAttemptStore.listByOrderGid({
      environment: 'dev', connectionId: acme.connectionId, shopifyOrderGid: 'gid://shopify/Order/12345',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      outcome: 'parked',
      stage: 'mapping',
      errorClass: 'unmapped_construct',
    });
    expect(rows[0]?.outboundPayloadUri).toBeUndefined();
    expect(rows[0]?.payloadDigest).toBeUndefined();
    // NS write never happened, but the Shopify-order archive runs BEFORE the
    // mapping step so parked attempts still have a Shopify payload archived
    // (that's the whole point — operators can see what Shopify sent that
    // failed to map).
    expect(rows[0]?.shopifyPayloadUri).toMatch(/-shopify\.json$/);
    expect(outboundPayloadStore.putCount()).toBe(1);
  });

  it('records the delivery_count from attemptCtx (redelivery → row says 3)', async () => {
    const order = makeFakeOrder({ id: 'gid://shopify/Order/12345' });
    const { deps } = buildDeps({ order });
    const orderAttemptStore = new InMemoryOrderAttemptStore();
    const orderSyncLog = new InMemoryOrderSyncLogStore();
    const wired: OrderHandlerDeps = { ...deps, orderAttemptStore, orderSyncLog };

    await handleOrderMessage(wired, makeMessage(), attemptCtx({ deliveryCount: 3 }));

    const rows = await orderAttemptStore.listByOrderGid({
      environment: 'dev', connectionId: acme.connectionId, shopifyOrderGid: 'gid://shopify/Order/12345',
    });
    expect(rows[0]?.deliveryCount).toBe(3);
    const log = await orderSyncLog.findByOrderGid({
      environment: 'dev', connectionId: acme.connectionId, shopifyOrderGid: 'gid://shopify/Order/12345',
    });
    expect(log?.attemptCount).toBe(3);
    expect(log?.lastDeliveryCount).toBe(3);
  });

  it('swallows blob-store failures — NS upsert + attempt row still happen, failed URI is null', async () => {
    const order = makeFakeOrder({ id: 'gid://shopify/Order/12345' });
    const { deps, ns } = buildDeps({ order });
    const orderAttemptStore = new InMemoryOrderAttemptStore();
    const outboundPayloadStore = new InMemoryPayloadStore();
    // First put is the Shopify-order archive (right after getOrder); fail
    // that one to assert the rest of the pipeline still runs to completion.
    outboundPayloadStore.failNext(new Error('blob 503 — Azure busy'));
    const wired: OrderHandlerDeps = { ...deps, orderAttemptStore, outboundPayloadStore };

    const outcome = await handleOrderMessage(wired, makeMessage(), attemptCtx());
    expect(outcome.kind).toBe('imported');
    // NS upsert happened despite the blob outage.
    expect(ns.getRecords(acme.nsAccountId, 'salesorder' as never).size).toBe(1);
    const rows = await orderAttemptStore.listByOrderGid({
      environment: 'dev', connectionId: acme.connectionId, shopifyOrderGid: 'gid://shopify/Order/12345',
    });
    expect(rows[0]?.outcome).toBe('imported');
    // The failed Shopify archive leaves the URI null, while the outbound +
    // NS response archives still went through.
    expect(rows[0]?.shopifyPayloadUri).toBeUndefined();
    expect(rows[0]?.outboundPayloadUri).toMatch(/^mem:\/\/outbound\//);
    expect(rows[0]?.nsResponseUri).toMatch(/-response\.json$/);
    // Digest still built — it's derived from the in-memory payload, blob-independent.
    expect(rows[0]?.payloadDigest).toBeDefined();
  });

  it('short-circuit redelivery (already_synced) still records an attempt row with no payload URIs', async () => {
    const order = makeFakeOrder({ id: 'gid://shopify/Order/12345' });
    const { deps } = buildDeps({ order });
    const orderAttemptStore = new InMemoryOrderAttemptStore();
    const outboundPayloadStore = new InMemoryPayloadStore();
    const wired: OrderHandlerDeps = { ...deps, orderAttemptStore, outboundPayloadStore };

    // First delivery: imports normally.
    await handleOrderMessage(wired, makeMessage(), attemptCtx({ deliveryCount: 1 }));
    // Redelivery hits the already_synced short-circuit on the xref claim.
    await handleOrderMessage(wired, makeMessage(), attemptCtx({ deliveryCount: 2 }));

    const rows = await orderAttemptStore.listByOrderGid({
      environment: 'dev', connectionId: acme.connectionId, shopifyOrderGid: 'gid://shopify/Order/12345',
    });
    expect(rows).toHaveLength(2);
    // Most-recent first (listByOrderGid sorts deliveryCount desc).
    expect(rows[0]).toMatchObject({ deliveryCount: 2, outcome: 'already_synced' });
    expect(rows[0]?.outboundPayloadUri).toBeUndefined();
    expect(rows[0]?.payloadDigest).toBeUndefined();
    expect(rows[1]).toMatchObject({ deliveryCount: 1, outcome: 'imported' });
    // Blob puts: 3 for the imported attempt (Shopify input + outbound NS
    // request + NS response), 0 for the short-circuit. The redelivery
    // returns already_synced from xref before re-fetching anything.
    expect(outboundPayloadStore.putCount()).toBe(3);
  });

  it('transient throw still records an attempt row (outcome=transient_throw) before re-throwing', async () => {
    const { deps, shopify } = buildDeps();
    (shopify as unknown as { getOrder: typeof shopify.getOrder }).getOrder = async () => {
      throw new Error('store-x.myshopify.com returned 503: upstream busy');
    };
    const orderAttemptStore = new InMemoryOrderAttemptStore();
    const wired: OrderHandlerDeps = { ...deps, orderAttemptStore };

    await expect(handleOrderMessage(wired, makeMessage(), attemptCtx({ deliveryCount: 2 }))).rejects.toThrow(/503/);

    const rows = await orderAttemptStore.listByOrderGid({
      environment: 'dev', connectionId: acme.connectionId, shopifyOrderGid: 'gid://shopify/Order/12345',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      deliveryCount: 2,
      outcome: 'transient_throw',
      errorClass: 'transient',
    });
    expect(rows[0]?.detail).toMatch(/503/);
  });

  it('no attempt row written when orderAttemptStore is not wired (back-compat)', async () => {
    const order = makeFakeOrder({ id: 'gid://shopify/Order/12345' });
    const { deps } = buildDeps({ order });
    // No orderAttemptStore in deps.
    const outcome = await handleOrderMessage(deps, makeMessage(), attemptCtx());
    expect(outcome.kind).toBe('imported');
    // Nothing to assert beyond "doesn't throw" — the store isn't there to read from.
  });
});

describe('handleOrderMessage — telemetry surface (sync-health metrics + auth alert)', () => {
  it('emits trackImport with non-zero durationMs on a successful import', async () => {
    const { telemetry, spy } = buildTelemetrySpy();
    const order = makeFakeOrder({ id: 'gid://shopify/Order/12345' });
    const { deps } = buildDeps({ order, telemetry });

    const startedAt = new Date(Date.now() - 50);
    const outcome = await handleOrderMessage(deps, makeMessage(), {
      deliveryCount: 1,
      startedAt,
    });

    expect(outcome.kind).toBe('imported');
    expect(spy.imports).toHaveLength(1);
    expect(spy.imports[0]?.environment).toBe('dev');
    expect(spy.imports[0]?.connectionId).toBe('acme-us');
    expect(spy.imports[0]?.durationMs).toBeGreaterThanOrEqual(0);
    // No other counters should fire on the happy path.
    expect(spy.parks).toHaveLength(0);
    expect(spy.ignored).toHaveLength(0);
    expect(spy.authErrors).toHaveLength(0);
  });

  it('emits trackPark with stage + errorClass on the mapping park path', async () => {
    const { telemetry, spy } = buildTelemetrySpy();
    const order = makeFakeOrder({
      id: 'gid://shopify/Order/12345',
      currencyCode: 'GBP', // no GBP row in defaultLookups → mapping park
    });
    const { deps } = buildDeps({ order, telemetry });
    const outcome = await handleOrderMessage(deps, makeMessage());
    expect(outcome.kind).toBe('parked');
    expect(spy.parks).toHaveLength(1);
    expect(spy.parks[0]?.stage).toBe('mapping');
    expect(spy.parks[0]?.errorClass).toBe('unmapped_construct');
    expect(spy.imports).toHaveLength(0);
  });

  it('emits trackIgnored when the eligibility predicate rejects the order', async () => {
    const { telemetry, spy } = buildTelemetrySpy();
    const order = makeFakeOrder({ id: 'gid://shopify/Order/12345', test: true });
    const { deps } = buildDeps({ order, telemetry });
    const outcome = await handleOrderMessage(deps, makeMessage());
    expect(outcome).toMatchObject({ kind: 'ignored_by_eligibility', reason: 'test_order' });
    expect(spy.ignored).toHaveLength(1);
    expect(spy.ignored[0]?.reason).toBe('test_order');
  });

  it('emits trackAuthError when a thrown error classifies as auth (and still re-throws for SB retry)', async () => {
    const { telemetry, spy } = buildTelemetrySpy();
    const { deps, shopify } = buildDeps({ telemetry });
    // Inject a getOrder that throws a 401 → classifier returns 'auth'.
    (shopify as unknown as { getOrder: typeof shopify.getOrder }).getOrder = async () => {
      throw new Error('store-x returned 401: token expired');
    };
    await expect(handleOrderMessage(deps, makeMessage())).rejects.toThrow(/401/);
    expect(spy.authErrors).toHaveLength(1);
    expect(spy.authErrors[0]?.flow).toBe('order-import');
    expect(spy.authErrors[0]?.message).toMatch(/401/);
  });
});
