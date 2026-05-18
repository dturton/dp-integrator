#!/usr/bin/env node
/**
 * `dpi` CLI — operations dashboard for dp-integrator.
 *
 * Verbs:
 *   status         One-screen overview (backlog counts, recent xref activity,
 *                  recent handler outcomes from App Insights)
 *   parked         List xref rows currently parked (status='error') with the
 *                  most recent park reason from App Insights logs
 *   help           Show this usage
 *
 * Required env (export once in your shell):
 *   DPI_PG_HOST       e.g. dpi-pg-dev-<suffix>.postgres.database.azure.com
 *   DPI_PG_DATABASE   e.g. dpi_dev
 *   DPI_PG_USER       your Entra principal name (e.g. dturton@etrivo.com)
 *   DPI_ENVIRONMENT   dev | sandbox | prod  (defaults to 'dev')
 *
 * Optional:
 *   DPI_AI_APP_ID     App Insights component appId — enables the outcome
 *                     summary in `status` and reason backfill in `parked`.
 *   DPI_PG_PORT       defaults to 5432
 *
 * Authentication: uses DefaultAzureCredential (azure-cli session is fine for
 * local use). The user must be a Postgres Entra admin on the target server
 * — already granted to dturton@etrivo.com in Slice B1.
 *
 * M2 will extend this with:
 *   recent <count>    Tail of recent imports + failures
 *   replay <gid>      Clear an error row + republish the webhook
 *   reasons <gid>     Full park history for one order
 */
import { attemptsCommand } from './commands/attempts.js';
import { parkedCommand } from './commands/parked.js';
import { recentCommand } from './commands/recent.js';
import { reconcileCommand } from './commands/reconcile.js';
import { replayCommand } from './commands/replay.js';
import { statusCommand } from './commands/status.js';

const USAGE = `dpi — dp-integrator ops dashboard

Usage: dpi <command> [options]

Commands:
  status                  One-screen overview of the integration's state
  parked [--limit N]      List parked orders (xref status='error') with reasons
  recent [opts]           Tail order_sync_log — per-order ledger (order #, email, totals, tries, NS link, status)
      --limit N             default 20
      --connection <id>     filter to one connection
      --status <s>          filter to imported | parked | ignored
  attempts <gid|id>       Full Service Bus delivery timeline for one order (M2-D)
      --connection <id>     required — connection id (e.g. acme-us)
  reconcile [opts]        Daily Shopify-vs-dpi snapshot table (M3-B); drift in red
      --limit N             default 14
      --connection <id>     filter to one connection
      --from YYYY-MM-DD     business_date lower bound (inclusive)
      --to YYYY-MM-DD       business_date upper bound (inclusive)
  replay <gid|id>         Re-publish an order through the import pipeline
      --connection <id>     required — connection id from \`dpi parked\` output
      --force               override the refusal when xref status='synced'
      --topic <t>           webhook topic stamped on the message (default orders/updated)
  help                    Show this message

Env: DPI_PG_HOST, DPI_PG_DATABASE, DPI_PG_USER required for all verbs.
     DPI_AI_APP_ID enables log-backed reason info on status/parked.
     DPI_ENVIRONMENT defaults to 'dev'.
     replay also needs: DPI_SERVICE_BUS_NAMESPACE, DPI_CONNECTIONS_JSON, and
     'Azure Service Bus Data Sender' on the operator's Entra principal.
`;

async function main(): Promise<void> {
  const [verb, ...rest] = process.argv.slice(2);
  switch (verb) {
    case undefined:
    case 'help':
    case '--help':
    case '-h':
      process.stdout.write(USAGE);
      return;
    case 'status':
      await statusCommand();
      return;
    case 'parked':
      await parkedCommand(rest);
      return;
    case 'recent':
      await recentCommand(rest);
      return;
    case 'attempts':
      await attemptsCommand(rest);
      return;
    case 'reconcile':
      await reconcileCommand(rest);
      return;
    case 'replay':
      await replayCommand(rest);
      return;
    default:
      process.stderr.write(`dpi: unknown command '${verb}'\n\n${USAGE}`);
      process.exit(2);
  }
}

main().catch((err: unknown) => {
  const e = err as Error;
  process.stderr.write(`dpi: ${e.message ?? String(err)}\n`);
  process.exit(1);
});
