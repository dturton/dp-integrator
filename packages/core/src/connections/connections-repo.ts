import type { Environment } from '../env.js';
import { isEnvironment } from '../env.js';
import type { Connection, OrderTarget, TaxEngine } from '../types.js';

/**
 * Repository contract for looking up `Connection` config.
 *
 * Production wires a SQL-backed impl (reading `dbo.connections`); Slice A
 * ships an in-memory impl seeded from JSON so the webhook receiver can deploy
 * before SQL persistence + admin write-paths land.
 *
 * Multi-tenant invariant: a lookup by shop domain must be unambiguous within
 * an environment — the same store cannot map to two connections at once.
 */
export interface ConnectionsRepo {
  findByShopDomain(args: {
    environment: Environment;
    shopDomain: string;
  }): Promise<Connection | undefined>;
  findById(args: { environment: Environment; connectionId: string }): Promise<Connection | undefined>;
  listEnabled(environment: Environment): Promise<readonly Connection[]>;
}

export class InMemoryConnectionsRepo implements ConnectionsRepo {
  private readonly byShop = new Map<string, Connection>();
  private readonly byId = new Map<string, Connection>();
  private readonly all: readonly Connection[];

  constructor(seed: readonly Connection[]) {
    this.all = seed;
    for (const c of seed) {
      const shopKey = shopKeyFor(c.environment, c.shopifyStore);
      if (this.byShop.has(shopKey)) {
        throw new Error(
          `InMemoryConnectionsRepo: duplicate shop '${c.shopifyStore}' in environment '${c.environment}'`,
        );
      }
      this.byShop.set(shopKey, c);
      const idKey = idKeyFor(c.environment, c.connectionId);
      if (this.byId.has(idKey)) {
        throw new Error(
          `InMemoryConnectionsRepo: duplicate connection_id '${c.connectionId}' in environment '${c.environment}'`,
        );
      }
      this.byId.set(idKey, c);
    }
  }

  async findByShopDomain(args: {
    environment: Environment;
    shopDomain: string;
  }): Promise<Connection | undefined> {
    return this.byShop.get(shopKeyFor(args.environment, args.shopDomain));
  }

  async findById(args: {
    environment: Environment;
    connectionId: string;
  }): Promise<Connection | undefined> {
    return this.byId.get(idKeyFor(args.environment, args.connectionId));
  }

  async listEnabled(environment: Environment): Promise<readonly Connection[]> {
    return this.all.filter((c) => c.environment === environment && c.enabled);
  }
}

function shopKeyFor(env: Environment, shop: string): string {
  return `${env}|${shop.toLowerCase()}`;
}

function idKeyFor(env: Environment, id: string): string {
  return `${env}|${id}`;
}

/**
 * Parse + validate a JSON string of `Connection` objects (the shape in
 * `config/connections.example.jsonc`, minus comments). Throws on the first
 * invalid record so a misconfigured deploy fails fast at startup rather than
 * silently dropping webhooks.
 */
