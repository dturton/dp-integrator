import { NetSuiteError } from 'netsuite-sdk';
import type { ErrorClass } from '@dpi/core';

/**
 * Map a thrown NetSuite SDK error (or any error) into our handler-facing
 * classification.
 *
 * The SDK exposes `isAuthError` and `isRetryable` getters; we layer two
 * additional NS-specific cues on top:
 *
 *  1. Concurrency-governance / rate-limit responses come back as 429 or as
 *     400 with `o:errorCode` `WS_CONCURRENT_REQUEST_LIMIT_EXCEEDED`. Both are
 *     transient — back off and retry, do not park.
 *  2. Common data-shape rejections (400 + INVALID_*, INSUFFICIENT_PERMISSION
 *     against a specific field, MISSING_REQD_FIELD) are `data` — park; do not retry.
 *
 * Anything we can't confidently classify becomes `unknown`, which the handler
 * treats like `data` (parked) so we never silently retry-loop on a novel shape.
 */
export function mapNetSuiteError(err: unknown): ErrorClass {
  if (NetSuiteError.isNetSuiteError(err)) {
    if (err.isAuthError) return 'auth';

    const errorCode = err.code;
    const errorDetails = err.details?.['o:errorDetails'] ?? [];
    const allCodes = [errorCode, ...errorDetails.map((d) => d?.['o:errorCode']).filter(Boolean)]
      .filter((c): c is string => typeof c === 'string')
      .map((c) => c.toUpperCase());

    // NS concurrency / rate-limit — transient regardless of status code.
    if (
      err.status === 429 ||
      allCodes.some((c) => c.includes('CONCURRENT') || c.includes('GOVERNANCE'))
    ) {
      return 'transient';
    }

    if (err.isRetryable) return 'transient';

    // 400/422 with a data-shape code → park, don't retry.
    if (err.status === 400 || err.status === 422) {
      const dataCodePatterns = [
        'INVALID_KEY_OR_REF',
        'INVALID_FIELD',
        'INVALID_RECORD',
        'INVALID_FIELD_VALUE',
        'MISSING_REQD_FIELD',
        'USER_ERROR',
        'INSUFFICIENT_PERMISSION',
      ];
      if (allCodes.some((c) => dataCodePatterns.some((p) => c.includes(p)))) {
        return 'data';
      }
    }

    // Unclassified NetSuite error — treat as unknown (handler parks).
    return 'unknown';
  }

  // Bare network errors are transient; everything else is unknown.
  if (err instanceof Error) {
    const msg = err.message.toLowerCase();
    if (msg.includes('econnreset') || msg.includes('etimedout') || msg.includes('socket hang up')) {
      return 'transient';
    }
  }
  return 'unknown';
}
