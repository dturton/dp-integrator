import { describe, expect, it } from 'vitest';
import {
  InMemoryReconciliationStore,
  type ReconciliationSnapshotInput,
} from '../src/reconciliation/reconciliation-store.js';

function base(overrides: Partial<ReconciliationSnapshotInput> = {}): ReconciliationSnapshotInput {
  return {
    environment: 'dev',
    connectionId: 'acme-us',
    businessDate: '2026-05-17',
    shopifyOrderCount: 5,
    nsTxnCount: 5,
    shopifyTotal: '500.00',
    nsTotal: '500.00',
    discrepancy: null,
    ...overrides,
  };
}

describe('InMemoryReconciliationStore', () => {
  it('upsert inserts a new snapshot', async () => {
    const store = new InMemoryReconciliationStore();
    const r = await store.upsert(base());
    expect(r.businessDate).toBe('2026-05-17');
    expect(r.shopifyOrderCount).toBe(5);
    expect(r.discrepancy).toBeNull();
    expect(store.size()).toBe(1);
  });

  it('upsert overwrites on same (env, connection, business_date)', async () => {
    const store = new InMemoryReconciliationStore();
    await store.upsert(base({ shopifyOrderCount: 5, nsTxnCount: 5, discrepancy: null }));
    await store.upsert(
      base({
        shopifyOrderCount: 6,
        nsTxnCount: 5,
        shopifyTotal: '600.00',
        nsTotal: '500.00',
        discrepancy: { countDiff: 1, totalDiff: '100.00', reason: 'count_and_total_diff' },
      }),
    );
    const all = await store.list({ environment: 'dev' });
    expect(all).toHaveLength(1);
    expect(all[0]?.shopifyOrderCount).toBe(6);
    expect(all[0]?.discrepancy).toMatchObject({ countDiff: 1 });
  });

  it('list filters by date window and connection', async () => {
    const store = new InMemoryReconciliationStore();
    await store.upsert(base({ businessDate: '2026-05-15' }));
    await store.upsert(base({ businessDate: '2026-05-16' }));
    await store.upsert(base({ businessDate: '2026-05-17' }));
    await store.upsert(base({ connectionId: 'other', businessDate: '2026-05-17' }));
    const r = await store.list({
      environment: 'dev',
      connectionId: 'acme-us',
      fromBusinessDate: '2026-05-16',
    });
    expect(r.map((s) => s.businessDate)).toEqual(['2026-05-17', '2026-05-16']);
  });

  it('partitions by environment — sandbox snapshots invisible to dev', async () => {
    const store = new InMemoryReconciliationStore();
    await store.upsert(base({ environment: 'dev' }));
    await store.upsert(base({ environment: 'sandbox' }));
    expect((await store.list({ environment: 'dev' }))).toHaveLength(1);
    expect((await store.list({ environment: 'sandbox' }))).toHaveLength(1);
  });
});
