import type { Connection, SecretProvider } from '@dpi/core';
import { OrderNotFoundError, type OrderSummary, type ShopifyGateway } from './gateway.js';
import { verifyShopifyHmac } from './hmac.js';
import type {
  MoneyV2,
  ShopifyAddress,
  ShopifyCustomer,
  ShopifyFinancialStatus,
  ShopifyFulfillmentStatus,
  ShopifyLineItem,
  ShopifyOrder,
  ShopifyShippingLine,
  ShopifyTaxLine,
  ShopifyTransaction,
} from './order.js';
import { ShopifyTokenService } from './token-service.js';

/**
 * Production `ShopifyGateway` against the Admin GraphQL API.
 *
 * Authentication path (brief invariant 6 + 2026 Dev Dashboard model):
 *   1. Resolve the connection's `shopifyAppTokenRef` to a Shopify client_id
 *      and `shopifyWebhookSecretRef` to a client_secret via the `SecretProvider`.
 *   2. Exchange (client_id, client_secret) for a short-lived `shpat_` access
 *      token via `ShopifyTokenService`. Token cached per shop, refreshed 5 min
 *      before expiry.
 *   3. Use the token in `X-Shopify-Access-Token` for the GraphQL POST.
 *
 * `getOrder` runs a single GraphQL query that pulls everything the v1
 * `ShopifyOrder` model needs, in the same shape, so the mapping engine
 * downstream doesn't care whether the order came from a webhook fixture or
 * the live API.
 */

export interface ShopifyHttpGatewayConfig {
  /** SecretProvider used to resolve per-connection client_id / client_secret refs. */
  readonly secrets: SecretProvider;
  /** Optional shared token service. Defaults to a fresh one. */
  readonly tokenService?: ShopifyTokenService;
  /** Shopify Admin GraphQL API version. Default `2025-01`. */
  readonly apiVersion?: string;
  /** Optional fetch override for tests. */
  readonly fetchImpl?: typeof fetch;
}

export class ShopifyHttpGateway implements ShopifyGateway {
  private readonly secrets: SecretProvider;
  private readonly tokenService: ShopifyTokenService;
  private readonly apiVersion: string;
  private readonly fetchImpl: typeof fetch;

  constructor(config: ShopifyHttpGatewayConfig) {
    this.secrets = config.secrets;
    this.tokenService =
      config.tokenService ??
      new ShopifyTokenService(config.fetchImpl ? { fetchImpl: config.fetchImpl } : {});
    this.apiVersion = config.apiVersion ?? '2025-01';
    this.fetchImpl = config.fetchImpl ?? fetch;
  }

  verifyWebhook(input: { rawBody: string; hmac: string; secret: string }): boolean {
    return verifyShopifyHmac(input);
  }

