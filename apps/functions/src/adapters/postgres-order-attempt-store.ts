import type pg from 'pg';
import type {
  Environment,
  OrderAttempt,
  OrderAttemptInput,
  OrderAttemptOutcome,
  OrderAttemptStore,
} from '@dpi/core';

/**
 * Postgres-backed `OrderAttemptStore`. Append-only — every Service Bus
 * delivery emits one row regardless of outcome (M2-D).
 *
 * `payload_digest` is stored as JSONB so the future admin UI can render the
 * inline summary (tranId / lineCount / total) without a blob fetch. The full
 * outbound payload lives in the `outbound-netsuite` blob container; the URI
 * is on `outbound_payload_uri`.
 */
export class PostgresOrderAttemptStore implements OrderAttemptStore {
  constructor(private readonly pool: pg.Pool) {}

  async record(input: OrderAttemptInput): Promise<OrderAttempt> {
    const r = await this.pool.query<OrderAttemptDb>(
      `
      INSERT INTO order_attempt (
        environment, connection_id, shopify_order_gid,
        delivery_count, sb_message_id, sb_session_id,
        outcome, stage, error_class, detail,
        inbound_envelope_uri, outbound_payload_uri,
        ns_response_uri, ns_response_status,
        shopify_payload_uri,
        payload_digest,
        started_at, finished_at, duration_ms
      )
      VALUES (
        $1, $2, $3,
        $4, $5, $6,
        $7, $8, $9, $10,
        $11, $12,
        $13, $14,
        $15,
        $16::jsonb,
        $17, $18, $19
      )
      RETURNING *
      `,
      [
        input.environment,
        input.connectionId,
        input.shopifyOrderGid,
        input.deliveryCount,
        input.sbMessageId ?? null,
        input.sbSessionId ?? null,
        input.outcome,
        input.stage ?? null,
        input.errorClass ?? null,
        input.detail ?? null,
        input.inboundEnvelopeUri ?? null,
        input.outboundPayloadUri ?? null,
        input.nsResponseUri ?? null,
        input.nsResponseStatus ?? null,
        input.shopifyPayloadUri ?? null,
        input.payloadDigest !== undefined ? JSON.stringify(input.payloadDigest) : null,
        input.startedAt,
        input.finishedAt,
        input.durationMs,
      ],
    );
    const row = r.rows[0];
    if (!row) throw new Error('PostgresOrderAttemptStore.record: returned no row');
    return toRow(row);
  }

  async listByOrderGid(parts: {
    environment: Environment;
    connectionId: string;
    shopifyOrderGid: string;
  }): Promise<OrderAttempt[]> {
    const r = await this.pool.query<OrderAttemptDb>(
      `SELECT *
         FROM order_attempt
        WHERE environment=$1 AND connection_id=$2 AND shopify_order_gid=$3
        ORDER BY delivery_count DESC, finished_at DESC`,
      [parts.environment, parts.connectionId, parts.shopifyOrderGid],
    );
    return r.rows.map(toRow);
  }
}

interface OrderAttemptDb {
  id: string | number;
  environment: Environment;
  connection_id: string;
  shopify_order_gid: string;
  delivery_count: number;
  sb_message_id: string | null;
  sb_session_id: string | null;
  outcome: OrderAttemptOutcome;
  stage: string | null;
  error_class: string | null;
  detail: string | null;
  inbound_envelope_uri: string | null;
  outbound_payload_uri: string | null;
  ns_response_uri: string | null;
  ns_response_status: number | null;
  shopify_payload_uri: string | null;
  payload_digest: Record<string, unknown> | null;
  started_at: Date;
  finished_at: Date;
  duration_ms: number;
  created_at: Date;
}

function toRow(row: OrderAttemptDb): OrderAttempt {
  return {
    id: String(row.id),
    environment: row.environment,
    connectionId: row.connection_id,
    shopifyOrderGid: row.shopify_order_gid,
    deliveryCount: row.delivery_count,
    ...(row.sb_message_id !== null ? { sbMessageId: row.sb_message_id } : {}),
    ...(row.sb_session_id !== null ? { sbSessionId: row.sb_session_id } : {}),
    outcome: row.outcome,
    ...(row.stage !== null ? { stage: row.stage } : {}),
    ...(row.error_class !== null ? { errorClass: row.error_class } : {}),
    ...(row.detail !== null ? { detail: row.detail } : {}),
    ...(row.inbound_envelope_uri !== null ? { inboundEnvelopeUri: row.inbound_envelope_uri } : {}),
    ...(row.outbound_payload_uri !== null ? { outboundPayloadUri: row.outbound_payload_uri } : {}),
    ...(row.ns_response_uri !== null ? { nsResponseUri: row.ns_response_uri } : {}),
    ...(row.ns_response_status !== null ? { nsResponseStatus: row.ns_response_status } : {}),
    ...(row.shopify_payload_uri !== null ? { shopifyPayloadUri: row.shopify_payload_uri } : {}),
    ...(row.payload_digest !== null ? { payloadDigest: row.payload_digest } : {}),
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    createdAt: row.created_at,
  };
}
