import { describe, expect, it, vi } from 'vitest';
import { InMemorySecretProvider, type Connection } from '@dpi/core';
import {
  OrderNotFoundError,
  OrderTruncatedError,
  ShopifyHttpGateway,
  ShopifyTokenService,
} from '../src/index.js';

const connection: Connection = {
  connectionId: 'dev-store-1',
  environment: 'dev',
  shopifyStore: 'sw31sy-js.myshopify.com',
  shopifyAppTokenRef: 'shopify-admin-token-dev-store-1',
  shopifyClientIdRef: 'shopify-client-id-dev-store-1',
  shopifyClientSecretRef: 'shopify-client-secret-dev-store-1',
  shopifyWebhookSecretRef: 'shopify-webhook-secret-dev-store-1',
  nsAccountId: 'pending',
  nsSubsidiary: 'pending',
  baseCurrency: 'USD',
  taxEngine: 'suitetax',
  orderTarget: 'sales_order',
  mapVersion: 'v1',
  enabled: true,
};

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function tokenResponse(): Response {
  return jsonResponse({ access_token: 'shpat_mock', scope: 'read_orders', expires_in: 86399 });
}

function makeGqlOrderResponse(overrides: Record<string, unknown> = {}): Response {
  return jsonResponse({
    data: {
      order: {
        id: 'gid://shopify/Order/100',
        name: '#1001',
        createdAt: '2026-05-16T10:00:00Z',
        updatedAt: '2026-05-16T10:00:00Z',
        processedAt: '2026-05-16T10:00:00Z',
        currencyCode: 'USD',
        displayFinancialStatus: 'PAID',
        displayFulfillmentStatus: null,
        test: false,
        totalPriceSet:         { presentmentMoney: { amount: '120.00', currencyCode: 'USD' } },
        subtotalPriceSet:      { presentmentMoney: { amount: '100.00', currencyCode: 'USD' } },
        totalTaxSet:           { presentmentMoney: { amount: '10.00',  currencyCode: 'USD' } },
        totalShippingPriceSet: { presentmentMoney: { amount: '10.00',  currencyCode: 'USD' } },
        totalDiscountsSet:     { presentmentMoney: { amount: '0.00',   currencyCode: 'USD' } },
        customer: {
          id: 'gid://shopify/Customer/42',
          email: 'buyer@example.com',
          firstName: 'Buyer',
          lastName: 'Example',
          defaultAddress: null,
        },
        billingAddress: null,
        shippingAddress: null,
        lineItems: {
          edges: [
            {
              node: {
                id: 'gid://shopify/LineItem/1',
                title: 'Widget',
                sku: 'WIDGET-1',
                quantity: 2,
                variant: { id: 'gid://shopify/ProductVariant/9' },
                originalUnitPriceSet: { presentmentMoney: { amount: '50.00', currencyCode: 'USD' } },
                discountedTotalSet:   { presentmentMoney: { amount: '100.00', currencyCode: 'USD' } },
                discountAllocations: [],
              },
            },
          ],
          pageInfo: { hasNextPage: false },
        },
        shippingLines: {
          edges: [
            {
              node: {
                id: 'gid://shopify/ShippingLine/1',
                title: 'Standard',
                source: 'shopify',
                originalPriceSet: { presentmentMoney: { amount: '10.00', currencyCode: 'USD' } },
                taxLines: [],
              },
            },
          ],
          pageInfo: { hasNextPage: false },
        },
        taxLines: [
          { title: 'State Tax', rate: 0.1, priceSet: { presentmentMoney: { amount: '10.00', currencyCode: 'USD' } } },
        ],
        transactions: {
          nodes: [
            {
              id: 'gid://shopify/Transaction/1',
              kind: 'SALE',
              status: 'SUCCESS',
              gateway: 'shopify_payments',
              processedAt: '2026-05-16T10:00:00Z',
              amountSet: { presentmentMoney: { amount: '120.00', currencyCode: 'USD' } },
            },
          ],
          pageInfo: { hasNextPage: false },
        },
        physicalLocation: null,
        risk: { recommendation: 'ACCEPT' },
        ...overrides,
      },
    },
  });
}

