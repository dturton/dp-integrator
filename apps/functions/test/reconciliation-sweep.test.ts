import { describe, expect, it } from 'vitest';
import {
  InMemoryConnectionsRepo,
  InMemoryOrderSyncLogStore,
  InMemoryReconciliationStore,
  type Connection,
} from '@dpi/core';
import { FakeShopifyGateway } from '@dpi/shopify-client';
import {
  DEFAULT_RECONCILIATION_CONFIG,
  reconcileOneDay,
  runReconciliation,
  type ReconciliationDeps,
} from '../src/triggers/reconciliation-sweep.js';
import type { Telemetry } from '../src/telemetry.js';

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

interface TelSpy {
  drifts: Array<{
    environment: string;
    connectionId: string;
    businessDate: string;
    countDiff: number;
    totalDiff: string;
  }>;
}

function spyTelemetry(): { telemetry: Telemetry; spy: TelSpy } {
  const spy: TelSpy = { drifts: [] };
  const noop = (): void => {};
  return {
    spy,
    telemetry: {
      trackImport: noop,
      trackPark: noop,
      trackIgnored: noop,
      trackCatchupPoll: noop,
      trackAuthError: noop,
      trackReconciliationDrift: (a) => spy.drifts.push(a),
      flush: async () => undefined,
    },
  };
}

function build(opts: { now?: Date; connections?: readonly Connection[] } = {}): {
  deps: ReconciliationDeps;
  shopify: FakeShopifyGateway;
  ledger: InMemoryOrderSyncLogStore;
  recon: InMemoryReconciliationStore;
  spy: TelSpy;
} {
  const shopify = new FakeShopifyGateway();
  const ledger = new InMemoryOrderSyncLogStore();
  const recon = new InMemoryReconciliationStore();
  const { telemetry, spy } = spyTelemetry();
  return {
    shopify,
    ledger,
    recon,
    spy,
    deps: {
      environment: 'dev',
      connections: new InMemoryConnectionsRepo(opts.connections ?? [acme]),
      shopify,
      orderSyncLog: ledger,
      reconciliationStore: recon,
      telemetry,
      now: opts.now ? () => opts.now! : undefined,
    },
  };
}

function seedShopifyOrders(
  fake: FakeShopifyGateway,
  list: Array<{ id: string; total: string; processedAt: string; test?: boolean }>,
): void {
  for (const o of list) {
    // We don't need a full ShopifyOrder shape for the aggregate fake — only
    // a minimal record that satisfies the filter + total.
    fake.seedOrder({
      id: o.id,
      name: o.id,
      createdAt: o.processedAt,
      updatedAt: o.processedAt,
      processedAt: o.processedAt,
      currencyCode: 'USD',
      totalPrice: { amount: o.total, currencyCode: 'USD' },
      subtotalPrice: { amount: o.total, currencyCode: 'USD' },
      totalTax: { amount: '0.00', currencyCode: 'USD' },
      totalShippingPrice: { amount: '0.00', currencyCode: 'USD' },
      totalDiscounts: { amount: '0.00', currencyCode: 'USD' },
      financialStatus: 'paid',
      fulfillmentStatus: null,
      test: o.test ?? false,
      fraudHold: false,
      customer: null,
      lineItems: [],
      shippingLines: [],
      taxLines: [],
      transactions: [],
    });
  }
}

async function seedLedger(
  store: InMemoryOrderSyncLogStore,
  list: Array<{ orderId: string; total: string; syncedAt: Date }>,
): Promise<void> {
  for (const r of list) {
    await store.upsert({
      environment: 'dev',
      connectionId: 'acme-us',
      shopifyOrderGid: `gid://shopify/Order/${r.orderId}`,
      shopifyOrderId: r.orderId,
      status: 'imported',
      currencyCode: 'USD',
      totalPrice: r.total,
      syncedAt: r.syncedAt,
      nsAccountId: '1234567',
      nsRecordType: 'salesorder',
      nsInternalId: r.orderId,
    });
  }
}

