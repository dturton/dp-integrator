import { buildPool } from '../lib/db.js';
import { dim, heading, renderTable, statusColor } from '../lib/format.js';
import { runKql } from '../lib/insights.js';

/**
 * Lists xref rows currently in `status='error'` (parked by the handler)
 * with the most recent park reason from App Insights, when available.
 *
 * Use this as the "what's stuck and why" view. To retry a parked row:
 *   DELETE FROM entity_xref WHERE source_id = 'gid://shopify/Order/X';
 * then redeliver the webhook (curl or Shopify admin). M2 will add a proper
 * `dpi replay <gid>` verb that does both atomically.
 */
export async function parkedCommand(argv: readonly string[]): Promise<void> {
  const limit = parseLimit(argv);
  const env = process.env['DPI_ENVIRONMENT'] ?? 'dev';
  const pool = buildPool();
  try {
    console.log(`\n${heading(`Parked orders (${env}, top ${limit})`)}\n`);
    const rows = await pool.query<{
      source_id: string;
      connection_id: string;
      updated_at: string;
    }>(
      `SELECT source_id, connection_id, updated_at::text
         FROM entity_xref
        WHERE environment=$1 AND status='error'
        ORDER BY updated_at DESC
        LIMIT $2`,
      [env, limit],
    );

    if (rows.rows.length === 0) {
      console.log(dim('  (nothing parked)'));
      return;
    }

    // Best-effort: pull reasons from App Insights so the operator sees WHY.
    const reasons = new Map<string, { stage: string; detail: string }>();
    if (process.env['DPI_AI_APP_ID']) {
      try {
        const kql = `
          traces
          | where timestamp > ago(7d) and message contains 'outcome=parked'
          | extend order = extract('order=([^\\\\s]+)', 1, message)
          | extend stage = extract('stage=([a-z_]+)', 1, message)
          | extend detail = extract('detail="([^"]+)"', 1, message)
          | summarize arg_max(timestamp, stage, detail) by order
        `;
        const found = runKql<{ order: string; stage: string; detail: string }>(kql);
        for (const r of found) reasons.set(r.order, { stage: r.stage, detail: r.detail });
      } catch (err) {
        console.log(dim(`  (App Insights query failed: ${(err as Error).message})`));
      }
    }

    console.log(
      renderTable(
        rows.rows.map((r) => {
          const reason = reasons.get(r.source_id);
          return {
            order: shortenGid(r.source_id),
            connection: r.connection_id,
            status: statusColor('error'),
            stage: reason?.stage ?? dim('-'),
            reason: reason?.detail ?? dim('(no recent log; check App Insights manually)'),
            parked_at: r.updated_at.replace('T', ' ').slice(0, 19),
          };
        }),
      ),
    );

    console.log(
      `\n${dim('Retry a row: DELETE FROM entity_xref WHERE source_id=\'gid://shopify/Order/<id>\'; then redeliver.')}\n`,
    );
  } finally {
    await pool.end();
  }
}

function parseLimit(argv: readonly string[]): number {
  const idx = argv.indexOf('--limit');
  if (idx === -1) return 20;
  const v = Number(argv[idx + 1]);
  if (!Number.isFinite(v) || v <= 0) {
    throw new Error('--limit must be a positive integer');
  }
  return v;
}

function shortenGid(gid: string): string {
  const m = /^gid:\/\/shopify\/(.+)$/.exec(gid);
  return m ? m[1]! : gid;
}
