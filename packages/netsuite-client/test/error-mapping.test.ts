import { describe, expect, it } from 'vitest';
import { NetSuiteError } from 'netsuite-sdk';
import { mapNetSuiteError } from '../src/error-mapping.js';

function nsError(
  status: number,
  code: string,
  extraDetails?: ReadonlyArray<{ 'o:errorCode'?: string; detail?: string }>,
): NetSuiteError {
  return new NetSuiteError(
    `NetSuite ${status} ${code}`,
    status,
    code,
    extraDetails ? { 'o:errorDetails': [...extraDetails] } : undefined,
    undefined,
    'POST',
  );
}

describe('mapNetSuiteError', () => {
  it('classifies 401 / 403 as auth', () => {
    expect(mapNetSuiteError(nsError(401, 'UNAUTHORIZED'))).toBe('auth');
    expect(mapNetSuiteError(nsError(403, 'FORBIDDEN'))).toBe('auth');
  });

  it('classifies 5xx as transient (via SDK isRetryable)', () => {
    expect(mapNetSuiteError(nsError(500, 'INTERNAL'))).toBe('transient');
    expect(mapNetSuiteError(nsError(503, 'UNAVAILABLE'))).toBe('transient');
  });

  it('classifies 429 as transient', () => {
    expect(mapNetSuiteError(nsError(429, 'TOO_MANY_REQUESTS'))).toBe('transient');
  });

  it('classifies NS concurrency-governance as transient even on 400', () => {
    expect(
      mapNetSuiteError(
        nsError(400, 'BAD_REQUEST', [{ 'o:errorCode': 'WS_CONCURRENT_REQUEST_LIMIT_EXCEEDED' }]),
      ),
    ).toBe('transient');
    expect(
      mapNetSuiteError(
        nsError(400, 'BAD_REQUEST', [{ 'o:errorCode': 'USAGE_LIMIT_EXCEEDED_GOVERNANCE' }]),
      ),
    ).toBe('transient');
  });

  it('classifies INVALID_FIELD / MISSING_REQD_FIELD on 400 as data (park, do not retry)', () => {
    expect(
      mapNetSuiteError(nsError(400, 'BAD_REQUEST', [{ 'o:errorCode': 'INVALID_FIELD' }])),
    ).toBe('data');
    expect(
      mapNetSuiteError(nsError(400, 'BAD_REQUEST', [{ 'o:errorCode': 'MISSING_REQD_FIELD' }])),
    ).toBe('data');
    expect(
      mapNetSuiteError(nsError(422, 'INVALID_RECORD', [{ 'o:errorCode': 'INVALID_KEY_OR_REF' }])),
    ).toBe('data');
  });

  it('classifies bare network errors as transient', () => {
    expect(mapNetSuiteError(new Error('socket hang up'))).toBe('transient');
    expect(mapNetSuiteError(new Error('connect ETIMEDOUT 1.2.3.4:443'))).toBe('transient');
    expect(mapNetSuiteError(new Error('read ECONNRESET'))).toBe('transient');
  });

  it('classifies anything it cannot identify as unknown (handler parks)', () => {
    expect(mapNetSuiteError(nsError(400, 'BAD_REQUEST'))).toBe('unknown');
    expect(mapNetSuiteError(new Error('something weird'))).toBe('unknown');
    expect(mapNetSuiteError('not even an error')).toBe('unknown');
  });
});
