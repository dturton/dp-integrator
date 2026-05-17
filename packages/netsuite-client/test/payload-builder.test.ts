import { describe, expect, it } from 'vitest';
import type { Connection } from '@dpi/core';
import { InMemoryLookupResolver, MapDeriveRegistry } from '@dpi/mapping-engine';
import { makeFakeOrder } from '@dpi/shopify-client';
import {
  buildOrderPayload,
  defaultDeriveRegistry,
  netsuiteOrderRecordType,
  parseShopifyDate,
  shopifyLineToItemLine,
} from '../src/index.js';

const acme: Connection = {
  connectionId: 'acme-us',
  environment: 'dev',
  shopifyStore: 'acme-us.myshopify.com',
  shopifyAppTokenRef: 'shopify-client-id-acme-us',
  shopifyWebhookSecretRef: 'shopify-webhook-secret-acme-us',
  nsAccountId: '1234567',
  nsSubsidiary: '1',
  nsLocation: '10',
  baseCurrency: 'USD',
  taxEngine: 'suitetax',
  orderTarget: 'sales_order',
  mapVersion: 'v1',
  enabled: true,
};

function lookupsWithDefaults(): InMemoryLookupResolver {
  return new InMemoryLookupResolver({
    lookup_currency: { USD: '1', EUR: '2' },
    lookup_payment_method: { shopify_payments: '12' },
  });
}

describe('derive fns', () => {
  it('parseShopifyDate extracts YYYY-MM-DD from ISO timestamp', () => {
    const out = parseShopifyDate({ field: 'processedAt' }, { processedAt: '2026-05-17T13:11:53Z' });
    expect(out).toBe('2026-05-17');
  });

  it('parseShopifyDate returns null on missing field', () => {
    const out = parseShopifyDate({ field: 'missing' }, {});
    expect(out).toBeNull();
  });

  it('parseShopifyDate throws on a non-date string', () => {
    expect(() => parseShopifyDate({ field: 'x' }, { x: 'not a date' })).toThrow(/not a valid ISO date/);
  });

  it('shopifyLineToItemLine fans Shopify lines to NS line objects', () => {
    const order = makeFakeOrder();
    const lines = shopifyLineToItemLine({}, order) as Array<Record<string, unknown>>;
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      item: 'WIDGET-1',
      quantity: 2,
      rate: '50.00',
      description: 'Widget',
      amount: '100.00',
      externalid: 'gid://shopify/LineItem/1',
    });
  });

  it('shopifyLineToItemLine uses defaultItemId when supplied (overrides sku)', () => {
    const order = makeFakeOrder();
    const lines = shopifyLineToItemLine({ defaultItemId: '999' }, order) as Array<Record<string, unknown>>;
    expect(lines[0]?.['item']).toBe('999');
  });
});

describe('buildOrderPayload', () => {
  it('builds the standard NS Sales Order payload', async () => {
    const order = makeFakeOrder();
    const r = await buildOrderPayload({
      connection: acme,
      order,
      customerInternalId: 'ns_cust_42',
      lookups: lookupsWithDefaults(),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload).toMatchObject({
      subsidiary: '1',
      tranid: '#1001',
      externalid: 'gid://shopify/Order/100',
      entity: 'ns_cust_42',
      trandate: '2026-05-16',
      currency: '1',
      paymentmethod: '12',
      location: '10',
    });
    expect(r.payload.item).toHaveLength(1);
    expect(r.payload.item[0]).toMatchObject({ item: 'WIDGET-1', quantity: 2 });
    expect(r.payload.shipping).toHaveLength(1);
  });

  it('omits `location` when connection.nsLocation is unset', async () => {
    const order = makeFakeOrder();
    const { nsLocation: _drop, ...rest } = acme;
    const r = await buildOrderPayload({
      connection: rest as Connection,
      order,
      customerInternalId: 'ns_cust_42',
      lookups: lookupsWithDefaults(),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload).not.toHaveProperty('location');
  });

  it('omits the shipping sublist when the order has no shipping lines', async () => {
    const order = makeFakeOrder({ shippingLines: [] });
    const r = await buildOrderPayload({
      connection: acme,
      order,
      customerInternalId: 'ns_cust_42',
      lookups: lookupsWithDefaults(),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload).not.toHaveProperty('shipping');
  });

  it('parks when the order has no line items', async () => {
    const order = makeFakeOrder({ lineItems: [] });
    const r = await buildOrderPayload({
      connection: acme,
      order,
      customerInternalId: 'ns_cust_42',
      lookups: lookupsWithDefaults(),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.parked).toMatchObject({ reason: 'unmapped_construct', construct: 'lineItems' });
  });

  it('parks when currency lookup misses (required mapping)', async () => {
    const order = makeFakeOrder({ currencyCode: 'GBP' });
    const lookups = new InMemoryLookupResolver({ lookup_currency: { USD: '1' } });
    const r = await buildOrderPayload({
      connection: acme,
      order,
      customerInternalId: 'ns_cust_42',
      lookups,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.parked).toMatchObject({
      reason: 'unmapped_construct',
      construct: 'lookup_currency',
      evidence: { currencyCode: 'GBP' },
    });
  });

  it('payment method lookup is optional (continues on miss)', async () => {
    const order = makeFakeOrder({
      transactions: [
        {
          id: 'gid://shopify/Transaction/9',
          kind: 'sale',
          status: 'success',
          gateway: 'unknown_gateway',
          amount: { amount: '0.00', currencyCode: 'USD' },
          processedAt: '2026-05-16T10:00:00Z',
        },
      ],
    });
    const r = await buildOrderPayload({
      connection: acme,
      order,
      customerInternalId: 'ns_cust_42',
      lookups: lookupsWithDefaults(),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload.paymentmethod).toBeNull();
  });

  it('accepts a custom derive registry', async () => {
    const order = makeFakeOrder();
    const customDerives = new MapDeriveRegistry({
      ...Object.fromEntries(
        ['parseShopifyDate', 'shopifyLineToItemLine', 'shopifyShippingToLine'].map((n) => {
          // re-export the defaults
          const reg = defaultDeriveRegistry();
          return [n, reg.get(n)!];
        }),
      ),
      // could register additional fns here for connection-specific maps
    });
    const r = await buildOrderPayload({
      connection: acme,
      order,
      customerInternalId: 'ns_cust_42',
      lookups: lookupsWithDefaults(),
      derives: customDerives,
    });
    expect(r.ok).toBe(true);
  });
});

describe('netsuiteOrderRecordType', () => {
  it('maps sales_order → salesorder', () => {
    expect(netsuiteOrderRecordType({ ...acme, orderTarget: 'sales_order' })).toBe('salesorder');
  });

  it('maps cash_sale → cashsale', () => {
    expect(netsuiteOrderRecordType({ ...acme, orderTarget: 'cash_sale' })).toBe('cashsale');
  });
});
