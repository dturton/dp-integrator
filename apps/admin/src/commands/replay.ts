import {
  isEnvironment,
  parseConnectionsConfig,
  type Connection,
  type Environment,
  type OrderWebhookMessageBody,
} from '@dpi/core';
import { buildPool } from '../lib/db.js';
import { ServiceBusQueueProducer } from '../lib/service-bus-producer.js';
import { dim, heading } from '../lib/format.js';

/**
 * `dpi replay <gid|orderId> --connection <id> [--force] [--topic <t>]`
 *
 * Un-claims the xref row for the given order (if any) and re-publishes a
 * fresh `OrderWebhookMessage` to the env's Service Bus topic. The order
 * handler then runs the import pipeline as if the webhook had just arrived.
 *
 * Replay policy (mirrors `requestReplay` in @dpi/core — the function app's
 * REST endpoint uses the typed version; this verb runs the same rules with
 * raw SQL so the CLI doesn't need to depend on PostgresXrefStore):
 *
 *   - status='synced'  → refuse unless --force (the brief's idempotency
 *                        invariant: no double-import). --force does the
 *                        delete and publishes anyway.
 *   - status='pending' → delete + publish (the orphan-pending case left
 *                        over from a pre-E1 handler crash, for example).
 *   - status='error'   → delete + publish (the normal replay-after-fix path).
 *   - status='ignored' → delete + publish (operator decided eligibility
 *                        was wrong; let the pipeline reevaluate).
 *   - no row           → publish only (operator may have hand-deleted
 *                        already; just re-deliver).
 *
 * Env required:
 *   DPI_PG_HOST / DPI_PG_DATABASE / DPI_PG_USER   shared with status/parked.
 *   DPI_SERVICE_BUS_NAMESPACE  e.g. dpi-sb-dev-xxx.servicebus.windows.net
 *   DPI_CONNECTIONS_JSON       same shape as the Function App setting (so
 *                              the CLI can resolve shopifyStore for the
 *                              message body). Fetch once via:
 *
 *      az functionapp config appsettings list --name <funcapp> \
 *        --resource-group <rg> \
 *        --query "[?name=='DPI_CONNECTIONS_JSON'].value | [0]" -o tsv
 *
 * Az role required on the operator's Entra principal:
 *   "Azure Service Bus Data Sender" on the namespace (or topic):
 *
 *      az role assignment create --assignee <principal-id> \
 *        --role "Azure Service Bus Data Sender" \
 *        --scope "/subscriptions/<sub>/resourceGroups/<rg>/providers/Microsoft.ServiceBus/namespaces/<ns>"
 */
