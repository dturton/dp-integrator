import type { DeriveFn } from '@dpi/mapping-engine';
import { MapDeriveRegistry } from '@dpi/mapping-engine';
import type { ShopifyLineItem, ShopifyOrder } from '@dpi/shopify-client';

/**
 * Built-in derive functions referenced by the default order field-map
 * (`buildDefaultOrderMap`). New connection-specific maps can register
 * additional fns via `MapDeriveRegistry.register(...)`.
 */

/**
 * Parses an ISO-8601 date string and returns `YYYY-MM-DD` (NS `trandate`
 * field accepts the date-only form). Args: `{ field: string }` — path on the
 * source object.
 */
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
 * Translate Shopify line items into the NS `item` sublist payload. Each NS
 * line carries:
 *   - `item`: NS item internal id (looked up by Shopify sku/variantId; falls
 *     back to `defaultItemId` from args when the sku doesn't resolve — for
 *     dev/test we accept this stub; prod connections will configure
 *     `lookup_item` and pin `defaultItemId` to a generic non-inventory item)
 *   - `quantity`: from Shopify
 *   - `rate`: per-unit price from Shopify (presentment money)
 *   - `description`: line title
 *   - `amount`: line subtotal (post-discount, pre-tax)
 *   - `externalid`: Shopify line item GID (for line-level idempotency)
 *
 * Args: `{ defaultItemId?: string }` — fallback NS item id when a Shopify SKU
 * has no lookup_item row.
 *
 * Tax + balancing land in Slice D2/D3 — this fn produces the bare product
 * lines only.
 */
export const shopifyLineToItemLine: DeriveFn = (args, source) => {
  const order = source as ShopifyOrder;
  const defaultItemId = (args['defaultItemId'] as string | undefined) ?? null;
  return order.lineItems.map((line) => buildLine(line, defaultItemId));
};

function buildLine(line: ShopifyLineItem, defaultItemId: string | null): Record<string, unknown> {
  // Prefer SKU as the lookup key for the item; v1 connections wire a real
  // lookup_item table. Until then, fall back to defaultItemId so a deploy can
  // exercise the pipeline end-to-end against FakeNetSuiteGateway.
  const itemId = defaultItemId ?? line.sku ?? 'UNMAPPED-ITEM';
  return {
    item: itemId,
    quantity: line.quantity,
    rate: line.originalUnitPrice.amount,
    description: line.title,
    amount: line.discountedTotal.amount,
    externalid: line.id,
  };
}

/**
 * Translate Shopify shipping lines into NS shipping items. Mirrors the
 * line-item derive's shape so the same mapping primitive list can call it
 * with a different `to:` field.
 */
export const shopifyShippingToLine: DeriveFn = (args, source) => {
  const order = source as ShopifyOrder;
  const fallbackShipItem = (args['defaultShipItemId'] as string | undefined) ?? 'SHIP-STANDARD';
  return order.shippingLines.map((s) => ({
    item: fallbackShipItem,
    rate: s.price.amount,
    description: s.title,
    amount: s.price.amount,
    externalid: s.id,
  }));
};

/**
 * Standard derive registry. Connections can extend it by wrapping with their
 * own `MapDeriveRegistry` that knows additional fns.
 */
export function defaultDeriveRegistry(): MapDeriveRegistry {
  return new MapDeriveRegistry({
    parseShopifyDate,
    shopifyLineToItemLine,
    shopifyShippingToLine,
  });
}
