import type pg from 'pg';
import {
  InMemoryConnectionsRepo,
  SharedInMemoryGovernorStore,
  isEnvironment,
  parseConnectionsConfig,
  type Connection,
  type ConnectionsRepo,
  type Environment,
  type ErrorStore,
  type GovernorConfig,
  type OrderAttemptStore,
  type OrderSyncLogStore,
  type PayloadStore,
  type QueueProducer,
  type ReconciliationStore,
  type SecretProvider,
  type SyncWatermarkStore,
  type XrefStore,
} from '@dpi/core';
import {
  FakeNetSuiteGateway,
  NetSuiteClientFactory,
  SdkNetSuiteGateway,
  type NetSuiteGateway,
  type NsAccountConfig,
} from '@dpi/netsuite-client';
import { ShopifyHttpGateway, type ShopifyGateway } from '@dpi/shopify-client';
import {
  BlobEnvelopeStore,
  BlobPayloadStore,
  BlobReader,
  KeyVaultSecretProvider,
  PostgresErrorStore,
  PostgresOrderAttemptStore,
  PostgresOrderSyncLogStore,
  PostgresReconciliationStore,
  PostgresSyncWatermarkStore,
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
  /** Slice M2-B. Same lifecycle as xrefStore — both rely on pgPool. */
  readonly errorStore?: ErrorStore;
  /** Slice M3-A — catch-up poller cursor per (connection, flow). */
  readonly watermarkStore?: SyncWatermarkStore;
  /** Per-order ledger; powers `dpi recent` + reconciliation. */
  readonly orderSyncLog?: OrderSyncLogStore;
  /** Slice M2-D — per-delivery attempt ledger; powers `dpi attempts` + future UI timeline. */
  readonly orderAttemptStore?: OrderAttemptStore;
  /** Slice M2-D — outbound NS payload archive. Independent of pgPool. */
  readonly outboundPayloadStore?: PayloadStore;
  /** Slice M3-B — daily reconciliation snapshots. */
  readonly reconciliationStore?: ReconciliationStore;
  /**
   * Read-side companion to outboundPayloadStore — backs the /api/ops/payload
   * proxy that streams archived blobs to the admin UI.
   */
  readonly blobReader?: BlobReader;
  /** Allowed blob-account origin for the payload proxy (SSRF guard). */
  readonly blobAccountUrl?: string;
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
  // M2-D — separate container for outbound NS-payload snapshots. Default
  // distinct from inbound so retention policies don't tangle (debug-grade
  // vs HMAC-evidence-grade).
  const outboundContainer = process.env['DPI_OUTBOUND_PAYLOAD_CONTAINER'] ?? 'outbound-netsuite';
  const guestCustomerInternalId = process.env['GUEST_CUSTOMER_NS_ID'] ?? '1';

  const connectionsJson = requireEnv('DPI_CONNECTIONS_JSON');
  const parsed = parseConnectionsConfig(connectionsJson);

  const secrets = new KeyVaultSecretProvider({ vaultUri });
  const shopify = new ShopifyHttpGateway({ secrets });

  // NS gateway: when any connection carries a real nsAccountId (anything other
  // than the 'pending' placeholder), build a SdkNetSuiteGateway against the
  // first-party netsuite-sdk with per-account TBA creds resolved from KV.
  // If nothing is configured, fall back to FakeNetSuiteGateway so the pipeline
  // still runs end-to-end (handler logs synthetic ids, xref still flips synced).
  const ns: NetSuiteGateway = buildNetSuiteGateway(parsed, secrets);

  // Postgres is optional at the bootstrap layer so a Slice-A-only env can boot
  // without it. The order-import handler (Slice B+) refuses to start if
  // xrefStore isn't present.
  const pgHost = process.env['POSTGRES_HOST'];
  const pgDatabase = process.env['POSTGRES_DATABASE'];
  const pgUser = process.env['POSTGRES_MI_USER'] ?? process.env['WEBSITE_SITE_NAME'];
  let pgPool: pg.Pool | undefined;
  let xrefStore: XrefStore | undefined;
  let errorStore: ErrorStore | undefined;
  let watermarkStore: SyncWatermarkStore | undefined;
  let orderSyncLog: OrderSyncLogStore | undefined;
  let orderAttemptStore: OrderAttemptStore | undefined;
  let reconciliationStore: ReconciliationStore | undefined;
  if (pgHost && pgDatabase && pgUser) {
    pgPool = buildPgPool({ host: pgHost, database: pgDatabase, user: pgUser });
    xrefStore = new PostgresXrefStore(pgPool);
    errorStore = new PostgresErrorStore(pgPool);
    watermarkStore = new PostgresSyncWatermarkStore(pgPool);
    orderSyncLog = new PostgresOrderSyncLogStore(pgPool);
    orderAttemptStore = new PostgresOrderAttemptStore(pgPool);
    reconciliationStore = new PostgresReconciliationStore(pgPool);
  }
  // M2-D outbound-payload archive — same storage account as the inbound
  // envelopes, distinct container. Independent of pgPool: even a no-DB
  // bootstrap can still snapshot what we send to NS.
  const outboundPayloadStore: PayloadStore = new BlobPayloadStore({
    accountUrl: blobAccountUrl,
    container: outboundContainer,
  });
  // Same MI auth, no per-container scoping — the proxy validates URIs
  // against an allowlist + DB cross-check before each read.
  const blobReader = new BlobReader({ accountUrl: blobAccountUrl });

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
    ...(errorStore ? { errorStore } : {}),
    ...(watermarkStore ? { watermarkStore } : {}),
    ...(orderSyncLog ? { orderSyncLog } : {}),
    ...(orderAttemptStore ? { orderAttemptStore } : {}),
    ...(reconciliationStore ? { reconciliationStore } : {}),
    outboundPayloadStore,
    blobReader,
    blobAccountUrl,
  };
}

