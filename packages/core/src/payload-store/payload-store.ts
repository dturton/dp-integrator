import type { Environment } from '../env.js';

/**
 * Archive of the outbound NetSuite payload — what we actually shipped at NS
 * upsert time. Sibling of the inbound `EnvelopeStore` (kept distinct because
 * inbound is HMAC-verified evidence with stricter retention; outbound is
 * debug-grade with a shorter window).
 *
 * Implementations write the JSON to durable storage and return a URI that
 * `order_attempt.outbound_payload_uri` carries. A write failure must NEVER
 * block the NS upsert — the caller wraps `put` so blob outages degrade
 * gracefully to "no archive for this attempt".
 */

/**
 * `outbound` — the JSON we shipped to NS. Default kind, preserves the
 * existing per-attempt path shape so legacy reads keep working.
 * `ns_response` — what NS returned (success or structured error). Same
 * attempt, same path layout, with a `-response.json` suffix so both blobs
 * sit next to each other in the date partition.
 */
export type PayloadKind = 'outbound' | 'ns_response';

export interface PayloadStoreContext {
  readonly environment: Environment;
  readonly connectionId: string;
  /** The Shopify order GID — used for path layout and metadata. */
  readonly shopifyOrderGid: string;
  /** Service Bus deliveryCount (1-based). Distinct path per attempt so redeliveries don't clobber. */
  readonly deliveryCount: number;
  readonly nsAccountId?: string;
  readonly nsRecordType?: string;
  /** When the attempt started — drives the date partitioning in the blob path. */
  readonly attemptStartedAt: Date;
  /** Defaults to 'outbound'. 'ns_response' suffixes the blob path with `-response.json`. */
  readonly kind?: PayloadKind;
}

export interface PayloadStore {
  /**
   * Persist the outbound payload and return a stable URI to it. Caller
   * receives the URI and stamps it onto `order_attempt.outbound_payload_uri`.
   */
  put(payload: Record<string, unknown>, ctx: PayloadStoreContext): Promise<string>;
}

/** In-memory impl for tests. */
export class InMemoryPayloadStore implements PayloadStore {
  private readonly blobs = new Map<string, Record<string, unknown>>();
  private putAttempts = 0;
  /** When set, the next `put` throws this and the count is consumed. Used to assert the handler's catch swallows blob errors. */
  private failNextError?: Error;

  async put(payload: Record<string, unknown>, ctx: PayloadStoreContext): Promise<string> {
    this.putAttempts += 1;
    if (this.failNextError) {
      const e = this.failNextError;
      delete this.failNextError;
      throw e;
    }
    const uri = pathFor(ctx);
    this.blobs.set(uri, payload);
    return uri;
  }

  /** Test helper — read the payload that was archived at `uri`. */
  get(uri: string): Record<string, unknown> | undefined {
    return this.blobs.get(uri);
  }

  putCount(): number {
    return this.putAttempts;
  }

  /** Cause the next `put` to throw — exercises the handler's swallow. */
  failNext(err: Error): void {
    this.failNextError = err;
  }
}

function pathFor(ctx: PayloadStoreContext): string {
  const id = (ctx.shopifyOrderGid.split('/').pop() ?? 'unknown').replace(/[^a-z0-9_-]/gi, '_');
  const d = ctx.attemptStartedAt;
  const yyyy = String(d.getUTCFullYear());
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const ts = d.toISOString().replace(/[:.]/g, '-');
  const suffix = ctx.kind === 'ns_response' ? '-response.json' : '.json';
  return `mem://outbound/${ctx.environment}/${ctx.connectionId}/${yyyy}/${mm}/${dd}/${id}-attempt${ctx.deliveryCount}-${ts}${suffix}`;
}
