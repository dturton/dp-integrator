import type { DeriveFn } from '@dpi/mapping-engine';
import { MapDeriveRegistry } from '@dpi/mapping-engine';
import type { ShopifyAddress, ShopifyLineItem, ShopifyOrder } from '@dpi/shopify-client';

/**
 * Built-in derive functions referenced by the default order field-map
 * (`buildDefaultOrderHeaderMap`). New connection-specific maps can register
 * additional fns via `MapDeriveRegistry.register(...)`.
 *
 * Reference-field shape: each NS line item's `item` field is emitted as a
 * plain string id here; the payload builder's auto-ref wrap converts it to
 * `{ id: '<value>' }`. Same for shipping lines.
 */

/** Parse ISO timestamp into `YYYY-MM-DD` for NS `tranDate`. */
export const parseShopifyDate: DeriveFn = (args, source) => {
  const field = String(args['field'] ?? '');
  if (!field) throw new Error('parseShopifyDate: args.field is required');
  const raw = (source as Record<string, unknown>)[field];
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`parseShopifyDate: '${field}' is not a valid ISO date: ${raw}`);
  }
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
};

/**
 * Translate Shopify line items into NS `item` sublist payloads.
 *
 * Args:
 *   - `defaultItemId?: string` — NS item internal id used when a Shopify SKU
 *     has no resolution path yet. v1 connections without a `lookup_item`
 *     table fall through to this so the upsert can succeed end-to-end. Set
 *     in the field-map's derive args.
 */
export const shopifyLineToItemLine: DeriveFn = (args, source) => {
  const order = source as ShopifyOrder;
  const defaultItemId = (args['defaultItemId'] as string | undefined) ?? null;
  return order.lineItems.map((line) => buildLine(line, defaultItemId));
};

function buildLine(line: ShopifyLineItem, defaultItemId: string | null): Record<string, unknown> {
  // Prefer SKU lookup → defaultItemId fallback → ultimate sentinel. The
  // payload builder will wrap whatever ends up in `item` as `{ id: '<value>' }`.
  const itemId = defaultItemId ?? line.sku ?? 'UNMAPPED-ITEM';
  return {
    item: itemId,
    quantity: line.quantity,
    rate: Number(line.originalUnitPrice.amount),
    amount: Number(line.discountedTotal.amount),
    description: line.title,
  };
}

/**
 * Pull the numeric id off the end of `order.id` (a Shopify GID of the form
 * `gid://shopify/Order/<digits>`). Surfaces in NS via the connection's
 * `extraOrderHeaderMappings`, e.g.:
 *
 *   { kind: 'derive', fn: 'extractShopifyOrderId', args: {}, to: 'custbody_shopify_order_id' }
 *
 * Operators can then search NS by Shopify order id directly, without
 * cross-referencing the `externalId` form.
 *
 * Throws if `order.id` doesn't end in a digit run — that would mean Shopify
 * changed GID shape, which should fail loudly rather than silently emit a
 * malformed value.
 */
export const extractShopifyOrderId: DeriveFn = (_args, source) => {
  const order = source as ShopifyOrder;
  const m = /\/(\d+)$/.exec(order.id);
  if (!m) {
    throw new Error(
      `extractShopifyOrderId: cannot extract numeric id from order.id='${order.id}'`,
    );
  }
  return m[1];
};

/**
 * Translate Shopify shipping lines into NS shipping sublist objects.
 */
export const shopifyShippingToLine: DeriveFn = (args, source) => {
  const order = source as ShopifyOrder;
  const fallback = (args['defaultShipItemId'] as string | undefined) ?? null;
  return order.shippingLines.map((s) => ({
    item: fallback ?? 'SHIP-STANDARD',
    rate: Number(s.price.amount),
    amount: Number(s.price.amount),
    description: s.title,
  }));
};

/**
 * Translate a Shopify address into NS's address sub-record shape.
 *
 * Mapping:
 *   Shopify              NS
 *   ────────             ──────
 *   firstName + lastName → addressee (composed)
 *   company             → attention
 *   address1            → addr1
 *   address2            → addr2
 *   city                → city
 *   provinceCode        → state           (2-letter for US/CA)
 *   zip                 → zip
 *   countryCode         → country         (2-letter ISO, emitted as plain string)
 *   phone               → addrPhone
 *
 * Returns `null` for an address that has no meaningful content (no
 * address1, no city, no zip) so the caller can skip emitting the field
 * rather than land an empty sub-record on the NS payload.
 */
export function shopifyAddressToNs(addr: ShopifyAddress | undefined | null): Record<string, unknown> | null {
  if (!addr) return null;
  const hasContent = Boolean(addr.address1 || addr.city || addr.zip);
  if (!hasContent) return null;
  const addressee = [addr.firstName, addr.lastName].filter(Boolean).join(' ').trim();
  const out: Record<string, unknown> = {};
  if (addressee) out['addressee'] = addressee;
  if (addr.company) out['attention'] = addr.company;
  if (addr.address1) out['addr1'] = addr.address1;
  if (addr.address2) out['addr2'] = addr.address2;
  if (addr.city) out['city'] = addr.city;
  if (addr.provinceCode) out['state'] = addr.provinceCode;
  if (addr.zip) out['zip'] = addr.zip;
  if (addr.countryCode) out['country'] = addr.countryCode;
  if (addr.phone) out['addrPhone'] = addr.phone;
  return out;
}

/** Shipping address derive — reads `order.shippingAddress` → NS sub-record. */
export const shopifyShippingAddressToNs: DeriveFn = (_args, source) => {
  const order = source as ShopifyOrder;
  return shopifyAddressToNs(order.shippingAddress);
};

/** Billing address derive — reads `order.billingAddress` → NS sub-record. */
export const shopifyBillingAddressToNs: DeriveFn = (_args, source) => {
  const order = source as ShopifyOrder;
  return shopifyAddressToNs(order.billingAddress);
};

/** Standard derive registry. */
export function defaultDeriveRegistry(): MapDeriveRegistry {
  return new MapDeriveRegistry({
    parseShopifyDate,
    shopifyLineToItemLine,
    shopifyShippingToLine,
    extractShopifyOrderId,
    shopifyShippingAddressToNs,
    shopifyBillingAddressToNs,
  });
}
