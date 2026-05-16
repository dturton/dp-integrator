import { describe, expect, it } from 'vitest';
import { FakeNetSuiteGateway } from '../src/fake-gateway.js';

describe('FakeNetSuiteGateway externalId upsert semantics', () => {
  it('first upsert creates; second upsert with same externalId updates the same record', async () => {
    const gw = new FakeNetSuiteGateway();
    const first = await gw.upsertByExternalId({
      nsAccountId: '1234567',
      recordType: 'salesOrder',
      externalId: 'gid://shopify/Order/1',
      payload: { tranId: 'SO-1', subsidiary: 1 },
    });
    expect(first.created).toBe(true);

    const second = await gw.upsertByExternalId({
      nsAccountId: '1234567',
      recordType: 'salesOrder',
      externalId: 'gid://shopify/Order/1',
      payload: { tranId: 'SO-1', subsidiary: 1, memo: 'updated' },
    });
    expect(second.created).toBe(false);
    expect(second.internalId).toBe(first.internalId);

    // Exactly ONE record exists — the brief's idempotency invariant.
    const records = gw.getRecords('1234567', 'salesOrder');
    expect(records.size).toBe(1);
  });

  it('different NS accounts maintain isolated stores (multi-tenant invariant)', async () => {
    const gw = new FakeNetSuiteGateway();
    await gw.upsertByExternalId({
      nsAccountId: '111',
      recordType: 'salesOrder',
      externalId: 'gid://shopify/Order/1',
      payload: { tranId: 'SO-A1' },
    });
    await gw.upsertByExternalId({
      nsAccountId: '222',
      recordType: 'salesOrder',
      externalId: 'gid://shopify/Order/1',
      payload: { tranId: 'SO-B1' },
    });
    expect(gw.getRecords('111', 'salesOrder').size).toBe(1);
    expect(gw.getRecords('222', 'salesOrder').size).toBe(1);
    const a = await gw.findByExternalId({
      nsAccountId: '111',
      recordType: 'salesOrder',
      externalId: 'gid://shopify/Order/1',
    });
    const b = await gw.findByExternalId({
      nsAccountId: '222',
      recordType: 'salesOrder',
      externalId: 'gid://shopify/Order/1',
    });
    expect((a as { tranId: string }).tranId).toBe('SO-A1');
    expect((b as { tranId: string }).tranId).toBe('SO-B1');
  });

  it('failNext throws the queued error on the next call only', async () => {
    const gw = new FakeNetSuiteGateway();
    gw.failNext(new Error('boom'));
    await expect(
      gw.upsertByExternalId({
        nsAccountId: '1',
        recordType: 'salesOrder',
        externalId: 'gid://shopify/Order/1',
        payload: {},
      }),
    ).rejects.toThrow('boom');

    // Subsequent calls succeed.
    const ok = await gw.upsertByExternalId({
      nsAccountId: '1',
      recordType: 'salesOrder',
      externalId: 'gid://shopify/Order/1',
      payload: {},
    });
    expect(ok.created).toBe(true);
    expect(gw.attemptCount()).toBe(2);
  });
});
