import type { Environment } from '../env.js';

/**
 * One row per (environment, connection, business_date) capturing the daily
 * audit sweep output (brief §9, M3-B): Shopify-side count + total vs the
 * dpi side (order_sync_log where status='imported' for the same window),
 * plus a structured `discrepancy` payload when they don't agree.
 *
 * The brief frames this as Shopify vs NS. We use the local order_sync_log
 * as the dpi-side aggregate rather than a live NS aggregate query — the
 * ledger captures every successful NS write, so "ledger says imported"
 * implies "NS holds the record." Hitting NS again on every sweep would be
 * wasteful (and NS-side SuiteQL aggregates are quirky to align with
 * Shopify's processed_at semantics). A follow-up slice can add a NS-side
 * verification pass when the operational need is concrete.
 */
export interface ReconciliationSnapshot {
  readonly environment: Environment;
  readonly connectionId: string;
  /** ISO date string (YYYY-MM-DD) for the business day this snapshot covers. */
  readonly businessDate: string;
  readonly shopifyOrderCount: number;
  readonly nsTxnCount: number;
  /** Shopify total in the connection's base currency, formatted as a fixed-2 decimal string. */
  readonly shopifyTotal: string;
  readonly nsTotal: string;
  /**
   * Structured drift payload. `null` when counts AND totals agree within
   * tolerance; an object otherwise:
   *   {
   *     countDiff: number,       // shopifyCount - nsCount
   *     totalDiff: string,       // shopify - ns as fixed-2 decimal
   *     toleranceAmount: number, // the configured tolerance
   *     reason: 'count_diff' | 'total_diff' | 'count_and_total_diff'
   *   }
   */
  readonly discrepancy: Readonly<Record<string, unknown>> | null;
  readonly createdAt: Date;
}

export interface ReconciliationSnapshotInput {
  readonly environment: Environment;
  readonly connectionId: string;
  readonly businessDate: string;
  readonly shopifyOrderCount: number;
  readonly nsTxnCount: number;
  readonly shopifyTotal: string;
  readonly nsTotal: string;
  readonly discrepancy: Readonly<Record<string, unknown>> | null;
}

export interface ReconciliationListFilter {
  readonly environment: Environment;
  readonly connectionId?: string;
  readonly fromBusinessDate?: string;
  readonly toBusinessDate?: string;
  readonly limit?: number;
}

export interface ReconciliationStore {
  /**
   * Upsert the snapshot for (env, connection, business_date). Re-running
   * the sweep for the same day overwrites — useful when an operator triggers
   * a manual reconciliation after fixing drift.
   */
  upsert(input: ReconciliationSnapshotInput): Promise<ReconciliationSnapshot>;
  list(filter: ReconciliationListFilter): Promise<ReconciliationSnapshot[]>;
}

/** In-memory impl for tests. */
export class InMemoryReconciliationStore implements ReconciliationStore {
  private readonly rows = new Map<string, ReconciliationSnapshot>();

  async upsert(input: ReconciliationSnapshotInput): Promise<ReconciliationSnapshot> {
    const k = key(input);
    const existing = this.rows.get(k);
    const row: ReconciliationSnapshot = {
      environment: input.environment,
      connectionId: input.connectionId,
      businessDate: input.businessDate,
      shopifyOrderCount: input.shopifyOrderCount,
      nsTxnCount: input.nsTxnCount,
      shopifyTotal: input.shopifyTotal,
      nsTotal: input.nsTotal,
      discrepancy: input.discrepancy,
      createdAt: existing?.createdAt ?? new Date(),
    };
    this.rows.set(k, row);
    return row;
  }

  async list(filter: ReconciliationListFilter): Promise<ReconciliationSnapshot[]> {
    const all = Array.from(this.rows.values()).filter((r) => {
      if (r.environment !== filter.environment) return false;
      if (filter.connectionId && r.connectionId !== filter.connectionId) return false;
      if (filter.fromBusinessDate && r.businessDate < filter.fromBusinessDate) return false;
      if (filter.toBusinessDate && r.businessDate > filter.toBusinessDate) return false;
      return true;
    });
    all.sort((a, b) => b.businessDate.localeCompare(a.businessDate));
    return filter.limit ? all.slice(0, filter.limit) : all;
  }

  /** Test helper. */
  size(): number {
    return this.rows.size;
  }
}

function key(p: { environment: Environment; connectionId: string; businessDate: string }): string {
  return `${p.environment}|${p.connectionId}|${p.businessDate}`;
}
