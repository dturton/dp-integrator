import { describe, expect, it } from 'vitest';
import {
  InMemoryConnectionsRepo,
  InMemoryQueue,
  InMemorySyncWatermarkStore,
  InMemoryXrefStore,
  type Connection,
} from '@dpi/core';
import { FakeShopifyGateway, makeFakeOrder } from '@dpi/shopify-client';
import {
  CATCHUP_FLOW,
  DEFAULT_CATCHUP_CONFIG,
  pollCatchup,
  type CatchupConfig,
  type CatchupDeps,
} from '../src/triggers/order-catchup-poller.js';
import type { OrderWebhookMessage } from '../src/messages.js';

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

function build(opts: {
  connections?: readonly Connection[];
  withXref?: boolean;
  withWatermark?: boolean;
  now?: Date;
} = {}): {
  deps: CatchupDeps;
  shopify: FakeShopifyGateway;
  xrefStore: InMemoryXrefStore;
  watermarkStore: InMemorySyncWatermarkStore;
  queue: InMemoryQueue<OrderWebhookMessage>;
} {
  const shopify = new FakeShopifyGateway();
  const xrefStore = new InMemoryXrefStore();
  const watermarkStore = new InMemorySyncWatermarkStore();
  const queue = new InMemoryQueue<OrderWebhookMessage>();
  const now = opts.now ?? new Date('2026-05-17T20:00:00Z');
  return {
    shopify,
    xrefStore,
    watermarkStore,
    queue,
    deps: {
      environment: 'dev',
      connections: new InMemoryConnectionsRepo(opts.connections ?? [acme]),
      xrefStore: opts.withXref === false ? undefined : xrefStore,
      watermarkStore: opts.withWatermark === false ? undefined : watermarkStore,
      shopify,
      queue,
      now: () => now,
    },
  };
}

const TEST_CFG: CatchupConfig = {
  ...DEFAULT_CATCHUP_CONFIG,
  bootstrapLookbackHours: 24,
  overlapSecondsOnEmpty: 60,
  pageSize: 50,
};

