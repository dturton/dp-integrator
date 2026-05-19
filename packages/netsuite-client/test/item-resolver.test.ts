import { describe, expect, it } from 'vitest';
import { FakeNetSuiteGateway } from '../src/fake-gateway.js';
import { resolveItemReferences } from '../src/item-resolver.js';
import type { NsOrderPayload } from '../src/payload-builder.js';

const nsAccountId = 'acct-1';

function payload(itemLines: Array<Record<string, unknown>>, shipping?: Array<Record<string, unknown>>): NsOrderPayload {
  return {
    item: { items: itemLines },
    ...(shipping ? { shipping: { items: shipping } } : {}),
  } as NsOrderPayload;
}

describe('resolveItemReferences', () => {
  it('rewrites SKUs to NS internal ids when seeded', async () => {
    const ns = new FakeNetSuiteGateway();
    ns.seedItem(nsAccountId, 'WIDGET-1', '11001');
    const result = await resolveItemReferences(
      payload([{ item: { id: 'WIDGET-1' }, quantity: 2 }]),
      ns,
      nsAccountId,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.item.items[0]).toEqual({ item: { id: '11001' }, quantity: 2 });
    }
  });

  it('parks with unmapped_construct when no fallback is configured and SKU misses', async () => {
    const ns = new FakeNetSuiteGateway();
    const result = await resolveItemReferences(
      payload([{ item: { id: 'MISSING-SKU' }, quantity: 1 }]),
      ns,
      nsAccountId,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.parked.reason).toBe('unmapped_construct');
      expect(result.parked.detail).toMatch(/MISSING-SKU/);
    }
  });

  it('substitutes fallbackItemInternalId on an item-line miss instead of parking', async () => {
    const ns = new FakeNetSuiteGateway();
    ns.seedItem(nsAccountId, 'KNOWN', '11001');
    const result = await resolveItemReferences(
      payload([
        { item: { id: 'KNOWN' }, quantity: 1 },
        { item: { id: 'MISSING-SKU' }, quantity: 3 },
      ]),
      ns,
      nsAccountId,
      { fallbackItemInternalId: '6542' },
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.item.items).toEqual([
        { item: { id: '11001' }, quantity: 1 },
        { item: { id: '6542' }, quantity: 3 },
      ]);
    }
  });

  it('resolves all-digit SKUs through NS (does not treat numeric strings as internal ids)', async () => {
    // Regression: Franklin Electric MPN-style SKUs like '92980015' are all
    // digits but are NOT NS internal ids. The earlier `/^\d+$/` shortcut
    // passed them through verbatim and NS rejected with INVALID_FIELD_VALUE.
    const ns = new FakeNetSuiteGateway();
    ns.seedItem(nsAccountId, '92980015', '54321');
    const result = await resolveItemReferences(
      payload([{ item: { id: '92980015' }, quantity: 1 }]),
      ns,
      nsAccountId,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.item.items[0]).toEqual({ item: { id: '54321' }, quantity: 1 });
    }
  });

  it('passes through pre-resolved __resolved refs without NS lookup (defaultShipItemId path)', async () => {
    // Regression: `connection.defaultShipItemId` is a NS internal id, not a
    // SKU. The shipping derive stamps `{ id, __resolved: true }` so the
    // resolver should NOT call resolveItemId — it'd miss and park. The
    // marker must also be stripped before NS sees the payload.
    const ns = new FakeNetSuiteGateway();
    ns.seedItem(nsAccountId, 'WIDGET-1', '11001');
    const result = await resolveItemReferences(
      payload(
        [{ item: { id: 'WIDGET-1' }, quantity: 1 }],
        [{ item: { id: '6516', __resolved: true }, rate: 10 }],
      ),
      ns,
      nsAccountId,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.shipping?.items[0]).toEqual({ item: { id: '6516' }, rate: 10 });
    }
    // resolveItemId only ran for the line item (WIDGET-1), not the shipping ref.
    expect(ns.resolveItemAttemptCount()).toBe(1);
  });

  it('does NOT apply the item fallback to shipping lines (shipping keeps parking on miss)', async () => {
    const ns = new FakeNetSuiteGateway();
    ns.seedItem(nsAccountId, 'KNOWN', '11001');
    const result = await resolveItemReferences(
      payload(
        [{ item: { id: 'KNOWN' }, quantity: 1 }],
        [{ item: { id: 'UNREGISTERED-SHIP-METHOD' }, rate: 5 }],
      ),
      ns,
      nsAccountId,
      { fallbackItemInternalId: '6542' },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.parked.reason).toBe('unmapped_construct');
      expect(result.parked.construct).toMatch(/^shipping:/);
    }
  });
});
