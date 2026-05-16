import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Verify a Shopify webhook HMAC.
 *
 * Spec: `Base64(HMAC-SHA256(rawBody, sharedSecret)) === X-Shopify-Hmac-Sha256`.
 * Comparison MUST be constant-time, and any decode failure (bad base64, wrong
 * byte length) must return `false` rather than throw — a malformed webhook is
 * an invalid webhook, never an exception path.
 *
 * `rawBody` must be the byte-exact body Shopify signed. The HTTP trigger reads
 * it before any JSON parsing; do not pass a re-serialized object here.
 */
export function verifyShopifyHmac(input: {
  rawBody: string | Uint8Array;
  hmac: string;
  secret: string;
}): boolean {
  const { rawBody, hmac, secret } = input;
  if (typeof hmac !== 'string' || hmac.length === 0) return false;
  if (typeof secret !== 'string' || secret.length === 0) return false;

  const bodyBuf =
    typeof rawBody === 'string' ? Buffer.from(rawBody, 'utf8') : Buffer.from(rawBody);

  const expected = createHmac('sha256', secret).update(bodyBuf).digest();

  let provided: Buffer;
  try {
    provided = Buffer.from(hmac, 'base64');
  } catch {
    return false;
  }
  if (provided.length !== expected.length) return false;

  return timingSafeEqual(expected, provided);
}
