// Environment + types
export { ENVIRONMENTS, isEnvironment, type Environment } from './env.js';
export type {
  EntityType,
  SourceSystem,
  TargetSystem,
  TaxEngine,
  OrderTarget,
  Connection,
  ShopifyWebhookEnvelope,
} from './types.js';

// Idempotency / dedup key
export { dedupKey, type DedupKeyParts } from './id/dedup-key.js';

// Secret provider
export {
  EnvSecretProvider,
  InMemorySecretProvider,
  type SecretProvider,
} from './secrets/secret-provider.js';

// Error classification + store
export { RETRYABLE_CLASSES, isRetryable, type ErrorClass } from './errors/error-class.js';
export {
  InMemoryErrorStore,
  type ErrorRecord,
  type ErrorStatus,
  type ErrorStore,
  type NewErrorInput,
} from './errors/error-store.js';

// Xref / idempotency store
export {
  InMemoryXrefStore,
  type ClaimInput,
  type ClaimResult,
  type XrefRow,
  type XrefStatus,
  type XrefStore,
} from './xref/xref-store.js';

// Queue abstraction
export {
  InMemoryQueue,
  type QueueConsumer,
  type QueueMessage,
  type QueueProducer,
  type QueueProvider,
} from './queue/queue.js';

// Connections repository
export {
  InMemoryConnectionsRepo,
  parseConnectionsConfig,
  type ConnectionsRepo,
} from './connections/connections-repo.js';

// Replay (M2)
export {
  requestReplay,
  type OrderWebhookMessageBody,
  type ReplayDeps,
  type ReplayOutcome,
  type ReplayRequest,
} from './replay/replay.js';

// Governor
export {
  PerProcessGovernorStore,
  SharedInMemoryGovernorStore,
  type GovernorBackingStore,
  type GovernorConfig,
} from './governor/governor-store.js';
export { acquireSlot, newHolderId } from './governor/acquire.js';