  async getOrder(connection: Connection, orderGid: string): Promise<ShopifyOrder> {
    const accessToken = await this.resolveAccessToken(connection);
    const url = `https://${connection.shopifyStore}/admin/api/${this.apiVersion}/graphql.json`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': accessToken,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ query: ORDER_QUERY, variables: { id: orderGid } }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `ShopifyHttpGateway.getOrder: ${connection.shopifyStore} returned ${res.status}: ${text}`,
      );
    }
    const json = (await res.json()) as {
      data?: { order?: GraphQLOrder | null };
      errors?: ReadonlyArray<{ message?: string }>;
    };
    if (json.errors && json.errors.length > 0) {
      throw new Error(
        `ShopifyHttpGateway.getOrder: GraphQL errors: ${json.errors.map((e) => e.message ?? '?').join('; ')}`,
      );
    }
    if (!json.data?.order) {
      throw new OrderNotFoundError(orderGid, connection.shopifyStore);
    }
    return mapGraphQLOrder(json.data.order);
  }

  async listOrdersUpdatedSince(
    connection: Connection,
    args: { since: string; limit?: number },
  ): Promise<ReadonlyArray<OrderSummary>> {
    const limit = args.limit ?? 250;
    const accessToken = await this.resolveAccessToken(connection);
    const url = `https://${connection.shopifyStore}/admin/api/${this.apiVersion}/graphql.json`;
    // Shopify's `query` argument on the orders connection supports the
    // standard search syntax. `updated_at:>=` plus `sortKey: UPDATED_AT`
    // ascending gives us oldest-first within the window — the watermark
    // advances monotonically.
    const queryString = `updated_at:>='${args.since}'`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': accessToken,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({
        query: ORDERS_UPDATED_SINCE_QUERY,
        variables: { first: limit, query: queryString },
      }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `ShopifyHttpGateway.listOrdersUpdatedSince: ${connection.shopifyStore} returned ${res.status}: ${text}`,
      );
    }
    const json = (await res.json()) as {
      data?: { orders?: { edges?: ReadonlyArray<{ node: { id: string; updatedAt: string } }> } | null };
      errors?: ReadonlyArray<{ message?: string }>;
    };
    if (json.errors && json.errors.length > 0) {
      throw new Error(
        `ShopifyHttpGateway.listOrdersUpdatedSince: GraphQL errors: ${json.errors
          .map((e) => e.message ?? '?')
          .join('; ')}`,
      );
    }
    const edges = json.data?.orders?.edges ?? [];
    return edges.map((e) => ({ id: e.node.id, updatedAt: e.node.updatedAt }));
  }

  async tagOrder(
    connection: Connection,
    orderGid: string,
    tags: readonly string[],
  ): Promise<readonly string[]> {
    if (tags.length === 0) return [];
    const accessToken = await this.resolveAccessToken(connection);
    const url = `https://${connection.shopifyStore}/admin/api/${this.apiVersion}/graphql.json`;
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        'X-Shopify-Access-Token': accessToken,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify({ query: TAGS_ADD_MUTATION, variables: { id: orderGid, tags } }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `ShopifyHttpGateway.tagOrder: ${connection.shopifyStore} returned ${res.status}: ${text}`,
      );
    }
    const json = (await res.json()) as {
      data?: {
        tagsAdd?: {
          node?: { id?: string; tags?: ReadonlyArray<string> } | null;
          userErrors?: ReadonlyArray<{ field?: ReadonlyArray<string>; message?: string; code?: string }>;
        } | null;
      };
      errors?: ReadonlyArray<{ message?: string }>;
    };
    if (json.errors && json.errors.length > 0) {
      throw new Error(
        `ShopifyHttpGateway.tagOrder: GraphQL errors: ${json.errors.map((e) => e.message ?? '?').join('; ')}`,
      );
    }
    const userErrors = json.data?.tagsAdd?.userErrors ?? [];
    if (userErrors.length > 0) {
      // Shopify uses a NOT_FOUND code on tagsAdd when the GID can't be
      // resolved to an order — surface that as the typed error so the
      // handler's classifier routes it as a data park rather than a
      // generic retry.
      const notFound = userErrors.find((e) => e.code === 'NOT_FOUND');
      if (notFound) {
        throw new OrderNotFoundError(orderGid, connection.shopifyStore);
      }
      throw new Error(
        `ShopifyHttpGateway.tagOrder: userErrors: ${userErrors
          .map((e) => `${(e.field ?? []).join('.')}: ${e.message ?? '?'} (${e.code ?? '?'})`)
          .join('; ')}`,
      );
    }
    return json.data?.tagsAdd?.node?.tags ?? [];
  }

  private async resolveAccessToken(connection: Connection): Promise<string> {
    // shopifyAppTokenRef now holds the client_id ref (Slice C contract — see
    // ASSUMPTIONS.md on the 2026 Dev Dashboard model).
    const [clientId, clientSecret] = await Promise.all([
      this.secrets.getSecret(connection.shopifyAppTokenRef),
      this.secrets.getSecret(connection.shopifyWebhookSecretRef),
    ]);
    const token = await this.tokenService.getAccessToken({
      shopDomain: connection.shopifyStore,
      clientId,
      clientSecret,
    });
    return token.accessToken;
  }
}

// --- GraphQL queries + response shapes -------------------------------------

const ORDERS_UPDATED_SINCE_QUERY = `
  query OrdersUpdatedSince($first: Int!, $query: String!) {
    orders(first: $first, query: $query, sortKey: UPDATED_AT, reverse: false) {
      edges {
        node { id updatedAt }
      }
    }
  }
`;

