import { describe, expect, it } from 'vitest';
import type { Connection } from '@dpi/core';
import { makeFakeOrder } from '@dpi/shopify-client';
import {
  applyTaxPayloadHeader,
  LegacyTaxStrategy,
  strategyFor,
  SuiteTaxStrategy,
} from '../src/index.js';

const acmeSuiteTax: Connection = {
  connectionId: 'acme-us',
  environment: 'dev',
  shopifyStore: 'acme-us.myshopify.com',
  shopifyAppTokenRef: 'x',
  shopifyWebhookSecretRef: 'y',
  nsAccountId: '1234567',
  nsSubsidiary: '1',
  baseCurrency: 'USD',
  taxEngine: 'suitetax',
  orderTarget: 'sales_order',
  mapVersion: 'v1',
  enabled: true,
};

const acmeLegacy: Connection = { ...acmeSuiteTax, taxEngine: 'legacy' };

describe('SuiteTaxStrategy', () => {
  it('returns empty parts (NS recomputes tax from customer address + nexus)', () => {
    const order = makeFakeOrder();
    const part = new SuiteTaxStrategy().buildOrderTax(acmeSuiteTax, order);
    expect(part).toEqual({ lineTax: [], headerTax: {}, taxItems: [] });
  });

  it('returns empty parts for tax-free orders', () => {
    const order = makeFakeOrder({ taxLines: [], totalTax: { amount: '0.00', currencyCode: 'USD' } });
    const part = new SuiteTaxStrategy().buildOrderTax(acmeSuiteTax, order);
    expect(part).toEqual({ lineTax: [], headerTax: {}, taxItems: [] });
  });

  it('returns empty parts for shipping tax (delegated to NS)', () => {
    const part = new SuiteTaxStrategy().buildShippingTax(acmeSuiteTax, [
      { title: 'Shipping Tax', rate: 0.05, price: { amount: '0.50', currencyCode: 'USD' } },
    ]);
    expect(part).toEqual({ lineTax: [], headerTax: {}, taxItems: [] });
  });
});

describe('LegacyTaxStrategy', () => {
  it('emits header taxsubtotal + first-line taxitem/taxrate', () => {
    const order = makeFakeOrder();
    const part = new LegacyTaxStrategy().buildOrderTax(acmeLegacy, order);
    expect(part.headerTax).toEqual({
      taxsubtotal: '10.00',
      taxitem: 'State Tax',
      taxrate: 0.1,
    });
  });

  it('emits no header when order is tax-free', () => {
    const order = makeFakeOrder({ taxLines: [], totalTax: { amount: '0.00', currencyCode: 'USD' } });
    const part = new LegacyTaxStrategy().buildOrderTax(acmeLegacy, order);
    expect(part).toEqual({ lineTax: [], headerTax: {}, taxItems: [] });
  });

  it('emits shipping tax fields from the first shipping tax line', () => {
    const part = new LegacyTaxStrategy().buildShippingTax(acmeLegacy, [
      { title: 'Ship Tax', rate: 0.05, price: { amount: '0.50', currencyCode: 'USD' } },
    ]);
    expect(part.headerTax).toEqual({ shippingtax1rate: 0.05, shippingtaxcode: 'Ship Tax' });
  });
});

describe('strategyFor', () => {
  it('returns SuiteTaxStrategy for suitetax connection', () => {
    expect(strategyFor(acmeSuiteTax)).toBeInstanceOf(SuiteTaxStrategy);
  });

  it('returns LegacyTaxStrategy for legacy connection', () => {
    expect(strategyFor(acmeLegacy)).toBeInstanceOf(LegacyTaxStrategy);
  });
});

describe('applyTaxPayloadHeader', () => {
  it('merges headerTax fields into a payload object', () => {
    const payload: Record<string, unknown> = { tranid: '#1001' };
    applyTaxPayloadHeader(payload, {
      lineTax: [],
      headerTax: { taxdetailsoverride: true, taxsubtotal: '10.00' },
      taxItems: [],
    });
    expect(payload).toEqual({
      tranid: '#1001',
      taxdetailsoverride: true,
      taxsubtotal: '10.00',
    });
  });

  it('is a no-op for an empty headerTax', () => {
    const payload: Record<string, unknown> = { x: 1 };
    applyTaxPayloadHeader(payload, { lineTax: [], headerTax: {}, taxItems: [] });
    expect(payload).toEqual({ x: 1 });
  });
});
