import { describe, expect, it } from 'vitest';
import { shopifyGidToNsExternalId } from '../src/index.js';

describe('shopifyGidToNsExternalId', () => {
  it('transforms a Shopify Order GID to shopify-order-<id>', () => {
    expect(shopifyGidToNsExternalId('gid://shopify/Order/12345')).toBe('shopify-order-12345');
  });

  it('transforms a Shopify Customer GID', () => {
    expect(shopifyGidToNsExternalId('gid://shopify/Customer/9947916992675')).toBe(
      'shopify-customer-9947916992675',
    );
  });

  it('lowercases the type segment', () => {
    expect(shopifyGidToNsExternalId('gid://shopify/SalesChannel/9')).toBe('shopify-saleschannel-9');
  });

  it('is deterministic (same input → same output) — idempotency invariant', () => {
    const a = shopifyGidToNsExternalId('gid://shopify/Order/7');
    const b = shopifyGidToNsExternalId('gid://shopify/Order/7');
    expect(a).toBe(b);
  });

  it('produces only URL-safe chars (the whole point of the helper)', () => {
    const out = shopifyGidToNsExternalId('gid://shopify/Order/12345');
    expect(out).toMatch(/^[a-z0-9_-]+$/);
  });

  it('preserves non-Shopify external ids that are already URL-safe', () => {
    expect(shopifyGidToNsExternalId('legacy-order-42')).toBe('legacy-order-42');
    expect(shopifyGidToNsExternalId('shop-internal_99')).toBe('shop-internal_99');
  });

  it('sanitizes non-Shopify externalIds containing unsafe chars', () => {
    expect(shopifyGidToNsExternalId('foo:bar/baz')).toBe('foo-bar-baz');
    expect(shopifyGidToNsExternalId('order#1001')).toBe('order-1001');
    expect(shopifyGidToNsExternalId('spaces in id')).toBe('spaces-in-id');
  });

  it('handles a GID that does not match the Shopify pattern by falling through to sanitization', () => {
    // Missing numeric id at the end → not a Shopify GID match → sanitize fall-through.
    expect(shopifyGidToNsExternalId('gid://other/Customer/abc')).toBe('gid---other-Customer-abc');
  });
});
