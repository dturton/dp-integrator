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

  /**
   * Resolve a NetSuite `item` (inventory or shipping item) by its `itemid`
   * column (the human-readable SKU / shipping-method name). Returns the
   * NS internal id, or `null` when no item matches.
   *
   * NS REST won't accept a SKU string as `item.id` on a salesorder line —
   * the line must reference the internal id. The order-import pipeline
   * calls this for each line's SKU and each shipping line's title; misses
   * park the order (the brief's "register the missing mapping, don't
   * guess" stance).
   *
   * Implementations should cache resolutions for the process lifetime.
   * SKU → internal id is stable for the lifetime of the item record, and
   * one order frequently references the same SKU across multiple lines.
   */
  resolveItemId(args: { nsAccountId: string; sku: string }): Promise<string | null>;
}
