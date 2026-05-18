import type { Connection } from '@dpi/core';
import {
  shopifyAddressToNs,
  type CustomerAddressbookEntry,
  type NetSuiteGateway,
} from '@dpi/netsuite-client';
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
 * Order-level addresses to consider for the customer's NS addressbook.
 *
 * Two behavior paths, switched on `connection.shopifyAddressIdField`:
 *
 *   - **Unset (legacy D9):** overwrite the addressbook from the current
 *     order's addresses on every import. Same-address-on-both-sides
 *     collapses to one entry.
 *   - **Set:** read-merge-write keyed on the Shopify MailingAddress GID
 *     stamped onto each entry's `custrecord_shopify_address_id`. Incoming
 *     addresses with a matching id update that entry in place; non-matching
 *     incoming addresses append; existing entries that aren't matched are
 *     preserved untouched. The incoming addresses become the new defaults
 *     and any prior default entries get their default flags unset.
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

  // Slice D10: when the connection has a Shopify-address-id custom field
  // configured, the addressbook write is a merge against existing entries
  // rather than a blind overwrite. We need the customer's NS internal id
  // before the write to read its current addressbook — fall back to [] for
  // brand-new customers (no NS row yet → nothing to merge against).
  const fieldId = connection.shopifyAddressIdField;
  let existingEntries: ReadonlyArray<CustomerAddressbookEntry> = [];
  if (fieldId) {
    const existing = await deps.ns.findByExternalId({
      nsAccountId: connection.nsAccountId,
      recordType: 'customer' as Parameters<NetSuiteGateway['findByExternalId']>[0]['recordType'],
      externalId: shopifyCustomer.id,
      fields: ['id'],
    });
    const existingId = existing?.['id'];
    if (existingId !== undefined && existingId !== null) {
      existingEntries = await deps.ns.getCustomerAddressbook({
        nsAccountId: connection.nsAccountId,
        customerInternalId: String(existingId),
        shopifyIdField: fieldId,
      });
    }
  }

  const payload = buildCustomerPayload(
    connection,
    shopifyCustomer,
    orderAddresses,
    existingEntries,
  );
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
 * optional `addressbook` sublist. Addressbook composition branches on whether
 * the connection has `shopifyAddressIdField` configured:
 *
 *   - Unset → legacy overwrite-from-order (slice D9 behavior).
 *   - Set → merge against `existingEntries` keyed on the Shopify address GID.
 */
function buildCustomerPayload(
  connection: Connection,
  c: ShopifyCustomer,
  orderAddresses: OrderAddressesForCustomer,
  existingEntries: ReadonlyArray<CustomerAddressbookEntry>,
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
  // NS requires at least one of Email/Phone on customer create. Shopify keeps
  // phones on addresses, not the customer record; try the customer's default
  // address first, then the order's shipping/billing addresses as a last
  // resort so we don't 400 when the customer record itself lacks a phone.
  const phone =
    c.defaultAddress?.phone ?? orderAddresses.shipping?.phone ?? orderAddresses.billing?.phone;
  if (phone) payload['phone'] = phone;

  const addressbook = connection.shopifyAddressIdField
    ? buildAddressbookMerged(orderAddresses, existingEntries, connection.shopifyAddressIdField)
    : buildAddressbookLegacy(orderAddresses);
  if (addressbook.length > 0) {
    payload['addressbook'] = { items: addressbook };
  }
  return payload;
}

/**
 * Legacy slice-D9 addressbook build: blind overwrite from the current order's
 * addresses. Used when the connection has no `shopifyAddressIdField` configured.
 */
