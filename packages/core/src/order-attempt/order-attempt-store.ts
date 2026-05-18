import type { Environment } from '../env.js';

/**
 * One row per Service Bus delivery of an order-import message — the
 * per-attempt audit substrate behind retry visibility and the future admin
 * UI's timeline view. Distinct from:
 *
 *   - `entity_xref`  — dedup ledger (one row per order, idempotency-only)
 *   - `order_sync_log` — terminal-outcome ledger (one row per order, the
 *     "where did this land?" answer)
 *
 * Every Service Bus delivery emits a row, including short-circuits
 * (`already_synced` / `already_claimed`) so the timeline explains every
 * redelivery — not just the meaningful ones. The full outbound NS payload
 * lives in blob storage (`outbound_payload_uri`); a small inline
 * `payload_digest` keeps the most-asked fields readable without a blob
 * fetch.
 */

export type OrderAttemptOutcome =
  | 'imported'
  | 'parked'
  | 'ignored_by_eligibility'
  | 'already_synced'
  | 'already_claimed'
  | 'ignored'
  | 'rejected'
  | 'transient_throw'
  | 'auth_throw'
  | 'quarantined';

export interface OrderAttempt {
  readonly id: string;
  readonly environment: Environment;
  readonly connectionId: string;
  readonly shopifyOrderGid: string;
  readonly deliveryCount: number;
  readonly sbMessageId?: string;
  readonly sbSessionId?: string;
  readonly outcome: OrderAttemptOutcome;
  readonly stage?: string;
  readonly errorClass?: string;
  readonly detail?: string;
  readonly inboundEnvelopeUri?: string;
  readonly outboundPayloadUri?: string;
  readonly payloadDigest?: Record<string, unknown>;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly durationMs: number;
  readonly createdAt: Date;
}

export interface OrderAttemptInput {
  readonly environment: Environment;
  readonly connectionId: string;
  readonly shopifyOrderGid: string;
  readonly deliveryCount: number;
  readonly sbMessageId?: string;
  readonly sbSessionId?: string;
  readonly outcome: OrderAttemptOutcome;
  readonly stage?: string;
  readonly errorClass?: string;
  readonly detail?: string;
  readonly inboundEnvelopeUri?: string;
  readonly outboundPayloadUri?: string;
  readonly payloadDigest?: Record<string, unknown>;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly durationMs: number;
}

export interface OrderAttemptStore {
  /**
   * Append one attempt row. Idempotency / dedup is intentionally NOT enforced
   * here — Service Bus delivery counts are monotonic per session, and a
   * redelivery genuinely is a new attempt. The store is append-only.
   */
  record(input: OrderAttemptInput): Promise<OrderAttempt>;

  /** All attempts for a single order, most-recent delivery first. */
  listByOrderGid(parts: {
    environment: Environment;
    connectionId: string;
    shopifyOrderGid: string;
  }): Promise<OrderAttempt[]>;
}

/** In-memory impl for tests. */
export class InMemoryOrderAttemptStore implements OrderAttemptStore {
  private readonly rows: OrderAttempt[] = [];
  private seq = 0;

  async record(input: OrderAttemptInput): Promise<OrderAttempt> {
    const row: OrderAttempt = {
      id: `attempt_${String(++this.seq).padStart(8, '0')}`,
      environment: input.environment,
      connectionId: input.connectionId,
      shopifyOrderGid: input.shopifyOrderGid,
      deliveryCount: input.deliveryCount,
      ...(input.sbMessageId !== undefined ? { sbMessageId: input.sbMessageId } : {}),
      ...(input.sbSessionId !== undefined ? { sbSessionId: input.sbSessionId } : {}),
      outcome: input.outcome,
      ...(input.stage !== undefined ? { stage: input.stage } : {}),
      ...(input.errorClass !== undefined ? { errorClass: input.errorClass } : {}),
      ...(input.detail !== undefined ? { detail: input.detail } : {}),
      ...(input.inboundEnvelopeUri !== undefined ? { inboundEnvelopeUri: input.inboundEnvelopeUri } : {}),
      ...(input.outboundPayloadUri !== undefined ? { outboundPayloadUri: input.outboundPayloadUri } : {}),
      ...(input.payloadDigest !== undefined ? { payloadDigest: input.payloadDigest } : {}),
      startedAt: input.startedAt,
      finishedAt: input.finishedAt,
      durationMs: input.durationMs,
      createdAt: new Date(),
    };
    this.rows.push(row);
    return row;
  }

  async listByOrderGid(parts: {
    environment: Environment;
    connectionId: string;
    shopifyOrderGid: string;
  }): Promise<OrderAttempt[]> {
    return this.rows
      .filter(
        (r) =>
          r.environment === parts.environment &&
          r.connectionId === parts.connectionId &&
          r.shopifyOrderGid === parts.shopifyOrderGid,
      )
      .sort((a, b) => b.deliveryCount - a.deliveryCount);
  }

  /** Test helper. */
  all(): readonly OrderAttempt[] {
    return this.rows;
  }

  size(): number {
    return this.rows.length;
  }
}