describe('pollCatchup', () => {
  it('on first run with no watermark, bootstraps from now - lookback and enqueues matching orders', async () => {
    const { deps, shopify, queue, watermarkStore } = build({
      now: new Date('2026-05-17T20:00:00Z'),
    });
    shopify.seedOrder(makeFakeOrder({
      id: 'gid://shopify/Order/100',
      updatedAt: '2026-05-17T19:55:00Z', // within 24h lookback
    }));
    shopify.seedOrder(makeFakeOrder({
      id: 'gid://shopify/Order/101',
      updatedAt: '2026-05-15T10:00:00Z', // outside 24h lookback
    }));

    const outcome = await pollCatchup(deps, TEST_CFG);
    expect(outcome.perConnection).toHaveLength(1);
    const r = outcome.perConnection[0]!;
    expect(r.kind).toBe('polled');
    if (r.kind !== 'polled') return;
    expect(r.observed).toBe(1);
    expect(r.enqueued).toBe(1);
    expect(queue.size()).toBe(1);
    const [msg] = await queue.drain();
    expect(msg?.body.orderGid).toBe('gid://shopify/Order/100');
    expect(msg?.body.envelopeBlobUri).toMatch(/^catchup:\/\/dpi\/dev\/acme-us\//);

    // Watermark advanced to the latest observed updatedAt.
    const wm = await watermarkStore.get({
      environment: 'dev',
      connectionId: 'acme-us',
      flow: CATCHUP_FLOW,
    });
    expect(wm?.lastCursor).toBe('2026-05-17T19:55:00Z');
  });

  it('skips orders whose xref is already synced (no duplicate NS write)', async () => {
    const { deps, shopify, xrefStore, queue } = build();
    shopify.seedOrder(makeFakeOrder({
      id: 'gid://shopify/Order/200',
      updatedAt: '2026-05-17T19:55:00Z',
    }));
    await xrefStore.claim({
      environment: 'dev',
      connectionId: 'acme-us',
      entityType: 'order',
      sourceSystem: 'shopify',
      sourceId: 'gid://shopify/Order/200',
      targetSystem: 'netsuite',
      targetExternal: 'gid://shopify/Order/200',
    });
    await xrefStore.recordSuccess(
      {
        environment: 'dev',
        connectionId: 'acme-us',
        entityType: 'order',
        sourceSystem: 'shopify',
        sourceId: 'gid://shopify/Order/200',
      },
      'ns_99',
      'gid://shopify/Order/200',
    );

    const outcome = await pollCatchup(deps, TEST_CFG);
    const r = outcome.perConnection[0]!;
    if (r.kind !== 'polled') throw new Error('expected polled');
    expect(r.observed).toBe(1);
    expect(r.enqueued).toBe(0); // synced → skipped
    expect(queue.size()).toBe(0);
  });

  it('re-enqueues orders whose xref is pending or deferred', async () => {
    const { deps, shopify, xrefStore, queue } = build();
    shopify.seedOrder(makeFakeOrder({
      id: 'gid://shopify/Order/300',
      updatedAt: '2026-05-17T19:55:00Z',
    }));
    await xrefStore.claim({
      environment: 'dev',
      connectionId: 'acme-us',
      entityType: 'order',
      sourceSystem: 'shopify',
      sourceId: 'gid://shopify/Order/300',
      targetSystem: 'netsuite',
      targetExternal: 'gid://shopify/Order/300',
    });
    await xrefStore.recordFailure({
      environment: 'dev',
      connectionId: 'acme-us',
      entityType: 'order',
      sourceSystem: 'shopify',
      sourceId: 'gid://shopify/Order/300',
    });
    await xrefStore.markDeferred({
      environment: 'dev',
      connectionId: 'acme-us',
      entityType: 'order',
      sourceSystem: 'shopify',
      sourceId: 'gid://shopify/Order/300',
    });

    const outcome = await pollCatchup(deps, TEST_CFG);
    const r = outcome.perConnection[0]!;
    if (r.kind !== 'polled') throw new Error('expected polled');
    expect(r.enqueued).toBe(1);
    expect(queue.size()).toBe(1);
  });

  it('skips parked error rows until an operator replays them', async () => {
    const { deps, shopify, xrefStore, queue } = build();
    shopify.seedOrder(makeFakeOrder({
      id: 'gid://shopify/Order/301',
      updatedAt: '2026-05-17T19:55:00Z',
    }));
    await xrefStore.claim({
      environment: 'dev',
      connectionId: 'acme-us',
      entityType: 'order',
      sourceSystem: 'shopify',
      sourceId: 'gid://shopify/Order/301',
      targetSystem: 'netsuite',
      targetExternal: 'gid://shopify/Order/301',
    });
    await xrefStore.recordFailure({
      environment: 'dev',
      connectionId: 'acme-us',
      entityType: 'order',
      sourceSystem: 'shopify',
      sourceId: 'gid://shopify/Order/301',
    });

    const outcome = await pollCatchup(deps, TEST_CFG);
    const r = outcome.perConnection[0]!;
    if (r.kind !== 'polled') throw new Error('expected polled');
    expect(r.observed).toBe(1);
    expect(r.enqueued).toBe(0);
    expect(queue.size()).toBe(0);
  });

  it('advances the watermark to now-overlap when zero orders matched', async () => {
    const { deps, watermarkStore } = build({
      now: new Date('2026-05-17T20:00:00Z'),
    });
    const outcome = await pollCatchup(deps, TEST_CFG);
    const r = outcome.perConnection[0]!;
    if (r.kind !== 'polled') throw new Error('expected polled');
    expect(r.observed).toBe(0);
    expect(r.enqueued).toBe(0);
    const wm = await watermarkStore.get({
      environment: 'dev',
      connectionId: 'acme-us',
      flow: CATCHUP_FLOW,
    });
    // now - 60s = 2026-05-17T19:59:00.000Z (toISOString always includes ms)
    expect(wm?.lastCursor).toBe('2026-05-17T19:59:00.000Z');
  });

  it('skips connections cleanly when xrefStore / watermarkStore are absent (Slice-A env)', async () => {
    const { deps } = build({ withXref: false });
    const outcome = await pollCatchup(deps, TEST_CFG);
    expect(outcome.perConnection[0]).toMatchObject({
      kind: 'skipped',
      reason: 'not_ready',
    });
  });

  it('skips disabled connections', async () => {
    const disabled: Connection = { ...acme, enabled: false };
    const { deps, shopify, queue } = build({ connections: [disabled] });
    shopify.seedOrder(makeFakeOrder({
      id: 'gid://shopify/Order/400',
      updatedAt: '2026-05-17T19:55:00Z',
    }));
    const outcome = await pollCatchup(deps, TEST_CFG);
    // listEnabled excludes the disabled connection — no per-connection entry at all.
    expect(outcome.perConnection).toHaveLength(0);
    expect(queue.size()).toBe(0);
  });

  it('handles two connections independently — watermark per connection', async () => {
    const acmeUs: Connection = { ...acme };
    const acmeEu: Connection = { ...acme, connectionId: 'acme-eu', shopifyStore: 'acme-eu.myshopify.com' };
    const { deps, shopify, queue, watermarkStore } = build({ connections: [acmeUs, acmeEu] });
    // Note: FakeShopifyGateway's listOrdersUpdatedSince ignores connection (it
    // returns whatever is seeded). Seed one order updated within the window so
    // both connections see it; per-connection watermarks should advance
    // independently.
    shopify.seedOrder(makeFakeOrder({
      id: 'gid://shopify/Order/500',
      updatedAt: '2026-05-17T19:55:00Z',
    }));
    const outcome = await pollCatchup(deps, TEST_CFG);
    expect(outcome.perConnection).toHaveLength(2);
    expect(queue.size()).toBe(2); // both connections enqueue
    expect((await watermarkStore.get({ environment: 'dev', connectionId: 'acme-us', flow: CATCHUP_FLOW }))?.lastCursor).toBe('2026-05-17T19:55:00Z');
    expect((await watermarkStore.get({ environment: 'dev', connectionId: 'acme-eu', flow: CATCHUP_FLOW }))?.lastCursor).toBe('2026-05-17T19:55:00Z');
  });

  it('uses the watermark from a prior poll as `since` on the next run', async () => {
    const { deps, shopify, watermarkStore } = build({
      now: new Date('2026-05-17T20:30:00Z'),
    });
    // Seed an existing watermark from a previous poll.
    await watermarkStore.set({
      environment: 'dev',
      connectionId: 'acme-us',
      flow: CATCHUP_FLOW,
      cursor: '2026-05-17T20:00:00Z',
    });
    // An order updated BEFORE the watermark — should NOT be returned by the
    // fake's filter (since=2026-05-17T20:00:00Z).
    shopify.seedOrder(makeFakeOrder({
      id: 'gid://shopify/Order/600',
      updatedAt: '2026-05-17T19:55:00Z',
    }));
    // An order updated AFTER the watermark — should be returned.
    shopify.seedOrder(makeFakeOrder({
      id: 'gid://shopify/Order/601',
      updatedAt: '2026-05-17T20:15:00Z',
    }));
    const outcome = await pollCatchup(deps, TEST_CFG);
    const r = outcome.perConnection[0]!;
    if (r.kind !== 'polled') throw new Error('expected polled');
    expect(r.observed).toBe(1);
    expect(r.fromCursor).toBe('2026-05-17T20:00:00Z');
    expect(r.newCursor).toBe('2026-05-17T20:15:00Z');
  });

  it('walks multiple Shopify pages in one run before advancing the watermark', async () => {
    const cfg: CatchupConfig = { ...TEST_CFG, pageSize: 2 };
    const { deps, shopify, queue, watermarkStore } = build({
      now: new Date('2026-05-17T20:30:00Z'),
    });
    shopify.seedOrder(makeFakeOrder({
      id: 'gid://shopify/Order/700',
      updatedAt: '2026-05-17T20:01:00Z',
    }));
    shopify.seedOrder(makeFakeOrder({
      id: 'gid://shopify/Order/701',
      updatedAt: '2026-05-17T20:02:00Z',
    }));
    shopify.seedOrder(makeFakeOrder({
      id: 'gid://shopify/Order/702',
      updatedAt: '2026-05-17T20:03:00Z',
    }));

    const outcome = await pollCatchup(deps, cfg);
    const r = outcome.perConnection[0]!;
    if (r.kind !== 'polled') throw new Error('expected polled');
    expect(r.observed).toBe(3);
    expect(r.enqueued).toBe(3);
    expect(queue.size()).toBe(3);
    expect((await watermarkStore.get({
      environment: 'dev',
      connectionId: 'acme-us',
      flow: CATCHUP_FLOW,
    }))?.lastCursor).toBe('2026-05-17T20:03:00Z');
  });
});
