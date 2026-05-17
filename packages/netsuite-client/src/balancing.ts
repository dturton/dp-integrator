import { park, type MappingResult } from '@dpi/mapping-engine';
import type { ShopifyOrder } from '@dpi/shopify-client';
import type { NsOrderPayload } from './payload-builder.js';

/**
 * Brief M1 invariant: NS total must reconcile to the Shopify total within
 * tolerance. Floating-point math at the Shopify <-> NS boundary plus per-
 * line discount allocation rounding makes exact equality unreliable; this
 * function:
 *
 *   1. Computes the sum the NS payload would render at: items + shipping +
 *      tax (taken from order.totalTax since the tax strategy already
 *      forwarded those totals).
 *   2. Compares against order.totalPrice.
 *   3. If the diff exceeds tolerance: park (`unmapped_construct`) — would
 *      mis-book revenue otherwise.
 *   4. If the diff is non-zero but within tolerance: append a balancing
 *      adjustment line to payload.item so the NS total matches exactly.
 *
 * The balancing line is a single NS item with the diff as `amount`,
 * `quantity=1`, and a connection-configured `balancingItemId`. The sign
 * carries naturally (Shopify total > sum → positive adjustment;
 * Shopify total < sum → negative).
 *
 * All money math uses string decimals (the on-the-wire format from
 * Shopify) routed through `Number.parseFloat` rounded to 2dp — sufficient
 * for currencies with up to 2 decimal places. Zero-decimal currencies (JPY,
 * KRW) work too since the rounding is a no-op for them. Three-decimal
 * currencies (KWD, OMR) would need a future extension to the tolerance
 * type.
 */

export interface BalancingOptions {
  /** Maximum absolute diff (in order currency) that gets absorbed via a balancing line. */
  readonly toleranceAmount: number;
  /** NS item internal id used as the balancing line. */
  readonly balancingItemId: string;
}

export const DEFAULT_BALANCING: BalancingOptions = {
  toleranceAmount: 0.05,
  balancingItemId: 'BALANCING',
};

export interface BalancingDiagnostics {
  readonly shopifyTotal: number;
  readonly nsLinesTotal: number;
  readonly nsTaxTotal: number;
  readonly nsShippingTotal: number;
  readonly orderDiscounts: number;
  readonly diff: number;
  readonly applied: boolean;
}

export interface BalancedPayload {
  readonly payload: NsOrderPayload;
  readonly diagnostics: BalancingDiagnostics;
}

export function applyBalancing(
  payload: NsOrderPayload,
  order: ShopifyOrder,
  options: BalancingOptions = DEFAULT_BALANCING,
): MappingResult<BalancedPayload> {
  const shopifyTotal = parseAmount(order.totalPrice.amount);
  const nsTaxTotal = parseAmount(order.totalTax.amount); // tax strategy forwarded these
  const nsShippingTotal = sumAmounts(
    (payload.shipping ?? []).map((line) => line['amount']),
  );
  const nsLinesTotal = sumAmounts(payload.item.map((line) => line['amount']));
  // Shopify's `totalDiscounts` reflects ORDER-LEVEL discounts that aren't
  // already reflected in each line's `discountedTotal` (line-level discounts
  // are baked into discountedTotal by Shopify). Subtract here so the
  // computed NS total matches what Shopify ultimately charged. A future
  // refinement adds an explicit NS discount line so the discount info is
  // preserved in NS (rather than being absorbed by the balancing line).
  const orderDiscounts = parseAmount(order.totalDiscounts.amount);
  const nsTotal = round2(nsLinesTotal + nsShippingTotal + nsTaxTotal - orderDiscounts);
  const diff = round2(shopifyTotal - nsTotal);

  if (Math.abs(diff) > options.toleranceAmount) {
    return park({
      reason: 'unmapped_construct',
      detail: `totals differ by ${diff.toFixed(2)} ${order.totalPrice.currencyCode} (tolerance ${options.toleranceAmount.toFixed(2)}); refusing to book until reconciled`,
      construct: 'balancing',
      evidence: {
        shopifyTotal,
        nsLinesTotal,
        nsShippingTotal,
        nsTaxTotal,
        orderDiscounts,
        diff,
      },
    });
  }

  const diagnostics: BalancingDiagnostics = {
    shopifyTotal,
    nsLinesTotal,
    nsTaxTotal,
    nsShippingTotal,
    orderDiscounts,
    diff,
    applied: diff !== 0,
  };
  if (diff === 0) {
    return { ok: true, payload: { payload, diagnostics } };
  }
  const balancingLine: Record<string, unknown> = {
    item: options.balancingItemId,
    quantity: 1,
    rate: diff.toFixed(2),
    amount: diff.toFixed(2),
    description: 'Rounding adjustment',
    externalid: `${payload.externalid}:balancing`,
  };
  const newPayload: NsOrderPayload = {
    ...payload,
    item: [...payload.item, balancingLine],
  };
  return { ok: true, payload: { payload: newPayload, diagnostics } };
}

function parseAmount(s: string): number {
  const n = Number.parseFloat(s);
  if (Number.isNaN(n)) {
    throw new Error(`balancing: cannot parse amount '${s}' as a number`);
  }
  return round2(n);
}

function sumAmounts(values: ReadonlyArray<unknown>): number {
  let total = 0;
  for (const v of values) {
    if (typeof v === 'string') total += parseAmount(v);
    else if (typeof v === 'number') total += round2(v);
  }
  return round2(total);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
