import type { DeriveFn } from '@dpi/mapping-engine';
import { MapDeriveRegistry } from '@dpi/mapping-engine';
import type { ShopifyLineItem, ShopifyOrder } from '@dpi/shopify-client';

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

/** Standard derive registry. */
export function defaultDeriveRegistry(): MapDeriveRegistry {
  return new MapDeriveRegistry({
    parseShopifyDate,
    shopifyLineToItemLine,
    shopifyShippingToLine,
  });
}