function buildAddressbookLegacy(
  addresses: OrderAddressesForCustomer,
): Array<Record<string, unknown>> {
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
      defaultShipping: !shipping,
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

/**
 * Merge incoming order addresses against the customer's existing NS
 * addressbook, keyed on the Shopify MailingAddress GID stamped into each
 * entry's `<shopifyIdField>` custom field.
 *
 *   - Incoming address with id matching an existing entry → update in place
 *     (emit `{ id: existingInternalId, ... }`). Default flags follow the
 *     new order.
 *   - Incoming address with no match (or no id) → append a new entry.
 *   - Existing entry not matched by any incoming address → preserve, with
 *     default flags forcibly unset (only one default per type can be true
 *     and the new order's address claims it).
 *   - Same incoming id on both billing + shipping sides → collapse to one
 *     entry with both default flags true.
 */
function buildAddressbookMerged(
  addresses: OrderAddressesForCustomer,
  existingEntries: ReadonlyArray<CustomerAddressbookEntry>,
  shopifyIdField: string,
): Array<Record<string, unknown>> {
  const billing = shopifyAddressToNs(addresses.billing, { shopifyIdField });
  const shipping = shopifyAddressToNs(addresses.shipping, { shopifyIdField });
  if (!billing && !shipping) {
    // No incoming addresses at all — leave the customer's addressbook
    // entirely untouched. Returning [] omits the field from the payload so
    // NS doesn't try to interpret an empty sublist as "clear all".
    return [];
  }

  const byShopifyId = new Map<string, CustomerAddressbookEntry>();
  for (const e of existingEntries) {
    if (e.shopifyAddressId) byShopifyId.set(e.shopifyAddressId, e);
  }

  const claimedExistingIds = new Set<string>();
  const out: Array<Record<string, unknown>> = [];

  const sameIds =
    addresses.billing?.id !== undefined &&
    addresses.shipping?.id !== undefined &&
    addresses.billing.id === addresses.shipping.id;

  if (sameIds && billing) {
    const matched = byShopifyId.get(addresses.billing!.id!);
    const entry: Record<string, unknown> = {
      defaultBilling: true,
      defaultShipping: true,
      label: 'Default',
      addressbookaddress: billing,
    };
    if (matched) {
      entry['id'] = matched.internalId;
      claimedExistingIds.add(matched.internalId);
    }
    out.push(entry);
  } else {
    if (billing) {
      const matched = addresses.billing?.id ? byShopifyId.get(addresses.billing.id) : undefined;
      const entry: Record<string, unknown> = {
        defaultBilling: true,
        defaultShipping: !shipping,
        label: 'Billing',
        addressbookaddress: billing,
      };
      if (matched) {
        entry['id'] = matched.internalId;
        claimedExistingIds.add(matched.internalId);
      }
      out.push(entry);
    }
    if (shipping) {
      const matched = addresses.shipping?.id ? byShopifyId.get(addresses.shipping.id) : undefined;
      const entry: Record<string, unknown> = {
        defaultBilling: !billing,
        defaultShipping: true,
        label: 'Shipping',
        addressbookaddress: shipping,
      };
      if (matched) {
        entry['id'] = matched.internalId;
        claimedExistingIds.add(matched.internalId);
      }
      out.push(entry);
    }
  }

  // Preserve any existing entries the incoming addresses didn't claim. The
  // incoming entries always become the active defaults (it's the most-recent
  // order's address, by construction), so any preserved entry that previously
  // held a default flag gets it unset — NS rejects multiple-default sublists
  // and "newest wins" matches the legacy D9 semantics. Compute the "claim"
  // off the actual outgoing entries we just built rather than the input
  // shape: a billing-only order still claims defaultShipping via
  // `defaultShipping: !shipping = true` on the billing entry.
  const claimsBillingDefault = out.some((e) => e['defaultBilling'] === true);
  const claimsShippingDefault = out.some((e) => e['defaultShipping'] === true);
  for (const e of existingEntries) {
    if (claimedExistingIds.has(e.internalId)) continue;
    const preserved: Record<string, unknown> = {
      id: e.internalId,
      defaultBilling: claimsBillingDefault ? false : e.defaultBilling,
      defaultShipping: claimsShippingDefault ? false : e.defaultShipping,
    };
    if (e.label) preserved['label'] = e.label;
    out.push(preserved);
  }

  return out;
}
