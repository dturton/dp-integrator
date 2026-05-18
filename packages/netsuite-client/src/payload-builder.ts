import type { Connection } from '@dpi/core';
import {
  evaluate,
  type EvaluatorContext,
  type LookupResolver,
  type MapDeriveRegistry,
  type Mapping,
  type MappingResult,
  type ParkReason,
  park,
} from '@dpi/mapping-engine';
import type { ShopifyOrder } from '@dpi/shopify-client';
import { buildDefaultLineItemsMap, buildDefaultOrderHeaderMap, buildDefaultShippingMap } from './default-order-map.js';
import { defaultDeriveRegistry } from './derive-fns.js';

/**
 * Assembled NS payload for a Sales Order or Cash Sale. Shape matches what
 * `NetSuiteGateway.upsertByExternalId(...)` ships to NS REST:
 *
 *   - Reference fields (subsidiary, entity, currency, location,
 *     orderStatus, paymentMethod) are objects `{ id: '<value>' }`.
 *   - Line items live under `item: { items: [...] }` per NS sublist
 *     convention; each line's `item` field is also `{ id: '<value>' }`.
 *   - Same for shipping under `shipping: { items: [...] }`.
 *
 * Mappings produce plain string ids; this builder wraps them via
 * `wrapNsReferences()` at the end so the field-map config stays terse.
 */
export interface NsOrderPayload extends Record<string, unknown> {
  readonly subsidiary: { id: string };
  readonly externalId: string;
  readonly tranId: string;
  readonly entity: { id: string };
  readonly item: { items: ReadonlyArray<Record<string, unknown>> };
  readonly shipping?: { items: ReadonlyArray<Record<string, unknown>> };
}

export interface BuildOrderPayloadArgs {
  readonly connection: Connection;
  readonly order: ShopifyOrder;
  readonly customerInternalId: string;
  readonly lookups: LookupResolver;
  readonly derives?: MapDeriveRegistry;
  readonly headerOverride?: readonly Mapping[];
}

export async function buildOrderPayload(
  args: BuildOrderPayloadArgs,
): Promise<MappingResult<NsOrderPayload>> {
  const derives = args.derives ?? defaultDeriveRegistry();
  const ctx: EvaluatorContext = { lookups: args.lookups, derives };

  const headerMappings = args.headerOverride ?? buildDefaultOrderHeaderMap(args.connection);
  const headerResult = await evaluate(args.order, headerMappings, ctx);
  if (!headerResult.ok) return headerResult;

  const linesResult = await evaluate(args.order, [buildDefaultLineItemsMap()], ctx);
  if (!linesResult.ok) return linesResult;
  const lineItems = linesResult.payload['item'];
  if (!Array.isArray(lineItems)) {
    return park({
      reason: 'unmapped_construct',
      detail: 'line items derive returned non-array',
      construct: 'shopifyLineToItemLine',
    });
  }
  if (lineItems.length === 0) {
    return park({
      reason: 'unmapped_construct',
      detail: 'order has no mappable line items',
      construct: 'lineItems',
    });
  }

  const shippingResult = await evaluate(args.order, [buildDefaultShippingMap(args.connection)], ctx);
  if (!shippingResult.ok) return shippingResult;
  const shippingLines = shippingResult.payload['shipping'];

  const header = headerResult.payload;
  for (const required of ['subsidiary', 'externalId', 'tranId'] as const) {
    if (typeof header[required] !== 'string') {
      return park({
        reason: 'unmapped_construct',
        detail: `${required} missing from header map`,
        construct: required,
      });
    }
  }

  // Order-level discount (slice D7). Shopify carries it at order header;
  // NS consumes it via `discountItem` + `discountRate`. If the connection
  // hasn't been configured with a discount item but the order *does* carry a
  // discount, we park rather than book the order at the un-discounted total —
  // NS would over-tax against the larger base (brief invariant 2).
  const discountFields = mapOrderDiscount(args.connection, args.order);
  if (!discountFields.ok) return { ok: false, parked: discountFields.parked };

  // Build the raw payload, then run the NS-ref auto-wrap pass over it.
  const raw: Record<string, unknown> = {
    ...header,
    entity: args.customerInternalId,
    item: lineItems,
    ...(Array.isArray(shippingLines) && shippingLines.length > 0
      ? { shipping: shippingLines }
      : {}),
    ...discountFields.fields,
  };
  return { ok: true, payload: wrapNsReferences(raw) as NsOrderPayload };
}

