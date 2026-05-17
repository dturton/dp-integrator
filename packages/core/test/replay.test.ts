import { describe, expect, it } from 'vitest';
import { InMemoryConnectionsRepo } from '../src/connections/connections-repo.js';
import { InMemoryQueue } from '../src/queue/queue.js';
import {
  requestReplay,
  type OrderWebhookMessageBody,
} from '../src/replay/replay.js';
import type { Connection } from '../src/types.js';
import { InMemoryXrefStore } from '../src/xref/xref-store.js';

const acme: Connection = {
  connectionId: 'acme-us',
  environment: 'dev',
  shopifyStore: 'acme-us.myshopify.com',
  shopifyAppTokenRef: 'shopify-client-id-acme-us',
  shopifyWebhookSecretRef: 'shopify-webhook-secret-acme-us',
  nsAccountId: '1234567',
  nsSubsidiary: '1',
  baseCurrency: 'USD',
  taxEngine: 'suitetax',
  orderTarget: 'sales_order',
  mapVersion: 'v1',
  enabled: true,
};

const ORDER = 'gid://shopify/Order/12345';
const dedup = {
  environment: 'dev' as const,
  connectionId: acme.connectionId,
  entityType: 'order' as const,
  sourceSystem: 'shopify' as const,
  sourceId: ORDER,
  targetSystem: 'netsuite' as const,
  targetExternal: ORDER,
};

function build() {
  const xrefStore = new InMemoryXrefStore();
  const queue = new InMemoryQueue<OrderWebhookMessageBody>();
  const connections = new InMemoryConnectionsRepo([acme]);
  return { xrefStore, queue, connections, deps: { xrefStore, queue, connections } };
}

describe('requestReplay', () => {
  it('deletes a parked xref row and publishes a fresh OrderWebhookMessage', async () => {
    const { xrefStore, queue, deps } = build();
    await xrefStore.claim(dedup);
    await xrefStore.recordFailure(dedup);
    expect(xrefStore.size()).toBe(1);

    const outcome = await requestReplay(deps, {
      environment: 'dev',
      connectionId: acme.connectionId,
      orderGid: ORDER,
    });

    expect(outcome).toMatchObject({
      outcome: 'replayed',
      previousStatus: 'error',
      sessionId: `${acme.connectionId}:${ORDER}`,
    });
    expect(xrefStore.size()).toBe(0);
    expect(queue.size()).toBe(1);

    const [msg] = await queue.drain();
    expect(msg?.sessionId).toBe(`${acme.connectionId}:${ORDER}`);
    expect(msg?.body.connectionId).toBe(acme.connectionId);
    expect(msg?.body.orderGid).toBe(ORDER);
    expect(msg?.body.shopDomain).toBe(acme.shopifyStore);
    expect(msg?.body.envelopeBlobUri).toMatch(/^replay:\/\/dpi\/dev\/acme-us\//);
    expect(msg?.body.schemaVersion).toBe(1);
  });

  it('refuses by default when xref is already synced (no delete, no publish)', async () => {
    const { xrefStore, queue, deps } = build();
    await xrefStore.claim(dedup);
    await xrefStore.recordSuccess(dedup, 'ns_internal_99', ORDER);

    const outcome = await requestReplay(deps, {
      environment: 'dev',
      connectionId: acme.connectionId,
      orderGid: ORDER,
    });

    expect(outcome).toMatchObject({
      outcome: 'refused_already_synced',
      targetId: 'ns_internal_99',
    });
    expect(xrefStore.size()).toBe(1);
    expect(queue.size()).toBe(0);
  });

  it('force=true overrides the already_synced refusal — deletes + publishes', async () => {
    const { xrefStore, queue, deps } = build();
    await xrefStore.claim(dedup);
    await xrefStore.recordSuccess(dedup, 'ns_internal_99', ORDER);

    const outcome = await requestReplay(deps, {
      environment: 'dev',
      connectionId: acme.connectionId,
      orderGid: ORDER,
      force: true,
    });

    expect(outcome).toMatchObject({ outcome: 'replayed', previousStatus: 'synced' });
    expect(xrefStore.size()).toBe(0);
    expect(queue.size()).toBe(1);
  });

  it('publishes only (no delete) when no xref row exists — previousStatus="absent"', async () => {
    const { xrefStore, queue, deps } = build();

    const outcome = await requestReplay(deps, {
      environment: 'dev',
      connectionId: acme.connectionId,
      orderGid: ORDER,
    });

    expect(outcome).toMatchObject({ outcome: 'replayed', previousStatus: 'absent' });
    expect(xrefStore.size()).toBe(0);
    expect(queue.size()).toBe(1);
  });

  it('returns unknown_connection without touching xref or queue', async () => {
    const { xrefStore, queue, deps } = build();

    const outcome = await requestReplay(deps, {
      environment: 'dev',
      connectionId: 'never-heard-of-it',
      orderGid: ORDER,
    });

    expect(outcome).toMatchObject({ outcome: 'unknown_connection' });
    expect(xrefStore.size()).toBe(0);
    expect(queue.size()).toBe(0);
  });

  it('stamps the configured topic on the replayed message; defaults to orders/updated', async () => {
    const { queue, deps } = build();
    await requestReplay(deps, {
      environment: 'dev',
      connectionId: acme.connectionId,
      orderGid: ORDER,
    });
    const [defaulted] = await queue.drain();
    expect(defaulted?.body.topic).toBe('orders/updated');

    await requestReplay(deps, {
      environment: 'dev',
      connectionId: acme.connectionId,
      orderGid: ORDER,
      topic: 'orders/create',
    });
    const [explicit] = await queue.drain();
    expect(explicit?.body.topic).toBe('orders/create');
  });
});
