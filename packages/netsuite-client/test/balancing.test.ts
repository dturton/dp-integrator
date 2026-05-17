import { describe, expect, it } from 'vitest';
import { makeFakeOrder } from '@dpi/shopify-client';
import { applyBalancing, DEFAULT_BALANCING, type NsOrderPayload } from '../src/index.js';

function basePayload(overrides: Partial<NsOrderPayload> = {}): NsOrderPayload {
  return {
    subsidiary: '1',
    externalid: 'gid://shopify/Order/100',
    tranid: '#1001',
    entity: 'cust-1',
    item: [
      { item: 'WIDGET-1', quantity: 2, rate: '50.00', amount: '100.00', description: 'Widget', externalid: 'l1' },
    ],
    shipping: [
      { item: 'SHIP-STANDARD', rate: '10.00', amount: '10.00', description: 'Standard', externalid: 's1' },
    ],
    ...overrides,
  };
}

describe('applyBalancing', () => {
  it('no-ops when totals already match', () => {
    const order = makeFakeOrder(); // totalPrice 120, lines 100, shipping 10, tax 10
    const payload = basePayload();
    const r = applyBalancing(payload, order);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload.payload.item).toHaveLength(1);  // no balancing line added
    expect(r.payload.diagnostics.diff).toBe(0);
    expect(r.payload.diagnostics.applied).toBe(false);
  });

  it('adds a positive balancing line when NS sum is short (small rounding diff)', () => {
    // Shopify total = 120.00, but our lines sum to 99.99 (1 cent short).
    const order = makeFakeOrder();
    const payload = basePayload({
      item: [{ item: 'WIDGET-1', quantity: 2, rate: '49.995', amount: '99.99', description: 'W', externalid: 'l1' }],
    });
    const r = applyBalancing(payload, order);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload.payload.item).toHaveLength(2);
    expect(r.payload.payload.item[1]).toMatchObject({
      item: 'BALANCING',
      amount: '0.01',
      rate: '0.01',
      externalid: 'gid://shopify/Order/100:balancing',
    });
    expect(r.payload.diagnostics).toMatchObject({ diff: 0.01, applied: true });
  });

  it('adds a negative balancing line when NS sum exceeds Shopify total', () => {
    const order = makeFakeOrder();
    const payload = basePayload({
      item: [{ item: 'WIDGET-1', quantity: 2, rate: '50.005', amount: '100.01', description: 'W', externalid: 'l1' }],
    });
    const r = applyBalancing(payload, order);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.payload.payload.item[1]?.['amount']).toBe('-0.01');
  });

  it('parks when diff exceeds the tolerance', () => {
    const order = makeFakeOrder(); // Shopify total 120
    const payload = basePayload({
      item: [{ item: 'WIDGET-1', quantity: 2, rate: '40.00', amount: '80.00', description: 'W', externalid: 'l1' }],
    });
    const r = applyBalancing(payload, order); // sum: 80 + 10 + 10 = 100 → diff 20
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.parked).toMatchObject({
      reason: 'unmapped_construct',
      construct: 'balancing',
    });
    expect(r.parked.evidence).toMatchObject({ shopifyTotal: 120, diff: 20 });
  });

  it('uses a custom toleranceAmount + balancingItemId when provided', () => {
    const order = makeFakeOrder();
    const payload = basePayload({
      item: [{ item: 'WIDGET-1', quantity: 2, rate: '49.50', amount: '99.00', description: 'W', externalid: 'l1' }],
    });
    const r = applyBalancing(payload, order, { toleranceAmount: 5, balancingItemId: 'NS-ROUND' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const bal = r.payload.payload.item[1] as Record<string, unknown>;
    expect(bal['item']).toBe('NS-ROUND');
    expect(bal['amount']).toBe('1.00');
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
    expect(r.payload.diagnostics.diff).toBe(0);
  });

  it('DEFAULT_BALANCING tolerance is 0.05', () => {
    expect(DEFAULT_BALANCING.toleranceAmount).toBe(0.05);
    expect(DEFAULT_BALANCING.balancingItemId).toBe('BALANCING');
  });

  it('does not mutate the input payload (returns a new one)', () => {
    const order = makeFakeOrder();
    const payload = basePayload({
      item: [{ item: 'X', quantity: 1, rate: '99.99', amount: '99.99', description: 'X', externalid: 'l1' }],
    });
    const before = payload.item.length;
    const r = applyBalancing(payload, order);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(payload.item.length).toBe(before); // input unchanged
    expect(r.payload.payload.item.length).toBe(before + 1);
  });
});
