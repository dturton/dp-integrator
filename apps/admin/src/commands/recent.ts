import { buildPool } from '../lib/db.js';
import { dim, heading, renderTable, statusColor } from '../lib/format.js';

/**
 * `dpi recent [--limit N] [--connection id] [--status imported|parked|ignored]`
 *
 * Tails the `order_sync_log` table — per-order ledger written by the import
 * handler on every terminal outcome. Surfaces order number, customer email,
 * Shopify totals, NS link, status, and timing without joining live to either
 * system.
 */
export async function recentCommand(argv: readonly string[]): Promise<void> {
  const limit = parseLimit(argv);
  const connectionId = flagValue(argv, '--connection');
  const status = flagValue(argv, '--status');
  if (status && !['imported', 'parked', 'ignored'].includes(status)) {
    throw new Error("dpi recent: --status must be one of: imported, parked, ignored");
  }
  const env = process.env['DPI_ENVIRONMENT'] ?? 'dev';

  const pool = buildPool();
  try {
    const titleParts = [`env=${env}`];
    if (connectionId) titleParts.push(`conn=${connectionId}`);
    if (status) titleParts.push(`status=${status}`);
    titleParts.push(`top ${limit}`);
    console.log(`\n${heading(`Recent order sync log (${titleParts.join(', ')})`)}\n`);

    const clauses: string[] = ['environment = $1'];
    const params: unknown[] = [env];
    if (connectionId) {
      params.push(connectionId);
      clauses.push(`connection_id = $${params.length}`);
    }
    if (status) {
      params.push(status);
      clauses.push(`status = $${params.length}`);
    }
    params.push(limit);
    const limitIdx = params.length;

    const r = await pool.query<{
      shopify_order_id: string;
      shopify_order_name: string | null;
      customer_email: string | null;
      currency_code: string | null;
      total_price: string | null;
      total_discounts: string | null;
      status: string;
      ns_internal_id: string | null;
      park_stage: string | null;
      park_detail: string | null;
      ignored_reason: string | null;
      synced_at: string | null;
      updated_at: string;
    }>(
      `SELECT shopify_order_id, shopify_order_name, customer_email,
              currency_code, total_price::text, total_discounts::text,
              status, ns_internal_id, park_stage, park_detail, ignored_reason,
              synced_at::text, updated_at::text
         FROM order_sync_log
        WHERE ${clauses.join(' AND ')}
        ORDER BY COALESCE(synced_at, updated_at) DESC
        LIMIT $${limitIdx}`,
      params,
    );

    if (r.rows.length === 0) {
      console.log(dim('  (no rows)'));
      return;
    }

    console.log(
      renderTable(
        r.rows.map((row) => {
          const total = formatMoney(row.total_price, row.currency_code);
          const discount = isPositiveAmount(row.total_discounts)
            ? `-${formatMoney(row.total_discounts, row.currency_code)}`
            : '';
          const note = noteFor(row);
          return {
            order: row.shopify_order_name ?? `#${row.shopify_order_id}`,
            email: row.customer_email ?? dim('-'),
            total,
            discount: discount || dim('-'),
            status: statusColor(rowStatus(row.status)),
            ns: row.ns_internal_id ? `SO ${row.ns_internal_id}` : dim('-'),
            note: note ?? dim('-'),
            at: (row.synced_at ?? row.updated_at).replace('T', ' ').slice(0, 19),
          };
        }),
      ),
    );

    console.log('');
  } finally {
    await pool.end();
  }
}

function rowStatus(s: string): string {
  // The format library colors 'synced' / 'error' / etc. — bridge naming.
  if (s === 'imported') return 'synced';
  if (s === 'parked') return 'error';
  return s;
}

function noteFor(row: {
  park_stage: string | null;
  park_detail: string | null;
  ignored_reason: string | null;
  status: string;
}): string | undefined {
  if (row.status === 'parked' && row.park_stage) {
    const detail = row.park_detail ? row.park_detail.slice(0, 60) : '';
    return detail ? `${row.park_stage}: ${detail}` : row.park_stage;
  }
  if (row.status === 'ignored' && row.ignored_reason) {
    return row.ignored_reason;
  }
  return undefined;
}

function formatMoney(amount: string | null, currency: string | null): string {
  if (!amount) return '-';
  const n = Number.parseFloat(amount);
  if (!Number.isFinite(n)) return amount;
  const prefix = currency ? `${currency} ` : '';
  return `${prefix}${n.toFixed(2)}`;
}

function isPositiveAmount(amount: string | null): boolean {
  if (!amount) return false;
  const n = Number.parseFloat(amount);
  return Number.isFinite(n) && n > 0;
}

function parseLimit(argv: readonly string[]): number {
  const idx = argv.indexOf('--limit');
  if (idx === -1) return 20;
  const v = Number(argv[idx + 1]);
  if (!Number.isFinite(v) || v <= 0) {
    throw new Error('dpi recent: --limit must be a positive integer');
  }
  return v;
}

function flagValue(argv: readonly string[], name: string): string | undefined {
  const idx = argv.indexOf(name);
  if (idx === -1) return undefined;
  const v = argv[idx + 1];
  if (v === undefined || v.startsWith('--')) return undefined;
  return v;
}
