import { describe, expect, it } from 'vitest';
import { OrderNotFoundError } from '@dpi/shopify-client';
import { classifyHandlerError, shouldRetry } from '../src/triggers/error-classification.js';

// NetSuiteError lives in @dpi/netsuite-client's transitive dep `netsuite-sdk`
// which isn't on apps/functions's classpath. The dedicated NS classifier is
// covered by packages/netsuite-client/test/error-mapping.test.ts; here we
// only exercise the cross-cutting cues classifyHandlerError owns.

/**
 * The classifier's contract — encoded as the brief's four classes —
 * determines whether each failure path parks or re-throws. These tests pin
 * the most important transitions so a careless change can't silently
 * convert a "park, don't guess" stop into a tight retry loop or vice
 * versa.
 */
describe('classifyHandlerError', () => {
  it('classifies OrderNotFoundError as data (permanent — park, never retry)', () => {
    expect(classifyHandlerError(new OrderNotFoundError('gid://x', 'shop.myshopify.com'))).toBe('data');
  });

  it('classifies HTTP 5xx as transient (SB retry)', () => {
    expect(classifyHandlerError(new Error('store.myshopify.com returned 503: busy'))).toBe('transient');
    expect(classifyHandlerError(new Error('store.myshopify.com returned 500'))).toBe('transient');
    expect(classifyHandlerError(new Error('store.myshopify.com returned 502'))).toBe('transient');
  });

  it('classifies HTTP 429 as transient (rate limited)', () => {
    expect(classifyHandlerError(new Error('returned 429'))).toBe('transient');
  });

  it('classifies HTTP 401 / 403 as auth', () => {
    expect(classifyHandlerError(new Error('store returned 401: missing token'))).toBe('auth');
    expect(classifyHandlerError(new Error('store returned 403: forbidden'))).toBe('auth');
  });

  it('classifies HTTP 4xx (non-auth) as data', () => {
    expect(classifyHandlerError(new Error('returned 400: bad request'))).toBe('data');
    expect(classifyHandlerError(new Error('returned 404'))).toBe('data');
    expect(classifyHandlerError(new Error('returned 422: unprocessable'))).toBe('data');
  });

  it('handles bare "HTTP <status>" / "status=<status>" patterns', () => {
    expect(classifyHandlerError(new Error('shopify: HTTP 503'))).toBe('transient');
    expect(classifyHandlerError(new Error('something status=401 something'))).toBe('auth');
  });

  it('classifies network error patterns as transient', () => {
    expect(classifyHandlerError(new Error('ECONNRESET while reading'))).toBe('transient');
    expect(classifyHandlerError(new Error('ETIMEDOUT after 30s'))).toBe('transient');
    expect(classifyHandlerError(new Error('socket hang up'))).toBe('transient');
    expect(classifyHandlerError(new Error('fetch failed'))).toBe('transient');
  });

  it('classifies Shopify GraphQL errors as data', () => {
    expect(
      classifyHandlerError(
        new Error('ShopifyHttpGateway.getOrder: GraphQL errors: Field deprecated'),
      ),
    ).toBe('data');
  });

  it('classifies bare Error (no recognizable cues) as unknown — park, do not retry', () => {
    expect(classifyHandlerError(new Error('something exploded'))).toBe('unknown');
  });

  it('classifies non-Error throws as unknown', () => {
    expect(classifyHandlerError('a string')).toBe('unknown');
    expect(classifyHandlerError({ ad: 'hoc' })).toBe('unknown');
    expect(classifyHandlerError(undefined)).toBe('unknown');
  });
});

describe('shouldRetry', () => {
  it('retries only transient + auth (auth so creds rotation can recover)', () => {
    expect(shouldRetry('transient')).toBe(true);
    expect(shouldRetry('auth')).toBe(true);
  });

  it('parks data / unmapped_construct / unknown (never silently retry-loop)', () => {
    expect(shouldRetry('data')).toBe(false);
    expect(shouldRetry('unmapped_construct')).toBe(false);
    expect(shouldRetry('unknown')).toBe(false);
  });
});
