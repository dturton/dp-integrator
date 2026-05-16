import {
  InMemoryConnectionsRepo,
  isEnvironment,
  parseConnectionsConfig,
  type ConnectionsRepo,
  type Environment,
  type QueueProducer,
  type SecretProvider,
} from '@dpi/core';
import {
  BlobEnvelopeStore,
  KeyVaultSecretProvider,
  ServiceBusQueueProducer,
  type EnvelopeStore,
} from './adapters/index.js';
import type { OrderWebhookMessage } from './messages.js';

/**
 * Production app context wired from env vars (managed by Bicep + Azure App
 * Settings). Constructed once per process; the Function host reuses it across
 * invocations.
 *
 * Slice A only needs the receiver dependencies. Slice B will extend this with
 * `XrefStore`, `ErrorStore`, `NetSuiteClientFactory`, `ShopifyGateway`, etc.
 */
export interface AppContext {
  readonly environment: Environment;
  readonly connections: ConnectionsRepo;
  readonly secrets: SecretProvider;
  readonly envelopeStore: EnvelopeStore;
  readonly orderQueue: QueueProducer<OrderWebhookMessage>;
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
  };
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (value === undefined || value.length === 0) {
    throw new Error(`bootstrap: required env var '${key}' is not set`);
  }
  return value;
}
