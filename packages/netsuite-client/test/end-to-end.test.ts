import { describe, expect, it } from 'vitest';
import {
  dedupKey,
  InMemoryErrorStore,
  InMemoryXrefStore,
  SharedInMemoryGovernorStore,
  type Connection,
  type DedupKeyParts,
} from '@dpi/core';
import { FakeShopifyGateway, makeFakeOrder, type ShopifyGateway } from '@dpi/shopify-client';
import { FakeNetSuiteGateway, type NetSuiteGateway, type RecordType } from '../src/index.js';

/**
 * Minimal `processOrderImport` stub — the v1 order handler in skeleton form.
 *
 * Wires together:
 *   - xref claim (idempotency)
 *   - Shopify re-fetch (never trust the webhook body)
 *   - NS externalId upsert (the only mechanism — never get-then-create)
 *   - success / failure bookkeeping
 *
 * This is *not* M1 — there's no mapping, no eligibility, no tax. It exists to
 * prove the wiring works end-to-end through the fakes, which is the M0
 * acceptance bar ("a fake end-to-end order flows in tests").
 */
async function processOrderImport(
  envelope: { connection: Connection; orderGid: string },
  deps: {
    shopify: ShopifyGateway;
    netsuite: NetSuiteGateway;
    xref: InMemoryXrefStore;
    errors: InMemoryErrorStore;
  },
): Promise<{ outcome: 'created' | 'updated' | 'duplicate' | 'parked' | 'failed' }> {
  const parts: DedupKeyParts = {
    environment: envelope.connection.environment,
    connectionId: envelope.connection.connectionId,
    entityType: 'order',
    sourceSystem: 'shopify',
    sourceId: envelope.orderGid,
  };

  // 1. Claim xref row BEFORE any NS write (brief invariant 1).
  const claim = await deps.xref.claim({
    ...parts,
    targetSystem: 'netsuite',
    targetExternal: envelope.orderGid,
  });
  if (claim.outcome === 'already_synced') return { outcome: 'duplicate' };
  if (claim.outcome === 'ignored') return { outcome: 'duplicate' };
  if (claim.outcome === 'already_claimed') return { outcome: 'duplicate' };

  // 2. Re-fetch authoritative order. NEVER trust the webhook body.
  const order = await deps.shopify.getOrder(envelope.connection, envelope.orderGid);

  // 3. Build a (deliberately minimal) NS payload. M1 replaces this with the
  //    mapping engine + tax strategy + balancing line.
  const recordType: RecordType =
    envelope.connection.orderTarget === 'cash_sale' ? 'cashSale' : 'salesOrder';
  const payload: Record<string, unknown> = {
    externalId: order.id,
    tranId: order.name,
    subsidiary: envelope.connection.nsSubsidiary,
    currency: order.currencyCode,
    // M1: real items / discounts / shipping / tax / balancing line.
  };

  // 4. Upsert via externalId. The ONLY NS write mechanism per the brief.
  try {
    const result = await deps.netsuite.upsertByExternalId({
      nsAccountId: envelope.connection.nsAccountId,
      recordType,
      externalId: order.id,
      payload,
    });
    await deps.xref.recordSuccess(parts, result.internalId, result.externalId);
    return { outcome: result.created ? 'created' : 'updated' };
  } catch (err) {
    await deps.errors.record({
      environment: parts.environment,
      connectionId: parts.connectionId,
      flow: 'order-import',
      dedupKey: dedupKey(parts),
      errorClass: 'unknown',
      message: err instanceof Error ? err.message : String(err),
      ...(err instanceof Error && err.stack !== undefined ? { stack: err.stack } : {}),
      envelope,
    });
    await deps.xref.recordFailure(parts);
    return { outcome: 'failed' };
  }
}

function fakeConnection(overrides: Partial<Connection> = {}): Connection {
  return {
    connectionId: 'acme-us',
    environment: 'dev',
    shopifyStore: 'acme-us.myshopify.com',
    shopifyAppTokenRef: 'shopify-token-acme-us',
    nsAccountId: '1234567',
    nsSubsidiary: '1',
    baseCurrency: 'USD',
    taxEngine: 'suitetax',
    orderTarget: 'sales_order',
    mapVersion: 'v1',
    enabled: true,
    ...overrides,
  };
}

