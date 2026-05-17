import type pg from 'pg';
import {
  dedupKey,
  type ClaimInput,
  type ClaimResult,
  type DedupKeyParts,
  type Environment,
  type XrefRow,
  type XrefStatus,
  type XrefStore,
} from '@dpi/core';

/**
 * Postgres-backed `XrefStore`. The brief's idempotency invariant says claim
 * must be atomic and survive cross-instance scale-out — the SQL primary key
 * on `(environment, connection_id, entity_type, source_system, source_id)`
 * does that for us. `INSERT … ON CONFLICT DO NOTHING RETURNING` returns the
 * inserted row only when the conflict didn't fire; otherwise a follow-up
 * SELECT tells us what state the existing row is in.
 *
 * Every row read or written here is scoped by `environment` — sandbox runs
 * cannot resolve a prod NS internal id (brief invariant 4).
 */
export class PostgresXrefStore implements XrefStore {
  constructor(private readonly pool: pg.Pool) {}

  async claim(input: ClaimInput): Promise<ClaimResult> {
    // Race window: two parallel handlers for the same dedup key both call
    // claim(). The INSERT … ON CONFLICT path on the PK serializes them in the
    // database — exactly one returns the inserted row, the other returns
    // nothing and we read the existing row below.
    const insertSql = `
      INSERT INTO entity_xref (
        environment, connection_id, entity_type, source_system, source_id,
        target_system, target_id, target_external, source_hash, status
      )
      VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, $8, 'pending')
      ON CONFLICT (environment, connection_id, entity_type, source_system, source_id)
      DO NOTHING
      RETURNING *
    `;
    const inserted = await this.pool.query<XrefRowDb>(insertSql, [
      input.environment,
      input.connectionId,
      input.entityType,
      input.sourceSystem,
      input.sourceId,
      input.targetSystem,
      input.targetExternal,
      input.sourceHash ?? null,
    ]);

    if (inserted.rows.length === 1 && inserted.rows[0] !== undefined) {
      return { outcome: 'claimed', row: toXrefRow(inserted.rows[0]) };
    }

    const existing = await this.fetch(input);
    if (!existing) {
      // Vanishingly unlikely: row existed when INSERT failed but is gone now
      // (manual DELETE between the two queries). Treat as race; let the caller
      // back off and retry on the next message redelivery.
      throw new Error(
        `PostgresXrefStore.claim: row missing after ON CONFLICT for key ${dedupKey(input)}`,
      );
    }
    switch (existing.status) {
      case 'synced':
        return { outcome: 'already_synced', row: existing };
      case 'ignored':
        return { outcome: 'ignored', row: existing };
      case 'pending':
      case 'error':
        return { outcome: 'already_claimed', row: existing };
    }
  }

  async recordSuccess(
    parts: DedupKeyParts,
    targetId: string,
    externalId: string,
  ): Promise<XrefRow> {
    const sql = `
      UPDATE entity_xref
         SET target_id = $6,
             target_external = $7,
             status = 'synced',
             last_synced_at = NOW(),
             updated_at = NOW()
       WHERE environment = $1
         AND connection_id = $2
         AND entity_type = $3
         AND source_system = $4
         AND source_id = $5
       RETURNING *
    `;
    const r = await this.pool.query<XrefRowDb>(sql, [
      parts.environment,
      parts.connectionId,
      parts.entityType,
      parts.sourceSystem,
      parts.sourceId,
      targetId,
      externalId,
    ]);
    const row = r.rows[0];
    if (!row) {
      throw new Error(
        `PostgresXrefStore.recordSuccess: no xref row for key ${dedupKey(parts)}`,
      );
    }
    return toXrefRow(row);
  }

  async recordFailure(parts: DedupKeyParts, sourceHash?: string): Promise<XrefRow> {
    const sql = `
      UPDATE entity_xref
         SET status = 'error',
             source_hash = COALESCE($6, source_hash),
             updated_at = NOW()
       WHERE environment = $1
         AND connection_id = $2
         AND entity_type = $3
         AND source_system = $4
         AND source_id = $5
       RETURNING *
    `;
    const r = await this.pool.query<XrefRowDb>(sql, [
      parts.environment,
      parts.connectionId,
      parts.entityType,
      parts.sourceSystem,
      parts.sourceId,
      sourceHash ?? null,
    ]);
    const row = r.rows[0];
    if (!row) {
      throw new Error(
        `PostgresXrefStore.recordFailure: no xref row for key ${dedupKey(parts)}`,
      );
    }
    return toXrefRow(row);
  }

  async markIgnored(parts: DedupKeyParts): Promise<XrefRow> {
    // Upsert — ignored is the only status reachable from "no row exists yet"
    // (eligibility predicate said no on the very first delivery).
    const sql = `
      INSERT INTO entity_xref (
        environment, connection_id, entity_type, source_system, source_id,
        target_system, target_id, target_external, source_hash, status
      )
      VALUES ($1, $2, $3, $4, $5, 'netsuite', NULL, '', NULL, 'ignored')
      ON CONFLICT (environment, connection_id, entity_type, source_system, source_id)
      DO UPDATE SET status = 'ignored', updated_at = NOW()
      RETURNING *
    `;
    const r = await this.pool.query<XrefRowDb>(sql, [
      parts.environment,
      parts.connectionId,
      parts.entityType,
      parts.sourceSystem,
      parts.sourceId,
    ]);
    const row = r.rows[0];
    if (!row) {
      throw new Error(
        `PostgresXrefStore.markIgnored: upsert returned no row for key ${dedupKey(parts)}`,
      );
    }
    return toXrefRow(row);
  }

  async lookup(parts: DedupKeyParts): Promise<XrefRow | undefined> {
    return this.fetch(parts);
  }

  private async fetch(parts: DedupKeyParts): Promise<XrefRow | undefined> {
    const sql = `
      SELECT * FROM entity_xref
       WHERE environment = $1
         AND connection_id = $2
         AND entity_type = $3
         AND source_system = $4
         AND source_id = $5
       LIMIT 1
    `;
    const r = await this.pool.query<XrefRowDb>(sql, [
      parts.environment,
      parts.connectionId,
      parts.entityType,
      parts.sourceSystem,
      parts.sourceId,
    ]);
    return r.rows[0] ? toXrefRow(r.rows[0]) : undefined;
  }
}

interface XrefRowDb {
  environment: Environment;
  connection_id: string;
  entity_type: XrefRow['entityType'];
  source_system: XrefRow['sourceSystem'];
  source_id: string;
  target_system: XrefRow['targetSystem'];
  target_id: string | null;
  target_external: string;
  source_hash: string | null;
  status: XrefStatus;
  last_synced_at: Date | null;
}

function toXrefRow(row: XrefRowDb): XrefRow {
  return {
    environment: row.environment,
    connectionId: row.connection_id,
    entityType: row.entity_type,
    sourceSystem: row.source_system,
    sourceId: row.source_id,
    targetSystem: row.target_system,
    targetId: row.target_id,
    targetExternal: row.target_external,
    sourceHash: row.source_hash,
    status: row.status,
    lastSyncedAt: row.last_synced_at,
  };
}