const TAGS_ADD_MUTATION = `
  mutation TagsAdd($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      node { ... on Order { id tags } }
      userErrors { field message code }
    }
  }
`;


const ORDER_QUERY = `
  query Order($id: ID!) {
    order(id: $id) {
      id
      name
      createdAt
      updatedAt
      processedAt
      currencyCode
      displayFinancialStatus
      displayFulfillmentStatus
      test
      note
      tags
      totalPriceSet      { presentmentMoney { amount currencyCode } }
      subtotalPriceSet   { presentmentMoney { amount currencyCode } }
      totalTaxSet        { presentmentMoney { amount currencyCode } }
      totalShippingPriceSet { presentmentMoney { amount currencyCode } }
      totalDiscountsSet  { presentmentMoney { amount currencyCode } }
      customer {
        id
        email
        firstName
        lastName
        defaultAddress {
          firstName lastName company address1 address2 city province provinceCode country countryCode zip phone
        }
      }
      billingAddress {
        firstName lastName company address1 address2 city province provinceCode country countryCode zip phone
      }
      shippingAddress {
        firstName lastName company address1 address2 city province provinceCode country countryCode zip phone
      }
      lineItems(first: 250) {
        edges {
          node {
            id
            title
            sku
            quantity
            variant { id }
            originalUnitPriceSet { presentmentMoney { amount currencyCode } }
            discountedTotalSet   { presentmentMoney { amount currencyCode } }
            discountAllocations {
              allocatedAmountSet { presentmentMoney { amount currencyCode } }
              discountApplication { ... on DiscountCodeApplication { code } }
            }
          }
        }
      }
      shippingLines(first: 25) {
        edges {
          node {
            id
            title
            source
            carrierIdentifier
            originalPriceSet { presentmentMoney { amount currencyCode } }
            taxLines { title rate priceSet { presentmentMoney { amount currencyCode } } }
          }
        }
      }
      taxLines { title rate priceSet { presentmentMoney { amount currencyCode } } }
      transactions(first: 50) {
        id
        kind
        status
        gateway
        processedAt
        amountSet { presentmentMoney { amount currencyCode } }
      }
      physicalLocation { id }
      risk { recommendation }
    }
  }
`;

interface GraphQLMoneyBag { presentmentMoney: { amount: string; currencyCode: string }; }

interface GraphQLAddress {
  firstName?: string;
  lastName?: string;
  company?: string;
  address1?: string;
  address2?: string;
  city?: string;
  province?: string;
  provinceCode?: string;
  country?: string;
  countryCode?: string;
  zip?: string;
  phone?: string;
}

interface GraphQLOrder {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
  processedAt: string;
  currencyCode: string;
  displayFinancialStatus: string;
  displayFulfillmentStatus: string | null;
  test: boolean;
  note?: string;
  tags?: readonly string[];
  totalPriceSet: GraphQLMoneyBag;
  subtotalPriceSet: GraphQLMoneyBag;
  totalTaxSet: GraphQLMoneyBag;
  totalShippingPriceSet: GraphQLMoneyBag;
  totalDiscountsSet: GraphQLMoneyBag;
  customer: GraphQLCustomer | null;
  billingAddress?: GraphQLAddress;
  shippingAddress?: GraphQLAddress;
  lineItems: { edges: ReadonlyArray<{ node: GraphQLLineItem }> };
  shippingLines: { edges: ReadonlyArray<{ node: GraphQLShippingLine }> };
  taxLines: ReadonlyArray<GraphQLTaxLine>;
  transactions: ReadonlyArray<GraphQLTransaction>;
  physicalLocation: { id: string } | null;
  risk: { recommendation: string } | null;
}

interface GraphQLCustomer {
  id: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  defaultAddress?: GraphQLAddress | null;
}

interface GraphQLLineItem {
  id: string;
  title: string;
  sku?: string | null;
  quantity: number;
  variant?: { id: string } | null;
  originalUnitPriceSet: GraphQLMoneyBag;
  discountedTotalSet: GraphQLMoneyBag;
  discountAllocations: ReadonlyArray<{
    allocatedAmountSet: GraphQLMoneyBag;
    discountApplication?: { code?: string };
  }>;
}

