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
