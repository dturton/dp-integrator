import { buildPool } from '../lib/db.js';
import { dim, heading, renderTable } from '../lib/format.js';

/**
 * `dpi reconcile [--limit N] [--connection id] [--from YYYY-MM-DD] [--to YYYY-MM-DD]`
 *
 * Read-only view over `reconciliation_snapshots`. The sweep itself runs in
 * the function app on a daily timer (06:00 UTC); this verb shows the most
 * recent snapshots and any drift rows that need an operator's eyes.
 *
 * Triggering a fresh reconciliation outside the daily schedule is a separate
 * concern — for now, force one via the Function admin invoke endpoint (or
 * wait for the next daily fire). M3 follow-up: a `--run` flag here that
 * POSTs to a dedicated REST endpoint.
 */
export async function reconcileCommand(argv: readonly string[]): Promise<void> {
  const limit = parseNum(argv, '--limit', 14);
  const connectionId = flagValue(argv, '--connection');
  const fromDate = flagValue(argv, '--from');
  const toDate = flagValue(argv, '--to');
  const env = process.env['DPI_ENVIRONMENT'] ?? 'dev';

  const pool = buildPool();
  try {
    const tail: string[] = [`env=${env}`];
    if (connectionId) tail.push(`conn=${connectionId}`);
    if (fromDate) tail.push(`from=${fromDate}`);
    if (toDate) tail.push(`to=${toDate}`);
    tail.push(`top ${limit}`);
    console.log(`\n${heading(`Reconciliation snapshots (${tail.join(', ')})`)}\n`);

    const clauses: string[] = ['environment = $1'];
    const params: unknown[] = [env];
    if (connectionId) {
      params.push(connectionId);
      clauses.push(`connection_id = $${params.length}`);
    }
    if (fromDate) {
      params.push(fromDate);
      clauses.push(`business_date >= $${params.length}`);
    }
    if (toDate) {
      params.push(toDate);
      clauses.push(`business_date <= $${params.length}`);
    }
    params.push(limit);
    const limitIdx = params.length;

    const r = await pool.query<{
      business_date: string;
      connection_id: string;
      shopify_order_count: number;
      ns_txn_count: number;
      shopify_total: string;
      ns_total: string;
      discrepancy: Record<string, unknown> | null;
      created_at: string;
    }>(
      `SELECT business_date::text, connection_id,
              shopify_order_count, ns_txn_count,
              shopify_total::text, ns_total::text,
              discrepancy, created_at::text
         FROM reconciliation_snapshots
        WHERE ${clauses.join(' AND ')}
        ORDER BY business_date DESC, connection_id
        LIMIT $${limitIdx}`,
      params,
    );

    if (r.rows.length === 0) {
      console.log(dim('  (no snapshots — sweep runs daily at 06:00 UTC)'));
      return;
    }

    console.log(
      renderTable(
        r.rows.map((row) => ({
          date: row.business_date,
          connection: row.connection_id,
          shopify: `${row.shopify_order_count} / ${row.shopify_total}`,
          ns: `${row.ns_txn_count} / ${row.ns_total}`,
          drift: driftLabel(row.discrepancy),
          at: row.created_at.replace('T', ' ').slice(0, 19),
        })),
      ),
    );
    console.log('');
  } finally {
    await pool.end();
  }
}

function driftLabel(discrepancy: Record<string, unknown> | null): string {
  if (discrepancy === null) return dim('—');
  const countDiff = discrepancy['countDiff'];
  const totalDiff = discrepancy['totalDiff'];
  const reason = String(discrepancy['reason'] ?? 'drift');
  // ANSI red for visibility — format helper doesn't have a redColor export
  // but statusColor('error') is the convention used elsewhere.
  const TTY = process.stdout.isTTY === true;
  const RED = TTY ? '\x1b[31m' : '';
  const RESET = TTY ? '\x1b[0m' : '';
  return `${RED}${reason} (Δcount=${String(countDiff ?? '?')}, Δtotal=${String(totalDiff ?? '?')})${RESET}`;
}

function parseNum(argv: readonly string[], name: string, fallback: number): number {
  const v = flagValue(argv, name);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`dpi reconcile: ${name} must be a positive integer`);
  }
  return n;
}

function flagValue(argv: readonly string[], name: string): string | undefined {
  const idx = argv.indexOf(name);
  if (idx === -1) return undefined;
  const v = argv[idx + 1];
  if (v === undefined || v.startsWith('--')) return undefined;
  return v;
}
