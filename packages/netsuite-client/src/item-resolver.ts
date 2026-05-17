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
 * Already-numeric ids pass through unchanged — connections that pre-map
 * SKU→id via the `lookup` primitive (or via a future `lookup_item` table)
 * still work without an extra round-trip.
 *
 * On miss: parks with `unmapped_construct` carrying the SKU and the
 * sublist (item vs shipping). The brief's "register the missing mapping,
 * don't guess" stance — operators see the missing SKU on `dpi parked` and
 * either create the item in NS or correct the SKU in Shopify.
 */
export async function resolveItemReferences(
  payload: NsOrderPayload,
  ns: NetSuiteGateway,
  nsAccountId: string,
): Promise<MappingResult<NsOrderPayload>> {
  const itemLines = await resolveSublist(payload.item.items, ns, nsAccountId, 'item');
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
    const idStr = String(rawId);
    // Already a numeric NS internal id → nothing to resolve.
    if (/^\d+$/.test(idStr)) {
      resolved.push(line);
      continue;
    }
    const internalId = await ns.resolveItemId({ nsAccountId, sku: idStr });
    if (internalId === null) {
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
