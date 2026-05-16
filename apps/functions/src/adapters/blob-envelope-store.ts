import { DefaultAzureCredential, type TokenCredential } from '@azure/identity';
import { BlobServiceClient, type ContainerClient } from '@azure/storage-blob';
import type { Environment } from '@dpi/core';

/**
 * Brief invariant 3: the webhook receiver MUST persist the raw envelope before
 * returning 200 so an HMAC-verified delivery is never lost between receive and
 * enqueue. This adapter writes the raw body + headers as a blob; the Service
 * Bus message carries the resulting URI so the handler (and admin replay) can
 * recover the exact bytes Shopify signed.
 *
 * Storage account is the same one the Function App uses for deployment + AzureWebJobs;
 * the dedicated container is provisioned in Bicep. Auth via MI (`Storage Blob Data
 * Contributor` on the storage account).
 *
 * Blob naming embeds environment / connection / topic / date so lifecycle
 * management rules (retention, tiering) can target paths cleanly later.
 */
export interface WebhookEnvelopePayload {
  readonly environment: Environment;
  readonly connectionId: string;
  readonly shopDomain: string;
  readonly topic: string;
  readonly orderGid: string;
  readonly hmac: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly rawBody: string;
  readonly receivedAt: Date;
}

export interface BlobEnvelopeRef {
  readonly accountUrl: string;
  readonly container: string;
  readonly blobName: string;
  readonly uri: string;
}

/**
 * Contract decoupled from the Azure-backed class so the webhook handler can
 * be tested with an in-memory fake.
 */
export interface EnvelopeStore {
  put(payload: WebhookEnvelopePayload): Promise<BlobEnvelopeRef>;
}

export class BlobEnvelopeStore implements EnvelopeStore {
  private readonly container: ContainerClient;

  constructor(args: {
    /** Storage account blob endpoint, e.g. `https://dpistdevxxx.blob.core.windows.net`. */
    accountUrl: string;
    /** Container name, e.g. `inbound-webhooks`. */
    container: string;
    credential?: TokenCredential;
  }) {
    const credential = args.credential ?? new DefaultAzureCredential();
    const service = new BlobServiceClient(args.accountUrl, credential);
    this.container = service.getContainerClient(args.container);
  }

  async put(payload: WebhookEnvelopePayload): Promise<BlobEnvelopeRef> {
    const blobName = blobNameFor(payload);
    const blockBlob = this.container.getBlockBlobClient(blobName);
    const body = Buffer.from(payload.rawBody, 'utf8');
    await blockBlob.upload(body, body.length, {
      blobHTTPHeaders: { blobContentType: 'application/json' },
      metadata: {
        connection_id: payload.connectionId,
        environment: payload.environment,
        shop_domain: payload.shopDomain,
        topic: payload.topic.replace(/[^a-z0-9_-]/gi, '_'),
        order_gid: payload.orderGid,
        received_at: payload.receivedAt.toISOString(),
        hmac: payload.hmac,
      },
    });
    return {
      accountUrl: this.container.url.replace(/\/[^/]+$/, ''),
      container: this.container.containerName,
      blobName,
      uri: `${this.container.url}/${encodeBlobPath(blobName)}`,
    };
  }
}

function blobNameFor(payload: WebhookEnvelopePayload): string {
  const id = (payload.orderGid.split('/').pop() ?? 'unknown').replace(/[^a-z0-9_-]/gi, '_');
  const d = payload.receivedAt;
  const yyyy = String(d.getUTCFullYear());
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const ts = d.toISOString().replace(/[:.]/g, '-');
  // env/connection/topic/yyyy/mm/dd/orderId-ts.json — topic kept readable so
  // browsing in Storage Explorer surfaces `orders/create` vs `orders/updated`.
  return `${payload.environment}/${payload.connectionId}/${payload.topic}/${yyyy}/${mm}/${dd}/${id}-${ts}.json`;
}

function encodeBlobPath(path: string): string {
  // Preserve `/` separators but escape unsafe segment chars.
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}