export function parseConnectionsConfig(raw: string): Connection[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `parseConnectionsConfig: input is not valid JSON: ${(err as Error).message}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error('parseConnectionsConfig: expected a JSON array of connections');
  }
  return parsed.map((raw, idx) => coerceConnection(raw, idx));
}

const VALID_TAX_ENGINES: readonly TaxEngine[] = ['suitetax', 'legacy'];
const VALID_ORDER_TARGETS: readonly OrderTarget[] = ['sales_order', 'cash_sale'];

function coerceConnection(value: unknown, idx: number): Connection {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`parseConnectionsConfig[${idx}]: expected object, got ${typeof value}`);
  }
  const v = value as Record<string, unknown>;

  const env = v['environment'];
  if (!isEnvironment(env)) {
    throw new Error(
      `parseConnectionsConfig[${idx}]: invalid environment '${String(env)}'`,
    );
  }

  const taxEngine = v['taxEngine'];
  if (typeof taxEngine !== 'string' || !VALID_TAX_ENGINES.includes(taxEngine as TaxEngine)) {
    throw new Error(
      `parseConnectionsConfig[${idx}]: invalid taxEngine '${String(taxEngine)}'`,
    );
  }
  const orderTarget = v['orderTarget'];
  if (
    typeof orderTarget !== 'string' ||
    !VALID_ORDER_TARGETS.includes(orderTarget as OrderTarget)
  ) {
    throw new Error(
      `parseConnectionsConfig[${idx}]: invalid orderTarget '${String(orderTarget)}'`,
    );
  }

  const required = (key: string): string => {
    const x = v[key];
    if (typeof x !== 'string' || x.length === 0) {
      throw new Error(`parseConnectionsConfig[${idx}]: missing/empty string field '${key}'`);
    }
    return x;
  };

  const enabledRaw = v['enabled'];
  const enabled = enabledRaw === undefined ? true : Boolean(enabledRaw);

  const nsLocationRaw = v['nsLocation'];
  const nsLocation =
    nsLocationRaw === undefined || nsLocationRaw === null ? undefined : String(nsLocationRaw);

  const extrasRaw = v['extraOrderHeaderMappings'];
  let extraOrderHeaderMappings: readonly unknown[] | undefined;
  if (extrasRaw !== undefined && extrasRaw !== null) {
    if (!Array.isArray(extrasRaw)) {
      throw new Error(
        `parseConnectionsConfig[${idx}]: extraOrderHeaderMappings must be an array if provided`,
      );
    }
    extraOrderHeaderMappings = extrasRaw;
  }

  const defaultShipItemIdRaw = v['defaultShipItemId'];
  const defaultShipItemId =
    defaultShipItemIdRaw === undefined || defaultShipItemIdRaw === null
      ? undefined
      : String(defaultShipItemIdRaw);

  const defaultDiscountItemIdRaw = v['defaultDiscountItemId'];
  const defaultDiscountItemId =
    defaultDiscountItemIdRaw === undefined || defaultDiscountItemIdRaw === null
      ? undefined
      : String(defaultDiscountItemIdRaw);

  const writeTagsOnImportRaw = v['writeTagsOnImport'];
  const writeTagsOnImport =
    writeTagsOnImportRaw === undefined || writeTagsOnImportRaw === null
      ? undefined
      : Boolean(writeTagsOnImportRaw);

  const shopifyAddressIdFieldRaw = v['shopifyAddressIdField'];
  const shopifyAddressIdField =
    shopifyAddressIdFieldRaw === undefined || shopifyAddressIdFieldRaw === null
      ? undefined
      : String(shopifyAddressIdFieldRaw);

  const shopifyAppTokenRefRaw = v['shopifyAppTokenRef'];
  const shopifyAppTokenRef =
    typeof shopifyAppTokenRefRaw === 'string' && shopifyAppTokenRefRaw.length > 0
      ? shopifyAppTokenRefRaw
      : undefined;
  const shopifyClientIdRefRaw = v['shopifyClientIdRef'];
  const shopifyClientIdRef =
    typeof shopifyClientIdRefRaw === 'string' && shopifyClientIdRefRaw.length > 0
      ? shopifyClientIdRefRaw
      : undefined;
  const shopifyClientSecretRefRaw = v['shopifyClientSecretRef'];
  const shopifyClientSecretRef =
    typeof shopifyClientSecretRefRaw === 'string' && shopifyClientSecretRefRaw.length > 0
      ? shopifyClientSecretRefRaw
      : undefined;

  if (!shopifyAppTokenRef && !(shopifyClientIdRef && shopifyClientSecretRef)) {
    throw new Error(
      `parseConnectionsConfig[${idx}]: expected either shopifyAppTokenRef or both shopifyClientIdRef + shopifyClientSecretRef`,
    );
  }
  if ((shopifyClientIdRef && !shopifyClientSecretRef) || (!shopifyClientIdRef && shopifyClientSecretRef)) {
    throw new Error(
      `parseConnectionsConfig[${idx}]: shopifyClientIdRef and shopifyClientSecretRef must be provided together`,
    );
  }

  const conn: Connection = {
    connectionId: required('connectionId'),
    environment: env,
    shopifyStore: required('shopifyStore'),
    ...(shopifyAppTokenRef !== undefined ? { shopifyAppTokenRef } : {}),
    ...(shopifyClientIdRef !== undefined ? { shopifyClientIdRef } : {}),
    ...(shopifyClientSecretRef !== undefined ? { shopifyClientSecretRef } : {}),
    shopifyWebhookSecretRef: required('shopifyWebhookSecretRef'),
    nsAccountId: required('nsAccountId'),
    nsSubsidiary: required('nsSubsidiary'),
    ...(nsLocation !== undefined ? { nsLocation } : {}),
    baseCurrency: required('baseCurrency'),
    taxEngine: taxEngine as TaxEngine,
    orderTarget: orderTarget as OrderTarget,
    mapVersion: required('mapVersion'),
    enabled,
    ...(extraOrderHeaderMappings !== undefined ? { extraOrderHeaderMappings } : {}),
    ...(defaultShipItemId !== undefined ? { defaultShipItemId } : {}),
    ...(defaultDiscountItemId !== undefined ? { defaultDiscountItemId } : {}),
    ...(writeTagsOnImport !== undefined ? { writeTagsOnImport } : {}),
    ...(shopifyAddressIdField !== undefined ? { shopifyAddressIdField } : {}),
  };
  return conn;
}
