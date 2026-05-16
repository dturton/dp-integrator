import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyShopifyHmac } from '../src/hmac.js';

function sign(rawBody: string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');
}

describe('verifyShopifyHmac', () => {
  const secret = 'shpss_test_secret_value';
  const body = JSON.stringify({ id: 12345, financial_status: 'paid' });

  it('accepts a valid signature over a string body', () => {
    expect(verifyShopifyHmac({ rawBody: body, hmac: sign(body, secret), secret })).toBe(true);
  });

  it('accepts a valid signature over a Uint8Array body (matches utf8 string form)', () => {
    const bytes = new TextEncoder().encode(body);
    expect(verifyShopifyHmac({ rawBody: bytes, hmac: sign(body, secret), secret })).toBe(true);
  });

  it('rejects a tampered body (single byte mutation)', () => {
    const goodSig = sign(body, secret);
    const tampered = body.replace('paid', 'pai_');
    expect(verifyShopifyHmac({ rawBody: tampered, hmac: goodSig, secret })).toBe(false);
  });

  it('rejects a signature produced with a different secret', () => {
    const sig = sign(body, 'a-different-secret');
    expect(verifyShopifyHmac({ rawBody: body, hmac: sig, secret })).toBe(false);
  });

  it('rejects a base64 string of the wrong byte length', () => {
    // 16 bytes of zeros, not 32 — SHA-256 digest is 32 bytes.
    const tooShort = Buffer.alloc(16, 0).toString('base64');
    expect(verifyShopifyHmac({ rawBody: body, hmac: tooShort, secret })).toBe(false);
  });

  it('rejects an empty hmac string', () => {
    expect(verifyShopifyHmac({ rawBody: body, hmac: '', secret })).toBe(false);
  });

  it('rejects an empty secret (treat as misconfigured connection, not a failed compare)', () => {
    expect(verifyShopifyHmac({ rawBody: body, hmac: sign(body, secret), secret: '' })).toBe(false);
  });

  it('rejects a non-base64 garbage hmac without throwing', () => {
    // Buffer.from('...', 'base64') is permissive; the length check downstream catches it.
    expect(() =>
      verifyShopifyHmac({ rawBody: body, hmac: '!!!not-base64!!!', secret }),
    ).not.toThrow();
    expect(verifyShopifyHmac({ rawBody: body, hmac: '!!!not-base64!!!', secret })).toBe(false);
  });

  it('matches an empty body when correctly signed', () => {
    expect(verifyShopifyHmac({ rawBody: '', hmac: sign('', secret), secret })).toBe(true);
  });
});
