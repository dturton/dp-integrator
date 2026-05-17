import type { Mapping } from '@dpi/mapping-engine';
import type { Connection } from '@dpi/core';

/**
 * The built-in v1 field map for Shopify order → NS Sales Order / Cash Sale
 * header. Connection-specific overrides land in future slices; for now every
 * connection with `mapVersion === 'v1'` uses this. The shape mirrors the
 * illustrative `config/field-maps/order.example.jsonc`.
 *
 * The line-items / shipping derives are kept in a separate list so callers
 * (the payload builder) can place them under explicit NS sublist names
 * (`item`, `shipping`) rather than dumping them into the header bag.
 *
 * Header mappings populate top-level NS Sales Order / Cash Sale fields:
 *   - subsidiary: from connection.nsSubsidiary
 *   - location: looked up from connection's nsLocation (if set) — required=false
 *     so missing location doesn't park
 *   - tranid: Shopify order name (e.g. "#1001")
 *   - externalid: Shopify order GID — drives upsertByExternalId
 *   - trandate: derived from order.processedAt (YYYY-MM-DD)
 *   - currency: looked up from order.currencyCode via lookup_currency
 *   - paymentmethod: looked up from order.transactions[0].gateway (best-effort)
 */
export function buildDefaultOrderHeaderMap(connection: Connection): readonly Mapping[] {
  const headers: Mapping[] = [
    { kind: 'constant', value: connection.nsSubsidiary, to: 'subsidiary' },
    { kind: 'direct',   from: 'name', to: 'tranid' },
    { kind: 'direct',   from: 'id',   to: 'externalid' },
    {
      kind: 'derive',
      fn: 'parseShopifyDate',
      args: { field: 'processedAt' },
      to: 'trandate',
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
      to: 'paymentmethod',
      required: false,
    },
  ];
  if (connection.nsLocation !== undefined && connection.nsLocation.length > 0) {
    headers.push({ kind: 'constant', value: connection.nsLocation, to: 'location' });
  }
  return headers;
}

/**
 * The line-items mapping is a single Derive that fans out the Shopify line
 * items into an array of NS line objects. The payload builder slots the
 * result under `item` on the NS payload.
 */
export function buildDefaultLineItemsMap(): Mapping {
  return {
    kind: 'derive',
    fn: 'shopifyLineToItemLine',
    // Connection-specific default item id can be added via args once we
    // surface it on Connection; for now the derive falls back to the SKU.
    args: {},
    to: 'item',
  };
}

export function buildDefaultShippingMap(): Mapping {
  return {
    kind: 'derive',
    fn: 'shopifyShippingToLine',
    args: {},
    to: 'shipping',
  };
}
