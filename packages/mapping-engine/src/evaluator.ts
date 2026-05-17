import type {
  ConditionalMap,
  ConstantMap,
  DeriveMap,
  DirectMap,
  LookupMap,
  Mapping,
} from './primitives.js';
import { ok, park, type MappingResult } from './result.js';

/**
 * Evaluator for connection field maps. Walks a list of `Mapping` primitives,
 * pulls source values from the input (typically a Shopify order), and writes
 * onto a fresh output object using dot-path `to` keys.
 *
 * Park semantics (brief invariant 2):
 *   - LookupMap.required (default true) + lookup miss → park as
 *     `unmapped_construct`. Caller surfaces to error_records and stops; never
 *     improvises a default.
 *   - DeriveMap referencing an unregistered fn → throws (programmer error,
 *     not data shape — should be caught in tests).
 *   - ConditionalMap with no match and no `else` → noop (legitimate "skip
 *     this field in this case" pattern).
 *
 * Path semantics:
 *   - `from` / `when.path` / `lookup.fromKey` use dot syntax to walk into the
 *     source object: `customer.defaultAddress.country`. Returns undefined for
 *     any missing intermediate.
 *   - `to` uses dot syntax to nest the assignment on the output:
 *     `items[0].sku` is NOT supported (use a DeriveMap that returns an array
 *     for line items — array structure is a domain concern, not a path
 *     concern).
 */
export interface LookupResolver {
  resolve(table: string, key: string): Promise<string | undefined>;
}

export type DeriveFn = (args: Readonly<Record<string, unknown>>, source: unknown) => unknown | Promise<unknown>;

export interface DeriveRegistry {
  get(name: string): DeriveFn | undefined;
}

export interface EvaluatorContext {
  readonly lookups: LookupResolver;
  readonly derives: DeriveRegistry;
}

export async function evaluate(
  source: unknown,
  mappings: readonly Mapping[],
  ctx: EvaluatorContext,
): Promise<MappingResult<Record<string, unknown>>> {
  const out: Record<string, unknown> = {};
  for (const m of mappings) {
    const r = await applyMapping(source, m, ctx, out);
    if (!r.ok) return r;
  }
  return ok(out);
}

async function applyMapping(
  source: unknown,
  m: Mapping,
  ctx: EvaluatorContext,
  out: Record<string, unknown>,
): Promise<MappingResult<void>> {
  switch (m.kind) {
    case 'direct':       return applyDirect(source, m, out);
    case 'constant':     return applyConstant(m, out);
    case 'lookup':       return applyLookup(source, m, ctx, out);
    case 'derive':       return applyDerive(source, m, ctx, out);
    case 'conditional':  return applyConditional(source, m, ctx, out);
  }
}

function applyDirect(source: unknown, m: DirectMap, out: Record<string, unknown>): MappingResult<void> {
  const v = getPath(source, m.from);
  setPath(out, m.to, v);
  return ok(undefined);
}

function applyConstant(m: ConstantMap, out: Record<string, unknown>): MappingResult<void> {
  setPath(out, m.to, m.value);
  return ok(undefined);
}

async function applyLookup(
  source: unknown,
  m: LookupMap,
  ctx: EvaluatorContext,
  out: Record<string, unknown>,
): Promise<MappingResult<void>> {
  const key = getPath(source, m.fromKey);
  if (key === undefined || key === null) {
    if (m.required !== false) {
      return park({
        reason: 'unmapped_construct',
        detail: `lookup '${m.table}': source key '${m.fromKey}' missing`,
        construct: m.fromKey,
      });
    }
    setPath(out, m.to, null);
    return ok(undefined);
  }
  const resolved = await ctx.lookups.resolve(m.table, String(key));
  if (resolved === undefined) {
    if (m.required !== false) {
      return park({
        reason: 'unmapped_construct',
        detail: `lookup '${m.table}' has no row for key '${String(key)}'`,
        construct: m.table,
        evidence: { [m.fromKey]: key },
      });
    }
    setPath(out, m.to, null);
    return ok(undefined);
  }
  setPath(out, m.to, resolved);
  return ok(undefined);
}

async function applyDerive(
  source: unknown,
  m: DeriveMap,
  ctx: EvaluatorContext,
  out: Record<string, unknown>,
): Promise<MappingResult<void>> {
  const fn = ctx.derives.get(m.fn);
  if (!fn) {
    throw new Error(
      `mapping evaluator: derive fn '${m.fn}' is not registered (referenced by mapping → '${m.to}')`,
    );
  }
  const value = await fn(m.args ?? {}, source);
  setPath(out, m.to, value);
  return ok(undefined);
}

async function applyConditional(
  source: unknown,
  m: ConditionalMap,
  ctx: EvaluatorContext,
  out: Record<string, unknown>,
): Promise<MappingResult<void>> {
  const actual = getPath(source, m.when.path);
  const branch = strictEqual(actual, m.when.equals) ? m.then : m.else;
  if (!branch) return ok(undefined);
  return applyMapping(source, branch, ctx, out);
}

// --- path utilities ---------------------------------------------------------

export function getPath(source: unknown, path: string): unknown {
  if (path.length === 0) return source;
  const parts = path.split('.');
  let cur: unknown = source;
  for (const part of parts) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

export function setPath(out: Record<string, unknown>, path: string, value: unknown): void {
  if (path.length === 0) {
    throw new Error('setPath: path must be non-empty');
  }
  const parts = path.split('.');
  let cur: Record<string, unknown> = out;
  for (let i = 0; i < parts.length - 1; i++) {
    const key = parts[i]!;
    const next = cur[key];
    if (next === undefined || next === null || typeof next !== 'object') {
      const fresh: Record<string, unknown> = {};
      cur[key] = fresh;
      cur = fresh;
    } else {
      cur = next as Record<string, unknown>;
    }
  }
  cur[parts[parts.length - 1]!] = value;
}

// Strict equality for ConditionalMap.when.equals comparisons — `null` matches
// `null`, NOT undefined; primitive comparisons only (objects/arrays aren't a
// supported comparand because deep equality belongs in a Derive fn).
function strictEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  // Numeric NaN === NaN false; mappings shouldn't rely on NaN equality. OK.
  return false;
}
