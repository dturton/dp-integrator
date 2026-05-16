import { describe, expect, it } from 'vitest';
import { InMemoryXrefStore } from '../src/xref/xref-store.js';
import type { ClaimInput } from '../src/xref/xref-store.js';

function input(overrides: Partial<ClaimInput> = {}): ClaimInput {
  return {
    environment: 'prod',
    connectionId: 'conn-acme',
    entityType: 'order',
    sourceSystem: 'shopify',
    sourceId: 'gid://shopify/Order/100',
    targetSystem: 'netsuite',
    targetExternal: 'gid://shopify/Order/100',
    ...overrides,
  };
}

describe('InMemoryXrefStore', () => {
  it('claims a new row on first call', async () => {
    const store = new InMemoryXrefStore();
    const result = await store.claim(input());
    expect(result.outcome).toBe('claimed');
    expect(result.row.status).toBe('pending');
    expect(result.row.targetId).toBeNull();
  });

  it('returns already_claimed on redelivery of a pending row (the invariant)', async () => {
    const store = new InMemoryXrefStore();
    const first = await store.claim(input());
    const second = await store.claim(input());
    expect(first.outcome).toBe('claimed');
    expect(second.outcome).toBe('already_claimed');
    // Exactly one xref row exists.
    expect(store.size()).toBe(1);
  });

  it('returns already_synced once recordSuccess has run', async () => {
    const store = new InMemoryXrefStore();
    await store.claim(input());
    await store.recordSuccess(input(), 'ns_internal_42', 'gid://shopify/Order/100');
    const second = await store.claim(input());
    expect(second.outcome).toBe('already_synced');
    expect(second.row.targetId).toBe('ns_internal_42');
  });

  it('serializes concurrent claims so exactly one wins', async () => {
    const store = new InMemoryXrefStore();
    const concurrentCount = 25;
    const results = await Promise.all(
      Array.from({ length: concurrentCount }, () => store.claim(input())),
    );
    const claimed = results.filter((r) => r.outcome === 'claimed');
    const dups = results.filter((r) => r.outcome === 'already_claimed');
    expect(claimed).toHaveLength(1);
    expect(dups).toHaveLength(concurrentCount - 1);
    expect(store.size()).toBe(1);
  });

  it('keys claims per (environment, connection, source_id) — sandbox does not collide with prod', async () => {
    const store = new InMemoryXrefStore();
    const prodResult = await store.claim(input({ environment: 'prod' }));
    const sbxResult = await store.claim(input({ environment: 'sandbox' }));
    expect(prodResult.outcome).toBe('claimed');
    expect(sbxResult.outcome).toBe('claimed');
    expect(store.size()).toBe(2);
  });

  it('recordFailure flips the row to error but keeps it claimable for retry', async () => {
    const store = new InMemoryXrefStore();
    await store.claim(input());
    await store.recordFailure(input());
    const row = await store.lookup(input());
    expect(row?.status).toBe('error');
    // A retry claim returns already_claimed (an existing error row), NOT a fresh claim.
    const retry = await store.claim(input());
    expect(retry.outcome).toBe('already_claimed');
  });

  it('markIgnored creates a sentinel row so future deliveries no-op', async () => {
    const store = new InMemoryXrefStore();
    await store.markIgnored(input());
    const result = await store.claim(input());
    expect(result.outcome).toBe('ignored');
  });
});