export async function replayCommand(argv: readonly string[]): Promise<void> {
  const args = parseArgs(argv);
  const env = (process.env['DPI_ENVIRONMENT'] ?? 'dev') as Environment;
  if (!isEnvironment(env)) {
    throw new Error(`DPI_ENVIRONMENT='${env}' invalid; expected dev|sandbox|prod`);
  }

  const connectionsJson = required('DPI_CONNECTIONS_JSON');
  const namespace = required('DPI_SERVICE_BUS_NAMESPACE');
  const topic = process.env['DPI_SERVICE_BUS_TOPIC'] ?? 'orders-in';

  const connection = resolveConnection({
    json: connectionsJson,
    env,
    connectionId: args.connectionId,
  });

  const pool = buildPool();
  const queue = new ServiceBusQueueProducer<OrderWebhookMessageBody>({
    fullyQualifiedNamespace: namespace,
    topic,
  });

  try {
    console.log(`\n${heading(`Replay ${args.orderGid} on ${args.connectionId} (${env})`)}\n`);

    const existing = await pool.query<{ status: string; target_id: string | null }>(
      `SELECT status, target_id
         FROM entity_xref
        WHERE environment=$1 AND connection_id=$2 AND entity_type='order'
              AND source_system='shopify' AND source_id=$3
        LIMIT 1`,
      [env, args.connectionId, args.orderGid],
    );
    const prior = existing.rows[0];
    const previousStatus = prior?.status ?? 'absent';

    if (prior?.status === 'synced' && !args.force) {
      console.log(
        `  ${dim('refused:')} order is already synced (ns=${prior.target_id ?? '?'}). ` +
          'Pass --force to re-replay (will delete the xref row and re-publish).',
      );
      process.exitCode = 2;
      return;
    }

    if (prior) {
      await pool.query(
        `DELETE FROM entity_xref
          WHERE environment=$1 AND connection_id=$2 AND entity_type='order'
                AND source_system='shopify' AND source_id=$3`,
        [env, args.connectionId, args.orderGid],
      );
    }

    const now = new Date();
    const sessionId = `${args.connectionId}:${args.orderGid}`;
    const body: OrderWebhookMessageBody = {
      schemaVersion: 1,
      environment: env,
      connectionId: args.connectionId,
      shopDomain: connection.shopifyStore,
      topic: args.topic ?? 'orders/updated',
      orderGid: args.orderGid,
      envelopeBlobUri: `replay://dpi/${env}/${args.connectionId}/${encodeURIComponent(args.orderGid)}/${now.toISOString()}`,
      receivedAt: now.toISOString(),
      // Bypass the handler's webhook-only `update_before_create` gate —
      // operator-initiated replays are explicit acts that should proceed
      // even when no prior xref existed (or after this command's DELETE
      // above wiped one). Mirrors `requestReplay` in @dpi/core.
      source: 'replay',
    };
    await queue.enqueue({ sessionId, body });

    console.log(`  ${dim('replayed:')} previousStatus=${previousStatus} sessionId=${sessionId}`);
    console.log(`  ${dim('topic:')} ${body.topic}   ${dim('envelopeBlobUri:')} ${body.envelopeBlobUri}`);
    console.log(
      `\n${dim('Next: tail App Insights for `orderImportHandler` traces with that order GID.')}\n`,
    );
  } finally {
    await queue.close();
    await pool.end();
  }
}

interface ParsedArgs {
  readonly orderGid: string;
  readonly connectionId: string;
  readonly force: boolean;
  readonly topic?: string;
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional = argv.filter((a) => !a.startsWith('--'));
  const orderArg = positional[0];
  if (!orderArg) {
    throw new Error('dpi replay: missing <gid|orderId>\n\nUsage: dpi replay <gid|orderId> --connection <id> [--force] [--topic <t>]');
  }

  const orderGid = normalizeOrderGid(orderArg);
  if (orderGid === undefined) {
    throw new Error(`dpi replay: invalid order id '${orderArg}' (expected gid:// or numeric)`);
  }

  const connectionId = flagValue(argv, '--connection');
  if (!connectionId) {
    throw new Error('dpi replay: missing --connection <id> (from `dpi parked` output)');
  }

  const force = argv.includes('--force');
  const topic = flagValue(argv, '--topic');

  return { orderGid, connectionId, force, ...(topic !== undefined ? { topic } : {}) };
}

function flagValue(argv: readonly string[], name: string): string | undefined {
  const idx = argv.indexOf(name);
  if (idx === -1) return undefined;
  const v = argv[idx + 1];
  if (v === undefined || v.startsWith('--')) return undefined;
  return v;
}

function normalizeOrderGid(input: string): string | undefined {
  if (/^gid:\/\/shopify\/Order\/\d+$/.test(input)) return input;
  if (/^\d+$/.test(input)) return `gid://shopify/Order/${input}`;
  return undefined;
}

function resolveConnection(args: {
  json: string;
  env: Environment;
  connectionId: string;
}): Connection {
  const all = parseConnectionsConfig(args.json);
  const match = all.find(
    (c) => c.environment === args.env && c.connectionId === args.connectionId,
  );
  if (!match) {
    throw new Error(
      `dpi replay: connection '${args.connectionId}' not found for environment '${args.env}' ` +
        'in DPI_CONNECTIONS_JSON',
    );
  }
  return match;
}

function required(key: string): string {
  const v = process.env[key];
  if (!v || v.length === 0) {
    throw new Error(`dpi replay: required env var '${key}' not set`);
  }
  return v;
}
