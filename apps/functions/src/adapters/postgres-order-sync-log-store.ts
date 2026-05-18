import type pg from 'pg';
import type {
  Environment,
  OrderSyncLog,
  OrderSyncLogInput,
  OrderSyncLogListFilter,
  OrderSyncLogStatus,
  OrderSyncLogStore,
} from '@dpi/core';

/**
 * Postgres-backed `OrderSyncLogStore`. Upsert on `(environment,
 * connection_id, shopify_order_gid)` so a parked row transitions to
 * `imported` in place when a replay succeeds — no stale park fields left
 * behind because the SET clause overwrites every column from the input.
 */
export class PostgresOrderSyncLogStore implements OrderSyncLogStore {
  constructor(private readonly pool: pg.Pool) {}

  async upsert(input: OrderSyncLogInput): Promise<OrderSyncLog> {
    const r = await this.pool.query<OrderSyncLogDb>(
      `
      INSERT INTO order_sync_log (
        environment, connection_id,
        shopify_order_gid, shopify_order_id, shopify_order_name,
        shopify_created_at, shopify_processed_at, shopify_updated_at,
        customer_email,
        currency_code, total_price, subtotal_price, total_tax, total_discounts, total_shipping,
        status,
        ns_account_id, ns_record_type, ns_internal_id, ns_tran_id,
        park_stage, park_detail, park_error_class,
        ignored_reason,
        synced_at,
        attempt_count, last_delivery_count, last_outbound_payload_uri, last_inbound_envelope_uri
      )
      VALUES (
        $1, $2,
        $3, $4, $5,
        $6, $7, $8,
        $9,
        $10, $11, $12, $13, $14, $15,
        $16,
        $17, $18, $19, $20,
        $21, $22, $23,
        $24,
        $25,
        COALESCE($26, 0), $27, $28, $29
      )
      ON CONFLICT (environment, connection_id, shopify_order_gid)
      DO UPDATE SET
        shopify_order_id     = EXCLUDED.shopify_order_id,
        shopify_order_name   = EXCLUDED.shopify_order_name,
        shopify_created_at   = EXCLUDED.shopify_created_at,
        shopify_processed_at = EXCLUDED.shopify_processed_at,
        shopify_updated_at   = EXCLUDED.shopify_updated_at,
        customer_email       = EXCLUDED.customer_email,
        currency_code        = EXCLUDED.currency_code,
        total_price          = EXCLUDED.total_price,
        subtotal_price       = EXCLUDED.subtotal_price,
        total_tax            = EXCLUDED.total_tax,
        total_discounts      = EXCLUDED.total_discounts,
        total_shipping       = EXCLUDED.total_shipping,
        status               = EXCLUDED.status,
        ns_account_id        = EXCLUDED.ns_account_id,
        ns_record_type       = EXCLUDED.ns_record_type,
        ns_internal_id       = EXCLUDED.ns_internal_id,
        ns_tran_id           = COALESCE(EXCLUDED.ns_tran_id, order_sync_log.ns_tran_id),
        park_stage           = EXCLUDED.park_stage,
        park_detail          = EXCLUDED.park_detail,
        park_error_class     = EXCLUDED.park_error_class,
        ignored_reason       = EXCLUDED.ignored_reason,
        synced_at            = COALESCE(EXCLUDED.synced_at, order_sync_log.synced_at),
        -- M2-D retry telemetry: monotonic-take-max so a late-arriving sync_log
        -- update from an EARLIER delivery never drags attempt_count backwards.
        attempt_count        = GREATEST(order_sync_log.attempt_count, EXCLUDED.attempt_count),
        last_delivery_count  = COALESCE(EXCLUDED.last_delivery_count, order_sync_log.last_delivery_count),
        last_outbound_payload_uri = COALESCE(EXCLUDED.last_outbound_payload_uri, order_sync_log.last_outbound_payload_uri),
        last_inbound_envelope_uri = COALESCE(EXCLUDED.last_inbound_envelope_uri, order_sync_log.last_inbound_envelope_uri),
        updated_at           = NOW()
      RETURNING *
      `,
      [
        input.environment,
        input.connectionId,
        input.shopifyOrderGid,
        input.shopifyOrderId,
        input.shopifyOrderName ?? null,
        input.shopifyCreatedAt ?? null,
        input.shopifyProcessedAt ?? null,
        input.shopifyUpdatedAt ?? null,
        input.customerEmail ?? null,
        input.currencyCode ?? null,
        input.totalPrice ?? null,
        input.subtotalPrice ?? null,
        input.totalTax ?? null,
        input.totalDiscounts ?? null,
        input.totalShipping ?? null,
        input.status,
        input.nsAccountId ?? null,
        input.nsRecordType ?? null,
        input.nsInternalId ?? null,
        input.nsTranId ?? null,
        input.parkStage ?? null,
        input.parkDetail ?? null,
        input.parkErrorClass ?? null,
        input.ignoredReason ?? null,
        input.syncedAt ?? null,
        input.attemptCount ?? null,
        input.lastDeliveryCount ?? null,
        input.lastOutboundPayloadUri ?? null,
        input.lastInboundEnvelopeUri ?? null,
      ],
    );
    const row = r.rows[0];
    if (!row) throw new Error('PostgresOrderSyncLogStore.upsert: returned no row');
    return toRow(row);
  }

