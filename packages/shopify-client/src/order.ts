/**
 * Minimal typed Shopify Order model — only the fields the v1 mapping engine
 * needs to build a NS Sales Order / Cash Sale for a STANDARD product order.
 *
 * Out-of-v1 constructs (refunds, fulfillments, gift card tender, multi-currency
 * presentment money, B2B company location, Recharge subscription line shape,
 * POS-specific tender) are intentionally absent — orders carrying those fields
 * are parked as `unmapped_construct` by the mapping engine in M1, never silently
 * mapped through this skeleton model.
 *
 * Field shapes mirror Shopify Admin GraphQL where reasonable; the real client
 * will translate the GraphQL response into this shape in M1.
 */

export interface MoneyV2 {
  readonly amount: string;
  readonly currencyCode: string;
}

export interface ShopifyAddress {
  /**
   * Shopify MailingAddress GID (e.g. `gid://shopify/MailingAddress/123456`).
   *
   * On an Order, `shippingAddress` and `billingAddress` are *snapshots* —
   * each order carries its own MailingAddress with its own id, even if the
   * buyer reused a saved address. The id is still useful for deduping
   * downstream (we stamp it onto NS addressbook entries as
   * `custrecord_shopify_address_id`) so the same snapshot from a retried
   * import collapses to one entry rather than appending.
   *
   * Optional: some address surfaces in Shopify don't expose an id (e.g.
   * inline checkout-only addresses before they're persisted).
   */
  readonly id?: string;
  readonly firstName?: string;
  readonly lastName?: string;
  readonly company?: string;
  readonly address1?: string;
  readonly address2?: string;
  readonly city?: string;
  readonly province?: string;
  readonly provinceCode?: string;
  readonly country?: string;
  readonly countryCode?: string;
  readonly zip?: string;
  readonly phone?: string;
}

export interface ShopifyCustomer {
  /** Shopify GraphQL GID, e.g. `gid://shopify/Customer/12345`. */
  readonly id: string;
  readonly email?: string;
  readonly firstName?: string;
  readonly lastName?: string;
  readonly defaultAddress?: ShopifyAddress;
}

export interface ShopifyLineItem {
  /** Line GID. */
  readonly id: string;
  readonly title: string;
  readonly variantId?: string;
  readonly sku?: string;
  readonly quantity: number;
  readonly originalUnitPrice: MoneyV2;
  /** Pre-tax, post-discount line subtotal. */
  readonly discountedTotal: MoneyV2;
  /** Allocations of order-level discounts to this line. */
  readonly discountAllocations: readonly DiscountAllocation[];
}

export interface DiscountAllocation {
  readonly allocatedAmount: MoneyV2;
  /** Opaque code/title from Shopify — used by the mapping lookup. */
  readonly discountTitle?: string;
}

export interface ShopifyShippingLine {
  readonly id: string;
  readonly title: string;
  readonly source?: string;
  readonly carrierIdentifier?: string;
  readonly price: MoneyV2;
  /** Taxes specifically applied to this shipping line. */
  readonly taxLines: readonly ShopifyTaxLine[];
}

export interface ShopifyTaxLine {
  readonly title: string;
  readonly rate: number;
  readonly price: MoneyV2;
}

export interface ShopifyTransaction {
  readonly id: string;
  readonly kind: 'sale' | 'authorization' | 'capture' | 'refund' | 'void' | 'change';
  readonly status: 'success' | 'pending' | 'failure' | 'error';
  readonly gateway: string;
  readonly amount: MoneyV2;
  readonly processedAt: string;
}

/**
 * Financial / fulfillment status as Shopify exposes it on the order. Used by
 * the eligibility predicate (M1) to decide if the order should sync at all.
 */
export type ShopifyFinancialStatus =
  | 'pending'
  | 'authorized'
  | 'partially_paid'
  | 'paid'
  | 'partially_refunded'
  | 'refunded'
  | 'voided';

export type ShopifyFulfillmentStatus =
  | 'unfulfilled'
  | 'partial'
  | 'fulfilled'
  | 'restocked';

export interface ShopifyOrder {
  /** Shopify GraphQL GID, e.g. `gid://shopify/Order/100`. The NS externalId. */
  readonly id: string;
  /** Human-readable name (e.g. `#1001`). */
  readonly name: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly processedAt: string;
  readonly currencyCode: string;
  readonly totalPrice: MoneyV2;
  readonly subtotalPrice: MoneyV2;
  readonly totalTax: MoneyV2;
  readonly totalShippingPrice: MoneyV2;
  readonly totalDiscounts: MoneyV2;
  readonly financialStatus: ShopifyFinancialStatus;
  readonly fulfillmentStatus: ShopifyFulfillmentStatus | null;
  /** Shopify test orders MUST NEVER reach NS — eligibility predicate enforces this in M1. */
  readonly test: boolean;
  /** Pending fraud / manual hold flag — also blocks eligibility. */
  readonly fraudHold: boolean;
  readonly customer: ShopifyCustomer | null;
  readonly lineItems: readonly ShopifyLineItem[];
  readonly shippingLines: readonly ShopifyShippingLine[];
  readonly taxLines: readonly ShopifyTaxLine[];
  readonly transactions: readonly ShopifyTransaction[];
  readonly billingAddress?: ShopifyAddress;
  readonly shippingAddress?: ShopifyAddress;
  /** Shopify location GID this order is attributed to (POS / multi-location). */
  readonly locationId?: string;
  readonly note?: string;
  readonly tags?: readonly string[];
}
