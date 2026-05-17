import { describe, expect, it } from 'vitest';
import {
  InMemoryConnectionsRepo,
  InMemoryQueue,
  InMemoryXrefStore,
  type Connection,
  type OrderWebhookMessageBody,
} from '@dpi/core';
import {
  handleAdminReplay,
  normalizeOrderGid,
  type ReplayDeps,
} from '../src/triggers/admin-replay.js';

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

function build(opts: { withXref?: boolean } = {}): {
  deps: ReplayDeps;
  xrefStore: InMemoryXrefStore;
  queue: InMemoryQueue<OrderWebhookMessageBody>;
} {
  const xrefStore = new InMemoryXrefStore();
  const queue = new InMemoryQueue<OrderWebhookMessageBody>();
  const connections = new InMemoryConnectionsRepo([acme]);
  return {
    xrefStore,
    queue,
    deps: {
      environment: 'dev',
      connections,
      xrefStore: opts.withXref === false ? undefined : xrefStore,
      queue,
    },
  };
}

describe('handleAdminReplay', () => {
  it('202 replayed when xref absent — publishes once', async () => {
    const { deps, queue } = build();
    const res = await handleAdminReplay(
      deps,
      JSON.stringify({ connectionId: 'acme-us', orderGid: 'gid://shopify/Order/12345' }),
    );
    expect(res.status).toBe(202);
    expect((res.jsonBody as { outcome: string }).outcome).toBe('replayed');
    expect((res.jsonBody as { previousStatus: string }).previousStatus).toBe('absent');
    expect(queue.size()).toBe(1);
  });

  it('accepts a bare numeric order id and normalizes to a GID on the published message', async () => {
    const { deps, queue } = build();
    const res = await handleAdminReplay(
      deps,
      JSON.stringify({ connectionId: 'acme-us', orderGid: '999' }),
    );
    expect(res.status).toBe(202);
    const [msg] = await queue.drain();
    expect(msg?.body.orderGid).toBe('gid://shopify/Order/999');
  });

  it('409 refused_already_synced when xref status=synced', async () => {
    const { deps, xrefStore } = build();
    await xrefStore.claim({
      environment: 'dev',
      connectionId: 'acme-us',
      entityType: 'order',
      sourceSystem: 'shopify',
      sourceId: 'gid://shopify/Order/12345',
      targetSystem: 'netsuite',
      targetExternal: 'gid://shopify/Order/12345',
    });
    await xrefStore.recordSuccess(
      {
        environment: 'dev',
        connectionId: 'acme-us',
        entityType: 'order',
        sourceSystem: 'shopify',
        sourceId: 'gid://shopify/Order/12345',
      },
      'ns_internal_42',
      'gid://shopify/Order/12345',
    );
    const res = await handleAdminReplay(
      deps,
      JSON.stringify({ connectionId: 'acme-us', orderGid: '12345' }),
    );
    expect(res.status).toBe(409);
    expect((res.jsonBody as { outcome: string }).outcome).toBe('refused_already_synced');
    expect((res.jsonBody as { targetId: string }).targetId).toBe('ns_internal_42');
  });

  it('force=true overrides the already_synced refusal', async () => {
    const { deps, xrefStore } = build();
    await xrefStore.claim({
      environment: 'dev',
      connectionId: 'acme-us',
      entityType: 'order',
      sourceSystem: 'shopify',
      sourceId: 'gid://shopify/Order/12345',
      targetSystem: 'netsuite',
      targetExternal: 'gid://shopify/Order/12345',
    });
    await xrefStore.recordSuccess(
      {
        environment: 'dev',
        connectionId: 'acme-us',
        entityType: 'order',
        sourceSystem: 'shopify',
        sourceId: 'gid://shopify/Order/12345',
      },
      'ns_internal_42',
      'gid://shopify/Order/12345',
    );
    const res = await handleAdminReplay(
      deps,
      JSON.stringify({ connectionId: 'acme-us', orderGid: '12345', force: true }),
    );
    expect(res.status).toBe(202);
    expect((res.jsonBody as { previousStatus: string }).previousStatus).toBe('synced');
  });

  it('404 unknown_connection', async () => {
    const { deps } = build();
    const res = await handleAdminReplay(
      deps,
      JSON.stringify({ connectionId: 'never', orderGid: '12345' }),
    );
    expect(res.status).toBe(404);
  });

  it('400 on missing orderGid', async () => {
    const { deps } = build();
    const res = await handleAdminReplay(deps, JSON.stringify({ connectionId: 'acme-us' }));
    expect(res.status).toBe(400);
  });

  it('400 on malformed JSON', async () => {
    const { deps } = build();
    const res = await handleAdminReplay(deps, '{not json');
    expect(res.status).toBe(400);
  });

  it('503 not_ready when xref store is missing from bootstrap', async () => {
    const { deps } = build({ withXref: false });
    const res = await handleAdminReplay(
      deps,
      JSON.stringify({ connectionId: 'acme-us', orderGid: '12345' }),
    );
    expect(res.status).toBe(503);
  });
});

describe('normalizeOrderGid', () => {
  it('passes through a full GID', () => {
    expect(normalizeOrderGid('gid://shopify/Order/12345')).toBe('gid://shopify/Order/12345');
  });
  it('wraps a numeric id', () => {
    expect(normalizeOrderGid('12345')).toBe('gid://shopify/Order/12345');
  });
  it('rejects empty or malformed input', () => {
    expect(normalizeOrderGid('')).toBeUndefined();
    expect(normalizeOrderGid('not-an-id')).toBeUndefined();
    expect(normalizeOrderGid('gid://shopify/Order/abc')).toBeUndefined();
    expect(normalizeOrderGid(undefined)).toBeUndefined();
    expect(normalizeOrderGid(12345)).toBeUndefined();
  });
});
