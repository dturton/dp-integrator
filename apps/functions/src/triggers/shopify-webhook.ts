import {
  app,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from '@azure/functions';
import type {
  ConnectionsRepo,
  Environment,
  QueueProducer,
  SecretProvider,
} from '@dpi/core';
import { verifyShopifyHmac } from '@dpi/shopify-client';
import type { EnvelopeStore } from '../adapters/blob-envelope-store.js';
import { sessionKeyFor, type OrderWebhookMessage } from '../messages.js';

/**
 * Deps for the webhook handler. Production wires the Key Vault / Service Bus /
 * Blob-backed implementations; tests pass fakes via `handleShopifyWebhook` so
 * no Azure resource is required to cover the receiver's behavior.
 */
export interface WebhookDeps {
  readonly environment: Environment;
  readonly connections: ConnectionsRepo;
  readonly secrets: SecretProvider;
  readonly envelopeStore: EnvelopeStore;
  readonly orderQueue: QueueProducer<OrderWebhookMessage>;
  /** Injectable clock — defaults to `new Date()`. */
  readonly now?: () => Date;
}

export interface NormalizedRequest {
  readonly rawBody: string;
  readonly headers: Readonly<Record<string, string>>;
}

export type WebhookOutcomeStatus = 200 | 400 | 401 | 500;

export interface WebhookOutcome {
  readonly status: WebhookOutcomeStatus;
  /** Stable machine-readable reason for logs/metrics — never a free-form string. */
  readonly reason:
    | 'enqueued'
    | 'missing_shopify_headers'
    | 'unknown_or_disabled_shop'
    | 'invalid_hmac'
    | 'body_not_json'
    | 'body_missing_id'
    | 'secret_lookup_failed'
    | 'envelope_persist_failed'
    | 'enqueue_failed';
  readonly connectionId?: string;
  readonly orderGid?: string;
  readonly envelopeUri?: string;
}

/**
 * Pure webhook handler.
 *
 * Lifecycle (brief invariant 3 — verify, persist, enqueue, fast 200; never trust
 * the body for downstream mapping):
 *   1. Read Shopify headers (shop domain, hmac, topic). Missing → 401.
 *   2. Resolve connection by shop domain. Unknown/disabled → 401.
 *   3. Resolve webhook shared secret from the connection's ref. Failure → 500
 *      (misconfig; Shopify will retry until the ref is fixed).
 *   4. Verify HMAC. Mismatch → 401.
 *   5. Parse only the minimum from the body (order id → GID).
 *   6. Persist the raw envelope (blob) — never lose an HMAC-verified delivery.
 *   7. Enqueue a thin message to Service Bus with sessionId = `${connectionId}:${orderGid}`.
 *   8. 200.
 */
export async function handleShopifyWebhook(
  deps: WebhookDeps,
  req: NormalizedRequest,
): Promise<WebhookOutcome> {
  const shopDomain = req.headers['x-shopify-shop-domain'];
  const hmac = req.headers['x-shopify-hmac-sha256'];
  const topic = req.headers['x-shopify-topic'];

  if (!shopDomain || !hmac || !topic) {
    return { status: 401, reason: 'missing_shopify_headers' };
  }

  const connection = await deps.connections.findByShopDomain({
    environment: deps.environment,
    shopDomain,
  });
  if (!connection || !connection.enabled) {
    return {
      status: 401,
      reason: 'unknown_or_disabled_shop',
      ...(connection ? { connectionId: connection.connectionId } : {}),
    };
  }

  let secret: string;
  try {
    secret = await deps.secrets.getSecret(connection.shopifyWebhookSecretRef);
  } catch {
    return {
      status: 500,
      reason: 'secret_lookup_failed',
      connectionId: connection.connectionId,
    };
  }

  if (!verifyShopifyHmac({ rawBody: req.rawBody, hmac, secret })) {
    return { status: 401, reason: 'invalid_hmac', connectionId: connection.connectionId };
  }

  let orderIdRaw: unknown;
  try {
    const parsed = JSON.parse(req.rawBody) as { id?: unknown };
    orderIdRaw = parsed?.id;
  } catch {
    return { status: 400, reason: 'body_not_json', connectionId: connection.connectionId };
  }
  if (orderIdRaw === undefined || orderIdRaw === null || String(orderIdRaw).length === 0) {
    return { status: 400, reason: 'body_missing_id', connectionId: connection.connectionId };
  }
  const orderGid = `gid://shopify/Order/${String(orderIdRaw)}`;
  const receivedAt = (deps.now ?? (() => new Date()))();

  let envelopeUri: string;
  try {
    const ref = await deps.envelopeStore.put({
      environment: deps.environment,
      connectionId: connection.connectionId,
      shopDomain,
      topic,
      orderGid,
      hmac,
      headers: req.headers,
      rawBody: req.rawBody,
      receivedAt,
    });
    envelopeUri = ref.uri;
  } catch {
    return {
      status: 500,
      reason: 'envelope_persist_failed',
      connectionId: connection.connectionId,
      orderGid,
    };
  }

  const message: OrderWebhookMessage = {
    schemaVersion: 1,
    environment: deps.environment,
    connectionId: connection.connectionId,
    shopDomain,
    topic,
    orderGid,
    envelopeBlobUri: envelopeUri,
    receivedAt: receivedAt.toISOString(),
    source: 'webhook',
  };

  try {
    await deps.orderQueue.enqueue({
      sessionId: sessionKeyFor({ connectionId: connection.connectionId, orderGid }),
      body: message,
    });
  } catch {
    return {
      status: 500,
      reason: 'enqueue_failed',
      connectionId: connection.connectionId,
      orderGid,
      envelopeUri,
    };
  }

  return {
    status: 200,
    reason: 'enqueued',
    connectionId: connection.connectionId,
    orderGid,
    envelopeUri,
  };
}

/**
 * Register the v4 HTTP trigger. `getDeps` is invoked per request so the
 * bootstrap can lazy-init Azure clients and reuse them across invocations.
 */
export function registerShopifyWebhook(getDeps: () => WebhookDeps): void {
  app.http('shopifyOrderWebhook', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'webhooks/shopify/orders',
    handler: async (
      request: HttpRequest,
      context: InvocationContext,
    ): Promise<HttpResponseInit> => {
      const rawBody = await request.text();
      const headers: Record<string, string> = {};
      request.headers.forEach((value, key) => {
        headers[key.toLowerCase()] = value;
      });

      const outcome = await handleShopifyWebhook(getDeps(), { rawBody, headers });

      context.log(
        `shopifyOrderWebhook outcome=${outcome.reason} status=${outcome.status} ` +
          `connection=${outcome.connectionId ?? '-'} order=${outcome.orderGid ?? '-'}`,
      );

      return {
        status: outcome.status,
        jsonBody: { ok: outcome.status === 200, reason: outcome.reason },
      };
    },
  });
}
