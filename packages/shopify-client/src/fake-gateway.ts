import type { Connection } from '@dpi/core';
import {
  OrderNotFoundError,
  type OrderDailyAggregate,
  type OrderSummary,
  type ShopifyGateway,
} from './gateway.js';
import type { ShopifyOrder } from './order.js';

/**
 * In-memory fake — seed orders by GID, then call `getOrder` to retrieve them.
 * `verifyWebhook` honors a configurable HMAC predicate (default: always true)
 * so tests can simulate "bad signature" without needing a real secret.
 */
export class FakeShopifyGateway implements ShopifyGateway {
  private readonly orders = new Map<string, ShopifyOrder>();
  /** Tags applied per-order. Mirrors Shopify's set-add semantics. */
  private readonly tags = new Map<string, Set<string>>();
  /** Optional override — test "invalid HMAC" by returning false. */
  private verifier: (input: { rawBody: string; hmac: string; secret: string }) => boolean =
    () => true;
  /** Optional override — test tagOrder failure paths. */
  private tagOrderImpl: ((connection: Connection, orderGid: string, tags: readonly string[]) => Promise<readonly string[]>) | undefined;

  seedOrder(order: ShopifyOrder): void {
    this.orders.set(order.id, order);
  }

  setVerifier(fn: (input: { rawBody: string; hmac: string; secret: string }) => boolean): void {
    this.verifier = fn;
  }

  verifyWebhook(input: { rawBody: string; hmac: string; secret: string }): boolean {
    return this.verifier(input);
  }

  async getOrder(connection: Connection, orderGid: string): Promise<ShopifyOrder> {
    const order = this.orders.get(orderGid);
    if (!order) {
      // Mirror the http-gateway: a missing order is a typed not-found so
      // the handler parks rather than treating it as a transient failure.
      throw new OrderNotFoundError(orderGid, connection.shopifyStore);
    }
    return order;
  }

  /** Inject a custom tagOrder behavior for failure-mode tests. */
  setTagOrderImpl(
    fn: (connection: Connection, orderGid: string, tags: readonly string[]) => Promise<readonly string[]>,
  ): void {
    this.tagOrderImpl = fn;
  }

  async tagOrder(
    connection: Connection,
    orderGid: string,
    tags: readonly string[],
  ): Promise<readonly string[]> {
    if (this.tagOrderImpl) return this.tagOrderImpl(connection, orderGid, tags);
    if (!this.orders.has(orderGid)) {
      throw new OrderNotFoundError(orderGid, connection.shopifyStore);
    }
    const existing = this.tags.get(orderGid) ?? new Set<string>();
    for (const t of tags) existing.add(t);
    this.tags.set(orderGid, existing);
    return Array.from(existing).sort();
  }

  /** Test helper: read the tags currently on a seeded order. */
  getTags(orderGid: string): readonly string[] {
    return Array.from(this.tags.get(orderGid) ?? []).sort();
  }

  async listOrdersUpdatedSince(
    _connection: Connection,
    args: { since: string; limit?: number },
  ): Promise<ReadonlyArray<OrderSummary>> {
    const limit = args.limit ?? 250;
    const sinceMs = Date.parse(args.since);
    if (Number.isNaN(sinceMs)) {
      throw new Error(`FakeShopifyGateway.listOrdersUpdatedSince: 'since' not parseable: ${args.since}`);
    }
    const matching = Array.from(this.orders.values())
      .filter((o) => Date.parse(o.updatedAt) >= sinceMs)
      .sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt))
      .slice(0, limit)
      .map((o) => ({ id: o.id, updatedAt: o.updatedAt }));
    return matching;
  }

  async getDailyOrderAggregate(
    _connection: Connection,
    args: { fromInclusive: string; toExclusive: string },
  ): Promise<OrderDailyAggregate> {
    const fromMs = Date.parse(args.fromInclusive);
    const toMs = Date.parse(args.toExclusive);
    if (Number.isNaN(fromMs) || Number.isNaN(toMs)) {
      throw new Error('FakeShopifyGateway.getDailyOrderAggregate: window bounds must be ISO dates');
    }
    const matching = Array.from(this.orders.values()).filter((o) => {
      if (o.test) return false;
      const t = Date.parse(o.processedAt);
      return t >= fromMs && t < toMs;
    });
    const totals = new Map<string, number>();
    for (const o of matching) {
      const cur = o.totalPrice.currencyCode;
      const amount = Number.parseFloat(o.totalPrice.amount);
      if (!Number.isFinite(amount)) continue;
      totals.set(cur, (totals.get(cur) ?? 0) + amount);
    }
    const totalsByCurrency: Record<string, string> = {};
    for (const [cur, amt] of totals) totalsByCurrency[cur] = amt.toFixed(2);
    return { count: matching.length, totalsByCurrency };
  }
}

/**
 * Builds a minimal, valid `ShopifyOrder` for tests. Overrides merge shallowly.
 * Defaults model a standard paid product order with one line, one shipping line,
 * and one tax line — the v1 happy path.
 */
export function makeFakeOrder(overrides: Partial<ShopifyOrder> = {}): ShopifyOrder {
  const base: ShopifyOrder = {
    id: 'gid://shopify/Order/100',
    name: '#1001',
    createdAt: '2026-05-16T10:00:00Z',
    updatedAt: '2026-05-16T10:00:00Z',
    processedAt: '2026-05-16T10:00:00Z',
    currencyCode: 'USD',
    totalPrice: { amount: '120.00', currencyCode: 'USD' },
    subtotalPrice: { amount: '100.00', currencyCode: 'USD' },
    totalTax: { amount: '10.00', currencyCode: 'USD' },
    totalShippingPrice: { amount: '10.00', currencyCode: 'USD' },
    totalDiscounts: { amount: '0.00', currencyCode: 'USD' },
    financialStatus: 'paid',
    fulfillmentStatus: null,
    test: false,
    fraudHold: false,
    customer: {
      id: 'gid://shopify/Customer/42',
      email: 'buyer@example.com',
      firstName: 'Buyer',
      lastName: 'Example',
    },
    lineItems: [
      {
        id: 'gid://shopify/LineItem/1',
        title: 'Widget',
        sku: 'WIDGET-1',
        quantity: 2,
        originalUnitPrice: { amount: '50.00', currencyCode: 'USD' },
        discountedTotal: { amount: '100.00', currencyCode: 'USD' },
        discountAllocations: [],
      },
    ],
    shippingLines: [
      {
        id: 'gid://shopify/ShippingLine/1',
        title: 'Standard',
        price: { amount: '10.00', currencyCode: 'USD' },
        taxLines: [],
      },
    ],
    taxLines: [{ title: 'State Tax', rate: 0.1, price: { amount: '10.00', currencyCode: 'USD' } }],
    transactions: [
      {
        id: 'gid://shopify/Transaction/1',
        kind: 'sale',
        status: 'success',
        gateway: 'shopify_payments',
        amount: { amount: '120.00', currencyCode: 'USD' },
        processedAt: '2026-05-16T10:00:00Z',
      },
    ],
  };
  return { ...base, ...overrides };
}
