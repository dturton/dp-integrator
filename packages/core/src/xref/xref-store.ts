import type { Environment } from '../env.js';
import type { EntityType, SourceSystem, TargetSystem } from '../types.js';
import { dedupKey, type DedupKeyParts } from '../id/dedup-key.js';

export type XrefStatus = 'pending' | 'deferred' | 'synced' | 'error' | 'ignored';

export interface XrefClaimConfig {
  readonly claimLeaseMs: number;
}

export const DEFAULT_XREF_CLAIM_CONFIG: XrefClaimConfig = {
  claimLeaseMs: 15 * 60 * 1000,
};

export interface XrefRow {
  readonly environment: Environment;
  readonly connectionId: string;
  readonly entityType: EntityType;
  readonly sourceSystem: SourceSystem;
  readonly sourceId: string;
  readonly targetSystem: TargetSystem;
  /** NetSuite internal id once known (nullable until first successful write). */
  readonly targetId: string | null;
  /** Durable join — NS `externalId` = Shopify GID for orders. */
  readonly targetExternal: string;
  /** Hash of mapped meaningful fields — used to no-op on identical re-syncs (M2+). */
  readonly sourceHash: string | null;
  readonly status: XrefStatus;
  /**
   * When `status='pending'`, the timestamp at which the current worker last
   * claimed the row. Used as a lease so a crashed worker doesn't orphan the
   * row forever.
   */
  readonly claimedAt: Date | null;
  readonly lastSyncedAt: Date | null;
}

export interface ClaimInput extends DedupKeyParts {
  readonly targetSystem: TargetSystem;
  /** NS externalId we'll write. For orders, this is the Shopify order GID. */
  readonly targetExternal: string;
  readonly sourceHash?: string;
}

/**
 * Result of `claim()`.
 *
 *  - `claimed`: brand-new pending row; caller proceeds to write to the target.
 *  - `already_claimed`: row exists with status `pending` and its lease is still
 *    owned by another worker, OR the row is terminally parked (`error`).
 *    Caller should not write.
 *  - `claimed` can also mean "reclaimed" — a stale `pending` lease expired, or
 *    a `deferred` row became eligible to retry.
 *  - `already_synced`: row is `synced`. Treat as no-op (this is the redelivery
 *    case the brief's idempotency invariant is built to prevent).
 *  - `ignored`: row marked ignored (sync-eligibility predicate said no). Do nothing.
 */
export type ClaimResult =
  | { readonly outcome: 'claimed'; readonly row: XrefRow }
  | { readonly outcome: 'already_claimed'; readonly row: XrefRow }
  | { readonly outcome: 'already_synced'; readonly row: XrefRow }
  | { readonly outcome: 'ignored'; readonly row: XrefRow };

export interface XrefStore {
  /**
   * Atomically reserve a row for the given dedup key. The brief's invariant:
   * "Claim the `entity_xref` row before any NS write." Concurrent claims must
   * yield exactly one `claimed` and the rest `already_claimed`.
   */
  claim(input: ClaimInput): Promise<ClaimResult>;
  recordSuccess(parts: DedupKeyParts, targetId: string, externalId: string): Promise<XrefRow>;
  recordFailure(parts: DedupKeyParts, sourceHash?: string): Promise<XrefRow>;
  markDeferred(parts: DedupKeyParts, sourceHash?: string): Promise<XrefRow>;
  markIgnored(parts: DedupKeyParts): Promise<XrefRow>;
  lookup(parts: DedupKeyParts): Promise<XrefRow | undefined>;
  /**
   * Drop the xref row for `parts`. Used by the M2 replay path to "un-claim"
   * a parked or pending row so a re-published webhook will run through the
   * pipeline again. Returns the row as it existed before deletion, or
   * undefined if no row was present.
   *
   * Replay refuses to call delete on `status='synced'` without an explicit
   * force — that policy lives in the requestReplay() shared lib, not here,
   * so this method itself is a low-level primitive.
   */
  delete(parts: DedupKeyParts): Promise<XrefRow | undefined>;
}

/**
 * In-memory store for unit tests. Uses an internal lock to serialize claim
 * resolution so concurrent claims behave the same as the SQL impl will under
 * unique-index contention.
 */
export class InMemoryXrefStore implements XrefStore {
  private readonly rows = new Map<string, XrefRow>();
  /** Per-key promise chain to serialize claim()/record() against a single key. */
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly claimLeaseMs: number;
  private readonly now: () => Date;

  constructor(config: Partial<XrefClaimConfig> & { now?: () => Date } = {}) {
    this.claimLeaseMs = config.claimLeaseMs ?? DEFAULT_XREF_CLAIM_CONFIG.claimLeaseMs;
    this.now = config.now ?? (() => new Date());
  }

