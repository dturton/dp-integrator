import { park, type MappingResult } from '@dpi/mapping-engine';
import type { ShopifyOrder } from '@dpi/shopify-client';
import type { NsOrderPayload } from './payload-builder.js';

/**
 * Brief M1 invariant: NS total must reconcile to the Shopify total within
 * tolerance. This module:
 *
 *   1. Computes the sum the NS payload would render at: items + shipping +
 *      tax (taken from `order.totalTax` since the tax strategy forwarded
 *      those totals to header) MINUS `order.totalDiscounts` (which lives at
 *      order-level, not in per-line discountedTotal).
 *   2. Compares against `order.totalPrice`.
 *   3. If the diff exceeds tolerance: park (`unmapped_construct`).
 *   4. If non-zero but within tolerance: append a balancing adjustment line
 *      to the `item.items` sublist with the diff as `amount`.
 *
 * Default balancingItemId is `'6540'` (the "Shopify Variance" item the
 * dev NS sandbox has set up). Connection-specific overrides land via
 * `extraOrderHeaderMappings` + a future per-line config; for now this
 * default is good enough for the integration to balance.
 *
 * The balancing line's `item` is emitted as a plain string — the payload
 * builder's auto-ref wrap converts it to `{ id: '<value>' }` consistently
 * with line items produced by the mapping engine.
 */

export interface BalancingOptions {
  readonly toleranceAmount: number;
  readonly balancingItemId: string;
}

export const DEFAULT_BALANCING: BalancingOptions = {
  toleranceAmount: 0.05,
  balancingItemId: '6540',
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
  const nsTaxTotal = parseAmount(order.totalTax.amount);
  const nsShippingTotal = sumAmounts(
    (payload.shipping?.items ?? []).map((line) => (line as Record<string, unknown>)['amount']),
  );
  const nsLinesTotal = sumAmounts(payload.item.items.map((line) => (line as Record<string, unknown>)['amount']));
  const orderDiscounts = parseAmount(order.totalDiscounts.amount);
  const nsTotal = round2(nsLinesTotal + nsShippingTotal + nsTaxTotal - orderDiscounts);
  const diff = round2(shopifyTotal - nsTotal);

  if (Math.abs(diff) > options.toleranceAmount) {
    return park({
      reason: 'unmapped_construct',
      detail: `totals differ by ${diff.toFixed(2)} ${order.totalPrice.currencyCode} (tolerance ${options.toleranceAmount.toFixed(2)}); refusing to book until reconciled`,
      construct: 'balancing',
      evidence: { shopifyTotal, nsLinesTotal, nsShippingTotal, nsTaxTotal, orderDiscounts, diff },
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
    // Raw string — wrapped to `{ id: '<value>' }` by the payload builder's
    // wrapNsReferences pass when the payload is built. Here we're appending
    // post-build (after applyBalancing is called by the handler), so emit the
    // already-wrapped shape directly.
    item: { id: options.balancingItemId },
    quantity: 1,
    rate: diff,
    amount: diff,
    description: 'Rounding adjustment',
  };
  const newPayload: NsOrderPayload = {
    ...payload,
    item: { items: [...payload.item.items, balancingLine] },
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
