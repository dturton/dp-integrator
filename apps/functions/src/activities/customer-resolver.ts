import type { Connection } from '@dpi/core';
import type { NetSuiteGateway } from '@dpi/netsuite-client';
import type { ShopifyCustomer } from '@dpi/shopify-client';

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

export async function resolveCustomer(
  deps: CustomerResolverDeps,
  connection: Connection,
  shopifyCustomer: ShopifyCustomer | null,
  options: CustomerResolverOptions,
): Promise<CustomerResolution> {
  if (!shopifyCustomer) {
    return { internalId: options.guestCustomerInternalId, isGuest: true, created: false };
  }
  const payload = buildCustomerPayload(connection, shopifyCustomer);
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
 * Build the minimal NetSuite customer payload. Field names match NS Customer
 * record schema (lowercase, single-word per NS convention). Address fields
 * land in Slice D — they need separate address-list handling on the NS side
 * and the address-mapping primitives are part of the mapping engine.
 */
function buildCustomerPayload(
  connection: Connection,
  c: ShopifyCustomer,
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
  return payload;
}
