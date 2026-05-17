import { DefaultAzureCredential } from '@azure/identity';
import pg from 'pg';

const { Pool } = pg;

/**
 * Postgres pool for the local CLI. Uses Entra token auth (same flow as the
 * Function App), reading host/db/user from env. The CLI is run by the
 * developer who's already an Entra admin on the Postgres server (set in
 * Slice B1), so DefaultAzureCredential picks up the az-cli session.
 */
export function buildPool(): pg.Pool {
  const host = required('DPI_PG_HOST');
  const database = required('DPI_PG_DATABASE');
  const user = required('DPI_PG_USER');
  const credential = new DefaultAzureCredential();
  let cached: { token: string; expiresAt: number } | undefined;
  return new Pool({
    host,
    port: Number(process.env['DPI_PG_PORT'] ?? '5432'),
    database,
    user,
    max: 2,
    ssl: { rejectUnauthorized: true },
    password: async () => {
      if (cached && cached.expiresAt - 60_000 > Date.now()) return cached.token;
      const r = await credential.getToken('https://ossrdbms-aad.database.windows.net/.default');
      if (!r) throw new Error('dpi cli: no Entra token for Postgres');
      cached = { token: r.token, expiresAt: r.expiresOnTimestamp };
      return r.token;
    },
  });
}

function required(key: string): string {
  const v = process.env[key];
  if (!v || v.length === 0) {
    throw new Error(
      `dpi cli: required env var '${key}' not set. ` +
        `Export DPI_PG_HOST, DPI_PG_DATABASE, DPI_PG_USER (your Entra principal name).`,
    );
  }
  return v;
}
