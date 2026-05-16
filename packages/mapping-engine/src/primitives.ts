/**
 * Mapping primitive types for connection field maps (v2 spec §16).
 *
 * Implementations land in M1 — M0 only ships the schema so the rest of the
 * system can already depend on the shapes (config loader, mapping types
 * in the NS payload builder, etc.).
 */

export interface DirectMap {
  readonly kind: 'direct';
  /** Source path in the Shopify order, dot-separated. */
  readonly from: string;
  readonly to: string;
}

export interface ConstantMap {
  readonly kind: 'constant';
  readonly value: string | number | boolean | null;
  readonly to: string;
}

export interface LookupMap {
  readonly kind: 'lookup';
  /** Lookup table name (e.g. `lookup_payment_method`). */
  readonly table: string;
  /** Source field key into the lookup table. */
  readonly fromKey: string;
  readonly to: string;
  /** Park as `unmapped_construct` if the lookup misses (default: true). */
  readonly required?: boolean;
}

export interface DeriveMap {
  readonly kind: 'derive';
  /** Named derivation registered by the mapping engine (resolved at runtime). */
  readonly fn: string;
  readonly args?: Readonly<Record<string, unknown>>;
  readonly to: string;
}

export interface ConditionalMap {
  readonly kind: 'conditional';
  readonly when: { readonly path: string; readonly equals: unknown };
  readonly then: Mapping;
  readonly else?: Mapping;
}

export type Mapping =
  | DirectMap
  | ConstantMap
  | LookupMap
  | DeriveMap
  | ConditionalMap;
