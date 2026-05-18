import { describe, expect, it } from 'vitest';
import {
  InMemoryConnectionsRepo,
  parseConnectionsConfig,
  type Connection,
} from '../src/index.js';

const acme: Connection = {
  connectionId: 'acme-us',
  environment: 'dev',
  shopifyStore: 'acme-us.myshopify.com',
  shopifyAppTokenRef: 'shopify-token-acme-us',
  shopifyWebhookSecretRef: 'shopify-webhook-secret-acme-us',
  nsAccountId: '1234567',
  nsSubsidiary: '1',
  nsLocation: '10',
  baseCurrency: 'USD',
  taxEngine: 'suitetax',
  orderTarget: 'sales_order',
  mapVersion: 'v1',
  enabled: true,
};

const beta: Connection = {
  connectionId: 'beta-eu',
  environment: 'dev',
  shopifyStore: 'beta-eu.myshopify.com',
  shopifyAppTokenRef: 'shopify-token-beta-eu',
  shopifyWebhookSecretRef: 'shopify-webhook-secret-beta-eu',
  nsAccountId: '7654321',
  nsSubsidiary: '3',
  baseCurrency: 'EUR',
  taxEngine: 'legacy',
  orderTarget: 'cash_sale',
  mapVersion: 'v1',
  enabled: true,
};

describe('InMemoryConnectionsRepo', () => {
  it('looks up a connection by shop domain (case-insensitive)', async () => {
    const repo = new InMemoryConnectionsRepo([acme, beta]);
    await expect(
      repo.findByShopDomain({ environment: 'dev', shopDomain: 'ACME-us.myshopify.com' }),
    ).resolves.toEqual(acme);
  });

  it('returns undefined for an unknown shop', async () => {
    const repo = new InMemoryConnectionsRepo([acme]);
    await expect(
      repo.findByShopDomain({ environment: 'dev', shopDomain: 'missing.myshopify.com' }),
    ).resolves.toBeUndefined();
  });

  it('scopes lookup to environment (same shop in two envs are distinct)', async () => {
    const acmeProd: Connection = { ...acme, environment: 'prod' };
    const repo = new InMemoryConnectionsRepo([acme, acmeProd]);
    await expect(
      repo.findByShopDomain({ environment: 'prod', shopDomain: acme.shopifyStore }),
    ).resolves.toEqual(acmeProd);
    await expect(
      repo.findByShopDomain({ environment: 'sandbox', shopDomain: acme.shopifyStore }),
    ).resolves.toBeUndefined();
  });

  it('rejects duplicate shop in the same environment', () => {
    const dup: Connection = { ...acme, connectionId: 'acme-us-other' };
    expect(() => new InMemoryConnectionsRepo([acme, dup])).toThrow(/duplicate shop/);
  });

  it('rejects duplicate connection_id in the same environment', () => {
    const dup: Connection = { ...acme, shopifyStore: 'other.myshopify.com' };
    expect(() => new InMemoryConnectionsRepo([acme, dup])).toThrow(/duplicate connection_id/);
  });

  it('listEnabled filters out disabled and other envs', async () => {
    const disabled: Connection = { ...beta, connectionId: 'disabled', shopifyStore: 'd.myshopify.com', enabled: false };
    const repo = new InMemoryConnectionsRepo([acme, beta, disabled]);
    await expect(repo.listEnabled('dev')).resolves.toEqual([acme, beta]);
  });
});

describe('parseConnectionsConfig', () => {
  it('parses a valid array', () => {
    const json = JSON.stringify([acme, beta]);
    const parsed = parseConnectionsConfig(json);
    expect(parsed).toHaveLength(2);
    expect(parsed[0]).toEqual(acme);
    expect(parsed[1]).toEqual(beta);
  });

  it('omits nsLocation when not provided', () => {
    const { nsLocation: _omit, ...withoutLoc } = acme;
    const parsed = parseConnectionsConfig(JSON.stringify([withoutLoc]));
    expect(parsed[0]).not.toHaveProperty('nsLocation');
  });

  it('throws on invalid JSON', () => {
    expect(() => parseConnectionsConfig('{not json')).toThrow(/not valid JSON/);
  });

  it('throws when top-level is not an array', () => {
    expect(() => parseConnectionsConfig('{}')).toThrow(/expected a JSON array/);
  });

  it('throws on unknown taxEngine', () => {
    const bad = { ...acme, taxEngine: 'avatax' };
    expect(() => parseConnectionsConfig(JSON.stringify([bad]))).toThrow(/invalid taxEngine/);
  });

  it('throws on unknown orderTarget', () => {
    const bad = { ...acme, orderTarget: 'invoice' };
    expect(() => parseConnectionsConfig(JSON.stringify([bad]))).toThrow(/invalid orderTarget/);
  });

  it('throws on unknown environment', () => {
    const bad = { ...acme, environment: 'staging' };
    expect(() => parseConnectionsConfig(JSON.stringify([bad]))).toThrow(/invalid environment/);
  });

  it('throws on missing required string', () => {
    const bad: Record<string, unknown> = { ...acme };
    delete bad['nsAccountId'];
    expect(() => parseConnectionsConfig(JSON.stringify([bad]))).toThrow(/missing\/empty string field 'nsAccountId'/);
  });

  it('accepts client-credential refs without a direct Admin token ref', () => {
    const {
      shopifyAppTokenRef: _dropToken,
      ...rest
    } = acme;
    const parsed = parseConnectionsConfig(JSON.stringify([{
      ...rest,
      shopifyClientIdRef: 'shopify-client-id-acme-us',
      shopifyClientSecretRef: 'shopify-client-secret-acme-us',
    }]));
    expect(parsed[0]).toMatchObject({
      shopifyClientIdRef: 'shopify-client-id-acme-us',
      shopifyClientSecretRef: 'shopify-client-secret-acme-us',
    });
    expect(parsed[0]).not.toHaveProperty('shopifyAppTokenRef');
  });

  it('throws when only one client-credential ref is provided', () => {
    const bad = { ...acme, shopifyClientIdRef: 'client-id-only' };
    expect(() => parseConnectionsConfig(JSON.stringify([bad]))).toThrow(/must be provided together/);
  });

  it('defaults enabled=true when omitted', () => {
    const { enabled: _omit, ...rest } = acme;
    const parsed = parseConnectionsConfig(JSON.stringify([rest]));
    expect(parsed[0]?.enabled).toBe(true);
  });
});
