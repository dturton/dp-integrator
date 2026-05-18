import type { Environment } from '../env.js';

/**
 * One row per (environment, connection, shopifyOrderGid) capturing what the
 * handler did with the order. Distinct from `entity_xref` — that table is
 * narrow (dedup only); this one is the operator-facing ledger.
 *
 * Status transitions: a parked row can flip to 'imported' when a replay
 * succeeds. The handler uses an INSERT … ON CONFLICT DO UPDATE on the
 * unique (env, conn, gid) constraint so transitions don't leave stale rows.
 */
export type OrderSyncLogStatus = 'imported' | 'parked' | 'ignored' | 'deferred';

export interface OrderSyncLog {
  readonly id: string;
  readonly environment: Environment;
  readonly connectionId: string;

  readonly shopifyOrderGid: string;
  readonly shopifyOrderId: string;
  readonly shopifyOrderName?: string;
  readonly shopifyCreatedAt?: Date;
  readonly shopifyProcessedAt?: Date;
  readonly shopifyUpdatedAt?: Date;
  readonly customerEmail?: string;

  readonly currencyCode?: string;
  readonly totalPrice?: string;
  readonly subtotalPrice?: string;
  readonly totalTax?: string;
  readonly totalDiscounts?: string;
  readonly totalShipping?: string;

  readonly status: OrderSyncLogStatus;

  readonly nsAccountId?: string;
  readonly nsRecordType?: 'salesorder' | 'cashsale';
  readonly nsInternalId?: string;
  readonly nsTranId?: string;

  readonly parkStage?: string;
  readonly parkDetail?: string;
  readonly parkErrorClass?: string;
  /** Eligibility reason for ignored/deferred outcomes. */
  readonly ignoredReason?: string;

  readonly syncedAt?: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface OrderSyncLogInput {
  readonly environment: Environment;
  readonly connectionId: string;

  readonly shopifyOrderGid: string;
  readonly shopifyOrderId: string;
  readonly shopifyOrderName?: string;
  readonly shopifyCreatedAt?: Date;
  readonly shopifyProcessedAt?: Date;
  readonly shopifyUpdatedAt?: Date;
  readonly customerEmail?: string;

  readonly currencyCode?: string;
  readonly totalPrice?: string;
  readonly subtotalPrice?: string;
  readonly totalTax?: string;
  readonly totalDiscounts?: string;
  readonly totalShipping?: string;

  readonly status: OrderSyncLogStatus;

  readonly nsAccountId?: string;
  readonly nsRecordType?: 'salesorder' | 'cashsale';
  readonly nsInternalId?: string;
  readonly nsTranId?: string;

  readonly parkStage?: string;
  readonly parkDetail?: string;
  readonly parkErrorClass?: string;
  /** Eligibility reason for ignored/deferred outcomes. */
  readonly ignoredReason?: string;

  readonly syncedAt?: Date;
}

export interface OrderSyncLogListFilter {
  readonly environment: Environment;
  readonly connectionId?: string;
  readonly status?: OrderSyncLogStatus;
  readonly limit?: number;
}

export interface OrderSyncLogStore {
  /**
   * Insert (or update) the row for `(env, connection, gid)`. Updates clear
   * old NS / park / ignore fields that don't apply to the new outcome — so
   * a parked row that later imports doesn't keep its `parkStage` populated.
   */
  upsert(input: OrderSyncLogInput): Promise<OrderSyncLog>;

  list(filter: OrderSyncLogListFilter): Promise<OrderSyncLog[]>;

  findByOrderGid(parts: {
    environment: Environment;
    connectionId: string;
    shopifyOrderGid: string;
  }): Promise<OrderSyncLog | undefined>;
}

/** In-memory impl for tests. */
export class InMemoryOrderSyncLogStore implements OrderSyncLogStore {
  private readonly rows = new Map<string, OrderSyncLog>();
  private seq = 0;

  async upsert(input: OrderSyncLogInput): Promise<OrderSyncLog> {
    const k = key(input);
    const existing = this.rows.get(k);
    const now = new Date();
    const id = existing?.id ?? `log_${String(++this.seq).padStart(8, '0')}`;
    const row: OrderSyncLog = {
      id,
      environment: input.environment,
      connectionId: input.connectionId,
      shopifyOrderGid: input.shopifyOrderGid,
      shopifyOrderId: input.shopifyOrderId,
      ...(input.shopifyOrderName !== undefined ? { shopifyOrderName: input.shopifyOrderName } : {}),
      ...(input.shopifyCreatedAt !== undefined ? { shopifyCreatedAt: input.shopifyCreatedAt } : {}),
      ...(input.shopifyProcessedAt !== undefined ? { shopifyProcessedAt: input.shopifyProcessedAt } : {}),
      ...(input.shopifyUpdatedAt !== undefined ? { shopifyUpdatedAt: input.shopifyUpdatedAt } : {}),
      ...(input.customerEmail !== undefined ? { customerEmail: input.customerEmail } : {}),
      ...(input.currencyCode !== undefined ? { currencyCode: input.currencyCode } : {}),
      ...(input.totalPrice !== undefined ? { totalPrice: input.totalPrice } : {}),
      ...(input.subtotalPrice !== undefined ? { subtotalPrice: input.subtotalPrice } : {}),
      ...(input.totalTax !== undefined ? { totalTax: input.totalTax } : {}),
      ...(input.totalDiscounts !== undefined ? { totalDiscounts: input.totalDiscounts } : {}),
      ...(input.totalShipping !== undefined ? { totalShipping: input.totalShipping } : {}),
      status: input.status,
      ...(input.nsAccountId !== undefined ? { nsAccountId: input.nsAccountId } : {}),
      ...(input.nsRecordType !== undefined ? { nsRecordType: input.nsRecordType } : {}),
      ...(input.nsInternalId !== undefined ? { nsInternalId: input.nsInternalId } : {}),
      ...(input.nsTranId !== undefined ? { nsTranId: input.nsTranId } : {}),
      ...(input.parkStage !== undefined ? { parkStage: input.parkStage } : {}),
      ...(input.parkDetail !== undefined ? { parkDetail: input.parkDetail } : {}),
      ...(input.parkErrorClass !== undefined ? { parkErrorClass: input.parkErrorClass } : {}),
      ...(input.ignoredReason !== undefined ? { ignoredReason: input.ignoredReason } : {}),
      ...(input.syncedAt !== undefined ? { syncedAt: input.syncedAt } : {}),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.rows.set(k, row);
    return row;
  }

  async list(filter: OrderSyncLogListFilter): Promise<OrderSyncLog[]> {
    const all = Array.from(this.rows.values()).filter((r) => {
      if (r.environment !== filter.environment) return false;
      if (filter.connectionId && r.connectionId !== filter.connectionId) return false;
      if (filter.status && r.status !== filter.status) return false;
      return true;
    });
    all.sort((a, b) => {
      const ax = (a.syncedAt ?? a.updatedAt).getTime();
      const bx = (b.syncedAt ?? b.updatedAt).getTime();
      return bx - ax;
    });
    return filter.limit ? all.slice(0, filter.limit) : all;
  }

  async findByOrderGid(parts: {
    environment: Environment;
    connectionId: string;
    shopifyOrderGid: string;
  }): Promise<OrderSyncLog | undefined> {
    return this.rows.get(key(parts));
  }

  /** Test helper. */
  size(): number {
    return this.rows.size;
  }
}

function key(parts: { environment: Environment; connectionId: string; shopifyOrderGid: string }): string {
  return `${parts.environment}|${parts.connectionId}|${parts.shopifyOrderGid}`;
}
