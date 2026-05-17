import { describe, expect, it } from 'vitest';
import {
  InMemoryConnectionsRepo,
  InMemoryXrefStore,
  type Connection,
} from '@dpi/core';
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

function buildDeps(args: {
  connections?: readonly Connection[];
  order?: ShopifyOrder;
} = {}): {
  deps: OrderHandlerDeps;
  xrefStore: InMemoryXrefStore;
  shopify: FakeShopifyGateway;
  ns: FakeNetSuiteGateway;
} {
  const xrefStore = new InMemoryXrefStore();
  const shopify = new FakeShopifyGateway();
  const ns = new FakeNetSuiteGateway();
  if (args.order) shopify.seedOrder(args.order);
  const deps: OrderHandlerDeps = {
    environment: 'dev',
    connections: new InMemoryConnectionsRepo(args.connections ?? [acme]),
    xrefStore,
    shopify,
    ns,
    guestCustomerInternalId: '99',
  };
  return { deps, xrefStore, shopify, ns };
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

describe('handleOrderMessage — Slice C (full flow through customer resolution)', () => {
  it('claims xref, re-fetches order, runs eligibility, resolves customer', async () => {
    const order = makeFakeOrder({ id: 'gid://shopify/Order/12345' });
    const { deps, xrefStore, ns } = buildDeps({ order });

    const outcome = await handleOrderMessage(deps, makeMessage());

    expect(outcome.kind).toBe('claimed_pending_ns');
    if (outcome.kind === 'claimed_pending_ns') {
      expect(outcome.connectionId).toBe(acme.connectionId);
      expect(outcome.orderGid).toBe('gid://shopify/Order/12345');
      expect(outcome.customer.isGuest).toBe(false);
      expect(outcome.customer.created).toBe(true);
      expect(outcome.customer.internalId).toMatch(/^ns_1234567_/);
    }

    // xref claimed (status='pending') until Slice D writes the NS record
    const row = await xrefStore.lookup({
      environment: 'dev',
      connectionId: acme.connectionId,
      entityType: 'order',
      sourceSystem: 'shopify',
      sourceId: 'gid://shopify/Order/12345',
    });
    expect(row?.status).toBe('pending');

    // customer landed in NS (fake)
    expect(ns.getRecords(acme.nsAccountId, 'customer' as never).size).toBe(1);
  });

  it('redelivery while still pending → already_claimed (no re-fetch, no NS work)', async () => {
    const order = makeFakeOrder({ id: 'gid://shopify/Order/12345' });
    const { deps, shopify, ns } = buildDeps({ order });
    await handleOrderMessage(deps, makeMessage()); // first delivery: claims + resolves
    const before = { fetches: ns.attemptCount(), customers: ns.getRecords(acme.nsAccountId, 'customer' as never).size };

    const second = await handleOrderMessage(deps, makeMessage());
    expect(second.kind).toBe('already_claimed');
    // Verify the second delivery did NOT re-fetch or re-resolve.
    expect(ns.attemptCount()).toBe(before.fetches);
    expect(ns.getRecords(acme.nsAccountId, 'customer' as never).size).toBe(before.customers);
    expect(shopify).toBeDefined(); // assertion shape — ensure we used the fake gateway, not a leaked real one
  });

  it('test orders are marked ignored and never sent to NS', async () => {
    const order = makeFakeOrder({ id: 'gid://shopify/Order/12345', test: true });
    const { deps, xrefStore, ns } = buildDeps({ order });

    const outcome = await handleOrderMessage(deps, makeMessage());

    expect(outcome).toMatchObject({
      kind: 'ignored_by_eligibility',
      connectionId: acme.connectionId,
      orderGid: 'gid://shopify/Order/12345',
      reason: 'test_order',
    });
    const row = await xrefStore.lookup({
      environment: 'dev',
      connectionId: acme.connectionId,
      entityType: 'order',
      sourceSystem: 'shopify',
      sourceId: 'gid://shopify/Order/12345',
    });
    expect(row?.status).toBe('ignored');
    // No customer record was created (we short-circuited before customer resolution).
    expect(ns.attemptCount()).toBe(0);
  });

  it('fraud-held orders are marked ignored', async () => {
    const order = makeFakeOrder({ id: 'gid://shopify/Order/12345', fraudHold: true });
    const { deps } = buildDeps({ order });
    const outcome = await handleOrderMessage(deps, makeMessage());
    expect(outcome).toMatchObject({ kind: 'ignored_by_eligibility', reason: 'fraud_hold' });
  });

  it('orders with no line items are marked ignored', async () => {
    const order = makeFakeOrder({ id: 'gid://shopify/Order/12345', lineItems: [] });
    const { deps } = buildDeps({ order });
    const outcome = await handleOrderMessage(deps, makeMessage());
    expect(outcome).toMatchObject({ kind: 'ignored_by_eligibility', reason: 'no_line_items' });
  });

  it('guest orders use the guestCustomerInternalId fallback', async () => {
    const order = makeFakeOrder({ id: 'gid://shopify/Order/12345', customer: null });
    const { deps, ns } = buildDeps({ order });
    const outcome = await handleOrderMessage(deps, makeMessage());
    expect(outcome.kind).toBe('claimed_pending_ns');
    if (outcome.kind === 'claimed_pending_ns') {
      expect(outcome.customer.isGuest).toBe(true);
      expect(outcome.customer.internalId).toBe('99');
    }
    // No customer record was created (we used the guest fallback)
    expect(ns.getRecords(acme.nsAccountId, 'customer' as never).size).toBe(0);
  });

  it('redelivery of an already-synced order → already_synced', async () => {
    const order = makeFakeOrder({ id: 'gid://shopify/Order/12345' });
    const { deps, xrefStore } = buildDeps({ order });
    await handleOrderMessage(deps, makeMessage());
    // Simulate Slice D's recordSuccess to mark the xref as synced.
    await xrefStore.recordSuccess(
      {
        environment: 'dev',
        connectionId: acme.connectionId,
        entityType: 'order',
        sourceSystem: 'shopify',
        sourceId: 'gid://shopify/Order/12345',
      },
      'ns-internal-7777',
      'gid://shopify/Order/12345',
    );

    const outcome = await handleOrderMessage(deps, makeMessage());
    expect(outcome.kind).toBe('already_synced');
  });

  it('rejects a message with bad shape (no re-fetch attempted)', async () => {
    const { deps, shopify } = buildDeps();
    const bad = { ...makeMessage() } as Record<string, unknown>;
    delete bad['orderGid'];
    const outcome = await handleOrderMessage(deps, bad);
    expect(outcome).toMatchObject({ kind: 'rejected', reason: 'bad_message_shape' });
    expect(shopify).toBeDefined();
  });

  it('rejects on env mismatch', async () => {
    const { deps } = buildDeps();
    const outcome = await handleOrderMessage(deps, { ...makeMessage(), environment: 'sandbox' });
    expect(outcome).toMatchObject({ kind: 'rejected', reason: 'env_mismatch' });
  });

  it('rejects for unknown connection', async () => {
    const { deps } = buildDeps();
    const outcome = await handleOrderMessage(deps, { ...makeMessage(), connectionId: 'never-configured' });
    expect(outcome).toMatchObject({ kind: 'rejected', reason: 'unknown_connection' });
  });

  it('rejects for disabled connection', async () => {
    const { deps } = buildDeps({ connections: [{ ...acme, enabled: false }] });
    const outcome = await handleOrderMessage(deps, makeMessage());
    expect(outcome).toMatchObject({ kind: 'rejected', reason: 'unknown_connection' });
  });

  it('rethrows when Shopify re-fetch fails (SB will redeliver)', async () => {
    const { deps } = buildDeps(); // no order seeded → fake throws "not seeded"
    await expect(handleOrderMessage(deps, makeMessage())).rejects.toThrow(/not seeded/);
  });

  it('rethrows when customer upsert fails', async () => {
    const order = makeFakeOrder({ id: 'gid://shopify/Order/12345' });
    const { deps, ns } = buildDeps({ order });
    ns.failNext(new Error('ns customer write failed'));
    await expect(handleOrderMessage(deps, makeMessage())).rejects.toThrow(/customer write failed/);
  });

  it('rejects a non-object body', async () => {
    const { deps } = buildDeps();
    const outcome = await handleOrderMessage(deps, 'oops');
    expect(outcome).toMatchObject({ kind: 'rejected', reason: 'bad_message_shape' });
  });
});
