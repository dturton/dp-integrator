import { describe, expect, it } from 'vitest';
import type { Connection } from '@dpi/core';
import { InMemoryLookupResolver, MapDeriveRegistry } from '@dpi/mapping-engine';
import { makeFakeOrder } from '@dpi/shopify-client';
import {
  buildOrderPayload,
  defaultDeriveRegistry,
  extractShopifyOrderId,
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
  nsSubsidiary: '2',
  nsLocation: '1',
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
    expect(parseShopifyDate({ field: 'processedAt' }, { processedAt: '2026-05-17T13:11:53Z' })).toBe('2026-05-17');
  });

  it('parseShopifyDate returns null on missing field', () => {
    expect(parseShopifyDate({ field: 'missing' }, {})).toBeNull();
  });

  it('parseShopifyDate throws on a non-date string', () => {
    expect(() => parseShopifyDate({ field: 'x' }, { x: 'not a date' })).toThrow(/not a valid ISO date/);
  });

  it('extractShopifyOrderId returns the digit tail of a Shopify GID', () => {
    const order = makeFakeOrder({ id: 'gid://shopify/Order/6845372563619' });
    expect(extractShopifyOrderId({}, order)).toBe('6845372563619');
  });

  it('extractShopifyOrderId throws if the id has no digit tail', () => {
    const order = makeFakeOrder({ id: 'gid://shopify/Order/' });
    expect(() => extractShopifyOrderId({}, order)).toThrow(/cannot extract numeric id/);
  });

  it('extractShopifyOrderId wires through extraOrderHeaderMappings to a NS custom field', async () => {
    const order = makeFakeOrder({ id: 'gid://shopify/Order/6845372563619' });
    const r = await buildOrderPayload({
      connection: {
        ...acme,
        extraOrderHeaderMappings: [
          { kind: 'derive', fn: 'extractShopifyOrderId', args: {}, to: 'custbody_shopify_order_id' },
        ],
      },
      order,
      customerInternalId: '4203',
      lookups: lookupsWithDefaults(),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload['custbody_shopify_order_id']).toBe('6845372563619');
  });

  it('shopifyLineToItemLine emits item as plain string id (builder wraps later)', () => {
    const order = makeFakeOrder();
    const lines = shopifyLineToItemLine({}, order) as Array<Record<string, unknown>>;
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      item: 'WIDGET-1',
      quantity: 2,
      rate: 50,
      amount: 100,
      description: 'Widget',
    });
  });

  it('shopifyLineToItemLine uses defaultItemId when supplied (overrides sku)', () => {
    const order = makeFakeOrder();
    const lines = shopifyLineToItemLine({ defaultItemId: '6540' }, order) as Array<Record<string, unknown>>;
    expect(lines[0]?.['item']).toBe('6540');
  });
});

