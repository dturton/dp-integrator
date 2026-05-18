import type { ShopifyOrder } from '@dpi/shopify-client';

/**
 * Result of running the eligibility predicate over a re-fetched Shopify order.
 *
 * `eligible: true` → handler proceeds to map + write to NS.
 * `eligible: false` → handler either defers or ignores the order based on
 * `disposition`.
 *   `reason` is a stable machine-readable string so metrics can bucket by
 *   cause without parsing free text.
 */
export type EligibilityResult =
  | { readonly eligible: true }
  | {
      readonly eligible: false;
      readonly disposition: 'deferred' | 'ignored';
      readonly reason: EligibilityReason;
      readonly detail?: string;
    };

export type EligibilityReason =
  | 'test_order'
  | 'fraud_hold'
  | 'voided'
  | 'pending_payment'
  | 'no_line_items'
  | 'disallowed_topic';

/**
 * Connection-scoped overrides. If unset, defaults to "sync only paid/authorized,
 * non-test, non-fraud-held standard product orders with at least one line item".
 *
 * Future: Connection.eligibilityRule (json) on the database carries per-shop
 * tweaks; we accept it via this struct so the brief's "eligibility predicate"
 * is centrally testable.
 */
export interface EligibilityOptions {
  /**
   * Webhook topic the receiver originally accepted. Some connections may
   * want to sync only `orders/create` and ignore `orders/updated` (or vice
   * versa) — express that here. Default: both accepted.
   */
  readonly allowedTopics?: readonly string[];
  /**
   * Financial statuses that are eligible. Default: `['paid', 'authorized', 'partially_paid']`.
   * Pending/voided/refunded orders never reach NS via this slice.
   */
  readonly allowedFinancialStatuses?: readonly ShopifyOrder['financialStatus'][];
}

const DEFAULT_FINANCIAL_STATUSES: readonly ShopifyOrder['financialStatus'][] = [
  'paid',
  'authorized',
  'partially_paid',
];

/**
 * Pure eligibility predicate. Brief invariant 2 ("park, don't guess") is
 * implemented by the mapping evaluator; this is a narrower upstream filter
 * that just decides "should we even attempt to import?".
 */
export function checkEligibility(
  order: ShopifyOrder,
  topic: string,
  options: EligibilityOptions = {},
): EligibilityResult {
  // Test orders MUST NEVER reach NS — brief §1 invariant.
  if (order.test) {
    return { eligible: false, disposition: 'ignored', reason: 'test_order' };
  }
  if (order.fraudHold) {
    return { eligible: false, disposition: 'deferred', reason: 'fraud_hold' };
  }
  if (order.financialStatus === 'voided') {
    return { eligible: false, disposition: 'ignored', reason: 'voided' };
  }
  const allowedStatuses = options.allowedFinancialStatuses ?? DEFAULT_FINANCIAL_STATUSES;
  if (!allowedStatuses.includes(order.financialStatus)) {
    return {
      eligible: false,
      disposition: 'deferred',
      reason: 'pending_payment',
      detail: `financialStatus=${order.financialStatus} not in ${JSON.stringify(allowedStatuses)}`,
    };
  }
  if (order.lineItems.length === 0) {
    return { eligible: false, disposition: 'ignored', reason: 'no_line_items' };
  }
  if (options.allowedTopics && !options.allowedTopics.includes(topic)) {
    return {
      eligible: false,
      disposition: 'deferred',
      reason: 'disallowed_topic',
      detail: `topic=${topic} not in ${JSON.stringify(options.allowedTopics)}`,
    };
  }
  return { eligible: true };
}
