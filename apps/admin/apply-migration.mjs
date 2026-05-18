// One-shot migration applicator for dev. Reads a migration .sql file by
// path and runs it against the dpi PG pool (Entra-auth, same as the dpi CLI).
//
// Usage:
//   DPI_PG_HOST=... DPI_PG_DATABASE=... DPI_PG_USER=... \
//     node apply-migration.mjs ../../infra/db/migrations/0004_order_sync_log.sql
//
// Idempotent because all migrations in this repo use `CREATE … IF NOT EXISTS`.
// Replace with a real migration runner (dbmate / golang-migrate) when there's
// more than a handful of migrations and we need version tracking.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildPool } from './dist/lib/db.js';

const argv = process.argv.slice(2);
const path = argv[0];
if (!path) {
  console.error('usage: node apply-migration.mjs <path-to-migration.sql>');
  process.exit(2);
}
const sql = readFileSync(resolve(path), 'utf8');
const pool = buildPool();
try {
  console.log(`applying migration: ${path}`);
  await pool.query(sql);
  console.log('OK');
} catch (err) {
  console.error(`migration failed: ${err.message ?? err}`);
  process.exit(1);
} finally {
  await pool.end();
}