interface GraphQLShippingLine {
  id: string;
  title: string;
  source?: string;
  carrierIdentifier?: string;
  originalPriceSet: GraphQLMoneyBag;
  taxLines: ReadonlyArray<GraphQLTaxLine>;
}

interface GraphQLTaxLine {
  title: string;
  rate: number;
  priceSet: GraphQLMoneyBag;
}

interface GraphQLTransaction {
  id: string;
  kind: string;
  status: string;
  gateway: string;
  processedAt: string;
  amountSet: GraphQLMoneyBag;
}

// --- mapping ---------------------------------------------------------------

function mapGraphQLOrder(o: GraphQLOrder): ShopifyOrder {
  const order: ShopifyOrder = {
    id: o.id,
    name: o.name,
    createdAt: o.createdAt,
    updatedAt: o.updatedAt,
    processedAt: o.processedAt,
    currencyCode: o.currencyCode,
    totalPrice: money(o.totalPriceSet),
    subtotalPrice: money(o.subtotalPriceSet),
    totalTax: money(o.totalTaxSet),
    totalShippingPrice: money(o.totalShippingPriceSet),
    totalDiscounts: money(o.totalDiscountsSet),
    financialStatus: mapFinancialStatus(o.displayFinancialStatus),
    fulfillmentStatus: mapFulfillmentStatus(o.displayFulfillmentStatus),
    test: o.test,
    // Risk recommendation 'INVESTIGATE' / 'CANCEL' both indicate fraud-hold-worthy
    // signal in newer API versions; treat anything other than ACCEPT/null as held.
    fraudHold: isFraudHeld(o.risk),
    customer: o.customer ? mapCustomer(o.customer) : null,
    lineItems: o.lineItems.edges.map((e) => mapLineItem(e.node)),
    shippingLines: o.shippingLines.edges.map((e) => mapShippingLine(e.node)),
    taxLines: o.taxLines.map(mapTaxLine),
    transactions: o.transactions.map(mapTransaction),
  };
  // Optional fields — only attach when actually present to keep the object shape
  // matching `makeFakeOrder` / `exactOptionalPropertyTypes`-friendly callers.
  const optional: Partial<ShopifyOrder> = {
    ...(o.billingAddress ? { billingAddress: mapAddress(o.billingAddress) } : {}),
    ...(o.shippingAddress ? { shippingAddress: mapAddress(o.shippingAddress) } : {}),
    ...(o.physicalLocation ? { locationId: o.physicalLocation.id } : {}),
    ...(o.note ? { note: o.note } : {}),
    ...(o.tags && o.tags.length > 0 ? { tags: o.tags } : {}),
  };
  return { ...order, ...optional };
}

function money(bag: GraphQLMoneyBag): MoneyV2 {
  return { amount: bag.presentmentMoney.amount, currencyCode: bag.presentmentMoney.currencyCode };
}

function mapFinancialStatus(s: string): ShopifyFinancialStatus {
  const lc = s.toLowerCase();
  switch (lc) {
    case 'pending':
    case 'authorized':
    case 'partially_paid':
    case 'paid':
    case 'partially_refunded':
    case 'refunded':
    case 'voided':
      return lc;
    default:
      // Unknown statuses default to 'pending' — eligibility predicate rejects
      // them, so we don't silently route them to NS.
      return 'pending';
  }
}

function mapFulfillmentStatus(s: string | null): ShopifyFulfillmentStatus | null {
  if (s === null) return null;
  const lc = s.toLowerCase();
  switch (lc) {
    case 'unfulfilled':
    case 'partial':
    case 'fulfilled':
    case 'restocked':
      return lc;
    default:
      return null;
  }
}

function isFraudHeld(risk: GraphQLOrder['risk']): boolean {
  if (!risk) return false;
  const rec = risk.recommendation;
  return rec !== 'ACCEPT' && rec !== null && rec !== undefined;
}

