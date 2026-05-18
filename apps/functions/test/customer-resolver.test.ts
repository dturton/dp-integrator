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

  it('emits an addressbook entry per address; merges to one when billing equals shipping', async () => {
    const ns = new FakeNetSuiteGateway();
    const customer: ShopifyCustomer = {
      id: 'gid://shopify/Customer/42',
      firstName: 'Jane',
      lastName: 'Doe',
    };
    const sameAddress = {
      firstName: 'Jane', lastName: 'Doe', address1: '123 Main St',
      city: 'Springfield', provinceCode: 'IL', zip: '62701', countryCode: 'US',
    };
    await resolveCustomer(
      { ns },
      connection,
      customer,
      { guestCustomerInternalId: '99' },
      { billing: sameAddress, shipping: sameAddress },
    );
    const rec = ns.getRecords(connection.nsAccountId, 'customer' as never).get(customer.id);
    const addressbook = (rec?.payload['addressbook'] as { items: Array<Record<string, unknown>> }).items;
    expect(addressbook).toHaveLength(1);
    expect(addressbook[0]).toMatchObject({
      defaultBilling: true,
      defaultShipping: true,
      label: 'Default',
    });
    expect((addressbook[0] as { addressbookaddress: Record<string, unknown> }).addressbookaddress).toMatchObject({
      addr1: '123 Main St',
      city: 'Springfield',
      state: 'IL',
      country: 'US',
    });
  });

  it('emits two addressbook entries when billing and shipping differ (gift / drop-ship case)', async () => {
    const ns = new FakeNetSuiteGateway();
    const customer: ShopifyCustomer = {
      id: 'gid://shopify/Customer/43',
      firstName: 'Buyer',
      lastName: 'Person',
    };
    await resolveCustomer(
      { ns },
      connection,
      customer,
      { guestCustomerInternalId: '99' },
      {
        billing: { firstName: 'Buyer', lastName: 'Person', address1: '1 Pay St', city: 'A', provinceCode: 'CA', zip: '12345', countryCode: 'US' },
        shipping: { firstName: 'Recipient', lastName: 'Person', address1: '2 Ship St', city: 'B', provinceCode: 'NY', zip: '67890', countryCode: 'US' },
      },
    );
    const rec = ns.getRecords(connection.nsAccountId, 'customer' as never).get(customer.id);
    const addressbook = (rec?.payload['addressbook'] as { items: Array<Record<string, unknown>> }).items;
    expect(addressbook).toHaveLength(2);
    expect(addressbook[0]).toMatchObject({ defaultBilling: true, defaultShipping: false, label: 'Billing' });
    expect(addressbook[1]).toMatchObject({ defaultBilling: false, defaultShipping: true, label: 'Shipping' });
  });

  it('omits addressbook entirely when no order addresses provided', async () => {
    const ns = new FakeNetSuiteGateway();
    const customer: ShopifyCustomer = {
      id: 'gid://shopify/Customer/44',
      firstName: 'NoAddrs',
    };
    await resolveCustomer({ ns }, connection, customer, { guestCustomerInternalId: '99' });
    const rec = ns.getRecords(connection.nsAccountId, 'customer' as never).get(customer.id);
    expect(rec?.payload['addressbook']).toBeUndefined();
  });

  it('falls back to the order address phone when the customer has no email or default-address phone', async () => {
    const ns = new FakeNetSuiteGateway();
    const customer: ShopifyCustomer = {
      id: 'gid://shopify/Customer/9944208703651',
      firstName: 'Jose',
      lastName: 'Sardeneta',
    };
    await resolveCustomer(
      { ns },
      connection,
      customer,
      { guestCustomerInternalId: '99' },
      {
        shipping: {
          firstName: 'Jose', lastName: 'Sardeneta', address1: '8138 Birdsnest Dr',
          city: 'Birdsnest', provinceCode: 'VA', zip: '23307', countryCode: 'US',
          phone: '7577099567',
        },
      },
    );
    const rec = ns.getRecords(connection.nsAccountId, 'customer' as never).get(customer.id);
    expect(rec?.payload['phone']).toBe('7577099567');
    expect(rec?.payload['email']).toBeUndefined();
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
