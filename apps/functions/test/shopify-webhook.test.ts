import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  InMemoryConnectionsRepo,
  InMemoryQueue,
  InMemorySecretProvider,
  type Connection,
} from '@dpi/core';
import {
  type BlobEnvelopeRef,
  type EnvelopeStore,
  type WebhookEnvelopePayload,
} from '../src/adapters/blob-envelope-store.js';
import { sessionKeyFor, type OrderWebhookMessage } from '../src/messages.js';
import { handleShopifyWebhook, type WebhookDeps } from '../src/triggers/shopify-webhook.js';

// --- Test fakes -------------------------------------------------------------

class FakeEnvelopeStore implements EnvelopeStore {
  readonly puts: WebhookEnvelopePayload[] = [];
  private nextErr: Error | undefined;

  failNext(err: Error): void {
    this.nextErr = err;
  }

  async put(payload: WebhookEnvelopePayload): Promise<BlobEnvelopeRef> {
    if (this.nextErr) {
      const err = this.nextErr;
      this.nextErr = undefined;
      throw err;
    }
    this.puts.push(payload);
    return {
      accountUrl: 'https://fake.blob.core.windows.net',
      container: 'inbound-webhooks',
      blobName: `fake/${payload.connectionId}/${payload.orderGid}.json`,
      uri: `https://fake.blob.core.windows.net/inbound-webhooks/fake/${payload.connectionId}/${payload.orderGid}.json`,
    };
  }
}

// --- Fixtures ---------------------------------------------------------------

const ACME_SECRET = 'shpss_acme_secret';
const BETA_SECRET = 'shpss_beta_secret';
const FIXED_NOW = new Date('2026-05-16T10:00:00Z');

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

function sign(body: string, secret: string): string {
  return createHmac('sha256', secret).update(body, 'utf8').digest('base64');
}

function buildDeps(overrides: { connections?: readonly Connection[] } = {}): {
  deps: WebhookDeps;
  envelopeStore: FakeEnvelopeStore;
  queue: InMemoryQueue<OrderWebhookMessage>;
  secrets: InMemorySecretProvider;
} {
  const envelopeStore = new FakeEnvelopeStore();
  const queue = new InMemoryQueue<OrderWebhookMessage>();
  const secrets = new InMemorySecretProvider({
    [acme.shopifyWebhookSecretRef]: ACME_SECRET,
    [beta.shopifyWebhookSecretRef]: BETA_SECRET,
  });
  const deps: WebhookDeps = {
    environment: 'dev',
    connections: new InMemoryConnectionsRepo(overrides.connections ?? [acme, beta]),
    secrets,
    envelopeStore,
    orderQueue: queue,
    now: () => FIXED_NOW,
  };
  return { deps, envelopeStore, queue, secrets };
}

function validRequest(args: {
  shop: string;
  hmac: string;
  topic?: string;
  body?: string;
}): { rawBody: string; headers: Record<string, string> } {
  return {
    rawBody: args.body ?? JSON.stringify({ id: 9876543210, financial_status: 'paid' }),
    headers: {
      'x-shopify-shop-domain': args.shop,
      'x-shopify-hmac-sha256': args.hmac,
      'x-shopify-topic': args.topic ?? 'orders/create',
      'x-shopify-webhook-id': 'wh_test_1',
      'content-type': 'application/json',
    },
  };
}

// --- Tests ------------------------------------------------------------------

