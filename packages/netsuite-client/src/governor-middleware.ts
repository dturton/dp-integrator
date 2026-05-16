import type { Middleware } from 'netsuite-sdk';
import { acquireSlot, newHolderId, type GovernorBackingStore, type GovernorConfig } from '@dpi/core';

/**
 * Install on a `NetSuiteClient` via `client.use(governorMiddleware(...))`.
 *
 * Acquires a slot BEFORE the request leaves the SDK; releases AFTER the
 * response (or error) comes back. Slots are scoped per NS account via the
 * `nsAccountId` closed over here — so two clients pointing at the same
 * `nsAccountId` and sharing the same `GovernorBackingStore` enforce one
 * cross-instance budget.
 *
 * IMPORTANT: the SDK's transport runs its own retry loop (axios + `maxRetries`,
 * default 3). Each retried call re-enters this middleware and acquires a fresh
 * slot. That's intentional — retries consume capacity. Size the per-account
 * ceiling with that in mind.
 *
 * The middleware is opaque to the SDK's internal `RateLimiter` class. We never
 * use the SDK's bundled limiter (it's per-instance only — see the M0 burst test).
 */
export function governorMiddleware(args: {
  store: GovernorBackingStore;
  nsAccountId: string;
  config: GovernorConfig;
}): Middleware {
  const { store, nsAccountId, config } = args;
  return async (context, next) => {
    const holderId = newHolderId('ns');
    const release = await acquireSlot(store, nsAccountId, holderId, config);
    // Mark the request so observability layers can correlate slot occupancy.
    context.metadata['ns_account_id'] = nsAccountId;
    context.metadata['governor_holder_id'] = holderId;
    try {
      return await next();
    } finally {
      await release();
    }
  };
}
