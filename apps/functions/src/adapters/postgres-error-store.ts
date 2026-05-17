import type pg from 'pg';
import type {
  Environment,
  ErrorClass,
  ErrorRecord,
  ErrorStatus,
  ErrorStore,
  NewErrorInput,
} from '@dpi/core';

/**
 * Postgres-backed `ErrorStore`. The brief's M2 "error console + replay
 * surface" — orders that exhausted SB redeliveries (or otherwise failed
 * permanently) land here with the original envelope so an operator can
 * inspect, retry, or quarantine them.
 *
 * IDs from `BIGSERIAL` come back as `string` (pg's bigint → string default)
 * — we re-emit them as `string` IDs in the row so all consumers can compare
 * with === regardless of size.
 */
export class PostgresErrorStore implements ErrorStore {
  constructor(private readonly pool: pg.Pool) {}

  async record(input: NewErrorInput): Promise<ErrorRecord> {
    const sql = `
      INSERT INTO error_records (
        environment, connection_id, flow, dedup_key, error_class,
        message, stack, envelope, retry_count, status
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, 0, 'open')
      RETURNING *
    `;
    const r = await this.pool.query<ErrorRowDb>(sql, [
      input.environment,
      input.connectionId,
      input.flow,
      input.dedupKey,
      input.errorClass,
      input.message,
      input.stack ?? null,
      JSON.stringify(input.envelope ?? null),
    ]);
    const row = r.rows[0];
    if (!row) {
      throw new Error('PostgresErrorStore.record: insert returned no row');
    }
    return toErrorRecord(row);
  }

  async get(id: string): Promise<ErrorRecord | undefined> {
    const r = await this.pool.query<ErrorRowDb>(
      `SELECT * FROM error_records WHERE id = $1`,
      [Number(id)],
    );
    return r.rows[0] ? toErrorRecord(r.rows[0]) : undefined;
  }

  async list(filter?: {
    environment?: Environment;
    connectionId?: string;
    status?: ErrorStatus;
    errorClass?: ErrorClass;
  }): Promise<ErrorRecord[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];
    const push = (sql: string, val: unknown): void => {
      params.push(val);
      clauses.push(sql.replace('$$', `$${params.length}`));
    };
    if (filter?.environment) push(`environment = $$`, filter.environment);
    if (filter?.connectionId) push(`connection_id = $$`, filter.connectionId);
    if (filter?.status) push(`status = $$`, filter.status);
    if (filter?.errorClass) push(`error_class = $$`, filter.errorClass);
    const where = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const r = await this.pool.query<ErrorRowDb>(
      `SELECT * FROM error_records ${where} ORDER BY created_at DESC LIMIT 200`,
      params,
    );
    return r.rows.map(toErrorRecord);
  }

  async updateStatus(id: string, status: ErrorStatus, message?: string): Promise<ErrorRecord> {
    const sql = message !== undefined
      ? `UPDATE error_records SET status = $2, message = $3, updated_at = NOW() WHERE id = $1 RETURNING *`
      : `UPDATE error_records SET status = $2, updated_at = NOW() WHERE id = $1 RETURNING *`;
    const params = message !== undefined ? [Number(id), status, message] : [Number(id), status];
    const r = await this.pool.query<ErrorRowDb>(sql, params);
    const row = r.rows[0];
    if (!row) {
      throw new Error(`PostgresErrorStore.updateStatus: no row with id ${id}`);
    }
    return toErrorRecord(row);
  }

  async incrementRetry(id: string): Promise<ErrorRecord> {
    const r = await this.pool.query<ErrorRowDb>(
      `UPDATE error_records
          SET retry_count = retry_count + 1, updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [Number(id)],
    );
    const row = r.rows[0];
    if (!row) {
      throw new Error(`PostgresErrorStore.incrementRetry: no row with id ${id}`);
    }
    return toErrorRecord(row);
  }
}

interface ErrorRowDb {
  id: string | number;
  environment: Environment;
  connection_id: string;
  flow: string;
  dedup_key: string;
  error_class: ErrorClass;
  message: string;
  stack: string | null;
  envelope: unknown;
  retry_count: number;
  status: ErrorStatus;
  created_at: Date;
  updated_at: Date;
}

function toErrorRecord(row: ErrorRowDb): ErrorRecord {
  return {
    id: String(row.id),
    environment: row.environment,
    connectionId: row.connection_id,
    flow: row.flow,
    dedupKey: row.dedup_key,
    errorClass: row.error_class,
    message: row.message,
    ...(row.stack !== null ? { stack: row.stack } : {}),
    envelope: row.envelope,
    retryCount: row.retry_count,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
