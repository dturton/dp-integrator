import { suiteql, type RecordType } from 'netsuite-sdk';
import type { NetSuiteClientFactory, NsAccountConfig } from './client-factory.js';
import { shopifyGidToNsExternalId } from './external-id.js';
import type { NetSuiteGateway, UpsertResult } from './gateway.js';

/**
 * Real `NetSuiteGateway` backed by `netsuite-sdk`.
 *
 * URL construction note: we DO NOT use `client.records.upsert(...)` because
 * the SDK at 0.1.33 builds the URL as
 *   /record/v1/<type>/eid:<externalIdField>=<value>
 * but the NS REST API expects just
 *   /record/v1/<type>/eid:<value>
 * The extra `<externalIdField>=` segment makes the URL OAuth-signature
 * mismatch NS's parsed form and NS responds with a generic
 * `401 INVALID_LOGIN`. We bypass the SDK helper and call
 * `client.transport.request` directly with the canonical URL.
 *
 * External-id translation: Shopify GIDs (`gid://shopify/Order/12345`) contain
 * `:` and `/` which NS won't accept in external IDs (URL parse failures
 * also surface as `INVALID_LOGIN`). `shopifyGidToNsExternalId()` produces a
 * URL-safe deterministic form like `shopify-order-12345`. The xref table
 * still carries the original GID, so the brief's idempotency invariant is
 * preserved: same Shopify entity → same NS externalId every call.
 *
 * Internal-id extraction: NS REST returns 204 No Content with the new/updated
 * record's URL in the `Location` header for `eid:` upserts. Older paths put
 * `{ id }` in the body — `extractInternalId()` handles both.
 *
 * `created` flag is best-effort: NS uses 204 for both create and update via
 * `eid:`, so this is `false` in the common case. Caller treats as a hint.
 */
export class SdkNetSuiteGateway implements NetSuiteGateway {
  constructor(
    private readonly factory: NetSuiteClientFactory,
    private readonly accounts: ReadonlyMap<string, NsAccountConfig>,
  ) {}

  private resolveAccount(nsAccountId: string): NsAccountConfig {
    const a = this.accounts.get(nsAccountId);
    if (!a) throw new Error(`SdkNetSuiteGateway: unknown NS account '${nsAccountId}'`);
    return a;
  }

  async upsertByExternalId(args: {
    nsAccountId: string;
    recordType: RecordType;
    externalId: string;
    payload: Record<string, unknown>;
  }): Promise<UpsertResult> {
    const account = this.resolveAccount(args.nsAccountId);
    const client = await this.factory.get(account);
    const nsExternalId = shopifyGidToNsExternalId(args.externalId);

    const normalizedAccount = args.nsAccountId.toLowerCase().replace(/_/g, '-');
    const url =
      `https://${normalizedAccount}.suitetalk.api.netsuite.com` +
      `/services/rest/record/v1/${args.recordType}/eid:${nsExternalId}`;

    const response = await transportOf(client).request(url, {
      method: 'PUT',
      body: args.payload,
    });

    const internalId = extractInternalId(response);
    if (!internalId) {
      const loc = response.headers?.['location'] ?? response.headers?.['Location'] ?? '';
      throw new Error(
        `SdkNetSuiteGateway.upsertByExternalId: NS returned status=${response.status} but no internal id (Location='${loc}')`,
      );
    }
    return {
      internalId,
      // Original GID kept on the caller-facing result so xref bookkeeping
      // stays unchanged (recordSuccess wires xref.target_external to this).
      externalId: args.externalId,
      created: response.status === 201,
    };
  }

  async findByExternalId(args: {
    nsAccountId: string;
    recordType: RecordType;
    externalId: string;
    fields?: readonly string[];
  }): Promise<Record<string, unknown> | null> {
    const account = this.resolveAccount(args.nsAccountId);
    const client = await this.factory.get(account);
    const cols = args.fields?.length ? args.fields : (['id', 'externalid'] as const);
    // SuiteQL queries the stored value, which is the URL-safe transformed
    // form (because every write goes through shopifyGidToNsExternalId above).
    const nsExternalId = shopifyGidToNsExternalId(args.externalId);

    const sql = suiteql()
      .select(...cols)
      .from(args.recordType.toLowerCase())
      .whereEquals('externalid', nsExternalId)
      .build();

    return client.suiteql.queryOne<Record<string, unknown>>(sql);
  }
}

interface SdkTransport {
  request(
    url: string,
    options: { method: string; body?: unknown },
  ): Promise<{ status: number; headers?: Record<string, string>; body?: unknown }>;
}

function transportOf(client: unknown): SdkTransport {
  const t = (client as { transport?: SdkTransport }).transport;
  if (!t || typeof t.request !== 'function') {
    throw new Error('SdkNetSuiteGateway: NetSuiteClient.transport is missing the request method');
  }
  return t;
}

function extractInternalId(response: {
  body?: unknown;
  headers?: Record<string, string>;
}): string | undefined {
  if (response.body && typeof response.body === 'object') {
    const id = (response.body as { id?: string | number }).id;
    if (id !== undefined && id !== null) return String(id);
  }
  const location = response.headers?.['location'] ?? response.headers?.['Location'];
  if (typeof location === 'string' && location.length > 0) {
    const last = location.split('/').pop();
    if (last && last.length > 0) return last;
  }
  return undefined;
}
