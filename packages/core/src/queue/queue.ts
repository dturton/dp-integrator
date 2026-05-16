/**
 * Minimal queue abstraction used by the webhook receiver (enqueue only) and
 * the order handler (consume). The production substrate is Azure Service Bus
 * with sessions (per-order FIFO) — see `apps/functions` once wired in M1.
 *
 * `sessionId` maps to Service Bus session id so refund/edit can't precede
 * order for the same key. M1 will pass `${connection_id}:${order_gid}`.
 */
export interface QueueMessage<T> {
  readonly id: string;
  readonly sessionId: string | undefined;
  readonly body: T;
  /** Number of prior deliveries; Service Bus exposes this on receive. */
  readonly deliveryCount: number;
  readonly enqueuedAt: Date;
}

export interface QueueProducer<T> {
  enqueue(message: { sessionId?: string; body: T }): Promise<void>;
}

export interface QueueConsumer<T> {
  /** Drains all currently-enqueued messages for tests. Real consumer is the SB trigger. */
  drain(): Promise<QueueMessage<T>[]>;
}

/** Combined producer+consumer for tests. */
export type QueueProvider<T> = QueueProducer<T> & QueueConsumer<T>;

export class InMemoryQueue<T> implements QueueProvider<T> {
  private readonly buffer: QueueMessage<T>[] = [];
  private seq = 0;

  async enqueue(message: { sessionId?: string; body: T }): Promise<void> {
    this.buffer.push({
      id: `msg_${String(++this.seq).padStart(8, '0')}`,
      sessionId: message.sessionId,
      body: message.body,
      deliveryCount: 0,
      enqueuedAt: new Date(),
    });
  }

  async drain(): Promise<QueueMessage<T>[]> {
    const out = this.buffer.splice(0, this.buffer.length);
    return out;
  }

  size(): number {
    return this.buffer.length;
  }
}