interface DiscountFields { readonly ok: true; readonly fields: Record<string, unknown>; }
interface DiscountPark { readonly ok: false; readonly parked: ParkReason; }
type DiscountResult = DiscountFields | DiscountPark;

function mapOrderDiscount(connection: Connection, order: ShopifyOrder): DiscountResult {
  const amount = Number.parseFloat(order.totalDiscounts.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: true, fields: {} };
  }
  if (!connection.defaultDiscountItemId || connection.defaultDiscountItemId.length === 0) {
    return {
      ok: false,
      parked: {
        reason: 'unmapped_construct',
        detail:
          `order carries totalDiscounts=${amount.toFixed(2)} ${order.totalDiscounts.currencyCode} ` +
          `but connection '${connection.connectionId}' has no defaultDiscountItemId — set the NS ` +
          'Discount item internal id on the connection (must be "Apply Before Tax") and replay',
        construct: 'order_discount',
      },
    };
  }
  // NS REST `discountRate` accepts EITHER a number (currency amount, what
  // we want — Shopify gives us the absolute amount) OR a string ending in
  // `%` (percentage rate, not used here). Earlier rev emitted the value as
  // a 2-decimal string and NS rejected with INVALID_VALUE on the Number
  // field; round-trip through Number() to 2 decimals avoids both the float
  // precision issue and the type mismatch.
  return {
    ok: true,
    fields: {
      discountItem: connection.defaultDiscountItemId,
      discountRate: Number((-amount).toFixed(2)),
    },
  };
}

/**
 * Map `connection.orderTarget` to the NS REST record-type string.
 */
export function netsuiteOrderRecordType(connection: Connection): 'salesorder' | 'cashsale' {
  return connection.orderTarget === 'sales_order' ? 'salesorder' : 'cashsale';
}

// --- NS payload reference wrapping ------------------------------------------

/**
 * NS REST API requires reference fields as `{ id: '<value>' }` objects, NOT
 * bare strings. This pass walks a payload built from the mapping engine
 * (which produces strings) and wraps every known reference field.
 *
 * Header-level refs: subsidiary, entity, currency, location, orderStatus,
 * paymentMethod, customForm, terms.
 * Per-line refs: item, taxCode, location, units, price.
 *
 * Already-object values pass through unchanged (so connection extras that
 * explicitly emit `{ id: 'X' }` aren't double-wrapped).
 */
const HEADER_REF_FIELDS: readonly string[] = [
  'subsidiary', 'entity', 'currency', 'location', 'orderStatus', 'paymentMethod',
  'customForm', 'terms', 'employee', 'salesRep', 'nexus', 'shipMethod', 'discountItem',
];

const LINE_REF_FIELDS: readonly string[] = [
  'item', 'taxCode', 'location', 'units', 'price', 'department', 'class',
];

export function wrapNsReferences(raw: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    // Skip undefined fields entirely. `null` is a deliberate "clear this
    // field" signal in some NS contexts so it passes through unchanged
    // for ref fields — but for derived sub-records (addresses, etc.) a
    // null return from the derive means "no content," and we should NOT
    // emit `key: null` on the payload (NS treats that as INVALID_FIELD
    // on some sub-records). Drop nulls from non-ref keys.
    if (value === undefined) continue;
    if (key === 'item' || key === 'shipping') {
      // Sublist: wrap with { items: [...] } and ref-wrap each line's fields.
      if (Array.isArray(value)) {
        out[key] = { items: value.map((line) => wrapLineRefs(line as Record<string, unknown>)) };
      } else {
        out[key] = value;
      }
    } else if (HEADER_REF_FIELDS.includes(key)) {
      // For ref fields, keep null pass-through (some callers use it to
      // explicitly null a reference, e.g. paymentMethod=null when no match).
      out[key] = wrapRef(value);
    } else {
      if (value === null) continue;
      out[key] = value;
    }
  }
  return out;
}

function wrapLineRefs(line: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(line)) {
    if (LINE_REF_FIELDS.includes(k)) {
      out[k] = wrapRef(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function wrapRef(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === 'object') return value; // already an object — pass through
  if (typeof value === 'string' || typeof value === 'number') {
    return { id: String(value) };
  }
  return value;
}
