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
    const response = await client.records.upsert(
      args.recordType,
      'externalId',
      args.externalId,
      args.payload,
    );
    const data = response.data as { id?: string | number };
    const internalId = data.id !== undefined ? String(data.id) : '';
    return {
      internalId,
      externalId: args.externalId,
      // 201 → created; 200 → updated.
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
