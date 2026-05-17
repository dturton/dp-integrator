import { buildPool } from '../lib/db.js';
import { dim, heading, renderTable, statusColor } from '../lib/format.js';
import { runKql } from '../lib/insights.js';

/**
 * One-screen status overview: backlog by status, last-hour outcomes,
 * a heading describing the environment.
 */
export async function statusCommand(): Promise<void> {
  const pool = buildPool();
  try {
    const env = process.env['DPI_ENVIRONMENT'] ?? 'dev';
    console.log(`\n${heading(`dp-integrator — ${env}`)}\n`);

    // 1. Backlog by status
    console.log(heading('Backlog by xref status'));
    const counts = await pool.query<{ status: string; count: string }>(
      `SELECT status, count(*)::text AS count FROM entity_xref WHERE environment=$1 GROUP BY status ORDER BY status`,
      [env],
    );
    if (counts.rows.length === 0) {
      console.log(dim('  (no rows)'));
    } else {
      console.log(
        renderTable(
          counts.rows.map((r) => ({
            status: statusColor(r.status),
            count: r.count,
          })),
        ),
      );
    }

    // 2. Recent xref activity
    console.log(`\n${heading('Last 10 xref changes')}`);
    const recent = await pool.query<{
      source_id: string;
      status: string;
      updated_at: string;
      target_id: string | null;
    }>(
      `SELECT source_id, status, updated_at::text, target_id
         FROM entity_xref
        WHERE environment=$1
        ORDER BY updated_at DESC
        LIMIT 10`,
      [env],
    );
    if (recent.rows.length === 0) {
      console.log(dim('  (no rows)'));
    } else {
      console.log(
        renderTable(
          recent.rows.map((r) => ({
            order: shortenGid(r.source_id),
            status: statusColor(r.status),
            ns_id: r.target_id ?? dim('-'),
            updated: r.updated_at.replace('T', ' ').slice(0, 19),
          })),
        ),
      );
    }

    // 3. Recent handler outcomes from App Insights (skipped if DPI_AI_APP_ID isn't set)
    if (process.env['DPI_AI_APP_ID']) {
      console.log(`\n${heading('Handler outcomes (last 1h)')}`);
      try {
        const outcomes = runKql<{ outcome: string; count_: number }>(
          "traces | where timestamp > ago(1h) and message contains 'orderImportHandler outcome=' | extend outcome = extract('outcome=([a-z_]+)', 1, message) | summarize count_=count() by outcome | order by count_ desc",
        );
        if (outcomes.length === 0) {
          console.log(dim('  (no handler activity)'));
        } else {
          console.log(
            renderTable(
              outcomes.map((r) => ({
                outcome: r.outcome,
                count: String(r.count_),
              })),
            ),
          );
        }
      } catch (err) {
        console.log(dim(`  (App Insights query failed: ${(err as Error).message})`));
      }
    } else {
      console.log(`\n${dim('Tip: set DPI_AI_APP_ID for last-hour outcome counts.')}`);
    }

    console.log();
  } finally {
    await pool.end();
  }
}

function shortenGid(gid: string): string {
  // gid://shopify/Order/12345 → Order/12345 — keeps the table narrow.
  const m = /^gid:\/\/shopify\/(.+)$/.exec(gid);
  return m ? m[1]! : gid;
}
