import { DefaultAzureCredential, type TokenCredential } from '@azure/identity';
import pg from 'pg';

const { Pool } = pg;

/**
 * Azure Postgres Flex Entra-ID-auth pool.
 *
 * `pg.Pool` calls the `password` function on every new connection acquisition,
 * which lets us hand it a fresh Entra access token each time. Tokens TTL is
 * ~60 minutes, so the in-memory cache here is just an optimization — when the
 * Pool opens a connection it asks for a token and we return either the cached
 * one (if still valid for at least 60s) or a freshly-minted one.
 *
 * The MI is added as a Postgres Entra admin out-of-band (`az postgres
 * flexible-server microsoft-entra-admin create … --type ServicePrincipal`);
 * the connection user name is the principal's display name from that grant
 * (e.g. `dpi-func-dev-<suffix>`).
 *
 * SSL: Azure Postgres Flex requires TLS; we don't pin the CA here because the
 * Function host's CA bundle already includes the Microsoft Azure roots. If
 * you'd rather pin: `ssl: { ca: fs.readFileSync('/path/to/DigiCertGlobalRootCA.crt.pem') }`.
 */

const TOKEN_SCOPE = 'https://ossrdbms-aad.database.windows.net/.default';
const TOKEN_REFRESH_BUFFER_MS = 60_000;

export interface PgPoolConfig {
  readonly host: string;
  readonly port?: number;
  readonly database: string;
  /** Postgres user — must match the display name the MI was registered under. */
  readonly user: string;
  /** Max pool size. Default 4 (Flex Burstable B1ms has ~85 max conns). */
  readonly maxConnections?: number;
  readonly credential?: TokenCredential;
}

export function buildPgPool(cfg: PgPoolConfig): pg.Pool {
  const credential = cfg.credential ?? new DefaultAzureCredential();
  let cached: { token: string; expiresAt: number } | undefined;

  return new Pool({
    host: cfg.host,
    port: cfg.port ?? 5432,
    database: cfg.database,
    user: cfg.user,
    max: cfg.maxConnections ?? 4,
    ssl: { rejectUnauthorized: true },
    password: async () => {
      if (cached && cached.expiresAt - TOKEN_REFRESH_BUFFER_MS > Date.now()) {
        return cached.token;
      }
      const result = await credential.getToken(TOKEN_SCOPE);
      if (!result) throw new Error('pg-pool: credential returned no token for Postgres');
      cached = { token: result.token, expiresAt: result.expiresOnTimestamp };
      return result.token;
    },
  });
}
