import { describe, expect, it } from 'vitest';
import { dedupKey } from '../src/id/dedup-key.js';

describe('dedupKey', () => {
  it('produces stable canonical strings', () => {
    const k = dedupKey({
      environment: 'prod',
      connectionId: 'conn-acme',
      entityType: 'order',
      sourceSystem: 'shopify',
      sourceId: 'gid://shopify/Order/123',
    });
    expect(k).toBe('prod|conn-acme|order|shopify|gid://shopify/Order/123');
  });

  it('rejects empty components', () => {
    expect(() =>
      dedupKey({
        environment: 'prod',
        connectionId: '',
        entityType: 'order',
        sourceSystem: 'shopify',
        sourceId: 'gid://shopify/Order/1',
      }),
    ).toThrow(/empty\/non-string component/);
  });

  it("rejects components containing the reserved '|' separator", () => {
    expect(() =>
      dedupKey({
        environment: 'prod',
        connectionId: 'has|pipe',
        entityType: 'order',
        sourceSystem: 'shopify',
        sourceId: 'gid://shopify/Order/1',
      }),
    ).toThrow(/reserved separator/);
  });
});
