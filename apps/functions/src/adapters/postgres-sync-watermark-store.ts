import type pg from 'pg';
import type { Environment, SyncWatermarkRow, SyncWatermarkStore } from '@dpi/core';

/**
 * Postgres-backed `SyncWatermarkStore`. Upsert on `(environment,
 * connection_id, flow)` PK lets the poller call set() unconditionally on
 * every iteration — no need for explicit first-run insert logic.
 */
export class PostgresSyncWatermarkStore implements SyncWatermarkStore {
  constructor(private readonly pool: pg.Pool) {}

  async get(parts: {
    environment: Environment;
    connectionId: string;
    flow: string;
  }): Promise<SyncWatermarkRow | undefined> {
    const r = await this.pool.query<SyncWatermarkDb>(
      `SELECT environment, connection_id, flow, last_cursor, updated_at
         FROM sync_watermarks
        WHERE environment=$1 AND connection_id=$2 AND flow=$3
        LIMIT 1`,
      [parts.environment, parts.connectionId, parts.flow],
    );
    return r.rows[0] ? toRow(r.rows[0]) : undefined;
  }

  async set(input: {
    environment: Environment;
    connectionId: string;
    flow: string;
    cursor: string;
  }): Promise<SyncWatermarkRow> {
    const r = await this.pool.query<SyncWatermarkDb>(
      `INSERT INTO sync_watermarks (environment, connection_id, flow, last_cursor)
            VALUES ($1, $2, $3, $4)
       ON CONFLICT (environment, connection_id, flow)
       DO UPDATE SET last_cursor = EXCLUDED.last_cursor, updated_at = NOW()
       RETURNING environment, connection_id, flow, last_cursor, updated_at`,
      [input.environment, input.connectionId, input.flow, input.cursor],
    );
    const row = r.rows[0];
    if (!row) throw new Error('PostgresSyncWatermarkStore.set: upsert returned no row');
    return toRow(row);
  }
}

interface SyncWatermarkDb {
  environment: Environment;
  connection_id: string;
  flow: string;
  last_cursor: string | null;
  updated_at: Date;
}

function toRow(r: SyncWatermarkDb): SyncWatermarkRow {
  return {
    environment: r.environment,
    connectionId: r.connection_id,
    flow: r.flow,
    lastCursor: r.last_cursor,
    updatedAt: r.updated_at,
  };
}
