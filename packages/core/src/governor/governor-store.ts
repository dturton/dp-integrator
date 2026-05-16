/**
 * Per-NS-account concurrency budget.
 *
 * Invariant 5 from the brief: a burst of Shopify orders must never starve
 * other integrations sharing the same NetSuite account. The governor is
 * **per NS account** and must be **shared across all Azure Function instances**
 * targeting that account — otherwise N horizontally-scaled instances each get
 * a full budget and collectively blow the account ceiling.
 *
 * This module defines the cross-instance contract. Two M0 implementations:
 *
 *   - `SharedInMemoryGovernorStore` — single shared instance, used by all
 *     clients in tests. Models the cross-instance SQL store correctly.
 *   - `PerProcessGovernorStore` — each client gets its own instance (the trap
 *     the brief warns about; ships only so the burst test can prove it fails).
 *
 * The SQL implementation backed by `ns_governor_slots` lands later.
 */
export interface GovernorBackingStore {
  /**
   * Try to acquire a slot for `nsAccountId`. Non-blocking — returns false if the
   * account is at its ceiling. Caller (the middleware) is responsible for
   * waiting + retrying.
   *
   * `holderId` is opaque; the caller passes it back to `release()`. Real impls
   * persist it so a crash recovery sweep can free stuck slots.
   */
  tryAcquire(nsAccountId: string, holderId: string): Promise<boolean>;

  release(nsAccountId: string, holderId: string): Promise<void>;

  /** Current in-flight count for an account. Read-only telemetry. */
  inFlight(nsAccountId: string): Promise<number>;
}

export interface GovernorConfig {
  /** Hard ceiling per NS account. Sized BELOW the SuiteTalk concurrency governor. */
  readonly perAccountCeiling: number;
  /** Polling cadence when waiting for a slot. Default 25ms. */
  readonly pollIntervalMs?: number;
  /** Max time the middleware will wait for a slot before throwing. Default 60s. */
  readonly acquireTimeoutMs?: number;
}

/**
 * Reference impl shared across clients. Backed by a single `Map<accountId, Set<holderId>>`.
 *
 * Models the production SQL/Redis impl behaviorally: two NetSuiteClient
 * instances pointing at the same backing store enforce one shared budget.
 */
export class SharedInMemoryGovernorStore implements GovernorBackingStore {
  private readonly slots = new Map<string, Set<string>>();

  constructor(private readonly ceiling: number) {
    if (ceiling < 1) throw new Error(`Governor ceiling must be ≥ 1, got ${ceiling}`);
  }

  private bucket(nsAccountId: string): Set<string> {
    let b = this.slots.get(nsAccountId);
    if (!b) {
      b = new Set();
      this.slots.set(nsAccountId, b);
    }
    return b;
  }

  async tryAcquire(nsAccountId: string, holderId: string): Promise<boolean> {
    const b = this.bucket(nsAccountId);
    if (b.size >= this.ceiling) return false;
    b.add(holderId);
    return true;
  }

  async release(nsAccountId: string, holderId: string): Promise<void> {
    this.bucket(nsAccountId).delete(holderId);
  }

  async inFlight(nsAccountId: string): Promise<number> {
    return this.bucket(nsAccountId).size;
  }
}

/**
 * Per-process governor (THE TRAP). Each instance has its own bucket — so N
 * instances each get the full ceiling and collectively burst N× over.
 *
 * Ships only so the burst test can demonstrate the failure mode. **Never use
 * in production.** Real deployments wire `SharedInMemoryGovernorStore` (single
 * instance) or the SQL impl. The brief is explicit: "an in-process limiter
 * must visibly fail this test."
 */
export class PerProcessGovernorStore implements GovernorBackingStore {
  private readonly slots = new Set<string>();

  constructor(private readonly ceiling: number) {
    if (ceiling < 1) throw new Error(`Governor ceiling must be ≥ 1, got ${ceiling}`);
  }

  async tryAcquire(_nsAccountId: string, holderId: string): Promise<boolean> {
    if (this.slots.size >= this.ceiling) return false;
    this.slots.add(holderId);
    return true;
  }

  async release(_nsAccountId: string, holderId: string): Promise<void> {
    this.slots.delete(holderId);
  }

  async inFlight(_nsAccountId: string): Promise<number> {
    return this.slots.size;
  }
}