describe('reconcileOneDay', () => {
  it('matches Shopify totals to ledger totals → no drift, snapshot has discrepancy=null', async () => {
    const { deps, shopify, ledger, recon, spy } = build();
    seedShopifyOrders(shopify, [
      { id: 'gid://shopify/Order/1', total: '100.00', processedAt: '2026-05-17T10:00:00Z' },
      { id: 'gid://shopify/Order/2', total: '200.00', processedAt: '2026-05-17T15:00:00Z' },
    ]);
    await seedLedger(ledger, [
      { orderId: '1', total: '100.00', syncedAt: new Date('2026-05-17T10:01:00Z') },
      { orderId: '2', total: '200.00', syncedAt: new Date('2026-05-17T15:01:00Z') },
    ]);

    const result = await reconcileOneDay(deps, 'acme-us', '2026-05-17');
    expect(result.drift).toBe(false);
    expect(result.snapshot?.shopifyOrderCount).toBe(2);
    expect(result.snapshot?.nsTxnCount).toBe(2);
    expect(result.snapshot?.shopifyTotal).toBe('300.00');
    expect(result.snapshot?.nsTotal).toBe('300.00');
    expect(result.snapshot?.discrepancy).toBeNull();
    expect(spy.drifts).toHaveLength(0);
    expect(recon.size()).toBe(1);
  });

  it('flags drift when Shopify has more orders than the ledger (missed webhook)', async () => {
    const { deps, shopify, ledger, spy } = build();
    seedShopifyOrders(shopify, [
      { id: 'gid://shopify/Order/1', total: '100.00', processedAt: '2026-05-17T10:00:00Z' },
      { id: 'gid://shopify/Order/2', total: '200.00', processedAt: '2026-05-17T15:00:00Z' },
    ]);
    await seedLedger(ledger, [
      // Only one order in ledger — webhook for #2 was missed
      { orderId: '1', total: '100.00', syncedAt: new Date('2026-05-17T10:01:00Z') },
    ]);

    const result = await reconcileOneDay(deps, 'acme-us', '2026-05-17');
    expect(result.drift).toBe(true);
    expect(result.snapshot?.discrepancy).toMatchObject({
      countDiff: 1,
      totalDiff: '200.00',
      reason: 'count_and_total_diff',
    });
    expect(spy.drifts).toHaveLength(1);
    expect(spy.drifts[0]?.countDiff).toBe(1);
  });

  it('flags drift on total-only mismatch (count agrees, total off)', async () => {
    const { deps, shopify, ledger } = build();
    seedShopifyOrders(shopify, [
      { id: 'gid://shopify/Order/1', total: '100.00', processedAt: '2026-05-17T10:00:00Z' },
    ]);
    await seedLedger(ledger, [
      { orderId: '1', total: '99.00', syncedAt: new Date('2026-05-17T10:01:00Z') },
    ]);
    const result = await reconcileOneDay(deps, 'acme-us', '2026-05-17');
    expect(result.drift).toBe(true);
    expect(result.snapshot?.discrepancy).toMatchObject({
      countDiff: 0,
      reason: 'total_diff',
    });
  });

  it('treats a sub-tolerance total diff as no drift (rounding noise)', async () => {
    const { deps, shopify, ledger } = build();
    seedShopifyOrders(shopify, [
      { id: 'gid://shopify/Order/1', total: '100.00', processedAt: '2026-05-17T10:00:00Z' },
    ]);
    await seedLedger(ledger, [
      { orderId: '1', total: '99.99', syncedAt: new Date('2026-05-17T10:01:00Z') },
    ]);
    const result = await reconcileOneDay(deps, 'acme-us', '2026-05-17');
    expect(result.drift).toBe(false);
    expect(result.snapshot?.discrepancy).toBeNull();
  });

  it('excludes test orders from the Shopify side', async () => {
    const { deps, shopify, ledger } = build();
    seedShopifyOrders(shopify, [
      { id: 'gid://shopify/Order/1', total: '100.00', processedAt: '2026-05-17T10:00:00Z' },
      { id: 'gid://shopify/Order/2', total: '999.00', processedAt: '2026-05-17T11:00:00Z', test: true },
    ]);
    await seedLedger(ledger, [
      { orderId: '1', total: '100.00', syncedAt: new Date('2026-05-17T10:01:00Z') },
    ]);
    const result = await reconcileOneDay(deps, 'acme-us', '2026-05-17');
    expect(result.drift).toBe(false);
    expect(result.snapshot?.shopifyOrderCount).toBe(1);
    expect(result.snapshot?.shopifyTotal).toBe('100.00');
  });

  it('skips when orderSyncLog or reconciliationStore is missing', async () => {
    const { deps } = build();
    const r = await reconcileOneDay(
      { ...deps, orderSyncLog: undefined },
      'acme-us',
      '2026-05-17',
    );
    expect(r.skipped).toBe('not_ready');
    expect(r.snapshot).toBeUndefined();
  });
});

describe('runReconciliation', () => {
  it('iterates every enabled connection × daysBack', async () => {
    const acmeEu: Connection = { ...acme, connectionId: 'acme-eu', shopifyStore: 'acme-eu.myshopify.com' };
    const { deps, recon } = build({ now: new Date('2026-05-18T06:00:00Z'), connections: [acme, acmeEu] });
    const out = await runReconciliation(deps, { ...DEFAULT_RECONCILIATION_CONFIG, daysBack: 2 });
    // 2 connections × 2 days = 4 snapshots
    expect(out.perConnection).toHaveLength(4);
    expect(recon.size()).toBe(4);
    // Days are yesterday (2026-05-17) + day before (2026-05-16)
    const dates = out.perConnection.map((r) => r.businessDate).sort();
    expect(dates).toEqual(['2026-05-16', '2026-05-16', '2026-05-17', '2026-05-17']);
  });
});
