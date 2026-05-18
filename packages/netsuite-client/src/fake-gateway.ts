import type { RecordType } from 'netsuite-sdk';
import type { CustomerAddressbookEntry, NetSuiteGateway, UpsertResult } from './gateway.js';

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
  /** account → sku → ns internal id. Seeded via `seedItem`; unseeded SKUs resolve to null. */
  private readonly itemBySku = new Map<string, Map<string, string>>();
  private resolveAttempts = 0;
  /**
   * account → customer internal id → addressbook rows. Tests seed prior NS
   * addressbook state via `seedCustomerAddressbook`. Unseeded customers
   * (newly-upserted via `upsertByExternalId`) return [] from
   * `getCustomerAddressbook` — matches the "fresh NS record has no
   * addressbook entries yet" reality.
   */
  private readonly customerAddressbooks = new Map<string, Map<string, CustomerAddressbookEntry[]>>();

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
      return {
        internalId: existing.internalId,
        externalId: args.externalId,
        created: false,
        rawResponse: { status: 204, headers: { location: `/services/rest/record/v1/${args.recordType}/${existing.internalId}` } },
      };
    }
    const internalId = `ns_${args.nsAccountId}_${++this.internalIdSeq}`;
    bucket.set(args.externalId, { internalId, payload: args.payload });
    return {
      internalId,
      externalId: args.externalId,
      created: true,
      rawResponse: { status: 204, headers: { location: `/services/rest/record/v1/${args.recordType}/${internalId}` } },
    };
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

  /** Seed an `itemid → ns internal id` mapping for `resolveItemId`. */
  seedItem(nsAccountId: string, sku: string, internalId: string): void {
    let acct = this.itemBySku.get(nsAccountId);
    if (!acct) {
      acct = new Map();
      this.itemBySku.set(nsAccountId, acct);
    }
    acct.set(sku, internalId);
  }

  /** Total `resolveItemId` invocations — used to verify the cache short-circuits repeats. */
  resolveItemAttemptCount(): number {
    return this.resolveAttempts;
  }

  async resolveItemId(args: { nsAccountId: string; sku: string }): Promise<string | null> {
    this.resolveAttempts += 1;
    return this.itemBySku.get(args.nsAccountId)?.get(args.sku) ?? null;
  }

  /**
   * Seed addressbook rows for an existing customer. Tests use this to verify
   * the resolver's merge-by-shopify-id behavior — call after a first
   * `resolveCustomer(...)` to pre-populate what "NS already has" before the
   * second call.
   */
  seedCustomerAddressbook(
    nsAccountId: string,
    customerInternalId: string,
    entries: ReadonlyArray<CustomerAddressbookEntry>,
  ): void {
    let acct = this.customerAddressbooks.get(nsAccountId);
    if (!acct) {
      acct = new Map();
      this.customerAddressbooks.set(nsAccountId, acct);
    }
    acct.set(customerInternalId, [...entries]);
  }

  async getCustomerAddressbook(args: {
    nsAccountId: string;
    customerInternalId: string;
    shopifyIdField: string;
  }): Promise<ReadonlyArray<CustomerAddressbookEntry>> {
    // `shopifyIdField` is unused here — the fake stores already-projected
    // entries via `seedCustomerAddressbook`. The real SDK gateway uses it to
    // pick the column off the SuiteQL/REST result.
    void args.shopifyIdField;
    return this.customerAddressbooks.get(args.nsAccountId)?.get(args.customerInternalId) ?? [];
  }
}