describe('ShopifyHttpGateway.getOrder', () => {
  it('exchanges credentials → fetches order → maps to ShopifyOrder', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(tokenResponse())     // token exchange
      .mockResolvedValueOnce(makeGqlOrderResponse()); // GraphQL order query
    const secrets = new InMemorySecretProvider({
      'shopify-client-id-dev-store-1': 'cid_test',
      'shopify-client-secret-dev-store-1': 'shpss_test',
    });
    const gateway = new ShopifyHttpGateway({
      secrets,
      fetchImpl: fetchMock,
      tokenService: new ShopifyTokenService({ fetchImpl: fetchMock }),
    });

    const order = await gateway.getOrder(connection, 'gid://shopify/Order/100');

    expect(order.id).toBe('gid://shopify/Order/100');
    expect(order.name).toBe('#1001');
    expect(order.financialStatus).toBe('paid');
    expect(order.test).toBe(false);
    expect(order.fraudHold).toBe(false);
    expect(order.totalPrice).toEqual({ amount: '120.00', currencyCode: 'USD' });
    expect(order.lineItems).toHaveLength(1);
    expect(order.lineItems[0]).toMatchObject({
      sku: 'WIDGET-1',
      quantity: 2,
      variantId: 'gid://shopify/ProductVariant/9',
    });
    expect(order.transactions[0]?.kind).toBe('sale');
    expect(order.transactions[0]?.status).toBe('success');

    // Verify GraphQL request shape:
    const [graphqlUrl, graphqlInit] = fetchMock.mock.calls[1]!;
    expect(graphqlUrl).toBe('https://sw31sy-js.myshopify.com/admin/api/2025-01/graphql.json');
    expect((graphqlInit.headers as Record<string, string>)['X-Shopify-Access-Token']).toBe('shpat_mock');
    const body = JSON.parse(graphqlInit.body as string);
    expect(body.variables).toEqual({ id: 'gid://shopify/Order/100' });
    expect(body.query).toContain('order(id: $id)');
  });

  it('marks fraud hold when risk.recommendation is non-ACCEPT', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(makeGqlOrderResponse({ risk: { recommendation: 'INVESTIGATE' } }));
    const gateway = new ShopifyHttpGateway({
      secrets: new InMemorySecretProvider({
        'shopify-client-id-dev-store-1': 'x',
        'shopify-client-secret-dev-store-1': 'y',
      }),
      fetchImpl: fetchMock,
      tokenService: new ShopifyTokenService({ fetchImpl: fetchMock }),
    });
    const order = await gateway.getOrder(connection, 'gid://shopify/Order/100');
    expect(order.fraudHold).toBe(true);
  });

  it('throws a descriptive error on a non-2xx response', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }));
    const gateway = new ShopifyHttpGateway({
      secrets: new InMemorySecretProvider({
        'shopify-client-id-dev-store-1': 'x',
        'shopify-client-secret-dev-store-1': 'y',
      }),
      fetchImpl: fetchMock,
      tokenService: new ShopifyTokenService({ fetchImpl: fetchMock }),
    });
    await expect(gateway.getOrder(connection, 'gid://shopify/Order/100')).rejects.toThrow(/429/);
  });

  it('throws when GraphQL response carries errors', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({ errors: [{ message: 'Field deprecated' }] }));
    const gateway = new ShopifyHttpGateway({
      secrets: new InMemorySecretProvider({
        'shopify-client-id-dev-store-1': 'x',
        'shopify-client-secret-dev-store-1': 'y',
      }),
      fetchImpl: fetchMock,
      tokenService: new ShopifyTokenService({ fetchImpl: fetchMock }),
    });
    await expect(gateway.getOrder(connection, 'gid://shopify/Order/X')).rejects.toThrow(/GraphQL errors.*Field deprecated/);
  });

  it('throws OrderNotFoundError when data.order is null', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({ data: { order: null } }));
    const gateway = new ShopifyHttpGateway({
      secrets: new InMemorySecretProvider({
        'shopify-client-id-dev-store-1': 'x',
        'shopify-client-secret-dev-store-1': 'y',
      }),
      fetchImpl: fetchMock,
      tokenService: new ShopifyTokenService({ fetchImpl: fetchMock }),
    });
    await expect(gateway.getOrder(connection, 'gid://shopify/Order/missing'))
      .rejects.toThrow(OrderNotFoundError);
  });

  it('verifyWebhook delegates to the standalone HMAC verifier', () => {
    const gateway = new ShopifyHttpGateway({
      secrets: new InMemorySecretProvider({}),
      fetchImpl: vi.fn(),
    });
    expect(gateway.verifyWebhook({ rawBody: '', hmac: '', secret: '' })).toBe(false);
  });

  it('falls back to a direct Admin token when no client-credential refs are configured', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(makeGqlOrderResponse());
    const gateway = new ShopifyHttpGateway({
      secrets: new InMemorySecretProvider({
        'shopify-admin-token-dev-store-1': 'shpat_direct',
      }),
      fetchImpl: fetchMock,
    });

    const {
      shopifyClientIdRef: _dropClientId,
      shopifyClientSecretRef: _dropClientSecret,
      ...directTokenConnection
    } = connection;
    const order = await gateway.getOrder(directTokenConnection, 'gid://shopify/Order/100');

    expect(order.id).toBe('gid://shopify/Order/100');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((fetchMock.mock.calls[0]![1]!.headers as Record<string, string>)['X-Shopify-Access-Token']).toBe('shpat_direct');
  });

  it('throws OrderTruncatedError when Shopify reports more line items than the query fetched', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(makeGqlOrderResponse({
        lineItems: {
          edges: [],
          pageInfo: { hasNextPage: true },
        },
      }));
    const gateway = new ShopifyHttpGateway({
      secrets: new InMemorySecretProvider({
        'shopify-client-id-dev-store-1': 'x',
        'shopify-client-secret-dev-store-1': 'y',
      }),
      fetchImpl: fetchMock,
      tokenService: new ShopifyTokenService({ fetchImpl: fetchMock }),
    });

    await expect(gateway.getOrder(connection, 'gid://shopify/Order/100')).rejects.toThrow(OrderTruncatedError);
  });
});

