import { suiteql, type RecordType } from 'netsuite-sdk';
import type { NetSuiteClientFactory, NsAccountConfig } from './client-factory.js';
import type { NetSuiteGateway, UpsertResult } from './gateway.js';

/**
 * Real `NetSuiteGateway` backed by `netsuite-sdk`. Resolves the per-account
 * SDK client via the factory, then dispatches the SDK's `records.upsert` /
 * SuiteQL paths.
 *
 * The factory is the ONLY place that imports `NetSuiteClient`; everything
 * downstream sees `NetSuiteGateway`.
 *
 * Internal-id extraction: NS REST returns 204 No Content on both successful
 * create and update via the `eid:` (external-id) upsert path. The created or
 * updated record's internal id lives in the `Location` response header:
 *   Location: https://<acct>.suitetalk.api.netsuite.com/services/rest/record/v1/<recordType>/<internalId>
 * We parse the last URL segment. Some older NS API versions return 200/201
 * with `{ id }` in the body — handled as a fallback.
 *
 * `created` vs updated: NS doesn't reliably distinguish via status (both 204).
 * We set `created` from the body's HTTP status (201 only) for now; in the
 * common 204 case it'll be `false` either way. The caller should treat this
 * as a hint, not a guarantee.
 */
export class SdkNetSuiteGateway implements NetSuiteGateway {
  /**
   * `accounts` maps `nsAccountId → NsAccountConfig`. Hydrated from the
   * `connections` table in production; passed in by tests.
   */
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
    const response = (await client.records.upsert(
      args.recordType,
      'externalId',
      args.externalId,
      args.payload,
    )) as { status: number; headers?: Record<string, string>; body?: unknown };

    const internalId = extractInternalId(response);
    if (!internalId) {
      const loc = response.headers?.['location'] ?? response.headers?.['Location'] ?? '';
      throw new Error(
        `SdkNetSuiteGateway.upsertByExternalId: NS returned status=${response.status} but no internal id (Location='${loc}')`,
      );
    }
    return {
      internalId,
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

    // SuiteQL table names mirror the REST record type (lowercase).
    const sql = suiteql()
      .select(...cols)
      .from(args.recordType.toLowerCase())
      .whereEquals('externalid', args.externalId)
      .build();

    return client.suiteql.queryOne<Record<string, unknown>>(sql);
  }
}

function extractInternalId(response: {
  body?: unknown;
  headers?: Record<string, string>;
}): string | undefined {
  // Older NS / non-upsert paths put the id in the body.
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
