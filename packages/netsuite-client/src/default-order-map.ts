import type { Mapping } from '@dpi/mapping-engine';
import type { Connection } from '@dpi/core';

/**
 * Built-in v1 field map for Shopify order → NS Sales Order / Cash Sale
 * header. Field names use NS REST API's camelCase convention (`tranId`,
 * `tranDate`, `orderStatus`). Reference fields (`subsidiary`, `entity`,
 * `currency`, `location`, `orderStatus`) are emitted as plain string ids
 * here — the payload builder wraps them as `{ id: '<value>' }` afterward
 * (auto-ref wrapping) so the mapping config stays terse.
 *
 * Per-connection overrides land via `connection.extraOrderHeaderMappings`
 * which is appended verbatim to this list. Useful for:
 *   - NS custom fields (`custbody_internal_status`, etc.)
 *   - Per-tenant orderStatus choices (default below is `'B'` Pending Fulfillment)
 *   - Connection-specific tranid prefixes
 *
 * orderStatus default 'B' (Pending Fulfillment) — paid Shopify orders that
 * reach this slice's NS write step are awaiting shipment. Connections that
 * want a different status (e.g. 'A' Pending Approval) override via extras.
 */
export function buildDefaultOrderHeaderMap(connection: Connection): readonly Mapping[] {
  const headers: Mapping[] = [
    { kind: 'constant', value: connection.nsSubsidiary, to: 'subsidiary' },
    { kind: 'constant', value: 'B', to: 'orderStatus' },
    { kind: 'direct',   from: 'name', to: 'tranId' },
    { kind: 'direct',   from: 'id',   to: 'externalId' },
    {
      kind: 'derive',
      fn: 'parseShopifyDate',
      args: { field: 'processedAt' },
      to: 'tranDate',
    },
    {
      kind: 'lookup',
      table: 'lookup_currency',
      fromKey: 'currencyCode',
      to: 'currency',
    },
    {
      kind: 'lookup',
      table: 'lookup_payment_method',
      fromKey: 'transactions.0.gateway',
      to: 'paymentMethod',
      required: false,
    },
  ];
  if (connection.nsLocation !== undefined && connection.nsLocation.length > 0) {
    headers.push({ kind: 'constant', value: connection.nsLocation, to: 'location' });
  }
  // Per-tenant additions / overrides. Last-applied wins on the same `to` path,
  // so extras can override the defaults (e.g. set orderStatus='A' for a shop
  // that gates orders behind approval).
  if (connection.extraOrderHeaderMappings && connection.extraOrderHeaderMappings.length > 0) {
    headers.push(...(connection.extraOrderHeaderMappings as Mapping[]));
  }
  return headers;
}

/**
 * The line-items mapping is a single Derive that fans out the Shopify line
 * items into an array of NS line objects. The payload builder slots the
 * result under `item.items` on the NS payload (NS sublist convention).
 */
export function buildDefaultLineItemsMap(): Mapping {
  return {
    kind: 'derive',
    fn: 'shopifyLineToItemLine',
    args: {},
    to: 'item',
  };
}

export function buildDefaultShippingMap(connection: Connection): Mapping {
  const args: Record<string, unknown> = {};
  if (connection.defaultShipItemId !== undefined && connection.defaultShipItemId.length > 0) {
    args['defaultShipItemId'] = connection.defaultShipItemId;
  }
  return {
    kind: 'derive',
    fn: 'shopifyShippingToLine',
    args,
    to: 'shipping',
  };
}