function requireEnv(key: string): string {
  const value = process.env[key];
  if (value === undefined || value.length === 0) {
    throw new Error(`bootstrap: required env var '${key}' is not set`);
  }
  return value;
}

/**
 * Pick the NetSuiteGateway impl based on which connections have real
 * nsAccountIds. A connection with nsAccountId='pending' (or any other empty
 * placeholder) opts that account out of real NS writes; the handler still
 * runs end-to-end against the FakeNetSuiteGateway in that case.
 *
 * The KV secret-ref convention matches what we used in `az keyvault secret
 * set` for the dev account:
 *   ns-<sanitized-accountId>-consumer-key
 *   ns-<sanitized-accountId>-consumer-secret
 *   ns-<sanitized-accountId>-token-id
 *   ns-<sanitized-accountId>-token-secret
 * KV secret names disallow underscores; sanitize matches `[a-z]+[a-z0-9-]*`.
 *
 * Governor: per-account in-flight ceiling 10 (well below SuiteTalk's
 * concurrency governor). The SharedInMemoryGovernorStore is per-instance —
 * Slice E or M2 introduces a SQL-backed store for cross-instance correctness.
 */
function buildNetSuiteGateway(
  connections: readonly Connection[],
  secrets: SecretProvider,
): NetSuiteGateway {
  const realAccountIds = new Set(
    connections
      .map((c) => c.nsAccountId)
      .filter((id) => id.length > 0 && id !== 'pending'),
  );
  if (realAccountIds.size === 0) {
    return new FakeNetSuiteGateway();
  }
  const accounts = new Map<string, NsAccountConfig>();
  for (const accountId of realAccountIds) {
    const sanitized = accountId.toLowerCase().replace(/_/g, '-');
    accounts.set(accountId, {
      accountId,
      credentials: {
        consumerKeyRef: `ns-${sanitized}-consumer-key`,
        consumerSecretRef: `ns-${sanitized}-consumer-secret`,
        tokenKeyRef: `ns-${sanitized}-token-id`,
        tokenSecretRef: `ns-${sanitized}-token-secret`,
      },
    });
  }
  const governorConfig: GovernorConfig = { perAccountCeiling: 10 };
  const governorStore = new SharedInMemoryGovernorStore(governorConfig.perAccountCeiling);
  const factory = new NetSuiteClientFactory(secrets, governorStore, governorConfig);
  return new SdkNetSuiteGateway(factory, accounts);
}
