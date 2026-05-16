/**
 * Mapping result discriminated union.
 *
 * Invariant 2 from the brief: "Park, don't guess." When an order carries a
 * construct the connection isn't configured to handle, the mapping engine
 * MUST return `parked` with a reason — it must NEVER fall through to a
 * default mapping. The handler turns parked results into `error_records`
 * with class `unmapped_construct` and stops.
 *
 * `unmapped_construct` is also surfaced in `@dpi/core` `ErrorClass` so the
 * error store and admin replay surface know how to treat it.
 */
export type MappingResult<T> =
  | { readonly ok: true; readonly payload: T }
  | { readonly ok: false; readonly parked: ParkReason };

export interface ParkReason {
  readonly reason: 'unmapped_construct';
  /** Short description for the operator (e.g. "gift card tender not configured"). */
  readonly detail: string;
  /** Optional hint of the offending field/path for triage. */
  readonly construct?: string;
  /** Source values that prompted the park, for the error envelope. */
  readonly evidence?: Readonly<Record<string, unknown>>;
}

export function ok<T>(payload: T): MappingResult<T> {
  return { ok: true, payload };
}

export function park<T>(parked: ParkReason): MappingResult<T> {
  return { ok: false, parked };
}
