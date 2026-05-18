import { DefaultAzureCredential, type TokenCredential } from '@azure/identity';
import { BlobServiceClient, type ContainerClient } from '@azure/storage-blob';
import type { PayloadStore, PayloadStoreContext } from '@dpi/core';

/**
 * Maximum body size the admin-UI payload proxy will return. NS error bodies
 * are tiny; outbound Shopify orders with many lines can reach ~1 MB. Cap at
 * 5 MB to keep the function memory footprint sane.
 */
export const MAX_PAYLOAD_FETCH_BYTES = 5 * 1024 * 1024;

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
        kind: ctx.kind ?? 'outbound',
        ...(ctx.nsAccountId ? { ns_account_id: ctx.nsAccountId } : {}),
        ...(ctx.nsRecordType ? { ns_record_type: ctx.nsRecordType } : {}),
        attempt_started_at: ctx.attemptStartedAt.toISOString(),
      },
    });
    return `${this.container.url}/${encodeBlobPath(blobName)}`;
  }
}

/**
 * Read a blob by full URI using the same MI auth as the writer. Used by the
 * admin-UI payload proxy. Caller is expected to have already validated the
 * URI against an allowlist + DB cross-check; this only enforces the size
 * cap (rejects with `BlobTooLargeError` past `MAX_PAYLOAD_FETCH_BYTES`).
 */
export class BlobReader {
  private readonly service: BlobServiceClient;

  constructor(args: { accountUrl: string; credential?: TokenCredential }) {
    const credential = args.credential ?? new DefaultAzureCredential();
    this.service = new BlobServiceClient(args.accountUrl, credential);
  }

  async getJson(uri: string): Promise<{ body: string; size: number; contentType: string }> {
    const { container, blobName } = parseBlobUri(uri, this.service.url);
    const blobClient = this.service.getContainerClient(container).getBlobClient(blobName);
    const props = await blobClient.getProperties();
    const size = props.contentLength ?? 0;
    if (size > MAX_PAYLOAD_FETCH_BYTES) {
      throw new BlobTooLargeError(size);
    }
    const dl = await blobClient.download();
    const chunks: Buffer[] = [];
    let total = 0;
    const stream = dl.readableStreamBody;
    if (!stream) throw new Error('BlobReader: empty stream from download');
    for await (const chunk of stream as AsyncIterable<Buffer>) {
      total += chunk.length;
      if (total > MAX_PAYLOAD_FETCH_BYTES) {
        throw new BlobTooLargeError(total);
      }
      chunks.push(chunk);
    }
    return {
      body: Buffer.concat(chunks).toString('utf8'),
      size: total,
      contentType: props.contentType ?? 'application/json',
    };
  }

  async head(uri: string): Promise<{ size: number; contentType: string }> {
    const { container, blobName } = parseBlobUri(uri, this.service.url);
    const props = await this.service
      .getContainerClient(container)
      .getBlobClient(blobName)
      .getProperties();
    return {
      size: props.contentLength ?? 0,
      contentType: props.contentType ?? 'application/json',
    };
  }
}

export class BlobTooLargeError extends Error {
  constructor(public readonly size: number) {
    super(`Blob is ${size} bytes — exceeds ${MAX_PAYLOAD_FETCH_BYTES} byte cap`);
    this.name = 'BlobTooLargeError';
  }
}

/**
 * Split `https://acct.blob.core.windows.net/<container>/<encoded path>` into
 * `{ container, blobName }`. The blob-storage SDK accepts the URL-encoded
 * blob name as-is (it re-encodes internally), but we decode each segment so
 * traversal checks see the raw form.
 */
function parseBlobUri(uri: string, serviceUrl: string): { container: string; blobName: string } {
  const u = new URL(uri);
  const expected = new URL(serviceUrl);
  if (u.origin !== expected.origin) {
    throw new Error(`BlobReader: URI origin '${u.origin}' does not match service '${expected.origin}'`);
  }
  // pathname starts with '/' — split into [container, ...blob path segments]
  const parts = u.pathname.split('/').filter((p) => p.length > 0);
  if (parts.length < 2) {
    throw new Error(`BlobReader: URI '${uri}' missing container/blob path`);
  }
  const container = parts[0]!;
  const decodedSegments = parts.slice(1).map((segment) => decodeURIComponent(segment));
  for (const segment of decodedSegments) {
    if (segment === '..' || segment === '.' || segment.length === 0) {
      throw new Error(`BlobReader: rejected path segment '${segment}' in URI`);
    }
  }
  return { container, blobName: decodedSegments.join('/') };
}

function blobNameFor(ctx: PayloadStoreContext): string {
  const id = (ctx.shopifyOrderGid.split('/').pop() ?? 'unknown').replace(/[^a-z0-9_-]/gi, '_');
  const d = ctx.attemptStartedAt;
  const yyyy = String(d.getUTCFullYear());
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  const ts = d.toISOString().replace(/[:.]/g, '-');
  const suffix =
    ctx.kind === 'ns_response' ? '-response.json' :
    ctx.kind === 'shopify_order' ? '-shopify.json' :
    '.json';
  return `${ctx.environment}/${ctx.connectionId}/${yyyy}/${mm}/${dd}/${id}-attempt${ctx.deliveryCount}-${ts}${suffix}`;
}

function encodeBlobPath(path: string): string {
  return path
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}
