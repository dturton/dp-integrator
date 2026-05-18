import type { Environment } from '../env.js';

/**
 * Per-(environment, connection, flow) cursor for the catch-up poller.
 *
 * The poller asks Shopify for orders with `updated_at >= last_cursor`,
 * processes them, then advances the cursor. On first run for a new flow
 * there's no row yet; the caller bootstraps from `now - lookback` so the
 * first poll catches recent activity without scanning the entire store.
 *
 * `last_cursor` is opaque to the store — the brief defines it as VARCHAR
 * specifically so a future flow (catch-up for refunds, fulfillment, etc.)
 * can encode its own cursor shape (e.g. an opaque GraphQL pagination
 * cursor). For the order-catchup flow, this codebase stores an ISO
 * timestamp string.
 */
export interface SyncWatermarkRow {
  readonly environment: Environment;
  readonly connectionId: string;
  readonly flow: string;
  readonly lastCursor: string | null;
  readonly updatedAt: Date;
}

export interface SyncWatermarkStore {
  /** Get the current cursor (or undefined on first run for the flow). */
  get(parts: {
    environment: Environment;
    connectionId: string;
    flow: string;
  }): Promise<SyncWatermarkRow | undefined>;

  /**
   * Atomically advance the cursor. Inserts on first call. The caller is
   * expected to compute the new cursor — the store does not interpret it.
   */
  set(input: {
    environment: Environment;
    connectionId: string;
    flow: string;
    cursor: string;
  }): Promise<SyncWatermarkRow>;
}

/** In-memory store for unit tests. */
export class InMemorySyncWatermarkStore implements SyncWatermarkStore {
  private readonly rows = new Map<string, SyncWatermarkRow>();

  async get(parts: {
    environment: Environment;
    connectionId: string;
    flow: string;
  }): Promise<SyncWatermarkRow | undefined> {
    return this.rows.get(key(parts));
  }

  async set(input: {
    environment: Environment;
    connectionId: string;
    flow: string;
    cursor: string;
  }): Promise<SyncWatermarkRow> {
    const row: SyncWatermarkRow = {
      environment: input.environment,
      connectionId: input.connectionId,
      flow: input.flow,
      lastCursor: input.cursor,
      updatedAt: new Date(),
    };
    this.rows.set(key(input), row);
    return row;
  }

  /** Test helper. */
  size(): number {
    return this.rows.size;
  }
}

function key(parts: { environment: Environment; connectionId: string; flow: string }): string {
  return `${parts.environment}|${parts.connectionId}|${parts.flow}`;
}
