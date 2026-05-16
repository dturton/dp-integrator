import type { Environment } from '../env.js';
import type { ErrorClass } from './error-class.js';

export type ErrorStatus = 'open' | 'retrying' | 'resolved' | 'ignored' | 'quarantined';

export interface ErrorRecord {
  readonly id: string;
  readonly environment: Environment;
  readonly connectionId: string;
  readonly flow: string;
  /** Dedup key from `entity_xref` — correlates this error with its source row. */
  readonly dedupKey: string;
  readonly errorClass: ErrorClass;
  readonly message: string;
  readonly stack?: string;
  /** Raw upstream envelope (webhook body, etc.) for replay. */
  readonly envelope: unknown;
  readonly retryCount: number;
  readonly status: ErrorStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface NewErrorInput {
  readonly environment: Environment;
  readonly connectionId: string;
  readonly flow: string;
  readonly dedupKey: string;
  readonly errorClass: ErrorClass;
  readonly message: string;
  readonly stack?: string;
  readonly envelope: unknown;
}

export interface ErrorStore {
  record(input: NewErrorInput): Promise<ErrorRecord>;
  get(id: string): Promise<ErrorRecord | undefined>;
  /** List in a stable order (createdAt desc). Used by admin REST/CLI. */
  list(filter?: {
    environment?: Environment;
    connectionId?: string;
    status?: ErrorStatus;
    errorClass?: ErrorClass;
  }): Promise<ErrorRecord[]>;
  updateStatus(id: string, status: ErrorStatus, message?: string): Promise<ErrorRecord>;
  incrementRetry(id: string): Promise<ErrorRecord>;
}

/** In-memory implementation for tests. SQL impl lands when M2 wires admin replay. */
export class InMemoryErrorStore implements ErrorStore {
  private readonly rows = new Map<string, ErrorRecord>();
  private seq = 0;

  async record(input: NewErrorInput): Promise<ErrorRecord> {
    const now = new Date();
    const id = `err_${String(++this.seq).padStart(8, '0')}`;
    const row: ErrorRecord = {
      id,
      environment: input.environment,
      connectionId: input.connectionId,
      flow: input.flow,
      dedupKey: input.dedupKey,
      errorClass: input.errorClass,
      message: input.message,
      ...(input.stack !== undefined ? { stack: input.stack } : {}),
      envelope: input.envelope,
      retryCount: 0,
      status: 'open',
      createdAt: now,
      updatedAt: now,
    };
    this.rows.set(id, row);
    return row;
  }

  async get(id: string): Promise<ErrorRecord | undefined> {
    return this.rows.get(id);
  }

  async list(filter?: {
    environment?: Environment;
    connectionId?: string;
    status?: ErrorStatus;
    errorClass?: ErrorClass;
  }): Promise<ErrorRecord[]> {
    const all = Array.from(this.rows.values());
    const filtered = all.filter((r) => {
      if (filter?.environment && r.environment !== filter.environment) return false;
      if (filter?.connectionId && r.connectionId !== filter.connectionId) return false;
      if (filter?.status && r.status !== filter.status) return false;
      if (filter?.errorClass && r.errorClass !== filter.errorClass) return false;
      return true;
    });
    filtered.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return filtered;
  }

  async updateStatus(id: string, status: ErrorStatus, message?: string): Promise<ErrorRecord> {
    const existing = this.rows.get(id);
    if (!existing) throw new Error(`InMemoryErrorStore: no error record ${id}`);
    const updated: ErrorRecord = {
      ...existing,
      status,
      ...(message !== undefined ? { message } : {}),
      updatedAt: new Date(),
    };
    this.rows.set(id, updated);
    return updated;
  }

  async incrementRetry(id: string): Promise<ErrorRecord> {
    const existing = this.rows.get(id);
    if (!existing) throw new Error(`InMemoryErrorStore: no error record ${id}`);
    const updated: ErrorRecord = {
      ...existing,
      retryCount: existing.retryCount + 1,
      updatedAt: new Date(),
    };
    this.rows.set(id, updated);
    return updated;
  }

  /** Test helper. */
  size(): number {
    return this.rows.size;
  }
}
