import type pg from 'pg';
import {
  InMemoryConnectionsRepo,
  isEnvironment,
  parseConnectionsConfig,
  type ConnectionsRepo,
  type Environment,
  type QueueProducer,
  type SecretProvider,
  type XrefStore,
} from '@dpi/core';
import { FakeNetSuiteGateway, type NetSuiteGateway } from '@dpi/netsuite-client';
import { ShopifyHttpGateway, type ShopifyGateway } from '@dpi/shopify-client';
import {
  BlobEnvelopeStore,
  KeyVaultSecretProvider,
  PostgresXrefStore,
  ServiceBusQueueProducer,
  buildPgPool,
  type EnvelopeStore,
} from './adapters/index.js';
import type { OrderWebhookMessage } from './messages.js';

/**
 * Production app context wired from env vars (managed by Bicep + Azure App
 * Settings). Constructed once per process; the Function host reuses it across
 * invocations.
 *
 * Slice B added Postgres + XrefStore. Slice C adds:
 *   - ShopifyHttpGateway for live Admin GraphQL fetches
 *   - NetSuiteGateway for customer match/create (currently a FakeNetSuiteGateway
 *     stub — Slice D wires SdkNetSuiteGateway with per-account TBA creds)
 *   - guestCustomerInternalId (NS internal id for guest-checkout fallback)
 */
export interface AppContext {
  readonly environment: Environment;
  readonly connections: ConnectionsRepo;
  readonly secrets: SecretProvider;
  readonly envelopeStore: EnvelopeStore;
  readonly orderQueue: QueueProducer<OrderWebhookMessage>;
  readonly shopify: ShopifyGateway;
  readonly ns: NetSuiteGateway;
  readonly guestCustomerInternalId: string;
  /** Slice B+. May be undefined when Postgres isn't deployed. */
  readonly pgPool?: pg.Pool;
  readonly xrefStore?: XrefStore;
}

let cached: AppContext | undefined;

export function getAppContext(): AppContext {
  if (!cached) cached = buildAppContext();
  return cached;
}

export function resetAppContextForTests(): void {
  cached = undefined;
}

function buildAppContext(): AppContext {
  const environment = requireEnv('DPI_ENVIRONMENT');
  if (!isEnvironment(environment)) {
    throw new Error(`DPI_ENVIRONMENT='${environment}' invalid; expected one of dev|sandbox|prod`);
  }
  const vaultUri = requireEnv('KEY_VAULT_URI');
  const serviceBusNamespace = requireEnv('SERVICE_BUS_NAMESPACE');
  const serviceBusTopic = process.env['SERVICE_BUS_TOPIC'] ?? 'orders-in';
  const blobAccountUrl = requireEnv('BLOB_ACCOUNT_URL');
  const inboundContainer = process.env['INBOUND_BLOB_CONTAINER'] ?? 'inbound-webhooks';
  const guestCustomerInternalId = process.env['GUEST_CUSTOMER_NS_ID'] ?? '1';

  const connectionsJson = requireEnv('DPI_CONNECTIONS_JSON');
  const parsed = parseConnectionsConfig(connectionsJson);

  const secrets = new KeyVaultSecretProvider({ vaultUri });
  const shopify = new ShopifyHttpGateway({ secrets });

  // Slice C ships a FakeNetSuiteGateway stub in prod so the customer-resolve
  // step has somewhere to land. The handler exercises the full upstream path
  // (re-fetch, eligibility, customer build) but customer "internal ids" are
  // synthetic + reset on cold start. Slice D replaces this with the real
  // SdkNetSuiteGateway via NetSuiteClientFactory + per-account TBA creds.
  const ns: NetSuiteGateway = new FakeNetSuiteGateway();

  // Postgres is optional at the bootstrap layer so a Slice-A-only env can boot
  // without it. The order-import handler (Slice B+) refuses to start if
  // xrefStore isn't present.
  const pgHost = process.env['POSTGRES_HOST'];
  const pgDatabase = process.env['POSTGRES_DATABASE'];
  const pgUser = process.env['POSTGRES_MI_USER'] ?? process.env['WEBSITE_SITE_NAME'];
  let pgPool: pg.Pool | undefined;
  let xrefStore: XrefStore | undefined;
  if (pgHost && pgDatabase && pgUser) {
    pgPool = buildPgPool({ host: pgHost, database: pgDatabase, user: pgUser });
    xrefStore = new PostgresXrefStore(pgPool);
  }

  return {
    environment,
    connections: new InMemoryConnectionsRepo(parsed),
    secrets,
    envelopeStore: new BlobEnvelopeStore({
      accountUrl: blobAccountUrl,
      container: inboundContainer,
    }),
    orderQueue: new ServiceBusQueueProducer<OrderWebhookMessage>({
      fullyQualifiedNamespace: serviceBusNamespace,
      topic: serviceBusTopic,
    }),
    shopify,
    ns,
    guestCustomerInternalId,
    ...(pgPool ? { pgPool } : {}),
    ...(xrefStore ? { xrefStore } : {}),
  };
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (value === undefined || value.length === 0) {
    throw new Error(`bootstrap: required env var '${key}' is not set`);
  }
  return value;
}
