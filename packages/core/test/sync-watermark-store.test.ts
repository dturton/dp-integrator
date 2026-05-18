import { describe, expect, it } from 'vitest';
import { InMemorySyncWatermarkStore } from '../src/watermark/sync-watermark-store.js';

const parts = {
  environment: 'dev' as const,
  connectionId: 'acme-us',
  flow: 'order-catchup',
};

describe('InMemorySyncWatermarkStore', () => {
  it('returns undefined for a flow that has never been polled', async () => {
    const store = new InMemorySyncWatermarkStore();
    expect(await store.get(parts)).toBeUndefined();
  });

  it('set then get round-trips the cursor', async () => {
    const store = new InMemorySyncWatermarkStore();
    await store.set({ ...parts, cursor: '2026-05-17T20:00:00Z' });
    const row = await store.get(parts);
    expect(row?.lastCursor).toBe('2026-05-17T20:00:00Z');
    expect(row?.environment).toBe('dev');
    expect(row?.connectionId).toBe('acme-us');
    expect(row?.flow).toBe('order-catchup');
  });

  it('set overwrites the prior cursor (cursor moves forward across polls)', async () => {
    const store = new InMemorySyncWatermarkStore();
    await store.set({ ...parts, cursor: '2026-05-17T20:00:00Z' });
    await store.set({ ...parts, cursor: '2026-05-17T20:10:00Z' });
    expect((await store.get(parts))?.lastCursor).toBe('2026-05-17T20:10:00Z');
    expect(store.size()).toBe(1);
  });

  it('keys by (environment, connectionId, flow) — sandbox and dev do not collide', async () => {
    const store = new InMemorySyncWatermarkStore();
    await store.set({ ...parts, cursor: 'dev-cursor' });
    await store.set({ ...parts, environment: 'sandbox', cursor: 'sandbox-cursor' });
    expect((await store.get(parts))?.lastCursor).toBe('dev-cursor');
    expect((await store.get({ ...parts, environment: 'sandbox' }))?.lastCursor).toBe('sandbox-cursor');
    expect(store.size()).toBe(2);
  });
});