  private withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    // Keep the chain alive even on errors; clear it once settled and nothing else queued.
    this.locks.set(
      key,
      next.then(
        () => undefined,
        () => undefined,
      ),
    );
    return next;
  }

  async claim(input: ClaimInput): Promise<ClaimResult> {
    const key = dedupKey(input);
    return this.withLock(key, async () => {
      const existing = this.rows.get(key);
      if (existing) {
        switch (existing.status) {
          case 'synced':
            return { outcome: 'already_synced', row: existing };
          case 'ignored':
            return { outcome: 'ignored', row: existing };
          case 'deferred': {
            const reclaimed: XrefRow = {
              ...existing,
              status: 'pending',
              claimedAt: this.now(),
            };
            this.rows.set(key, reclaimed);
            return { outcome: 'claimed', row: reclaimed };
          }
          case 'pending':
            if (this.isLeaseExpired(existing.claimedAt)) {
              const reclaimed: XrefRow = {
                ...existing,
                status: 'pending',
                claimedAt: this.now(),
              };
              this.rows.set(key, reclaimed);
              return { outcome: 'claimed', row: reclaimed };
            }
            return { outcome: 'already_claimed', row: existing };
          case 'error':
            return { outcome: 'already_claimed', row: existing };
        }
      }
      const row: XrefRow = {
        environment: input.environment,
        connectionId: input.connectionId,
        entityType: input.entityType,
        sourceSystem: input.sourceSystem,
        sourceId: input.sourceId,
        targetSystem: input.targetSystem,
        targetId: null,
        targetExternal: input.targetExternal,
        sourceHash: input.sourceHash ?? null,
        status: 'pending',
        claimedAt: this.now(),
        lastSyncedAt: null,
      };
      this.rows.set(key, row);
      return { outcome: 'claimed', row };
    });
  }

  async recordSuccess(parts: DedupKeyParts, targetId: string, externalId: string): Promise<XrefRow> {
    const key = dedupKey(parts);
    return this.withLock(key, async () => {
      const existing = this.rows.get(key);
      if (!existing) throw new Error(`InMemoryXrefStore: cannot record success for unclaimed key ${key}`);
      const updated: XrefRow = {
        ...existing,
        targetId,
        targetExternal: externalId,
        status: 'synced',
        claimedAt: null,
        lastSyncedAt: new Date(),
      };
      this.rows.set(key, updated);
      return updated;
    });
  }

  async recordFailure(parts: DedupKeyParts, sourceHash?: string): Promise<XrefRow> {
    const key = dedupKey(parts);
    return this.withLock(key, async () => {
      const existing = this.rows.get(key);
      if (!existing) throw new Error(`InMemoryXrefStore: cannot record failure for unclaimed key ${key}`);
      const updated: XrefRow = {
        ...existing,
        status: 'error',
        claimedAt: null,
        ...(sourceHash !== undefined ? { sourceHash } : {}),
      };
      this.rows.set(key, updated);
      return updated;
    });
  }

  async markDeferred(parts: DedupKeyParts, sourceHash?: string): Promise<XrefRow> {
    const key = dedupKey(parts);
    return this.withLock(key, async () => {
      const existing = this.rows.get(key);
      const row: XrefRow = existing
        ? {
            ...existing,
            status: 'deferred',
            claimedAt: null,
            ...(sourceHash !== undefined ? { sourceHash } : {}),
          }
        : {
            environment: parts.environment,
            connectionId: parts.connectionId,
            entityType: parts.entityType,
            sourceSystem: parts.sourceSystem,
            sourceId: parts.sourceId,
            targetSystem: 'netsuite',
            targetId: null,
            targetExternal: '',
            sourceHash: sourceHash ?? null,
            status: 'deferred',
            claimedAt: null,
            lastSyncedAt: null,
          };
      this.rows.set(key, row);
      return row;
    });
  }

  async markIgnored(parts: DedupKeyParts): Promise<XrefRow> {
    const key = dedupKey(parts);
    return this.withLock(key, async () => {
      const existing = this.rows.get(key);
      const row: XrefRow = existing
        ? { ...existing, status: 'ignored', claimedAt: null }
        : {
            environment: parts.environment,
            connectionId: parts.connectionId,
            entityType: parts.entityType,
            sourceSystem: parts.sourceSystem,
            sourceId: parts.sourceId,
            targetSystem: 'netsuite',
            targetId: null,
            targetExternal: '',
            sourceHash: null,
            status: 'ignored',
            claimedAt: null,
            lastSyncedAt: null,
          };
      this.rows.set(key, row);
      return row;
    });
  }

  async lookup(parts: DedupKeyParts): Promise<XrefRow | undefined> {
    return this.rows.get(dedupKey(parts));
  }

  async delete(parts: DedupKeyParts): Promise<XrefRow | undefined> {
    const key = dedupKey(parts);
    return this.withLock(key, async () => {
      const existing = this.rows.get(key);
      this.rows.delete(key);
      return existing;
    });
  }

  /** Test helper. */
  size(): number {
    return this.rows.size;
  }

  private isLeaseExpired(claimedAt: Date | null): boolean {
    if (!claimedAt) return true;
    return this.now().getTime() - claimedAt.getTime() >= this.claimLeaseMs;
  }
}
