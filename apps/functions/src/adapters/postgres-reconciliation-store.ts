import type pg from 'pg';
import type {
  Environment,
  ReconciliationListFilter,
  ReconciliationSnapshot,
  ReconciliationSnapshotInput,
  ReconciliationStore,
} from '@dpi/core';

/**
 * Postgres-backed `ReconciliationStore`. Upsert on the PK
 * `(environment, connection_id, business_date)` so a manual re-run for the
 * same day overwrites cleanly.
 */
export class PostgresReconciliationStore implements ReconciliationStore {
  constructor(private readonly pool: pg.Pool) {}

  async upsert(input: ReconciliationSnapshotInput): Promise<ReconciliationSnapshot> {
    const r = await this.pool.query<RowDb>(
      `
      INSERT INTO reconciliation_snapshots (
        environment, connection_id, business_date,
        shopify_order_count, ns_txn_count,
        shopify_total, ns_total, discrepancy
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
      ON CONFLICT (environment, connection_id, business_date)
      DO UPDATE SET
        shopify_order_count = EXCLUDED.shopify_order_count,
        ns_txn_count        = EXCLUDED.ns_txn_count,
        shopify_total       = EXCLUDED.shopify_total,
        ns_total            = EXCLUDED.ns_total,
        discrepancy         = EXCLUDED.discrepancy
      RETURNING environment, connection_id, business_date::text AS business_date,
                shopify_order_count, ns_txn_count,
                shopify_total::text AS shopify_total, ns_total::text AS ns_total,
                discrepancy, created_at
      `,
      [
        input.environment,
        input.connectionId,
        input.businessDate,
        input.shopifyOrderCount,
        input.nsTxnCount,
        input.shopifyTotal,
        input.nsTotal,
        input.discrepancy === null ? null : JSON.stringify(input.discrepancy),
      ],
    );
    const row = r.rows[0];
    if (!row) throw new Error('PostgresReconciliationStore.upsert: returned no row');
    return toRow(row);
  }

  async list(filter: ReconciliationListFilter): Promise<ReconciliationSnapshot[]> {
    const clauses: string[] = ['environment = $1'];
    const params: unknown[] = [filter.environment];
    if (filter.connectionId) {
      params.push(filter.connectionId);
      clauses.push(`connection_id = $${params.length}`);
    }
    if (filter.fromBusinessDate) {
      params.push(filter.fromBusinessDate);
      clauses.push(`business_date >= $${params.length}`);
    }
    if (filter.toBusinessDate) {
      params.push(filter.toBusinessDate);
      clauses.push(`business_date <= $${params.length}`);
    }
    params.push(filter.limit ?? 30);
    const limitIdx = params.length;
    const r = await this.pool.query<RowDb>(
      `SELECT environment, connection_id, business_date::text AS business_date,
              shopify_order_count, ns_txn_count,
              shopify_total::text AS shopify_total, ns_total::text AS ns_total,
              discrepancy, created_at
         FROM reconciliation_snapshots
        WHERE ${clauses.join(' AND ')}
        ORDER BY business_date DESC
        LIMIT $${limitIdx}`,
      params,
    );
    return r.rows.map(toRow);
  }
}

interface RowDb {
  environment: Environment;
  connection_id: string;
  business_date: string;
  shopify_order_count: number;
  ns_txn_count: number;
  shopify_total: string;
  ns_total: string;
  discrepancy: Readonly<Record<string, unknown>> | null;
  created_at: Date;
}

function toRow(row: RowDb): ReconciliationSnapshot {
  return {
    environment: row.environment,
    connectionId: row.connection_id,
    businessDate: row.business_date,
    shopifyOrderCount: Number(row.shopify_order_count),
    nsTxnCount: Number(row.ns_txn_count),
    shopifyTotal: row.shopify_total,
    nsTotal: row.ns_total,
    discrepancy: row.discrepancy,
    createdAt: row.created_at,
  };
}