function mapAddress(a: GraphQLAddress): ShopifyAddress {
  const out: ShopifyAddress = {};
  if (a.firstName !== undefined) (out as Record<string, unknown>)['firstName'] = a.firstName;
  if (a.lastName !== undefined) (out as Record<string, unknown>)['lastName'] = a.lastName;
  if (a.company !== undefined) (out as Record<string, unknown>)['company'] = a.company;
  if (a.address1 !== undefined) (out as Record<string, unknown>)['address1'] = a.address1;
  if (a.address2 !== undefined) (out as Record<string, unknown>)['address2'] = a.address2;
  if (a.city !== undefined) (out as Record<string, unknown>)['city'] = a.city;
  if (a.province !== undefined) (out as Record<string, unknown>)['province'] = a.province;
  if (a.provinceCode !== undefined) (out as Record<string, unknown>)['provinceCode'] = a.provinceCode;
  if (a.country !== undefined) (out as Record<string, unknown>)['country'] = a.country;
  if (a.countryCode !== undefined) (out as Record<string, unknown>)['countryCode'] = a.countryCode;
  if (a.zip !== undefined) (out as Record<string, unknown>)['zip'] = a.zip;
  if (a.phone !== undefined) (out as Record<string, unknown>)['phone'] = a.phone;
  return out;
}

function mapCustomer(c: GraphQLCustomer): ShopifyCustomer {
  const out: { -readonly [K in keyof ShopifyCustomer]: ShopifyCustomer[K] } = { id: c.id };
  if (c.email !== undefined) out.email = c.email;
  if (c.firstName !== undefined) out.firstName = c.firstName;
  if (c.lastName !== undefined) out.lastName = c.lastName;
  if (c.defaultAddress) out.defaultAddress = mapAddress(c.defaultAddress);
  return out;
}

function mapLineItem(n: GraphQLLineItem): ShopifyLineItem {
  const out: { -readonly [K in keyof ShopifyLineItem]: ShopifyLineItem[K] } = {
    id: n.id,
    title: n.title,
    quantity: n.quantity,
    originalUnitPrice: money(n.originalUnitPriceSet),
    discountedTotal: money(n.discountedTotalSet),
    discountAllocations: n.discountAllocations.map((a) => {
      const da: { -readonly [K in keyof ShopifyLineItem['discountAllocations'][number]]: ShopifyLineItem['discountAllocations'][number][K] } = {
        allocatedAmount: money(a.allocatedAmountSet),
      };
      if (a.discountApplication?.code) da.discountTitle = a.discountApplication.code;
      return da;
    }),
  };
  if (n.sku !== undefined && n.sku !== null) out.sku = n.sku;
  if (n.variant?.id) out.variantId = n.variant.id;
  return out;
}

function mapShippingLine(n: GraphQLShippingLine): ShopifyShippingLine {
  const out: { -readonly [K in keyof ShopifyShippingLine]: ShopifyShippingLine[K] } = {
    id: n.id,
    title: n.title,
    price: money(n.originalPriceSet),
    taxLines: n.taxLines.map(mapTaxLine),
  };
  if (n.source !== undefined) out.source = n.source;
  if (n.carrierIdentifier !== undefined) out.carrierIdentifier = n.carrierIdentifier;
  return out;
}

function mapTaxLine(t: GraphQLTaxLine): ShopifyTaxLine {
  return { title: t.title, rate: t.rate, price: money(t.priceSet) };
}

function mapTransaction(t: GraphQLTransaction): ShopifyTransaction {
  return {
    id: t.id,
    kind: mapTransactionKind(t.kind),
    status: mapTransactionStatus(t.status),
    gateway: t.gateway,
    amount: money(t.amountSet),
    processedAt: t.processedAt,
  };
}

function mapTransactionKind(k: string): ShopifyTransaction['kind'] {
  const lc = k.toLowerCase();
  if (lc === 'sale' || lc === 'authorization' || lc === 'capture' || lc === 'refund' || lc === 'void' || lc === 'change') {
    return lc;
  }
  return 'change'; // unknown kinds bucket as 'change' for v1; surfaces in tests if it bites
}

function mapTransactionStatus(s: string): ShopifyTransaction['status'] {
  const lc = s.toLowerCase();
  if (lc === 'success' || lc === 'pending' || lc === 'failure' || lc === 'error') return lc;
  return 'error';
}
