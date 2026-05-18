import { describe, expect, it } from 'vitest';
import {
  InMemoryOrderSyncLogStore,
  type OrderSyncLogInput,
} from '../src/order-sync-log/order-sync-log-store.js';

function base(overrides: Partial<OrderSyncLogInput> = {}): OrderSyncLogInput {
  return {
    environment: 'dev',
    connectionId: 'acme-us',
    shopifyOrderGid: 'gid://shopify/Order/100',
    shopifyOrderId: '100',
    shopifyOrderName: '#1001',
    customerEmail: 'buyer@example.com',
    currencyCode: 'USD',
    totalPrice: '120.00',
    status: 'imported',
    nsAccountId: '1234567',
    nsRecordType: 'salesorder',
    nsInternalId: '664',
    syncedAt: new Date('2026-05-17T20:00:00Z'),
    ...overrides,
  };
}

describe('InMemoryOrderSyncLogStore', () => {
  it('upsert inserts a new row and findByOrderGid returns it', async () => {
    const store = new InMemoryOrderSyncLogStore();
    await store.upsert(base());
    const row = await store.findByOrderGid({
      environment: 'dev',
      connectionId: 'acme-us',
      shopifyOrderGid: 'gid://shopify/Order/100',
    });
    expect(row?.status).toBe('imported');
    expect(row?.shopifyOrderName).toBe('#1001');
    expect(row?.nsInternalId).toBe('664');
  });

  it('upsert updates the existing row (same gid → same id, transitions status)', async () => {
    const store = new InMemoryOrderSyncLogStore();
    await store.upsert(base({ status: 'parked', parkStage: 'mapping', parkDetail: 'discount unmapped', nsInternalId: undefined, syncedAt: undefined }));
    const first = await store.findByOrderGid({
      environment: 'dev',
      connectionId: 'acme-us',
      shopifyOrderGid: 'gid://shopify/Order/100',
    });
    expect(first?.status).toBe('parked');

    await store.upsert(base({ status: 'imported', nsInternalId: '664' }));
    const second = await store.findByOrderGid({
      environment: 'dev',
      connectionId: 'acme-us',
      shopifyOrderGid: 'gid://shopify/Order/100',
    });
    expect(second?.id).toBe(first?.id); // same row, not a new one
    expect(second?.status).toBe('imported');
    expect(second?.nsInternalId).toBe('664');
    expect(store.size()).toBe(1);
  });

  it('upsert leaves park fields blank when the new status is imported', async () => {
    const store = new InMemoryOrderSyncLogStore();
    // First: parked (park fields populated)
    await store.upsert(base({
      status: 'parked',
      parkStage: 'mapping',
      parkDetail: 'discount unmapped',
      nsInternalId: undefined,
    }));
    // Second: imported, NO park fields in input
    await store.upsert(base({ status: 'imported' }));
    const row = await store.findByOrderGid({
      environment: 'dev',
      connectionId: 'acme-us',
      shopifyOrderGid: 'gid://shopify/Order/100',
    });
    // InMemory impl rebuilds the row from input each time; the absent park
    // fields don't survive. (Postgres impl follows the same semantics via
    // UPSERT setting each column to EXCLUDED.value.)
    expect(row?.parkStage).toBeUndefined();
    expect(row?.parkDetail).toBeUndefined();
  });

  it('list filters by status + connectionId, ordered by syncedAt desc', async () => {
    const store = new InMemoryOrderSyncLogStore();
    await store.upsert(base({
      shopifyOrderGid: 'gid://shopify/Order/100',
      shopifyOrderId: '100',
      syncedAt: new Date('2026-05-17T20:00:00Z'),
    }));
    await store.upsert(base({
      shopifyOrderGid: 'gid://shopify/Order/101',
      shopifyOrderId: '101',
      syncedAt: new Date('2026-05-17T20:10:00Z'),
    }));
    await store.upsert(base({
      shopifyOrderGid: 'gid://shopify/Order/102',
      shopifyOrderId: '102',
      status: 'parked',
      parkStage: 'fetch',
      nsInternalId: undefined,
      syncedAt: undefined,
    }));
    const imported = await store.list({ environment: 'dev', status: 'imported' });
    expect(imported.map((r) => r.shopifyOrderId)).toEqual(['101', '100']);
    const all = await store.list({ environment: 'dev' });
    expect(all).toHaveLength(3);
  });

  it('list partitions by environment — sandbox does not see dev rows', async () => {
    const store = new InMemoryOrderSyncLogStore();
    await store.upsert(base({ environment: 'dev' }));
    await store.upsert(base({ environment: 'sandbox', shopifyOrderGid: 'gid://shopify/Order/200', shopifyOrderId: '200' }));
    expect((await store.list({ environment: 'dev' }))).toHaveLength(1);
    expect((await store.list({ environment: 'sandbox' }))).toHaveLength(1);
  });

  it('list respects limit', async () => {
    const store = new InMemoryOrderSyncLogStore();
    for (let i = 0; i < 5; i++) {
      await store.upsert(base({
        shopifyOrderGid: `gid://shopify/Order/${i}`,
        shopifyOrderId: String(i),
        syncedAt: new Date(2026, 4, 17, 20, i),
      }));
    }
    const r = await store.list({ environment: 'dev', limit: 3 });
    expect(r).toHaveLength(3);
  });
});
