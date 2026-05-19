import { park, type MappingResult } from '@dpi/mapping-engine';
import type { NetSuiteGateway } from './gateway.js';
import type { NsOrderPayload } from './payload-builder.js';

/**
 * Post-build pass that translates human-readable item identifiers
 * (Shopify SKUs / shipping titles) sitting in `payload.item.items[*].item.id`
 * and `payload.shipping?.items[*].item.id` into NS internal ids via
 * `NetSuiteGateway.resolveItemId(...)`.
 *
 * NS REST requires `item.id` on a salesorder line to be the internal id of
 * an `item` record — it rejects SKUs with a `USER_ERROR / Invalid Field
 * Value` against `item.items[N]`. The payload-builder + ref-wrap pipeline
 * emits the SKU as the placeholder id (it has no NS connection); this
 * resolver swaps each placeholder with the resolved internal id by
 * querying NS and caches the result for the gateway's process lifetime.
 *
 * Every id is sent through `resolveItemId` regardless of shape — SKUs are
 * frequently all-digit (e.g. Franklin Electric MPNs like `92980015`), so
 * "numeric means internal id" would collide with real SKUs and ship the
 * SKU to NS verbatim. The gateway's per-process cache keeps repeat
 * lookups cheap.
 *
 * Exception: producers that have a NS internal id in hand (e.g. the
 * shipping derive using `connection.defaultShipItemId`) emit a marker
 * `{ id, __resolved: true }`. The resolver strips the marker and passes
 * the line through unchanged. This avoids a doomed SuiteQL roundtrip on
 * values that were never SKUs to begin with.
 *
 * On miss: parks with `unmapped_construct` carrying the SKU and the
 * sublist (item vs shipping). The brief's "register the missing mapping,
 * don't guess" stance — operators see the missing SKU on `dpi parked` and
 * either create the item in NS or correct the SKU in Shopify.
 */
export interface ResolveItemReferencesOptions {
  /**
   * NS internal id of a generic catch-all item. When set, an item-line SKU
   * that doesn't resolve in NS falls onto this id instead of parking the
   * order. Only applied to the `item` sublist — shipping lines keep parking
   * on miss because they have their own per-connection `defaultShipItemId`
   * fed in upstream by the payload builder.
   */
  readonly fallbackItemInternalId?: string;
}

export async function resolveItemReferences(
  payload: NsOrderPayload,
  ns: NetSuiteGateway,
  nsAccountId: string,
  options: ResolveItemReferencesOptions = {},
): Promise<MappingResult<NsOrderPayload>> {
  const itemLines = await resolveSublist(
    payload.item.items,
    ns,
    nsAccountId,
    'item',
    options.fallbackItemInternalId,
  );
  if (!itemLines.ok) return itemLines;

  let shippingLines: { items: ReadonlyArray<Record<string, unknown>> } | undefined;
  if (payload.shipping) {
    const result = await resolveSublist(payload.shipping.items, ns, nsAccountId, 'shipping');
    if (!result.ok) return result;
    shippingLines = { items: result.payload };
  }

  const out: NsOrderPayload = {
    ...payload,
    item: { items: itemLines.payload },
    ...(shippingLines ? { shipping: shippingLines } : {}),
  };
  return { ok: true, payload: out };
}

async function resolveSublist(
  lines: ReadonlyArray<Record<string, unknown>>,
  ns: NetSuiteGateway,
  nsAccountId: string,
  sublistName: 'item' | 'shipping',
  fallbackInternalId?: string,
): Promise<MappingResult<ReadonlyArray<Record<string, unknown>>>> {
  const resolved: Record<string, unknown>[] = [];
  for (const [idx, line] of lines.entries()) {
    const itemRef = line['item'];
    if (!itemRef || typeof itemRef !== 'object') {
      resolved.push(line);
      continue;
    }
    const rawId = (itemRef as { id?: unknown }).id;
    if (rawId === undefined || rawId === null) {
      resolved.push(line);
      continue;
    }
    // Pre-resolved marker — value is already a NS internal id (e.g. set by
    // the shipping derive from `connection.defaultShipItemId`). Strip the
    // marker; NS expects only `id` on the ref object.
    if ((itemRef as { __resolved?: unknown }).__resolved === true) {
      resolved.push({ ...line, item: { id: String(rawId) } });
      continue;
    }
    const idStr = String(rawId);
    const internalId = await ns.resolveItemId({ nsAccountId, sku: idStr });
    if (internalId === null) {
      if (fallbackInternalId !== undefined) {
        resolved.push({ ...line, item: { id: fallbackInternalId } });
        continue;
      }
      return park({
        reason: 'unmapped_construct',
        detail: `${sublistName}[${idx}]: no NS item matches sku/title '${idStr}' — create the item in NS or correct the source`,
        construct: `${sublistName}:${idStr}`,
      });
    }
    resolved.push({ ...line, item: { id: internalId } });
  }
  return { ok: true, payload: resolved };
}