describe('handleShopifyWebhook', () => {
  it('happy path: persists envelope, enqueues with session key, returns 200', async () => {
    const { deps, envelopeStore, queue } = buildDeps();
    const body = JSON.stringify({ id: 100, financial_status: 'paid' });
    const req = validRequest({ shop: acme.shopifyStore, hmac: sign(body, ACME_SECRET), body });

    const outcome = await handleShopifyWebhook(deps, req);

    expect(outcome).toMatchObject({
      status: 200,
      reason: 'enqueued',
      connectionId: acme.connectionId,
      orderGid: 'gid://shopify/Order/100',
    });
    expect(envelopeStore.puts).toHaveLength(1);
    expect(envelopeStore.puts[0]).toMatchObject({
      connectionId: acme.connectionId,
      shopDomain: acme.shopifyStore,
      topic: 'orders/create',
      orderGid: 'gid://shopify/Order/100',
      rawBody: body,
      receivedAt: FIXED_NOW,
    });

    const messages = await queue.drain();
    expect(messages).toHaveLength(1);
    const [msg] = messages;
    expect(msg?.sessionId).toBe(
      sessionKeyFor({ connectionId: acme.connectionId, orderGid: 'gid://shopify/Order/100' }),
    );
    expect(msg?.body).toEqual({
      schemaVersion: 1,
      environment: 'dev',
      connectionId: acme.connectionId,
      shopDomain: acme.shopifyStore,
      topic: 'orders/create',
      orderGid: 'gid://shopify/Order/100',
      envelopeBlobUri: outcome.envelopeUri,
      receivedAt: FIXED_NOW.toISOString(),
      source: 'webhook',
    });
  });

  it('rejects when shop domain header is missing (401)', async () => {
    const { deps } = buildDeps();
    const body = '{"id":1}';
    const outcome = await handleShopifyWebhook(deps, {
      rawBody: body,
      headers: {
        'x-shopify-hmac-sha256': sign(body, ACME_SECRET),
        'x-shopify-topic': 'orders/create',
      },
    });
    expect(outcome).toEqual({ status: 401, reason: 'missing_shopify_headers' });
  });

  it('rejects when hmac header is missing (401)', async () => {
    const { deps } = buildDeps();
    const outcome = await handleShopifyWebhook(deps, {
      rawBody: '{"id":1}',
      headers: {
        'x-shopify-shop-domain': acme.shopifyStore,
        'x-shopify-topic': 'orders/create',
      },
    });
    expect(outcome).toEqual({ status: 401, reason: 'missing_shopify_headers' });
  });

  it('rejects when topic header is missing (401)', async () => {
    const { deps } = buildDeps();
    const body = '{"id":1}';
    const outcome = await handleShopifyWebhook(deps, {
      rawBody: body,
      headers: {
        'x-shopify-shop-domain': acme.shopifyStore,
        'x-shopify-hmac-sha256': sign(body, ACME_SECRET),
      },
    });
    expect(outcome).toEqual({ status: 401, reason: 'missing_shopify_headers' });
  });

  it('rejects an unknown shop domain (401, no connectionId reported)', async () => {
    const { deps, envelopeStore, queue } = buildDeps();
    const body = '{"id":1}';
    const outcome = await handleShopifyWebhook(deps, {
      rawBody: body,
      headers: {
        'x-shopify-shop-domain': 'stranger.myshopify.com',
        'x-shopify-hmac-sha256': sign(body, ACME_SECRET),
        'x-shopify-topic': 'orders/create',
      },
    });
    expect(outcome).toEqual({ status: 401, reason: 'unknown_or_disabled_shop' });
    expect(envelopeStore.puts).toEqual([]);
    expect(await queue.drain()).toEqual([]);
  });

  it('rejects a disabled connection (401, but reports connectionId)', async () => {
    const { deps } = buildDeps({ connections: [{ ...acme, enabled: false }] });
    const body = '{"id":1}';
    const outcome = await handleShopifyWebhook(
      deps,
      validRequest({ shop: acme.shopifyStore, hmac: sign(body, ACME_SECRET), body }),
    );
    expect(outcome).toMatchObject({
      status: 401,
      reason: 'unknown_or_disabled_shop',
      connectionId: acme.connectionId,
    });
  });

  it('rejects an invalid HMAC (401)', async () => {
    const { deps, envelopeStore, queue } = buildDeps();
    const body = '{"id":1}';
    const outcome = await handleShopifyWebhook(
      deps,
      validRequest({ shop: acme.shopifyStore, hmac: sign(body, 'wrong-secret'), body }),
    );
    expect(outcome).toMatchObject({
      status: 401,
      reason: 'invalid_hmac',
      connectionId: acme.connectionId,
    });
    expect(envelopeStore.puts).toEqual([]);
    expect(await queue.drain()).toEqual([]);
  });

  it('returns 500 when secret lookup fails (misconfigured ref)', async () => {
    // Build deps but DROP the secret so getSecret throws.
    const { deps } = buildDeps();
    const brokenSecrets = new InMemorySecretProvider({});
    const outcome = await handleShopifyWebhook(
      { ...deps, secrets: brokenSecrets },
      validRequest({ shop: acme.shopifyStore, hmac: 'whatever' }),
    );
    expect(outcome).toMatchObject({
      status: 500,
      reason: 'secret_lookup_failed',
      connectionId: acme.connectionId,
    });
  });

  it('rejects a body that is not valid JSON (400) — after HMAC succeeds', async () => {
    const { deps } = buildDeps();
    const body = 'not json at all';
    const outcome = await handleShopifyWebhook(
      deps,
      validRequest({ shop: acme.shopifyStore, hmac: sign(body, ACME_SECRET), body }),
    );
    expect(outcome).toMatchObject({
      status: 400,
      reason: 'body_not_json',
      connectionId: acme.connectionId,
    });
  });

  it('rejects a body missing the order id (400)', async () => {
    const { deps } = buildDeps();
    const body = JSON.stringify({ note: 'missing id' });
    const outcome = await handleShopifyWebhook(
      deps,
      validRequest({ shop: acme.shopifyStore, hmac: sign(body, ACME_SECRET), body }),
    );
    expect(outcome).toMatchObject({
      status: 400,
      reason: 'body_missing_id',
      connectionId: acme.connectionId,
    });
  });

  it('returns 500 when envelope persistence throws (Shopify retries)', async () => {
    const { deps, envelopeStore, queue } = buildDeps();
    envelopeStore.failNext(new Error('blob unavailable'));
    const body = '{"id":42}';
    const outcome = await handleShopifyWebhook(
      deps,
      validRequest({ shop: acme.shopifyStore, hmac: sign(body, ACME_SECRET), body }),
    );
    expect(outcome).toMatchObject({
      status: 500,
      reason: 'envelope_persist_failed',
      connectionId: acme.connectionId,
      orderGid: 'gid://shopify/Order/42',
    });
    expect(await queue.drain()).toEqual([]);
  });

  it('returns 500 when queue enqueue throws (Shopify retries)', async () => {
    const { deps, envelopeStore } = buildDeps();
    const failingQueue: typeof deps.orderQueue = {
      enqueue: async () => {
        throw new Error('SB unreachable');
      },
    };
    const body = '{"id":42}';
    const outcome = await handleShopifyWebhook(
      { ...deps, orderQueue: failingQueue },
      validRequest({ shop: acme.shopifyStore, hmac: sign(body, ACME_SECRET), body }),
    );
    expect(outcome).toMatchObject({
      status: 500,
      reason: 'enqueue_failed',
      connectionId: acme.connectionId,
      orderGid: 'gid://shopify/Order/42',
    });
    expect(envelopeStore.puts).toHaveLength(1); // envelope already persisted
  });

  it('multi-tenant: each connection uses its own webhook secret (isolation)', async () => {
    const { deps, queue } = buildDeps();
    const acmeBody = JSON.stringify({ id: 1 });
    const betaBody = JSON.stringify({ id: 2 });

    // The same secret cross-signed should fail; correct secret per shop should pass.
    await expect(
      handleShopifyWebhook(
        deps,
        validRequest({ shop: beta.shopifyStore, hmac: sign(betaBody, ACME_SECRET), body: betaBody }),
      ),
    ).resolves.toMatchObject({ status: 401, reason: 'invalid_hmac', connectionId: beta.connectionId });

    await expect(
      handleShopifyWebhook(
        deps,
        validRequest({ shop: acme.shopifyStore, hmac: sign(acmeBody, ACME_SECRET), body: acmeBody }),
      ),
    ).resolves.toMatchObject({ status: 200, connectionId: acme.connectionId });

    await expect(
      handleShopifyWebhook(
        deps,
        validRequest({ shop: beta.shopifyStore, hmac: sign(betaBody, BETA_SECRET), body: betaBody }),
      ),
    ).resolves.toMatchObject({ status: 200, connectionId: beta.connectionId });

    const messages = await queue.drain();
    expect(messages.map((m) => m.body.connectionId).sort()).toEqual(['acme-us', 'beta-eu']);
  });

  it('shop domain header is case-insensitive vs the configured store', async () => {
    const { deps } = buildDeps();
    const body = '{"id":7}';
    const outcome = await handleShopifyWebhook(
      deps,
      validRequest({
        shop: 'ACME-US.MYSHOPIFY.COM',
        hmac: sign(body, ACME_SECRET),
        body,
      }),
    );
    expect(outcome).toMatchObject({ status: 200, connectionId: acme.connectionId });
  });
});