describe('buildOrderPayload', () => {
  it('builds the NS payload with refs wrapped + line sublist + camelCase fields', async () => {
    const order = makeFakeOrder();
    const r = await buildOrderPayload({
      connection: acme,
      order,
      customerInternalId: '4203',
      lookups: lookupsWithDefaults(),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload).toMatchObject({
      subsidiary: { id: '2' },
      orderStatus: { id: 'B' },
      tranId: '#1001',
      externalId: 'gid://shopify/Order/100',
      entity: { id: '4203' },
      tranDate: '2026-05-16',
      currency: { id: '1' },
      paymentMethod: { id: '12' },
      location: { id: '1' },
    });
    expect(r.payload.item.items).toHaveLength(1);
    expect(r.payload.item.items[0]).toMatchObject({
      item: { id: 'WIDGET-1' },
      quantity: 2,
      rate: 50,
      amount: 100,
    });
    expect(r.payload.shipping?.items).toHaveLength(1);
    expect(r.payload.shipping?.items[0]).toMatchObject({ item: { id: 'SHIP-STANDARD' } });
  });

  it('appends connection.extraOrderHeaderMappings to the default map', async () => {
    const order = makeFakeOrder();
    const withExtras: Connection = {
      ...acme,
      extraOrderHeaderMappings: [
        { kind: 'constant', value: '2', to: 'custbody_internal_status' },
        { kind: 'constant', value: 'A', to: 'orderStatus' }, // override default 'B'
      ],
    };
    const r = await buildOrderPayload({
      connection: withExtras,
      order,
      customerInternalId: '4203',
      lookups: lookupsWithDefaults(),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload['custbody_internal_status']).toBe('2');
    expect(r.payload.orderStatus).toEqual({ id: 'A' }); // extras override default
  });

  it('omits location when connection.nsLocation is unset', async () => {
    const order = makeFakeOrder();
    const { nsLocation: _drop, ...rest } = acme;
    const r = await buildOrderPayload({
      connection: rest as Connection,
      order,
      customerInternalId: '4203',
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
      customerInternalId: '4203',
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
      customerInternalId: '4203',
      lookups: lookupsWithDefaults(),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.parked).toMatchObject({ reason: 'unmapped_construct', construct: 'lineItems' });
  });

  it('parks when a required lookup misses', async () => {
    const order = makeFakeOrder({ currencyCode: 'GBP' });
    const lookups = new InMemoryLookupResolver({ lookup_currency: { USD: '1' } });
    const r = await buildOrderPayload({
      connection: acme,
      order,
      customerInternalId: '4203',
      lookups,
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.parked).toMatchObject({
      reason: 'unmapped_construct',
      construct: 'lookup_currency',
    });
  });

  it('payment method lookup is optional (paymentMethod field missing on miss)', async () => {
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
      customerInternalId: '4203',
      lookups: lookupsWithDefaults(),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // required=false on miss writes null → ref wrap returns null as-is.
    expect(r.payload['paymentMethod']).toBeNull();
  });

  it('accepts a custom derive registry', async () => {
    const order = makeFakeOrder();
    const customDerives = new MapDeriveRegistry({
      ...Object.fromEntries(
        ['parseShopifyDate', 'shopifyLineToItemLine', 'shopifyShippingToLine'].map((n) => {
          const reg = defaultDeriveRegistry();
          return [n, reg.get(n)!];
        }),
      ),
    });
    const r = await buildOrderPayload({
      connection: acme,
      order,
      customerInternalId: '4203',
      lookups: lookupsWithDefaults(),
      derives: customDerives,
    });
    expect(r.ok).toBe(true);
  });
});

describe('buildOrderPayload — order-level discount (D7)', () => {
  it('emits discountItem + discountRate when order has totalDiscounts and connection has defaultDiscountItemId', async () => {
    const order = makeFakeOrder({
      totalDiscounts: { amount: '47.45', currencyCode: 'USD' },
    });
    const r = await buildOrderPayload({
      connection: { ...acme, defaultDiscountItemId: '8123' },
      order,
      customerInternalId: '4203',
      lookups: lookupsWithDefaults(),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // NS reference auto-wrap: discountItem is in HEADER_REF_FIELDS so the bare
    // string '8123' becomes { id: '8123' }. discountRate stays as the raw
    // negative currency string '-47.45'.
    expect(r.payload['discountItem']).toEqual({ id: '8123' });
    expect(r.payload['discountRate']).toBe('-47.45');
  });

  it('skips discount fields when order has no discount (totalDiscounts=0)', async () => {
    const order = makeFakeOrder({
      totalDiscounts: { amount: '0.00', currencyCode: 'USD' },
    });
    const r = await buildOrderPayload({
      // defaultDiscountItemId set, but no discount → no discount fields emitted
      connection: { ...acme, defaultDiscountItemId: '8123' },
      order,
      customerInternalId: '4203',
      lookups: lookupsWithDefaults(),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload['discountItem']).toBeUndefined();
    expect(r.payload['discountRate']).toBeUndefined();
  });

  it("parks (unmapped_construct) when order has a discount but connection has no defaultDiscountItemId — brief invariant: don't over-charge in NS", async () => {
    const order = makeFakeOrder({
      totalDiscounts: { amount: '47.45', currencyCode: 'USD' },
    });
    const r = await buildOrderPayload({
      connection: acme, // no defaultDiscountItemId
      order,
      customerInternalId: '4203',
      lookups: lookupsWithDefaults(),
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.parked.reason).toBe('unmapped_construct');
    expect(r.parked.detail).toMatch(/totalDiscounts=47\.45/);
    expect(r.parked.detail).toMatch(/defaultDiscountItemId/);
  });

  it('formats discountRate with 2 decimals from arbitrary decimal precision', async () => {
    const order = makeFakeOrder({
      totalDiscounts: { amount: '12.3456', currencyCode: 'USD' },
    });
    const r = await buildOrderPayload({
      connection: { ...acme, defaultDiscountItemId: '8123' },
      order,
      customerInternalId: '4203',
      lookups: lookupsWithDefaults(),
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload['discountRate']).toBe('-12.35');
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
