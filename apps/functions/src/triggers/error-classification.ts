import type { ErrorClass } from '@dpi/core';
import { mapNetSuiteError } from '@dpi/netsuite-client';
import { OrderNotFoundError, OrderTruncatedError } from '@dpi/shopify-client';

/**
 * Map any error raised during the order-import pipeline to one of the brief's
 * four meaningful classes. Drives the handler's retry-vs-park decision:
 *
 *   - `transient`: SB retries (HTTP 5xx, NS rate limit, network blip).
 *   - `data` / `unmapped_construct`: park; never auto-retry. Operator decides.
 *   - `auth`: park *and* surface for alerting (a future slice flips this into
 *     a notification, not just an error_records row). SB still retries so a
 *     credential rotation auto-recovers.
 *   - `unknown`: treat like data so we never silently retry-loop on a novel
 *     failure mode the classifier doesn't recognise yet.
 *
 * `OrderNotFoundError` (Slice E1) collapses to `data` — the order is
 * permanently gone, no retry will resurrect it.
 *
 * NetSuite errors are delegated to `mapNetSuiteError` which already encodes
 * the SDK's auth/retryable hints plus our 429 / WS_CONCURRENT_REQUEST_LIMIT
 * cues. Bare `Error`s with network-y messages (ECONNRESET / ETIMEDOUT /
 * "socket hang up") fall to `transient`.
 */
export function classifyHandlerError(err: unknown): ErrorClass {
  // Order-not-found from Shopify re-fetch (Slice E1) — permanent data error.
  if (err instanceof OrderNotFoundError) return 'data';
  if (err instanceof OrderTruncatedError) return 'data';

  // NetSuite errors carry the most signal — let the dedicated mapper handle them.
  // mapNetSuiteError returns 'auth' / 'transient' / 'data' / 'unknown' already.
  if (err instanceof Error && err.name === 'NetSuiteError') {
    return mapNetSuiteError(err);
  }

  // Generic transient cues from Shopify's HTTP gateway and lower-layer
  // fetch/AMQP transports. The HTTP gateway formats errors as
  //   "<store> returned <status>: <body>"
  // — extract the status to drive classification.
  if (err instanceof Error) {
    const lc = err.message.toLowerCase();
    const status = extractHttpStatus(err.message);

    if (status !== undefined) {
      if (status === 401 || status === 403) return 'auth';
      if (status === 429) return 'transient';
      if (status >= 500 && status < 600) return 'transient';
      if (status >= 400 && status < 500) return 'data';
    }

    if (
      lc.includes('econnreset') ||
      lc.includes('etimedout') ||
      lc.includes('socket hang up') ||
      lc.includes('network request failed') ||
      lc.includes('fetch failed')
    ) {
      return 'transient';
    }

    // GraphQL errors (Shopify response with `errors: [...]`) — almost always
    // a malformed query or a permissions issue. Park.
    if (lc.startsWith('shopifyhttpgateway.getorder: graphql errors')) {
      return 'data';
    }
  }

  return 'unknown';
}

/**
 * Pull an HTTP status code from the kinds of error strings our gateways
 * format. Two known shapes:
 *   `<store> returned <status>: <body>`         (ShopifyHttpGateway)
 *   `... status=<status> ...`                    (some NS error wrappers)
 * Returns undefined when no recognizable status is present.
 */
function extractHttpStatus(message: string): number | undefined {
  // "<store> returned <status>: <body>" — ShopifyHttpGateway's shape.
  const returned = /returned (\d{3})\b/i.exec(message);
  if (returned) return Number(returned[1]);
  // "status=<status>" or "status: <status>" — assorted lower-level error
  // wrappers, including the NS SDK's NetSuiteError when stringified.
  const status = /\bstatus[=:\s]+(\d{3})\b/i.exec(message);
  if (status) return Number(status[1]);
  // Bare "HTTP <status>" / "<status> Service Unavailable" patterns —
  // common from generic clients and the dev-server wrappers we use in tests.
  const http = /\bHTTP\s+(\d{3})\b/i.exec(message);
  if (http) return Number(http[1]);
  const phrase = /\b([45]\d{2})\s+(Service|Internal|Gateway|Bad|Unauthorized|Forbidden|Not\s+Found|Conflict)\b/i.exec(
    message,
  );
  if (phrase) return Number(phrase[1]);
  return undefined;
}

/**
 * Coarse retry decision derived from the class — handler uses this to decide
 * whether to throw (let SB retry / eventually DLQ → quarantine via M2-B) or
 * park gracefully.
 *
 * `auth` re-throws because a credential rotation between attempts can recover
 * (M3 will layer on actual alerting). `data` / `unmapped_construct` /
 * `unknown` park. `transient` re-throws and trusts SB's backoff.
 */
export function shouldRetry(cls: ErrorClass): boolean {
  return cls === 'transient' || cls === 'auth';
}
