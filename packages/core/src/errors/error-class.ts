/**
 * How the handler should treat a failure.
 *
 *  - transient: network/5xx/concurrency → auto-retry with backoff+jitter.
 *  - data: validation / missing xref / bad payload → park for human, do not retry.
 *  - auth: 401/403/TBA invalid → alert; do not retry.
 *  - unmapped_construct: the connection isn't configured to handle this order shape
 *    (unknown tender, tax engine, currency, discount mode, etc.). Park, never improvise.
 *  - unknown: classifier couldn't decide. Treat as data (park) so we don't loop.
 */
export type ErrorClass =
  | 'transient'
  | 'data'
  | 'auth'
  | 'unmapped_construct'
  | 'unknown';

export const RETRYABLE_CLASSES: readonly ErrorClass[] = ['transient'] as const;

export function isRetryable(cls: ErrorClass): boolean {
  return (RETRYABLE_CLASSES as readonly ErrorClass[]).includes(cls);
}