describe('M0 end-to-end — fake order flows from Shopify → NS', () => {
  it('creates one NS Sales Order, claims xref, records success', async () => {
    const shopify = new FakeShopifyGateway();
    const ns = new FakeNetSuiteGateway();
    const xref = new InMemoryXrefStore();
    const errors = new InMemoryErrorStore();
    const connection = fakeConnection();

    shopify.seedOrder(makeFakeOrder({ id: 'gid://shopify/Order/100', name: '#1001' }));

    const result = await processOrderImport(
      { connection, orderGid: 'gid://shopify/Order/100' },
      { shopify, netsuite: ns, xref, errors },
    );

    expect(result.outcome).toBe('created');

    // Exactly one NS record exists.
    expect(ns.getRecords(connection.nsAccountId, 'salesOrder').size).toBe(1);

    // xref row is `synced` and points at the NS internal id.
    const row = await xref.lookup({
      environment: 'dev',
      connectionId: 'acme-us',
      entityType: 'order',
      sourceSystem: 'shopify',
      sourceId: 'gid://shopify/Order/100',
    });
    expect(row?.status).toBe('synced');
    expect(row?.targetExternal).toBe('gid://shopify/Order/100');
    expect(row?.targetId).toBeTruthy();
    expect(errors.size()).toBe(0);
  });

  it('redelivered webhook produces ZERO duplicate NS records (idempotency invariant)', async () => {
    const shopify = new FakeShopifyGateway();
    const ns = new FakeNetSuiteGateway();
    const xref = new InMemoryXrefStore();
    const errors = new InMemoryErrorStore();
    const connection = fakeConnection();

    shopify.seedOrder(makeFakeOrder({ id: 'gid://shopify/Order/100' }));

    // First delivery — should create.
    const first = await processOrderImport(
      { connection, orderGid: 'gid://shopify/Order/100' },
      { shopify, netsuite: ns, xref, errors },
    );
    // Same webhook redelivered.
    const second = await processOrderImport(
      { connection, orderGid: 'gid://shopify/Order/100' },
      { shopify, netsuite: ns, xref, errors },
    );

    expect(first.outcome).toBe('created');
    expect(second.outcome).toBe('duplicate');
    // ONE NS record across both deliveries.
    expect(ns.getRecords(connection.nsAccountId, 'salesOrder').size).toBe(1);
    // The second delivery never reached the NS gateway at all.
    expect(ns.attemptCount()).toBe(1);
  });

  it('Cash Sale target routes the upsert to recordType=cashSale (per-connection choice)', async () => {
    const shopify = new FakeShopifyGateway();
    const ns = new FakeNetSuiteGateway();
    const xref = new InMemoryXrefStore();
    const errors = new InMemoryErrorStore();
    const connection = fakeConnection({ orderTarget: 'cash_sale' });

    shopify.seedOrder(makeFakeOrder({ id: 'gid://shopify/Order/200', name: '#2001' }));

    const result = await processOrderImport(
      { connection, orderGid: 'gid://shopify/Order/200' },
      { shopify, netsuite: ns, xref, errors },
    );

    expect(result.outcome).toBe('created');
    expect(ns.getRecords(connection.nsAccountId, 'cashSale').size).toBe(1);
    expect(ns.getRecords(connection.nsAccountId, 'salesOrder').size).toBe(0);
  });

  it('two connections to two NS accounts stay isolated (multi-tenant invariant)', async () => {
    const shopify = new FakeShopifyGateway();
    const ns = new FakeNetSuiteGateway();
    const xref = new InMemoryXrefStore();
    const errors = new InMemoryErrorStore();

    shopify.seedOrder(makeFakeOrder({ id: 'gid://shopify/Order/A', name: '#A' }));
    shopify.seedOrder(makeFakeOrder({ id: 'gid://shopify/Order/B', name: '#B' }));

    const connA = fakeConnection({ connectionId: 'acme-us', nsAccountId: 'NS-111' });
    const connB = fakeConnection({ connectionId: 'beta-eu', nsAccountId: 'NS-222' });

    await processOrderImport({ connection: connA, orderGid: 'gid://shopify/Order/A' }, { shopify, netsuite: ns, xref, errors });
    await processOrderImport({ connection: connB, orderGid: 'gid://shopify/Order/B' }, { shopify, netsuite: ns, xref, errors });

    expect(ns.getRecords('NS-111', 'salesOrder').size).toBe(1);
    expect(ns.getRecords('NS-222', 'salesOrder').size).toBe(1);
  });

  it('NS upsert failure parks the xref and records an error_record (no silent retry)', async () => {
    const shopify = new FakeShopifyGateway();
    const ns = new FakeNetSuiteGateway();
    const xref = new InMemoryXrefStore();
    const errors = new InMemoryErrorStore();
    const connection = fakeConnection();
    shopify.seedOrder(makeFakeOrder({ id: 'gid://shopify/Order/300' }));

    ns.failNext(new Error('NS sandbox down'));

    const result = await processOrderImport(
      { connection, orderGid: 'gid://shopify/Order/300' },
      { shopify, netsuite: ns, xref, errors },
    );
    expect(result.outcome).toBe('failed');

    const row = await xref.lookup({
      environment: 'dev',
      connectionId: 'acme-us',
      entityType: 'order',
      sourceSystem: 'shopify',
      sourceId: 'gid://shopify/Order/300',
    });
    expect(row?.status).toBe('error');
    expect(errors.size()).toBe(1);

    // Replay (manual): retry the same envelope. xref returns already_claimed,
    // so the handler does NOT double-write. (Real M2 replay path flips the
    // existing row's status before retrying — out of M0 scope.)
    const replay = await processOrderImport(
      { connection, orderGid: 'gid://shopify/Order/300' },
      { shopify, netsuite: ns, xref, errors },
    );
    expect(replay.outcome).toBe('duplicate');
  });

  it('proves the shared governor doesn\'t need to be consulted for fakes — wiring smoke test only', () => {
    // M0 invariant: the SharedInMemoryGovernorStore is constructible and
    // composable into the deps graph alongside the fakes. Real coordination
    // is exercised in core/test/governor.test.ts and netsuite-client/test/governor-middleware.test.ts.
    const store = new SharedInMemoryGovernorStore(10);
    expect(store).toBeDefined();
  });
});