  async list(filter: OrderSyncLogListFilter): Promise<OrderSyncLog[]> {
    const clauses: string[] = ['environment = $1'];
    const params: unknown[] = [filter.environment];
    if (filter.connectionId) {
      params.push(filter.connectionId);
      clauses.push(`connection_id = $${params.length}`);
    }
    if (filter.status) {
      params.push(filter.status);
      clauses.push(`status = $${params.length}`);
    }
    params.push(filter.limit ?? 50);
    const limitIdx = params.length;
    const r = await this.pool.query<OrderSyncLogDb>(
      `SELECT *
         FROM order_sync_log
        WHERE ${clauses.join(' AND ')}
        ORDER BY COALESCE(synced_at, updated_at) DESC
        LIMIT $${limitIdx}`,
      params,
    );
    return r.rows.map(toRow);
  }

  async findByOrderGid(parts: {
    environment: Environment;
    connectionId: string;
    shopifyOrderGid: string;
  }): Promise<OrderSyncLog | undefined> {
    const r = await this.pool.query<OrderSyncLogDb>(
      `SELECT * FROM order_sync_log
        WHERE environment=$1 AND connection_id=$2 AND shopify_order_gid=$3
        LIMIT 1`,
      [parts.environment, parts.connectionId, parts.shopifyOrderGid],
    );
    return r.rows[0] ? toRow(r.rows[0]) : undefined;
  }
}

interface OrderSyncLogDb {
  id: string | number;
  environment: Environment;
  connection_id: string;
  shopify_order_gid: string;
  shopify_order_id: string;
  shopify_order_name: string | null;
  shopify_created_at: Date | null;
  shopify_processed_at: Date | null;
  shopify_updated_at: Date | null;
  customer_email: string | null;
  currency_code: string | null;
  total_price: string | null;
  subtotal_price: string | null;
  total_tax: string | null;
  total_discounts: string | null;
  total_shipping: string | null;
  status: OrderSyncLogStatus;
  ns_account_id: string | null;
  ns_record_type: 'salesorder' | 'cashsale' | null;
  ns_internal_id: string | null;
  ns_tran_id: string | null;
  park_stage: string | null;
  park_detail: string | null;
  park_error_class: string | null;
  ignored_reason: string | null;
  synced_at: Date | null;
  created_at: Date;
  updated_at: Date;
  attempt_count: number | null;
  last_delivery_count: number | null;
  last_outbound_payload_uri: string | null;
  last_inbound_envelope_uri: string | null;
}

function toRow(row: OrderSyncLogDb): OrderSyncLog {
  return {
    id: String(row.id),
    environment: row.environment,
    connectionId: row.connection_id,
    shopifyOrderGid: row.shopify_order_gid,
    shopifyOrderId: row.shopify_order_id,
    ...(row.shopify_order_name !== null ? { shopifyOrderName: row.shopify_order_name } : {}),
    ...(row.shopify_created_at !== null ? { shopifyCreatedAt: row.shopify_created_at } : {}),
    ...(row.shopify_processed_at !== null ? { shopifyProcessedAt: row.shopify_processed_at } : {}),
    ...(row.shopify_updated_at !== null ? { shopifyUpdatedAt: row.shopify_updated_at } : {}),
    ...(row.customer_email !== null ? { customerEmail: row.customer_email } : {}),
    ...(row.currency_code !== null ? { currencyCode: row.currency_code } : {}),
    ...(row.total_price !== null ? { totalPrice: row.total_price } : {}),
    ...(row.subtotal_price !== null ? { subtotalPrice: row.subtotal_price } : {}),
    ...(row.total_tax !== null ? { totalTax: row.total_tax } : {}),
    ...(row.total_discounts !== null ? { totalDiscounts: row.total_discounts } : {}),
    ...(row.total_shipping !== null ? { totalShipping: row.total_shipping } : {}),
    status: row.status,
    ...(row.ns_account_id !== null ? { nsAccountId: row.ns_account_id } : {}),
    ...(row.ns_record_type !== null ? { nsRecordType: row.ns_record_type } : {}),
    ...(row.ns_internal_id !== null ? { nsInternalId: row.ns_internal_id } : {}),
    ...(row.ns_tran_id !== null ? { nsTranId: row.ns_tran_id } : {}),
    ...(row.park_stage !== null ? { parkStage: row.park_stage } : {}),
    ...(row.park_detail !== null ? { parkDetail: row.park_detail } : {}),
    ...(row.park_error_class !== null ? { parkErrorClass: row.park_error_class } : {}),
    ...(row.ignored_reason !== null ? { ignoredReason: row.ignored_reason } : {}),
    ...(row.synced_at !== null ? { syncedAt: row.synced_at } : {}),
    ...(row.attempt_count !== null ? { attemptCount: row.attempt_count } : {}),
    ...(row.last_delivery_count !== null ? { lastDeliveryCount: row.last_delivery_count } : {}),
    ...(row.last_outbound_payload_uri !== null
      ? { lastOutboundPayloadUri: row.last_outbound_payload_uri }
      : {}),
    ...(row.last_inbound_envelope_uri !== null
      ? { lastInboundEnvelopeUri: row.last_inbound_envelope_uri }
      : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
