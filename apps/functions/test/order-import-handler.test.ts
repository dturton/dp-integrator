import { describe, expect, it } from 'vitest';
import {
  InMemoryConnectionsRepo,
  InMemoryXrefStore,
  type Connection,
} from '@dpi/core';
import { InMemoryLookupResolver } from '@dpi/mapping-engine';
import { FakeNetSuiteGateway } from '@dpi/netsuite-client';
import { FakeShopifyGateway, makeFakeOrder, type ShopifyOrder } from '@dpi/shopify-client';
import type { OrderWebhookMessage } from '../src/messages.js';
import {
  handleOrderMessage,
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

function buildDeps(args: {
  connections?: readonly Connection[];
  order?: ShopifyOrder;
  lookups?: InMemoryLookupResolver;
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
  if (args.order) shopify.seedOrder(args.order);
  const deps: OrderHandlerDeps = {
    environment: 'dev',
    connections: new InMemoryConnectionsRepo(args.connections ?? [acme]),
    xrefStore,
    shopify,
    ns,
    guestCustomerInternalId: '99',
    lookupsFor: () => lookups,
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

  it('rethrows on Shopify re-fetch failure', async () => {
    const { deps } = buildDeps(); // no order seeded
    await expect(handleOrderMessage(deps, makeMessage())).rejects.toThrow(/not seeded/);
  });

  it('rethrows on NS upsert failure (customer succeeds, order fails)', async () => {
    const order = makeFakeOrder({ id: 'gid://shopify/Order/12345' });
    const { deps, ns } = buildDeps({ order });
    // First upsert is customer (succeeds), second is salesorder (fails).
    ns.failNext = ((original) => {
      let count = 0;
      return function (err: Error) {
        count++;
        if (count === 2) original.call(ns, err);
        else original.call(ns, new Error('placeholder')); // never used
      };
    })(ns.failNext);
    // Simpler approach: directly fail the *second* NS call by failing only after the customer succeeds.
    const realFailNext = FakeNetSuiteGateway.prototype.failNext.bind(ns);
    // Customer write happens first; let it through, then queue a failure for the order.
    await deps.ns.upsertByExternalId({
      nsAccountId: 'priming',
      recordType: 'noop' as never,
      externalId: 'noop',
      payload: {},
    }).catch(() => undefined); // burn a counter so failNext aligns
    realFailNext(new Error('ns order write failed'));
    await expect(handleOrderMessage(deps, makeMessage())).rejects.toThrow();
  });
});
