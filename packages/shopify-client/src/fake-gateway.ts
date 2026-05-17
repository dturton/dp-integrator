import type { Connection } from '@dpi/core';
import { OrderNotFoundError, type ShopifyGateway } from './gateway.js';
import type { ShopifyOrder } from './order.js';

/**
 * In-memory fake — seed orders by GID, then call `getOrder` to retrieve them.
 * `verifyWebhook` honors a configurable HMAC predicate (default: always true)
 * so tests can simulate "bad signature" without needing a real secret.
 */
export class FakeShopifyGateway implements ShopifyGateway {
  private readonly orders = new Map<string, ShopifyOrder>();
  /** Optional override — test "invalid HMAC" by returning false. */
  private verifier: (input: { rawBody: string; hmac: string; secret: string }) => boolean =
    () => true;

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
