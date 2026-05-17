import type { DeriveFn, DeriveRegistry, LookupResolver } from './evaluator.js';

/**
 * In-memory implementations for tests + the M0 boot path. Production wires a
 * SQL-backed `LookupResolver` (queries `lookup_*` tables for the active
 * connection) and a static derive registry seeded at startup.
 */

export class InMemoryLookupResolver implements LookupResolver {
  /** Keyed by `${table}|${key}` (lowercased table; case-sensitive key). */
  private readonly rows = new Map<string, string>();

  constructor(seed: Record<string, Record<string, string>> = {}) {
    for (const [table, entries] of Object.entries(seed)) {
      for (const [k, v] of Object.entries(entries)) {
        this.rows.set(`${table.toLowerCase()}|${k}`, v);
      }
    }
  }

  async resolve(table: string, key: string): Promise<string | undefined> {
    return this.rows.get(`${table.toLowerCase()}|${key}`);
  }

  set(table: string, key: string, value: string): void {
    this.rows.set(`${table.toLowerCase()}|${key}`, value);
  }
}

export class MapDeriveRegistry implements DeriveRegistry {
  private readonly fns = new Map<string, DeriveFn>();

  constructor(seed: Record<string, DeriveFn> = {}) {
    for (const [k, v] of Object.entries(seed)) this.fns.set(k, v);
  }

  get(name: string): DeriveFn | undefined {
    return this.fns.get(name);
  }

  register(name: string, fn: DeriveFn): void {
    this.fns.set(name, fn);
  }
}
