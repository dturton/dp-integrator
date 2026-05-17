import { describe, expect, it } from 'vitest';
import {
  InMemoryConnectionsRepo,
  InMemoryXrefStore,
  type Connection,
} from '@dpi/core';
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

function buildDeps(overrides: { connections?: readonly Connection[] } = {}): {
  deps: OrderHandlerDeps;
  xrefStore: InMemoryXrefStore;
} {
  const xrefStore = new InMemoryXrefStore();
  const deps: OrderHandlerDeps = {
    environment: 'dev',
    connections: new InMemoryConnectionsRepo(overrides.connections ?? [acme]),
    xrefStore,
  };
  return { deps, xrefStore };
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

describe('handleOrderMessage', () => {
  it('claims a brand-new xref row on first delivery', async () => {
    const { deps, xrefStore } = buildDeps();
    const outcome = await handleOrderMessage(deps, makeMessage());
    expect(outcome).toEqual({
      kind: 'claimed',
      connectionId: acme.connectionId,
      orderGid: 'gid://shopify/Order/12345',
    });
    const row = await xrefStore.lookup({
      environment: 'dev',
      connectionId: acme.connectionId,
      entityType: 'order',
      sourceSystem: 'shopify',
      sourceId: 'gid://shopify/Order/12345',
    });
    expect(row?.status).toBe('pending');
  });

  it('redelivery of an already-synced order is a no-op (already_synced)', async () => {
    const { deps, xrefStore } = buildDeps();
    // First delivery → claim + simulate a successful NS write (Slice D will do
    // this for real; here we just call recordSuccess directly).
    await handleOrderMessage(deps, makeMessage());
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
    expect(outcome).toEqual({
      kind: 'already_synced',
      connectionId: acme.connectionId,
      orderGid: 'gid://shopify/Order/12345',
    });
  });

  it('redelivery while a previous attempt is still pending → already_claimed', async () => {
    const { deps } = buildDeps();
    const first = await handleOrderMessage(deps, makeMessage());
    expect(first.kind).toBe('claimed');
    // No recordSuccess between calls — second delivery sees `pending` and gets `already_claimed`.
    const second = await handleOrderMessage(deps, makeMessage());
    expect(second.kind).toBe('already_claimed');
  });

  it('rejects a message with a missing required field', async () => {
    const { deps } = buildDeps();
    const bad = { ...makeMessage() } as Record<string, unknown>;
    delete bad['orderGid'];
    const outcome = await handleOrderMessage(deps, bad);
    expect(outcome).toMatchObject({ kind: 'rejected', reason: 'bad_message_shape' });
  });

  it('rejects a message with a non-1 schemaVersion', async () => {
    const { deps } = buildDeps();
    const outcome = await handleOrderMessage(deps, { ...makeMessage(), schemaVersion: 2 as 1 });
    expect(outcome).toMatchObject({ kind: 'rejected', reason: 'bad_message_shape' });
  });

  it('rejects a message whose environment does not match the handler', async () => {
    const { deps } = buildDeps();
    const outcome = await handleOrderMessage(deps, { ...makeMessage(), environment: 'sandbox' });
    expect(outcome).toMatchObject({ kind: 'rejected', reason: 'env_mismatch' });
  });

  it('rejects a message for an unknown connectionId (config drift)', async () => {
    const { deps } = buildDeps();
    const outcome = await handleOrderMessage(deps, { ...makeMessage(), connectionId: 'never-configured' });
    expect(outcome).toMatchObject({ kind: 'rejected', reason: 'unknown_connection' });
  });

  it('rejects a message for a disabled connection', async () => {
    const { deps } = buildDeps({ connections: [{ ...acme, enabled: false }] });
    const outcome = await handleOrderMessage(deps, makeMessage());
    expect(outcome).toMatchObject({ kind: 'rejected', reason: 'unknown_connection' });
  });

  it('rejects a non-object message body', async () => {
    const { deps } = buildDeps();
    const outcome = await handleOrderMessage(deps, 'just a string');
    expect(outcome).toMatchObject({ kind: 'rejected', reason: 'bad_message_shape' });
  });
});
