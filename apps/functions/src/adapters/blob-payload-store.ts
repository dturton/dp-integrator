import { DefaultAzureCredential, type TokenCredential } from '@azure/identity';
import { BlobServiceClient, type ContainerClient } from '@azure/storage-blob';
import type { PayloadStore, PayloadStoreContext } from '@dpi/core';

/**
 * Slice M2-D — archive the outbound NetSuite payload for each order-import
 * attempt. Sibling of `BlobEnvelopeStore` (inbound webhook archive) but
 * targets a distinct container (`outbound-netsuite` by default) so the two
 * lifecycles + retention policies can diverge:
 *
 *   - Inbound webhooks are HMAC-verified evidence Shopify can later request
 *     audit on. Long retention.
 *   - Outbound NS payloads are derived artifacts we built ourselves. Short
 *     retention (debug fuel, not compliance).
 *
 * The path encodes the attempt number so SB redeliveries don't clobber
 * earlier attempts' archives. Blob metadata mirrors the shape of
 * `BlobEnvelopeStore` so Storage Explorer browsing surfaces the right
 * filters.
 */
export class BlobPayloadStore implements PayloadStore {
  private readonly container: ContainerClient;

  constructor(args: {
    /** Storage account blob endpoint, e.g. `https://dpistdevxxx.blob.core.windows.net`. */
    accountUrl: string;
    /** Container name, e.g. `outbound-netsuite`. */
    container: string;
    credential?: TokenCredential;
  }) {
    const credential = args.credential ?? new DefaultAzureCredential();
    const service = new BlobServiceClient(args.accountUrl, credential);
    this.container = service.getContainerClient(args.container);
  }

  async put(payload: Record<string, unknown>, ctx: PayloadStoreContext): Promise<string> {
    const blobName = blobNameFor(ctx);
    const blockBlob = this.container.getBlockBlobClient(blobName);
    const body = Buffer.from(JSON.stringify(payload), 'utf8');
    await blockBlob.upload(body, body.length, {
      blobHTTPHeaders: { blobContentType: 'application/json' },
      metadata: {
        connection_id: ctx.connectionId,
        environment: ctx.environment,
        order_gid: ctx.shopifyOrderGid,
        delivery_count: String(ctx.deliveryCount),
        ...(ctx.nsAccountId ? { ns_account_id: ctx.nsAccountId } : {}),
        ...(ctx.nsRecordType ? { ns_record_type: ctx.nsRecordType } : {}),
        attempt_started_at: ctx.attemptStartedAt.toISOString(),
      },
    });
    return `${this.container.url}/${encodeBlobPath(blobName)}`;
  }
}

function blobNameFor(ctx: PayloadStoreContext): string {
  const id = (ctx.shopifyOrderGid.split('/').pop() ?? 'unknown').replace(/[^a-z0-9_-]/gi, '_');
  const d = ctx.attemptStartedAt;
  const yyyy = String(d.getUTCFullYear());
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const ts = d.toISOString().replace(/[:.]/g, '-');
  return `${ctx.environment}/${ctx.connectionId}/${yyyy}/${mm}/${dd}/${id}-attempt${ctx.deliveryCount}-${ts}.json`;
}

function encodeBlobPath(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}
