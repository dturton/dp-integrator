import type { Environment } from '../env.js';
import type { EntityType, SourceSystem } from '../types.js';

export interface DedupKeyParts {
  readonly environment: Environment;
  readonly connectionId: string;
  readonly entityType: EntityType;
  readonly sourceSystem: SourceSystem;
  readonly sourceId: string;
}

/**
 * Canonical dedup key for `entity_xref`. Stable across runs and processes.
 *
 * `:` is reserved as the separator; reject components that contain it so a
 * malicious or malformed source ID can't collide with another row.
 */
export function dedupKey(parts: DedupKeyParts): string {
  const values = [
    parts.environment,
    parts.connectionId,
    parts.entityType,
    parts.sourceSystem,
    parts.sourceId,
  ];
  for (const v of values) {
    if (typeof v !== 'string' || v.length === 0) {
      throw new Error(`dedupKey: empty/non-string component: ${JSON.stringify(parts)}`);
    }
    if (v.includes('|')) {
      throw new Error(`dedupKey: component contains reserved separator '|': ${v}`);
    }
  }
  return values.join('|');
}
