import { describe, expect, it } from 'vitest';
import type { Connection } from '@dpi/core';
import { FakeNetSuiteGateway } from '@dpi/netsuite-client';
import type { ShopifyCustomer } from '@dpi/shopify-client';
import { resolveCustomer } from '../src/activities/customer-resolver.js';

const connection: Connection = {
  connectionId: 'dev-store-1',
  environment: 'dev',
  shopifyStore: 'sw31sy-js.myshopify.com',
  shopifyAppTokenRef: 'id-ref',
  shopifyWebhookSecretRef: 'secret-ref',
  nsAccountId: '1234567',
  nsSubsidiary: '1',
  baseCurrency: 'USD',
  taxEngine: 'suitetax',
  orderTarget: 'sales_order',
  mapVersion: 'v1',
  enabled: true,
};

describe('resolveCustomer', () => {
  it('returns the guest fallback when there is no Shopify customer', async () => {
    const ns = new FakeNetSuiteGateway();
    const r = await resolveCustomer({ ns }, connection, null, { guestCustomerInternalId: '99' });
    expect(r).toEqual({ internalId: '99', isGuest: true, created: false });
    expect(ns.attemptCount()).toBe(0);
  });

  it('upserts a real customer (creates on first call, updates on second)', async () => {
    const ns = new FakeNetSuiteGateway();
    const customer: ShopifyCustomer = {
      id: 'gid://shopify/Customer/42',
      email: 'buyer@example.com',
      firstName: 'Buyer',
      lastName: 'Example',
    };

    const first = await resolveCustomer({ ns }, connection, customer, { guestCustomerInternalId: '99' });
    expect(first.isGuest).toBe(false);
    expect(first.created).toBe(true);
    expect(first.internalId).toMatch(/^ns_1234567_/);

    // Same Shopify GID → same NS internal id; created=false (it's an update now).
    const second = await resolveCustomer({ ns }, connection, customer, { guestCustomerInternalId: '99' });
    expect(second.internalId).toBe(first.internalId);
    expect(second.created).toBe(false);
  });

  it('builds a person payload with first/last name + email', async () => {
    const ns = new FakeNetSuiteGateway();
    const customer: ShopifyCustomer = {
      id: 'gid://shopify/Customer/42',
      email: 'buyer@example.com',
      firstName: 'Buyer',
      lastName: 'Example',
    };
    await resolveCustomer({ ns }, connection, customer, { guestCustomerInternalId: '99' });
    const records = ns.getRecords(connection.nsAccountId, 'customer' as never);
    const rec = records.get(customer.id);
    expect(rec?.payload).toEqual({
      externalid: 'gid://shopify/Customer/42',
      isperson: true,
      subsidiary: '1',
      firstname: 'Buyer',
      lastname: 'Example',
      email: 'buyer@example.com',
    });
  });

  it('builds a company payload when there is no first/last name', async () => {
    const ns = new FakeNetSuiteGateway();
    const customer: ShopifyCustomer = {
      id: 'gid://shopify/Customer/77',
      email: 'orders@acme.example',
      defaultAddress: { company: 'Acme Corp' },
    };
    await resolveCustomer({ ns }, connection, customer, { guestCustomerInternalId: '99' });
    const rec = ns.getRecords(connection.nsAccountId, 'customer' as never).get(customer.id);
    expect(rec?.payload).toMatchObject({
      isperson: false,
      companyname: 'Acme Corp',
      email: 'orders@acme.example',
    });
  });

  it('falls back to email then GID slug for company name when nothing else fits', async () => {
    const ns = new FakeNetSuiteGateway();
    const customer: ShopifyCustomer = { id: 'gid://shopify/Customer/9999', email: 'no-name@x.test' };
    await resolveCustomer({ ns }, connection, customer, { guestCustomerInternalId: '99' });
    const rec = ns.getRecords(connection.nsAccountId, 'customer' as never).get(customer.id);
    expect(rec?.payload).toMatchObject({ isperson: false, companyname: 'no-name@x.test' });

    const customer2: ShopifyCustomer = { id: 'gid://shopify/Customer/5555' };
    await resolveCustomer({ ns }, connection, customer2, { guestCustomerInternalId: '99' });
    const rec2 = ns.getRecords(connection.nsAccountId, 'customer' as never).get(customer2.id);
    expect(rec2?.payload).toMatchObject({ companyname: '5555' });
  });

  it('partitions records by NS account (multi-tenant isolation)', async () => {
    const ns = new FakeNetSuiteGateway();
    const a: Connection = { ...connection, nsAccountId: 'acct-A' };
    const b: Connection = { ...connection, nsAccountId: 'acct-B' };
    const customer: ShopifyCustomer = { id: 'gid://shopify/Customer/42', firstName: 'C' };

    const ra = await resolveCustomer({ ns }, a, customer, { guestCustomerInternalId: '99' });
    const rb = await resolveCustomer({ ns }, b, customer, { guestCustomerInternalId: '99' });

    expect(ra.internalId).toMatch(/^ns_acct-A_/);
    expect(rb.internalId).toMatch(/^ns_acct-B_/);
    expect(ra.internalId).not.toBe(rb.internalId);
  });
});
