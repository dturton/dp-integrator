import type { Connection } from '@dpi/core';
import {
  evaluate,
  type EvaluatorContext,
  type LookupResolver,
  type MapDeriveRegistry,
  type Mapping,
  type MappingResult,
  park,
} from '@dpi/mapping-engine';
import type { ShopifyOrder } from '@dpi/shopify-client';
import { buildDefaultLineItemsMap, buildDefaultOrderHeaderMap, buildDefaultShippingMap } from './default-order-map.js';
import { defaultDeriveRegistry } from './derive-fns.js';

/**
 * Assembled NS payload for a Sales Order or Cash Sale. The shape is what
 * `NetSuiteGateway.upsertByExternalId(...)` receives in `payload`.
 *
 * Slice D1 builds the header + line items + shipping. Tax (D2) and the
 * rounding/balancing line (D3) extend this structure:
 *   - Tax strategy fills `taxdetailsoverride` / `taxitem` / `taxcode` slots
 *   - Balancing appends a final adjustment item to `item[]`
 *
 * Customer is injected by the caller (handler) since `resolveCustomer`
 * already produced the NS internal id.
 */
export interface NsOrderPayload extends Record<string, unknown> {
  /** Header fields produced by the mapping evaluator. */
  readonly subsidiary: string;
  readonly externalid: string;
  readonly tranid: string;
  /** NS internal id of the customer. Caller supplies. */
  readonly entity: string;
  /** Line-item sublist. */
  readonly item: ReadonlyArray<Record<string, unknown>>;
  /** Shipping sublist (optional). */
  readonly shipping?: ReadonlyArray<Record<string, unknown>>;
}

export interface BuildOrderPayloadArgs {
  readonly connection: Connection;
  readonly order: ShopifyOrder;
  readonly customerInternalId: string;
  readonly lookups: LookupResolver;
  readonly derives?: MapDeriveRegistry;
  /** Override the default header mapping list (for tests / connection-specific maps). */
  readonly headerOverride?: readonly Mapping[];
}

export async function buildOrderPayload(
  args: BuildOrderPayloadArgs,
): Promise<MappingResult<NsOrderPayload>> {
  const derives = args.derives ?? defaultDeriveRegistry();
  const ctx: EvaluatorContext = { lookups: args.lookups, derives };

  // 1. Header mapping (top-level fields).
  const headerMappings = args.headerOverride ?? buildDefaultOrderHeaderMap(args.connection);
  const headerResult = await evaluate(args.order, headerMappings, ctx);
  if (!headerResult.ok) return headerResult;

  // 2. Line items — a single Derive that returns an array.
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

  // 3. Shipping — optional. Empty array is fine (digital orders).
  const shippingResult = await evaluate(args.order, [buildDefaultShippingMap()], ctx);
  if (!shippingResult.ok) return shippingResult;
  const shippingLines = shippingResult.payload['shipping'];

  const header = headerResult.payload;
  if (typeof header['subsidiary'] !== 'string') {
    return park({ reason: 'unmapped_construct', detail: 'subsidiary missing from header map', construct: 'subsidiary' });
  }
  if (typeof header['externalid'] !== 'string') {
    return park({ reason: 'unmapped_construct', detail: 'externalid missing from header map', construct: 'externalid' });
  }
  if (typeof header['tranid'] !== 'string') {
    return park({ reason: 'unmapped_construct', detail: 'tranid missing from header map', construct: 'tranid' });
  }

  const payload: NsOrderPayload = {
    ...header,
    subsidiary: header['subsidiary'],
    externalid: header['externalid'],
    tranid: header['tranid'],
    entity: args.customerInternalId,
    item: lineItems as ReadonlyArray<Record<string, unknown>>,
    ...(Array.isArray(shippingLines) && shippingLines.length > 0
      ? { shipping: shippingLines as ReadonlyArray<Record<string, unknown>> }
      : {}),
  };
  return { ok: true, payload };
}

/**
 * Map the connection's `orderTarget` to the NetSuite record type string the
 * gateway expects. Kept as a function (rather than inline at the call site)
 * so the same translation can be reused by tests and any future replay path.
 */
export function netsuiteOrderRecordType(connection: Connection): 'salesorder' | 'cashsale' {
  return connection.orderTarget === 'sales_order' ? 'salesorder' : 'cashsale';
}
