import type { RecordType } from 'netsuite-sdk';
import type { NetSuiteGateway, UpsertResult } from './gateway.js';

/**
 * In-memory NetSuiteGateway for tests. Models the externalId-keyed upsert
 * semantics exactly: two upserts with the same `(nsAccountId, recordType,
 * externalId)` triple produce ONE record and the second is an update — NEVER
 * a duplicate.
 *
 * Also lets tests:
 *   - inspect the in-memory records via `getRecords(nsAccountId, recordType)`
 *   - count attempts (incl. retried calls) via `attemptCount()` to verify the
 *     governor middleware is hooked correctly
 *   - inject failures via `failNext(error)` to drive error-mapping tests
 */
export class FakeNetSuiteGateway implements NetSuiteGateway {
  /** account → recordType → externalId → record */
  private readonly store = new Map<
    string,
    Map<string, Map<string, { internalId: string; payload: Record<string, unknown> }>>
  >();
  private internalIdSeq = 0;
  private attempts = 0;
  private failureQueue: Error[] = [];
  /** Optional latency injected per upsert call, ms. Used by the end-to-end concurrency test. */
  public latencyMs = 0;

  private bucket(
    nsAccountId: string,
    recordType: RecordType,
  ): Map<string, { internalId: string; payload: Record<string, unknown> }> {
    let acct = this.store.get(nsAccountId);
    if (!acct) {
      acct = new Map();
      this.store.set(nsAccountId, acct);
    }
    let rt = acct.get(recordType);
    if (!rt) {
      rt = new Map();
      acct.set(recordType, rt);
    }
    return rt;
  }

  /** Queue a one-shot error — the next call to `upsertByExternalId` will throw it. */
  failNext(error: Error): void {
    this.failureQueue.push(error);
  }

  /** Total `upsertByExternalId` invocations (incl. ones that threw). */
  attemptCount(): number {
    return this.attempts;
  }

  async upsertByExternalId(args: {
    nsAccountId: string;
    recordType: RecordType;
    externalId: string;
    payload: Record<string, unknown>;
  }): Promise<UpsertResult> {
    this.attempts += 1;
    const queued = this.failureQueue.shift();
    if (queued) throw queued;

    if (this.latencyMs > 0) {
      await new Promise((r) => setTimeout(r, this.latencyMs));
    }

    const bucket = this.bucket(args.nsAccountId, args.recordType);
    const existing = bucket.get(args.externalId);
    if (existing) {
      // Update in place — same internalId, no new row.
      existing.payload = args.payload;
      return { internalId: existing.internalId, externalId: args.externalId, created: false };
    }
    const internalId = `ns_${args.nsAccountId}_${++this.internalIdSeq}`;
    bucket.set(args.externalId, { internalId, payload: args.payload });
    return { internalId, externalId: args.externalId, created: true };
  }

  async findByExternalId(args: {
    nsAccountId: string;
    recordType: RecordType;
    externalId: string;
  }): Promise<Record<string, unknown> | null> {
    const rec = this.bucket(args.nsAccountId, args.recordType).get(args.externalId);
    if (!rec) return null;
    return { id: rec.internalId, externalid: args.externalId, ...rec.payload };
  }

  /** Inspect for assertions. */
  getRecords(
    nsAccountId: string,
    recordType: RecordType,
  ): Map<string, { internalId: string; payload: Record<string, unknown> }> {
    return this.bucket(nsAccountId, recordType);
  }
}
