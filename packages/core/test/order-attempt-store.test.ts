import { describe, expect, it } from 'vitest';
import {
  InMemoryOrderAttemptStore,
  type OrderAttemptInput,
} from '../src/order-attempt/order-attempt-store.js';

function base(overrides: Partial<OrderAttemptInput> = {}): OrderAttemptInput {
  return {
    environment: 'dev',
    connectionId: 'acme-us',
    shopifyOrderGid: 'gid://shopify/Order/100',
    deliveryCount: 1,
    sbMessageId: 'msg-aaa',
    sbSessionId: 'acme-us:gid://shopify/Order/100',
    outcome: 'imported',
    inboundEnvelopeUri: 'https://blob/inbound/100.json',
    outboundPayloadUri: 'https://blob/outbound/100-a1.json',
    payloadDigest: { tranId: '#1001', lineCount: 3, total: '120.00' },
    startedAt: new Date('2026-05-17T20:00:00Z'),
    finishedAt: new Date('2026-05-17T20:00:02Z'),
    durationMs: 2000,
    ...overrides,
  };
}

describe('InMemoryOrderAttemptStore', () => {
  it('records a row and returns it (with monotonic ids)', async () => {
    const store = new InMemoryOrderAttemptStore();
    const a = await store.record(base());
    const b = await store.record(base({ deliveryCount: 2, outcome: 'parked' }));
    expect(a.id).toMatch(/^attempt_/);
    expect(b.id).not.toBe(a.id);
    expect(store.size()).toBe(2);
  });

  it('listByOrderGid returns matching rows newest-delivery first', async () => {
    const store = new InMemoryOrderAttemptStore();
    await store.record(base({ deliveryCount: 1, outcome: 'transient_throw' }));
    await store.record(base({ deliveryCount: 2, outcome: 'transient_throw' }));
    await store.record(base({ deliveryCount: 3, outcome: 'imported' }));
    const rows = await store.listByOrderGid({
      environment: 'dev',
      connectionId: 'acme-us',
      shopifyOrderGid: 'gid://shopify/Order/100',
    });
    expect(rows.map((r) => r.deliveryCount)).toEqual([3, 2, 1]);
    expect(rows[0]?.outcome).toBe('imported');
  });

  it('listByOrderGid is partitioned by environment + connection + gid', async () => {
    const store = new InMemoryOrderAttemptStore();
    await store.record(base());
    await store.record(base({ environment: 'sandbox' }));
    await store.record(base({ connectionId: 'other' }));
    await store.record(base({ shopifyOrderGid: 'gid://shopify/Order/200' }));

    const rows = await store.listByOrderGid({
      environment: 'dev',
      connectionId: 'acme-us',
      shopifyOrderGid: 'gid://shopify/Order/100',
    });
    expect(rows).toHaveLength(1);
  });

  it('preserves optional fields exactly (no undefined leaks)', async () => {
    const store = new InMemoryOrderAttemptStore();
    // Minimal record — no optional fields.
    const row = await store.record({
      environment: 'dev',
      connectionId: 'acme-us',
      shopifyOrderGid: 'gid://shopify/Order/100',
      deliveryCount: 1,
      outcome: 'already_synced',
      startedAt: new Date('2026-05-17T20:00:00Z'),
      finishedAt: new Date('2026-05-17T20:00:00Z'),
      durationMs: 12,
    });
    expect(row.outcome).toBe('already_synced');
    expect(row.sbMessageId).toBeUndefined();
    expect(row.outboundPayloadUri).toBeUndefined();
    expect(row.payloadDigest).toBeUndefined();
  });

  it('records short-circuit outcomes (already_synced / already_claimed) with no payload URIs', async () => {
    const store = new InMemoryOrderAttemptStore();
    await store.record(base({ deliveryCount: 1, outcome: 'imported' }));
    await store.record(base({
      deliveryCount: 2,
      outcome: 'already_synced',
      outboundPayloadUri: undefined,
      payloadDigest: undefined,
    }));
    const rows = await store.listByOrderGid({
      environment: 'dev',
      connectionId: 'acme-us',
      shopifyOrderGid: 'gid://shopify/Order/100',
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]?.outcome).toBe('already_synced');
    expect(rows[0]?.outboundPayloadUri).toBeUndefined();
  });
});