describe('ShopifyHttpGateway.listOrdersUpdatedSince', () => {
  it('returns one page of summaries plus cursor metadata', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({
        data: {
          orders: {
            edges: [
              { cursor: 'cursor-1', node: { id: 'gid://shopify/Order/100', updatedAt: '2026-05-17T20:01:00Z' } },
              { cursor: 'cursor-2', node: { id: 'gid://shopify/Order/101', updatedAt: '2026-05-17T20:02:00Z' } },
            ],
            pageInfo: { hasNextPage: true, endCursor: 'cursor-2' },
          },
        },
      }));
    const gateway = new ShopifyHttpGateway({
      secrets: new InMemorySecretProvider({
        'shopify-client-id-dev-store-1': 'x',
        'shopify-client-secret-dev-store-1': 'y',
      }),
      fetchImpl: fetchMock,
      tokenService: new ShopifyTokenService({ fetchImpl: fetchMock }),
    });

    const page = await gateway.listOrdersUpdatedSince(connection, {
      since: '2026-05-17T20:00:00Z',
      limit: 2,
      after: 'cursor-0',
    });

    expect(page).toEqual({
      items: [
        { id: 'gid://shopify/Order/100', updatedAt: '2026-05-17T20:01:00Z' },
        { id: 'gid://shopify/Order/101', updatedAt: '2026-05-17T20:02:00Z' },
      ],
      hasNextPage: true,
      endCursor: 'cursor-2',
    });

    const body = JSON.parse(fetchMock.mock.calls[1]![1]!.body as string);
    expect(body.variables).toEqual({
      first: 2,
      query: "updated_at:>='2026-05-17T20:00:00Z'",
      after: 'cursor-0',
    });
  });
});

describe('ShopifyHttpGateway.tagOrder', () => {
  it('issues a tagsAdd mutation and returns the updated tags', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({
        data: {
          tagsAdd: {
            node: { id: 'gid://shopify/Order/1', tags: ['netsuite-664', 'foo'] },
            userErrors: [],
          },
        },
      }));
    const gateway = new ShopifyHttpGateway({
      secrets: new InMemorySecretProvider({
        'shopify-client-id-dev-store-1': 'x',
        'shopify-client-secret-dev-store-1': 'y',
      }),
      fetchImpl: fetchMock,
      tokenService: new ShopifyTokenService({ fetchImpl: fetchMock }),
    });
    const tags = await gateway.tagOrder(connection, 'gid://shopify/Order/1', ['netsuite-664']);
    expect(tags).toEqual(['netsuite-664', 'foo']);
    // Verify the GraphQL request used the mutation, not the order query.
    const body = JSON.parse(fetchMock.mock.calls[1]![1]!.body as string) as { query: string; variables: Record<string, unknown> };
    expect(body.query).toMatch(/mutation TagsAdd/);
    expect(body.variables).toEqual({ id: 'gid://shopify/Order/1', tags: ['netsuite-664'] });
  });

  it('throws OrderNotFoundError when tagsAdd returns NOT_FOUND userError', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({
        data: {
          tagsAdd: {
            node: null,
            userErrors: [{ field: ['id'], message: 'Order not found', code: 'NOT_FOUND' }],
          },
        },
      }));
    const gateway = new ShopifyHttpGateway({
      secrets: new InMemorySecretProvider({
        'shopify-client-id-dev-store-1': 'x',
        'shopify-client-secret-dev-store-1': 'y',
      }),
      fetchImpl: fetchMock,
      tokenService: new ShopifyTokenService({ fetchImpl: fetchMock }),
    });
    await expect(gateway.tagOrder(connection, 'gid://shopify/Order/missing', ['x']))
      .rejects.toThrow(OrderNotFoundError);
  });

  it('throws on non-NOT_FOUND userErrors with the message + code', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(tokenResponse())
      .mockResolvedValueOnce(jsonResponse({
        data: {
          tagsAdd: {
            node: null,
            userErrors: [{ field: ['tags'], message: 'invalid tag', code: 'INVALID' }],
          },
        },
      }));
    const gateway = new ShopifyHttpGateway({
      secrets: new InMemorySecretProvider({
        'shopify-client-id-dev-store-1': 'x',
        'shopify-client-secret-dev-store-1': 'y',
      }),
      fetchImpl: fetchMock,
      tokenService: new ShopifyTokenService({ fetchImpl: fetchMock }),
    });
    await expect(gateway.tagOrder(connection, 'gid://shopify/Order/1', ['bad/tag']))
      .rejects.toThrow(/INVALID/);
  });

  it('returns empty array without an API call when tags is empty', async () => {
    const fetchMock = vi.fn();
    const gateway = new ShopifyHttpGateway({
      secrets: new InMemorySecretProvider({}),
      fetchImpl: fetchMock,
    });
    const tags = await gateway.tagOrder(connection, 'gid://shopify/Order/1', []);
    expect(tags).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
