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
 * Slice B adds the Postgres pool + `XrefStore` for the order handler. The
 * pool is lazy — `pg.Pool` doesn't open a TCP connection until a query runs,
 * so the receiver path stays unaffected.
 */
export interface AppContext {
  readonly environment: Environment;
  readonly connections: ConnectionsRepo;
  readonly secrets: SecretProvider;
  readonly envelopeStore: EnvelopeStore;
  readonly orderQueue: QueueProducer<OrderWebhookMessage>;
  /** Slice B+. May be undefined when Postgres isn't deployed (e.g. early Slice A envs). */
  readonly pgPool?: pg.Pool;
  readonly xrefStore?: XrefStore;
}

let cached: AppContext | undefined;

export function getAppContext(): AppContext {
  if (!cached) cached = buildAppContext();
  return cached;
}

/** Test hook — reset the cached context between tests if ever needed. */
export function resetAppContextForTests(): void {
  cached = undefined;
}

function buildAppContext(): AppContext {
  const environment = requireEnv('DPI_ENVIRONMENT');
  if (!isEnvironment(environment)) {
    throw new Error(
      `DPI_ENVIRONMENT='${environment}' invalid; expected one of dev|sandbox|prod`,
    );
  }
  const vaultUri = requireEnv('KEY_VAULT_URI');
  const serviceBusNamespace = requireEnv('SERVICE_BUS_NAMESPACE');
  const serviceBusTopic = process.env['SERVICE_BUS_TOPIC'] ?? 'orders-in';
  const blobAccountUrl = requireEnv('BLOB_ACCOUNT_URL');
  const inboundContainer = process.env['INBOUND_BLOB_CONTAINER'] ?? 'inbound-webhooks';

  const connectionsJson = requireEnv('DPI_CONNECTIONS_JSON');
  const parsed = parseConnectionsConfig(connectionsJson);

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
    secrets: new KeyVaultSecretProvider({ vaultUri }),
    envelopeStore: new BlobEnvelopeStore({
      accountUrl: blobAccountUrl,
      container: inboundContainer,
    }),
    orderQueue: new ServiceBusQueueProducer<OrderWebhookMessage>({
      fullyQualifiedNamespace: serviceBusNamespace,
      topic: serviceBusTopic,
    }),
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
