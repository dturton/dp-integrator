import type pg from 'pg';
import type { LookupResolver } from '@dpi/mapping-engine';
import type { Connection } from '@dpi/core';

/**
 * Resolves mapping-engine lookups against the per-connection `lookup_*`
 * Postgres tables. Brief §5 / v2 spec §16 define the schema; each table is
 * keyed by `(environment, connection_id, <source_key>)`.
 *
 * Bound to a specific connection at construction time — the mapping
 * evaluator passes only the table + key, but every lookup must be scoped to
 * the connection's environment + id (multi-tenancy invariant). This wrapper
 * encapsulates that binding so the call sites stay terse.
 *
 * The query layout for each lookup table is fixed: the value column we want
 * is the third primary-key column's NS-side counterpart. The map below pins
 * that per table; future schema additions need to be registered here.
 *
 * In-process cache (no TTL): connection rows rarely change at runtime, and
 * the function host recycles often enough that staleness windows are short.
 * Slice E acceptance tests can disable the cache via `{ cache: false }` if
 * needed.
 */

interface TableMeta {
  /** Column used as the source key (LHS of the lookup). */
  readonly sourceKeyColumn: string;
  /** Column whose value the mapping engine wants back. */
  readonly valueColumn: string;
}

const TABLES: Readonly<Record<string, TableMeta>> = {
  lookup_payment_method: { sourceKeyColumn: 'shopify_gateway', valueColumn: 'ns_account_id' },
  lookup_ship_method:    { sourceKeyColumn: 'shopify_shipping_title', valueColumn: 'ns_ship_item_id' },
  lookup_tax:            { sourceKeyColumn: 'shopify_tax_title', valueColumn: 'ns_tax_code_id' },
  lookup_location:       { sourceKeyColumn: 'shopify_location_id', valueColumn: 'ns_location_id' },
  lookup_currency:       { sourceKeyColumn: 'currency_code', valueColumn: 'ns_currency_id' },
};

export interface PostgresLookupResolverOptions {
  readonly cache?: boolean;
}

export class PostgresLookupResolver implements LookupResolver {
  private readonly cache = new Map<string, string | undefined>();
  private readonly cacheEnabled: boolean;

  constructor(
    private readonly pool: pg.Pool,
    private readonly connection: Connection,
    options: PostgresLookupResolverOptions = {},
  ) {
    this.cacheEnabled = options.cache ?? true;
  }

  async resolve(table: string, key: string): Promise<string | undefined> {
    const meta = TABLES[table];
    if (!meta) {
      // Unknown table — the mapping config referenced a lookup we don't know how
      // to query. This is a programmer/config error, not a data shape issue.
      throw new Error(`PostgresLookupResolver: unknown lookup table '${table}'`);
    }
    const cacheKey = `${table}|${key}`;
    if (this.cacheEnabled && this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey);
    }
    const sql = `
      SELECT ${quoteIdent(meta.valueColumn)} AS v
        FROM ${quoteIdent(table)}
       WHERE environment   = $1
         AND connection_id = $2
         AND ${quoteIdent(meta.sourceKeyColumn)} = $3
       LIMIT 1
    `;
    const r = await this.pool.query<{ v: string | null }>(sql, [
      this.connection.environment,
      this.connection.connectionId,
      key,
    ]);
    const value = r.rows[0]?.v ?? undefined;
    if (this.cacheEnabled) this.cache.set(cacheKey, value ?? undefined);
    return value ?? undefined;
  }
}

function quoteIdent(s: string): string {
  if (!/^[a-z_][a-z0-9_]*$/i.test(s)) {
    throw new Error(`PostgresLookupResolver: refusing to quote suspicious identifier '${s}'`);
  }
  return `"${s}"`;
}
