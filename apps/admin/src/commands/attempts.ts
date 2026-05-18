import { buildPool } from '../lib/db.js';
import { dim, heading, red, renderTable, statusColor, yellow } from '../lib/format.js';

/**
 * `dpi attempts <gid|orderId> --connection <id>`
 *
 * Slice M2-D — full Service Bus delivery timeline for one order. Selects from
 * the `order_attempt` ledger (append-only, one row per delivery including
 * short-circuits). Mirrors the query the future admin UI's detail page will
 * issue, so building it as CLI first proves the data shape.
 *
 * The `<gid|orderId>` arg accepts either the full Shopify GID
 * (`gid://shopify/Order/123`) or the numeric tail (`123`); the latter is
 * resolved by suffix match against `shopify_order_gid`.
 */
export async function attemptsCommand(argv: readonly string[]): Promise<void> {
  const positional = argv.find((a) => !a.startsWith('--'));
  if (!positional) {
    throw new Error('dpi attempts: <gid|orderId> is required');
  }
  const connectionId = flagValue(argv, '--connection');
  if (!connectionId) {
    throw new Error('dpi attempts: --connection <id> is required');
  }
  const env = process.env['DPI_ENVIRONMENT'] ?? 'dev';

  // Accept the bare numeric tail OR the full GID. The GID form is exact-match;
  // the numeric form is suffix-match (Shopify GIDs end in /<digits>).
  const isGid = positional.startsWith('gid://shopify/Order/');
  const gidParam = isGid ? positional : `gid://shopify/Order/${positional}`;

  const pool = buildPool();
  try {
    console.log(`\n${heading(`Attempts for ${gidParam} (env=${env}, conn=${connectionId})`)}\n`);

    const r = await pool.query<{
      delivery_count: number;
      outcome: string;
      stage: string | null;
      error_class: string | null;
      detail: string | null;
      inbound_envelope_uri: string | null;
      outbound_payload_uri: string | null;
      payload_digest: Record<string, unknown> | null;
      duration_ms: number;
      finished_at: string;
    }>(
      `SELECT delivery_count, outcome, stage, error_class, detail,
              inbound_envelope_uri, outbound_payload_uri, payload_digest,
              duration_ms, finished_at::text
         FROM order_attempt
        WHERE environment=$1 AND connection_id=$2 AND shopify_order_gid=$3
        ORDER BY delivery_count DESC, finished_at DESC`,
      [env, connectionId, gidParam],
    );

    if (r.rows.length === 0) {
      console.log(dim('  (no attempts found — order may not have been delivered yet, or it was synced before slice M2-D)'));
      return;
    }

    console.log(
      renderTable(
        r.rows.map((row) => ({
          '#': formatDelivery(row.delivery_count, row.outcome),
          outcome: statusColor(outcomeToStatus(row.outcome)),
          stage: row.stage ?? dim('-'),
          class: row.error_class ?? dim('-'),
          ms: String(row.duration_ms),
          digest: formatDigest(row.payload_digest),
          inbound: row.inbound_envelope_uri ? '✓' : dim('-'),
          outbound: row.outbound_payload_uri ? '✓' : dim('-'),
          at: row.finished_at.replace('T', ' ').slice(0, 19),
        })),
      ),
    );

    // Detail block: print the first row's blob URIs + truncated error detail
    // in full underneath so the operator can copy/paste them. The table itself
    // stays narrow.
    const top = r.rows[0]!;
    console.log('');
    if (top.detail) console.log(`${dim('detail:')} ${top.detail.slice(0, 240)}`);
    if (top.inbound_envelope_uri) console.log(`${dim('inbound:')} ${top.inbound_envelope_uri}`);
    if (top.outbound_payload_uri) console.log(`${dim('outbound:')} ${top.outbound_payload_uri}`);
    console.log('');
  } finally {
    await pool.end();
  }
}

function outcomeToStatus(o: string): string {
  // Map order_attempt.outcome → the named statuses statusColor() knows.
  if (o === 'imported') return 'synced';
  if (o === 'parked' || o === 'quarantined' || o === 'rejected' || o === 'transient_throw' || o === 'auth_throw') {
    return 'error';
  }
  if (o === 'already_synced' || o === 'already_claimed') return 'pending';
  if (o === 'ignored' || o === 'ignored_by_eligibility') return 'ignored';
  return o;
}

function formatDelivery(n: number, outcome: string): string {
  // First delivery in dim; redeliveries highlighted by terminal outcome.
  const s = String(n);
  if (n <= 1) return dim(s);
  if (outcome === 'imported') return yellow(s); // succeeded eventually
  if (outcome === 'parked' || outcome === 'quarantined') return red(s);
  return s;
}

function formatDigest(d: Record<string, unknown> | null): string {
  if (!d) return dim('-');
  const parts: string[] = [];
  if (typeof d['tranId'] === 'string') parts.push(String(d['tranId']));
  if (typeof d['lineCount'] === 'number') parts.push(`${d['lineCount']}L`);
  return parts.length > 0 ? parts.join(' ') : dim('-');
}

function flagValue(argv: readonly string[], name: string): string | undefined {
  const idx = argv.indexOf(name);
  if (idx === -1) return undefined;
  const v = argv[idx + 1];
  if (v === undefined || v.startsWith('--')) return undefined;
  return v;
}
