import { describe, expect, it } from 'vitest';
import { makeFakeOrder } from '@dpi/shopify-client';
import { checkEligibility } from '../src/index.js';

describe('checkEligibility', () => {
  it('accepts a standard paid order with line items', () => {
    const order = makeFakeOrder();
    expect(checkEligibility(order, 'orders/create')).toEqual({ eligible: true });
  });

  it('rejects test orders (brief invariant: never sync test data to NS)', () => {
    const order = makeFakeOrder({ test: true });
    expect(checkEligibility(order, 'orders/create')).toEqual({
      eligible: false,
      reason: 'test_order',
    });
  });

  it('rejects fraud-hold orders', () => {
    const order = makeFakeOrder({ fraudHold: true });
    expect(checkEligibility(order, 'orders/create')).toEqual({
      eligible: false,
      reason: 'fraud_hold',
    });
  });

  it('rejects voided orders', () => {
    const order = makeFakeOrder({ financialStatus: 'voided' });
    expect(checkEligibility(order, 'orders/create')).toMatchObject({
      eligible: false,
      reason: 'voided',
    });
  });

  it('rejects pending-payment orders by default', () => {
    const order = makeFakeOrder({ financialStatus: 'pending' });
    expect(checkEligibility(order, 'orders/create')).toMatchObject({
      eligible: false,
      reason: 'pending_payment',
    });
  });

  it('rejects refunded orders by default', () => {
    const order = makeFakeOrder({ financialStatus: 'refunded' });
    expect(checkEligibility(order, 'orders/create')).toMatchObject({
      eligible: false,
      reason: 'pending_payment',
    });
  });

  it('rejects orders with no line items', () => {
    const order = makeFakeOrder({ lineItems: [] });
    expect(checkEligibility(order, 'orders/create')).toEqual({
      eligible: false,
      reason: 'no_line_items',
    });
  });

  it('respects allowedTopics override (rejects orders/updated when only orders/create allowed)', () => {
    const order = makeFakeOrder();
    expect(
      checkEligibility(order, 'orders/updated', { allowedTopics: ['orders/create'] }),
    ).toMatchObject({ eligible: false, reason: 'disallowed_topic' });
    expect(
      checkEligibility(order, 'orders/create', { allowedTopics: ['orders/create'] }),
    ).toEqual({ eligible: true });
  });

  it('respects allowedFinancialStatuses override', () => {
    const order = makeFakeOrder({ financialStatus: 'pending' });
    expect(
      checkEligibility(order, 'orders/create', { allowedFinancialStatuses: ['pending'] }),
    ).toEqual({ eligible: true });
  });

  it('test_order short-circuits even when financial_status is paid', () => {
    const order = makeFakeOrder({ test: true, financialStatus: 'paid' });
    expect(checkEligibility(order, 'orders/create').eligible).toBe(false);
  });
});
