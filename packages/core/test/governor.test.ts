import { describe, expect, it } from 'vitest';
import {
  acquireSlot,
  newHolderId,
  PerProcessGovernorStore,
  SharedInMemoryGovernorStore,
  type GovernorBackingStore,
} from '../src/index.js';

/**
 * Run `count` concurrent "fake NetSuite requests" against a backing store.
 * Each request: acquire → simulate ~jitter ms of work → release. We sample
 * `inFlight` at acquire time to capture the peak observed concurrency.
 *
 * `acquireFromStore` lets the caller choose WHICH store each request uses —
 * the shared-store case passes the same store for every request; the
 * per-process case picks one of N stores by request index.
 */
async function burst(opts: {
  acquireFromStore: (i: number) => GovernorBackingStore;
  count: number;
  ceiling: number;
  nsAccountId: string;
  workMs: number;
}): Promise<{ peak: number }> {
  const { acquireFromStore, count, ceiling, nsAccountId, workMs } = opts;
  let inFlight = 0;
  let peak = 0;

  const tasks = Array.from({ length: count }, (_, i) =>
    (async () => {
      const store = acquireFromStore(i);
      const release = await acquireSlot(store, nsAccountId, newHolderId(`h${i}`), {
        perAccountCeiling: ceiling,
        pollIntervalMs: 2,
        acquireTimeoutMs: 10_000,
      });
      inFlight += 1;
      if (inFlight > peak) peak = inFlight;
      try {
        // Jitter to interleave acquires/releases.
        await new Promise((r) => setTimeout(r, workMs * (0.5 + Math.random())));
      } finally {
        inFlight -= 1;
        await release();
      }
    })(),
  );

  await Promise.all(tasks);
  return { peak };
}

describe('NS governor — per-account ceiling enforcement (M0 invariant 5)', () => {
  it('SharedInMemoryGovernorStore: 500 concurrent requests across 2 clients stay ≤ ceiling', async () => {
    const CEILING = 10;
    const sharedStore = new SharedInMemoryGovernorStore(CEILING);
    // Both "clients" point at the SAME backing store — models the cross-instance
    // SQL governor every Function instance shares.
    const { peak } = await burst({
      acquireFromStore: () => sharedStore,
      count: 500,
      ceiling: CEILING,
      nsAccountId: 'ns-1234567',
      workMs: 4,
    });
    expect(peak).toBeLessThanOrEqual(CEILING);
    // Sanity: we actually saturated the budget (otherwise the test proves nothing).
    expect(peak).toBeGreaterThanOrEqual(CEILING - 1);
    expect(await sharedStore.inFlight('ns-1234567')).toBe(0);
  });

  /**
   * This test demonstrates the trap the brief warns about. Two NetSuite clients
   * each have their OWN PerProcessGovernorStore (the SDK's bundled `RateLimiter`
   * has the same shape — it's per-instance). Aggregate in-flight across the two
   * stores exceeds the ceiling because they don't coordinate.
   *
   * The test asserts the overshoot, so it passes by demonstrating the bug — that
   * keeps CI green while making the failure mode visible in test output.
   */
  it('PerProcessGovernorStore: same workload across 2 instances OVERSHOOTS the ceiling (the trap)', async () => {
    const CEILING_PER_INSTANCE = 10;
    const storeA = new PerProcessGovernorStore(CEILING_PER_INSTANCE);
    const storeB = new PerProcessGovernorStore(CEILING_PER_INSTANCE);
    // Round-robin: even-index requests use store A, odd use store B.
    const { peak } = await burst({
      acquireFromStore: (i) => (i % 2 === 0 ? storeA : storeB),
      count: 500,
      ceiling: CEILING_PER_INSTANCE,
      nsAccountId: 'ns-1234567',
      workMs: 4,
    });
    // The per-process limiter cannot enforce the per-account ceiling here:
    // aggregate concurrency exceeds it. The brief: "an in-process limiter must
    // visibly fail this test."
    expect(peak).toBeGreaterThan(CEILING_PER_INSTANCE);
  });
});
