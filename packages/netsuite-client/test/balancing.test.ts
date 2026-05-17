import { describe, expect, it } from 'vitest';
import { makeFakeOrder } from '@dpi/shopify-client';
import { applyBalancing, DEFAULT_BALANCING, type NsOrderPayload } from '../src/index.js';

function basePayload(overrides: Partial<NsOrderPayload> = {}): NsOrderPayload {
  return {
    subsidiary: { id: '2' },
    externalId: 'gid://shopify/Order/100',
    tranId: '#1001',
    entity: { id: '4203' },
    item: {
      items: [
        { item: { id: 'WIDGET-1' }, quantity: 2, rate: 50, amount: 100, description: 'Widget' },
      ],
    },
    shipping: {
      items: [
        { item: { id: 'SHIP-STANDARD' }, rate: 10, amount: 10, description: 'Standard' },
      ],
    },
    ...overrides,
  };
}

describe('applyBalancing', () => {
  it('no-ops when totals already match', () => {
    const order = makeFakeOrder(); // total 120 = lines 100 + shipping 10 + tax 10
    const payload = basePayload();
    const r = applyBalancing(payload, order);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload.payload.item.items).toHaveLength(1);
    expect(r.payload.diagnostics).toMatchObject({ diff: 0, applied: false });
  });

  it('adds a positive balancing line when NS sum is short (small rounding diff)', () => {
    const order = makeFakeOrder();
    const payload = basePayload({
      item: { items: [{ item: { id: 'WIDGET-1' }, quantity: 2, rate: 49.995, amount: 99.99, description: 'W' }] },
    });
    const r = applyBalancing(payload, order);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload.payload.item.items).toHaveLength(2);
    expect(r.payload.payload.item.items[1]).toMatchObject({
      item: { id: '6540' },
      amount: 0.01,
      rate: 0.01,
    });
  });

  it('adds a negative balancing line when NS sum exceeds Shopify total', () => {
    const order = makeFakeOrder();
    const payload = basePayload({
      item: { items: [{ item: { id: 'WIDGET-1' }, quantity: 2, rate: 50.005, amount: 100.01, description: 'W' }] },
    });
    const r = applyBalancing(payload, order);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload.payload.item.items[1]?.['amount']).toBe(-0.01);
  });

  it('parks when diff exceeds the tolerance', () => {
    const order = makeFakeOrder(); // total 120
    const payload = basePayload({
      item: { items: [{ item: { id: 'WIDGET-1' }, quantity: 2, rate: 40, amount: 80, description: 'W' }] },
    });
    const r = applyBalancing(payload, order);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.parked).toMatchObject({ reason: 'unmapped_construct', construct: 'balancing' });
    expect(r.parked.evidence).toMatchObject({ shopifyTotal: 120, diff: 20 });
  });

  it('uses a custom toleranceAmount + balancingItemId when provided', () => {
    const order = makeFakeOrder();
    const payload = basePayload({
      item: { items: [{ item: { id: 'WIDGET-1' }, quantity: 2, rate: 49.5, amount: 99, description: 'W' }] },
    });
    const r = applyBalancing(payload, order, { toleranceAmount: 5, balancingItemId: '999' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload.payload.item.items[1]).toMatchObject({ item: { id: '999' }, amount: 1 });
  });

  it('subtracts order-level discounts from the NS expected total', () => {
    const order = makeFakeOrder({
      lineItems: [
        {
          id: 'gid://shopify/LineItem/L1',
          title: 'Repair Kit',
          sku: 'RKGT15',
          quantity: 1,
          originalUnitPrice: { amount: '279.00', currencyCode: 'USD' },
          discountedTotal: { amount: '279.00', currencyCode: 'USD' },
          discountAllocations: [],
        },
      ],
      shippingLines: [],
      totalShippingPrice: { amount: '0.00', currencyCode: 'USD' },
      taxLines: [],
      totalTax: { amount: '0.00', currencyCode: 'USD' },
      totalDiscounts: { amount: '13.95', currencyCode: 'USD' },
      totalPrice: { amount: '265.05', currencyCode: 'USD' },
    });
    const payload = basePayload({
      item: { items: [{ item: { id: 'RKGT15' }, quantity: 1, rate: 279, amount: 279, description: 'Repair Kit' }] },
      shipping: undefined,
    });
    const r = applyBalancing(payload, order);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload.diagnostics).toMatchObject({
      shopifyTotal: 265.05,
      nsLinesTotal: 279,
      orderDiscounts: 13.95,
      diff: 0,
    });
    expect(r.payload.payload.item.items).toHaveLength(1);
  });

  it('handles tax-only orders (no shipping)', () => {
    const order = makeFakeOrder({
      shippingLines: [],
      totalShippingPrice: { amount: '0.00', currencyCode: 'USD' },
      totalPrice: { amount: '110.00', currencyCode: 'USD' },
    });
    const payload = basePayload({ shipping: undefined });
    const r = applyBalancing(payload, order);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload.diagnostics.nsShippingTotal).toBe(0);
  });

  it('DEFAULT_BALANCING tolerance is 0.05 and item is 6540 (Shopify Variance)', () => {
    expect(DEFAULT_BALANCING.toleranceAmount).toBe(0.05);
    expect(DEFAULT_BALANCING.balancingItemId).toBe('6540');
  });

  it('does not mutate the input payload', () => {
    const order = makeFakeOrder();
    const payload = basePayload({
      item: { items: [{ item: { id: 'X' }, quantity: 1, rate: 99.99, amount: 99.99, description: 'X' }] },
    });
    const before = payload.item.items.length;
    const r = applyBalancing(payload, order);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(payload.item.items.length).toBe(before);
    expect(r.payload.payload.item.items.length).toBe(before + 1);
  });
});
