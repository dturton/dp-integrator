import type { GovernorBackingStore, GovernorConfig } from './governor-store.js';

/**
 * Blocks until a slot is acquired or `acquireTimeoutMs` elapses.
 *
 * Returns a `release()` callback the caller MUST invoke (in a finally) so the
 * slot is freed even if the underlying request throws. Pattern lifted by the
 * SDK governor middleware.
 *
 * Note: the SDK's internal transport retries (axios `maxRetries`) re-enter the
 * middleware chain, so each retried call hits `acquireSlot` again and consumes
 * a fresh slot. Size the per-account ceiling accordingly.
 */
export async function acquireSlot(
  store: GovernorBackingStore,
  nsAccountId: string,
  holderId: string,
  config: GovernorConfig,
): Promise<() => Promise<void>> {
  const pollInterval = config.pollIntervalMs ?? 25;
  const timeout = config.acquireTimeoutMs ?? 60_000;
  const deadline = Date.now() + timeout;

  while (true) {
    const got = await store.tryAcquire(nsAccountId, holderId);
    if (got) {
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        await store.release(nsAccountId, holderId);
      };
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `Governor: timed out after ${timeout}ms waiting for slot on NS account '${nsAccountId}'`,
      );
    }
    await new Promise((r) => setTimeout(r, pollInterval));
  }
}

let holderSeq = 0;
/** Generate an opaque, unique-per-call holder id. */
export function newHolderId(prefix = 'h'): string {
  return `${prefix}_${Date.now().toString(36)}_${(++holderSeq).toString(36)}`;
}
