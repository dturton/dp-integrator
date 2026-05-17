import type { Connection } from '@dpi/core';
import type { ShopifyOrder, ShopifyTaxLine } from '@dpi/shopify-client';

/**
 * Tax engine choice is per-NS-account and the brief mandates we abstract it.
 * Each strategy returns:
 *   - `lineTax`   — per-NS-line tax detail (appended to each item line in
 *                   the NS payload). Empty for header-only strategies.
 *   - `headerTax` — fields set on the NS record header (where the engine
 *                   wants the tax totals).
 *   - `taxItems`  — optional explicit tax items added as separate lines on
 *                   the order. Empty for both v1 strategies; reserved for
 *                   accounts that book tax as a line item rather than a
 *                   field.
 *
 * Slice D2: both impls aggregate `order.taxLines` and forward the totals to
 * NS. Per-line taxcode resolution against `lookup_tax` lives in a future
 * pass — for now the brief's "park, don't guess" invariant is honored via
 * the mapping evaluator's lookup primitive, not via tax. Real production
 * connections will register a per-tax-line lookup_tax row before going live.
 */
export interface TaxPayloadPart {
  readonly lineTax: ReadonlyArray<Record<string, unknown>>;
  readonly headerTax: Record<string, unknown>;
  readonly taxItems: ReadonlyArray<Record<string, unknown>>;
}

export interface TaxStrategy {
  readonly engine: 'suitetax' | 'legacy';
  buildOrderTax(connection: Connection, order: ShopifyOrder): TaxPayloadPart;
  buildShippingTax(connection: Connection, shippingTax: readonly ShopifyTaxLine[]): TaxPayloadPart;
}

const EMPTY: TaxPayloadPart = { lineTax: [], headerTax: {}, taxItems: [] };

/**
 * SuiteTax — NS modern tax engine.
 *
 * Slice D5 policy: do NOT override NS's tax computation. NS computes tax
 * from the customer's address + the subsidiary's nexus when no override
 * is provided. Any rounding diff between Shopify's taxLines and NS's
 * recomputation is absorbed by `applyBalancing` (within tolerance) or
 * parks the order for review (over tolerance).
 *
 * The previous "pass-through" approach (taxDetailsOverride=true with the
 * Shopify tax title as taxCode) made NS reject the whole salesorder
 * because NS expects taxCode as an internal id reference and won't
 * accept arbitrary names. A real implementation needs a `lookup_tax`
 * table mapping Shopify tax-line titles → NS tax-code internal ids; the
 * mapping engine's lookup primitive already supports this and the
 * SuiteTax strategy will switch to override mode once a connection
 * registers those rows.
 */
export class SuiteTaxStrategy implements TaxStrategy {
  readonly engine = 'suitetax' as const;

  buildOrderTax(_connection: Connection, _order: ShopifyOrder): TaxPayloadPart {
    return EMPTY;
  }

  buildShippingTax(_connection: Connection, _shippingTax: readonly ShopifyTaxLine[]): TaxPayloadPart {
    return EMPTY;
  }
}

/**
 * Legacy Tax — older per-line `taxcode` / `taxrate` model. We forward the
 * single rate from the first tax line as the order default (NS computes
 * per-line at save time). When there's no tax, this is a no-op.
 */
export class LegacyTaxStrategy implements TaxStrategy {
  readonly engine = 'legacy' as const;

  buildOrderTax(_connection: Connection, order: ShopifyOrder): TaxPayloadPart {
    if (order.taxLines.length === 0 && order.totalTax.amount === '0.00') {
      return EMPTY;
    }
    // Take the first tax line as the order-default tax code + rate. For
    // multi-jurisdiction orders, connections should switch to SuiteTax (the
    // brief's tax engine choice is per-account).
    const primary = order.taxLines[0];
    const headerTax: Record<string, unknown> = {
      taxsubtotal: order.totalTax.amount,
    };
    if (primary) {
      headerTax['taxitem'] = primary.title;
      headerTax['taxrate'] = primary.rate;
    }
    return { lineTax: [], headerTax, taxItems: [] };
  }

  buildShippingTax(_connection: Connection, shippingTax: readonly ShopifyTaxLine[]): TaxPayloadPart {
    if (shippingTax.length === 0) return EMPTY;
    const primary = shippingTax[0]!;
    return {
      lineTax: [],
      headerTax: {
        shippingtax1rate: primary.rate,
        shippingtaxcode: primary.title,
      },
      taxItems: [],
    };
  }
}

/** Pick the strategy matching the connection. */
export function strategyFor(connection: Connection): TaxStrategy {
  switch (connection.taxEngine) {
    case 'suitetax':
      return new SuiteTaxStrategy();
    case 'legacy':
      return new LegacyTaxStrategy();
  }
}

/**
 * Merge a TaxPayloadPart into an existing NS payload header object. Used by
 * the payload builder to layer the engine's header tax fields onto the
 * mapping-evaluator output.
 */
export function applyTaxPayloadHeader(
  payload: Record<string, unknown>,
  part: TaxPayloadPart,
): void {
  for (const [k, v] of Object.entries(part.headerTax)) {
    payload[k] = v;
  }
}
