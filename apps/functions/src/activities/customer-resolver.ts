import type { Connection } from '@dpi/core';
import { shopifyAddressToNs, type NetSuiteGateway } from '@dpi/netsuite-client';
import type { ShopifyAddress, ShopifyCustomer } from '@dpi/shopify-client';

/**
 * Customer match-or-create activity (M1 brief §1: "customer match/create").
 *
 * Strategy:
 *   1. Guest order (`shopifyCustomer === null`) → return the connection's
 *      configured guest customer fallback. v1 surfaces this via the
 *      `guestCustomerInternalId` option; production connections wire it from
 *      a connection-config column once we add one (Slice D).
 *   2. Real customer → upsert against NetSuite keyed on the Shopify customer
 *      GID as externalid. Brief invariant 1 (idempotency) is honored by
 *      `NetSuiteGateway.upsertByExternalId` itself — repeated calls for the
 *      same GID never produce duplicate NS records.
 *
 * The NS payload here is intentionally minimal: identity fields + subsidiary.
 * Slice D extends this to addresses, defaults, and the company-vs-person
 * branching that NetSuite needs for B2B customers (out of v1 scope but the
 * shape leaves room).
 */

export interface CustomerResolverDeps {
  readonly ns: NetSuiteGateway;
}

export interface CustomerResolverOptions {
  /** NS internal id used when a Shopify order has no `customer` (guest checkout). Required. */
  readonly guestCustomerInternalId: string;
}

export interface CustomerResolution {
  readonly internalId: string;
  readonly isGuest: boolean;
  readonly created: boolean;
}

/**
 * Optional order-level addresses to write back to the customer record's
 * addressbook (slice D9). The connection chose "overwrite addressbook on
 * every import" — so the resolver always emits the order's addresses,
 * NS replaces the prior list. If both are present and identical, dedupes
 * to a single entry with both default flags set.
 */
export interface OrderAddressesForCustomer {
  readonly billing?: ShopifyAddress;
  readonly shipping?: ShopifyAddress;
}

export async function resolveCustomer(
  deps: CustomerResolverDeps,
  connection: Connection,
  shopifyCustomer: ShopifyCustomer | null,
  options: CustomerResolverOptions,
  orderAddresses: OrderAddressesForCustomer = {},
): Promise<CustomerResolution> {
  if (!shopifyCustomer) {
    return { internalId: options.guestCustomerInternalId, isGuest: true, created: false };
  }
  const payload = buildCustomerPayload(connection, shopifyCustomer, orderAddresses);
  const result = await deps.ns.upsertByExternalId({
    nsAccountId: connection.nsAccountId,
    // 'customer' is the NetSuite record-type string; netsuite-sdk's RecordType
    // enum accepts the literal. Kept as a string here so we don't import the
    // SDK enum into the orchestration layer.
    recordType: 'customer' as Parameters<NetSuiteGateway['upsertByExternalId']>[0]['recordType'],
    externalId: shopifyCustomer.id,
    payload,
  });
  return { internalId: result.internalId, isGuest: false, created: result.created };
}

/**
 * Build the NetSuite customer payload. Identity fields + subsidiary + an
 * optional `addressbook` sublist populated from the order's shipping/billing
 * addresses (overwrite-on-every-import semantics per connection choice).
 */
function buildCustomerPayload(
  connection: Connection,
  c: ShopifyCustomer,
  orderAddresses: OrderAddressesForCustomer,
): Record<string, unknown> {
  // Person if we have first/last name; fall back to company-only when only an
  // email or company is available. NS rejects records with neither.
  const isPerson = Boolean(c.firstName || c.lastName);
  const payload: Record<string, unknown> = {
    externalid: c.id,
    isperson: isPerson,
    subsidiary: connection.nsSubsidiary,
  };
  if (isPerson) {
    if (c.firstName) payload['firstname'] = c.firstName;
    if (c.lastName) payload['lastname'] = c.lastName;
  } else {
    // No name → use email or address.company as the company name; fallback to GID slug.
    const companyName =
      c.defaultAddress?.company ?? c.email ?? c.id.split('/').pop() ?? 'Unknown';
    payload['companyname'] = companyName;
  }
  if (c.email) payload['email'] = c.email;
  // Some NS accounts (and our dev sandbox) require Phone on customer create.
  // Shopify keeps the phone on the default address rather than the customer
  // record itself; fall through to it when present.
  const phone = c.defaultAddress?.phone;
  if (phone) payload['phone'] = phone;

  const addressbook = buildAddressbook(orderAddresses);
  if (addressbook.length > 0) {
    payload['addressbook'] = { items: addressbook };
  }
  return payload;
}

/**
 * Build the NS customer `addressbook` sublist from this order's billing +
 * shipping addresses.
 *
 *   - If both are present and identical (typical online order to a residence),
 *     emit ONE entry with both defaultBilling and defaultShipping = true.
 *   - If both are present and different (gift / drop-ship), emit TWO entries.
 *   - If only one is present, emit it with both default flags = true.
 *   - If neither has any content, emit nothing.
 */
function buildAddressbook(addresses: OrderAddressesForCustomer): Array<Record<string, unknown>> {
  const billing = shopifyAddressToNs(addresses.billing);
  const shipping = shopifyAddressToNs(addresses.shipping);
  if (!billing && !shipping) return [];

  // Same address used for both — collapse into one entry.
  if (billing && shipping && JSON.stringify(billing) === JSON.stringify(shipping)) {
    return [{
      defaultBilling: true,
      defaultShipping: true,
      label: 'Default',
      addressbookaddress: billing,
    }];
  }

  const out: Array<Record<string, unknown>> = [];
  if (billing) {
    out.push({
      defaultBilling: true,
      defaultShipping: !shipping, // become the shipping default if no separate shipping entry
      label: 'Billing',
      addressbookaddress: billing,
    });
  }
  if (shipping) {
    out.push({
      defaultBilling: !billing,
      defaultShipping: true,
      label: 'Shipping',
      addressbookaddress: shipping,
    });
  }
  return out;
}
