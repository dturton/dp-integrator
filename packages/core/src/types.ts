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
