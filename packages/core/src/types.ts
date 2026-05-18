import type { Environment } from './env.js';

/**
 * Entity types tracked in `entity_xref`. Includes future values
 * (refund/cancellation/fulfillment/item) so M2+ adds no migration.
 */
export type EntityType =
  | 'order'
  | 'customer'
  | 'refund'
  | 'cancellation'
  | 'fulfillment'
  | 'item';

export type SourceSystem = 'shopify' | 'netsuite';
export type TargetSystem = 'shopify' | 'netsuite';

export type TaxEngine = 'suitetax' | 'legacy';
export type OrderTarget = 'sales_order' | 'cash_sale';

/**
 * Per-connection config (one Shopify store → one NS account/subsidiary/location).
 * Hydrated from the `connections` table or local JSONC during dev.
 */
export interface Connection {
  readonly connectionId: string;
  readonly environment: Environment;
  readonly shopifyStore: string;
  /**
   * SecretProvider ref for the Shopify Admin API access token (custom-app token used
   * for GraphQL/REST calls). Separate from `shopifyWebhookSecretRef` — Shopify custom
   * apps issue two distinct secrets.
   */
  readonly shopifyAppTokenRef: string;
  /**
   * SecretProvider ref for the Shopify webhook **shared secret** (API secret key from
   * the custom app's API credentials page) used to verify the
   * `X-Shopify-Hmac-Sha256` header on inbound webhooks. Distinct from
   * `shopifyAppTokenRef` — a misconfiguration here parks all inbound deliveries as 401.
   */
  readonly shopifyWebhookSecretRef: string;
  readonly nsAccountId: string;
  readonly nsSubsidiary: string;
  readonly nsLocation?: string;
  readonly baseCurrency: string;
  readonly taxEngine: TaxEngine;
  readonly orderTarget: OrderTarget;
  /** Versioned mapping config key — opaque to core. */
  readonly mapVersion: string;
  /** Whether the connection is currently enabled. Disabled connections are config-visible but inert. */
  readonly enabled: boolean;
  /**
   * Per-tenant header field overrides. Appended to the built-in default
   * order-header mapping list, so the connection can layer NS custom fields
   * (`custbody_*`), per-account orderStatus choices, etc., without code
   * changes. Carried in `DPI_CONNECTIONS_JSON` for now.
   *
   * TODO (M2): promote to a SQL `connection_field_maps` table + admin REST
   * writer so ops can change tenant fields without a redeploy.
   *
   * Typed as `readonly unknown[]` here because validating recursive Mapping
   * shape at the parser layer is more ceremony than value for v1 — the
   * mapping evaluator throws clearly on malformed entries.
   */
  readonly extraOrderHeaderMappings?: readonly unknown[];
  /**
   * NS internal id of the shipping item to use for every Shopify shipping
   * line on this connection. Set when the store's shipping methods aren't
   * registered as named NS items matching the Shopify title — without this,
   * the item resolver parks every order with a shipping line.
   *
   * Future M2: replace with a `lookup_ship_method` table mapping each
   * Shopify shipping title to its own NS internal id (multi-rate stores).
   */
  readonly defaultShipItemId?: string;
  /**
   * NS internal id of a generic catch-all item used when a Shopify line's SKU
   * has no matching NS item record. Without this set, the item resolver parks
   * the order with `unmapped_construct` (brief invariant 2: "park, don't
   * guess"). Connections that prefer to land every order — accepting that
   * unmapped SKUs collapse onto a single "Shopify Item" placeholder for
   * later cleanup — set this to that item's NS internal id. Only applies to
   * the order-line sublist; shipping lines keep using `defaultShipItemId`.
   */
  readonly defaultItemId?: string;
  /**
   * NS internal id of the Discount item (`itemtype=Discount`) used to land
   * Shopify order-level discounts on NS sales orders. When `order.totalDiscounts`
   * is non-zero, the payload builder emits `discountItem: <this>` plus
   * `discountRate: -<amount>` on the header — NS then applies it before tax so
   * its recomputed tax base matches Shopify's.
   *
   * Brief invariant 2 ("park, don't guess"): if a Shopify order carries a
   * discount on a connection where this is **not** set, the payload builder
   * parks the order as `unmapped_construct` rather than letting it land in NS
   * without the discount (which over-charges via NS's now-larger tax base).
   *
   * The Discount item in NS must have "Apply Before Tax" enabled for this
   * approach to reproduce Shopify's tax base — that's a NS-side setup step,
   * not a code one.
   */
  readonly defaultDiscountItemId?: string;
  /**
   * When true, the order handler tags the Shopify order with `netsuite-<internalId>`
   * after a successful NS upsert (slice E2). Opt-in per connection because:
   *   1. it's the first NS→Shopify write the integration performs — the v1
   *      brief explicitly leaves NS→Shopify flows out of scope, so this is
   *      a deliberate exception you have to enable per tenant; and
   *   2. it requires the `write_orders` Shopify scope on the custom app —
   *      installing a wider scope on a store that doesn't need this feature
   *      shouldn't be forced.
   *
   * A tag-add failure does NOT roll back the import — the NS record is the
   * source of truth at that point. The failure logs at warn and is recorded
   * to `error_records` with `errorClass='data'` so ops can replay just the
   * tag operation later (a future slice; for now, manually).
   */
  readonly writeTagsOnImport?: boolean;
}

/** A Shopify webhook envelope as we receive it (minimal subset core needs). */
export interface ShopifyWebhookEnvelope {
  readonly topic: string;
  readonly shopDomain: string;
  readonly orderGid: string;
  readonly hmac: string;
  readonly rawBody: string;
  readonly receivedAt: Date;
}
