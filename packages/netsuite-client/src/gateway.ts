import type { RecordType } from 'netsuite-sdk';

/**
 * Result of an externalId-based upsert. NetSuite returns the (created or
 * updated) internal id; we surface it plus the externalId we wrote with so
 * callers can populate `entity_xref.target_id`.
 */
export interface UpsertResult {
  readonly internalId: string;
  readonly externalId: string;
  /** Whether this was an insert vs update. NS reports it implicitly via 201/200; surface so xref bookkeeping can branch. */
  readonly created: boolean;
}

export interface NetSuiteGateway {
  /**
   * Atomic create-or-update keyed on `externalId`. The brief's idempotency
   * mechanism: callers do NOT branch on get-then-create; the SDK's
   * `records.upsert(type, 'externalId', value, payload)` is the contract.
   *
   * For order import the externalId is the Shopify order GID.
   */
  upsertByExternalId(args: {
    nsAccountId: string;
    recordType: RecordType;
    externalId: string;
    payload: Record<string, unknown>;
  }): Promise<UpsertResult>;

  /**
   * Lookup a NetSuite record by externalId (single row). Used by customer
   * matching in M1 and by recovery sweeps; returns null when nothing matches.
   *
   * `fields` is an opaque list of NS field names; the gateway is responsible
   * for translating into a SuiteQL or REST query.
   */
  findByExternalId(args: {
    nsAccountId: string;
    recordType: RecordType;
    externalId: string;
    fields?: readonly string[];
  }): Promise<Record<string, unknown> | null>;
}
