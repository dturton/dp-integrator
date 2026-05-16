import { describe, expect, it } from 'vitest';
import { NetSuiteClient } from 'netsuite-sdk';
import { SharedInMemoryGovernorStore } from '@dpi/core';
import { governorMiddleware } from '../src/governor-middleware.js';

function makeClient(): NetSuiteClient {
  return new NetSuiteClient({
    auth: {
      consumerKey: 'ck',
      consumerSecret: 'cs',
      tokenKey: 'tk',
      tokenSecret: 'ts',
      realm: '1234567',
    },
    accountId: '1234567',
    timeout: 1_000,
    // SDK transport retries; we want zero here so we can exercise retries explicitly via the middleware chain.
    maxRetries: 0,
  });
}

describe('governorMiddleware (NetSuiteClient.use integration)', () => {
  it('acquires a slot before the request and releases after success', async () => {
    const store = new SharedInMemoryGovernorStore(2);
    const client = makeClient();
    let inFlightSeen = 0;
    client.use(governorMiddleware({ store, nsAccountId: '1234567', config: { perAccountCeiling: 2 } }));
    // Inner middleware (runs INSIDE the governor) captures in-flight while the slot is held.
    client.use(async (context, next) => {
      inFlightSeen = await store.inFlight('1234567');
      // Short-circuit: don't make a real HTTP call.
      return { status: 200, headers: {}, body: { ok: true, ctx: context.url }, duration: 0 };
    });

    await client.get('/x');
    expect(inFlightSeen).toBe(1);
    // Slot released by middleware's finally.
    expect(await store.inFlight('1234567')).toBe(0);
  });

  it('releases the slot even if the inner request throws', async () => {
    const store = new SharedInMemoryGovernorStore(1);
    const client = makeClient();
    client.use(governorMiddleware({ store, nsAccountId: '1234567', config: { perAccountCeiling: 1 } }));
    client.use(async () => {
      throw new Error('inner boom');
    });

    await expect(client.get('/x')).rejects.toThrow('inner boom');
    expect(await store.inFlight('1234567')).toBe(0);
  });

  it('two clients sharing the SAME governor store enforce one combined budget', async () => {
    const SHARED_CEILING = 2;
    const store = new SharedInMemoryGovernorStore(SHARED_CEILING);
    const make = (): NetSuiteClient => {
      const c = makeClient();
      c.use(
        governorMiddleware({
          store,
          nsAccountId: '1234567',
          config: { perAccountCeiling: SHARED_CEILING, pollIntervalMs: 2 },
        }),
      );
      c.use(async () => {
        // Hold the slot briefly so the ceiling actually saturates.
        await new Promise((r) => setTimeout(r, 30));
        return { status: 200, headers: {}, body: { ok: true }, duration: 0 };
      });
      return c;
    };

    const a = make();
    const b = make();

    // 6 concurrent requests across 2 clients sharing budget 2. Peak in-flight ≤ 2.
    let peak = 0;
    let inFlight = 0;
    const decorate = (call: Promise<unknown>): Promise<unknown> => {
      inFlight += 1;
      if (inFlight > peak) peak = inFlight;
      return call.finally(() => {
        inFlight -= 1;
      });
    };

    // We can't easily wrap from outside the middleware, so we sample the
    // governor's `inFlight` instead: spawn requests, poll the store while they
    // run.
    let pollPeak = 0;
    const pollHandle = setInterval(() => {
      void store.inFlight('1234567').then((n) => {
        if (n > pollPeak) pollPeak = n;
      });
    }, 5);

    await Promise.all([
      decorate(a.get('/1')),
      decorate(a.get('/2')),
      decorate(a.get('/3')),
      decorate(b.get('/4')),
      decorate(b.get('/5')),
      decorate(b.get('/6')),
    ]);
    clearInterval(pollHandle);

    expect(pollPeak).toBeLessThanOrEqual(SHARED_CEILING);
    expect(pollPeak).toBeGreaterThanOrEqual(1);
    expect(peak).toBeGreaterThan(SHARED_CEILING); // outer dispatch sent more than the cap, governor throttled inside
  });
});
