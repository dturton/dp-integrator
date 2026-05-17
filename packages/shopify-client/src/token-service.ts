/**
 * OAuth client-credentials token service for Shopify Dev Dashboard apps.
 *
 * The new (2026+) Dev Dashboard model no longer issues long-lived shpat_
 * tokens at install time. Instead, the app exchanges (client_id, client_secret)
 * for a short-lived access token via:
 *
 *   POST https://{shop}.myshopify.com/admin/oauth/access_token
 *   Content-Type: application/x-www-form-urlencoded
 *   client_id=…&client_secret=…&grant_type=client_credentials
 *
 * Returns { access_token, scope, expires_in }. `expires_in` is in seconds;
 * confirmed against the real store returning 86399 (~24h).
 *
 * This service caches per-shop tokens with a configurable refresh buffer
 * (default 5 min before expiry) so concurrent gateway calls don't stampede the
 * Shopify token endpoint. The cache is process-local — every Function App
 * instance maintains its own (acceptable because Shopify has no per-token
 * concurrency limit, and tokens are interchangeable for the same client_id).
 */

interface CachedToken {
  readonly accessToken: string;
  readonly expiresAt: number;
  readonly scope: string;
}

export interface ShopifyTokenServiceConfig {
  /** Refresh tokens that have less than this much TTL remaining (ms). Default 5 min. */
  readonly refreshBufferMs?: number;
  /** Optional fetch override for tests. Defaults to global `fetch`. */
  readonly fetchImpl?: typeof fetch;
  /** Injectable clock for tests. */
  readonly now?: () => number;
}

export interface ShopifyTokenServiceCredentials {
  /** Full shop domain — e.g. `xxx.myshopify.com`. Used to build the token URL. */
  readonly shopDomain: string;
  readonly clientId: string;
  readonly clientSecret: string;
}

export interface ShopifyAccessToken {
  readonly accessToken: string;
  readonly scope: string;
  /** Absolute epoch ms when the token expires. */
  readonly expiresAt: number;
}

export class ShopifyTokenService {
  private readonly cache = new Map<string, CachedToken>();
  private readonly refreshBufferMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  /** Per-shop in-flight promise so concurrent fetches dedupe to one token call. */
  private readonly inFlight = new Map<string, Promise<CachedToken>>();

  constructor(config: ShopifyTokenServiceConfig = {}) {
    this.refreshBufferMs = config.refreshBufferMs ?? 5 * 60 * 1000;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.now = config.now ?? Date.now;
  }

  async getAccessToken(creds: ShopifyTokenServiceCredentials): Promise<ShopifyAccessToken> {
    const cached = this.cache.get(creds.shopDomain);
    if (cached && cached.expiresAt - this.refreshBufferMs > this.now()) {
      return { accessToken: cached.accessToken, scope: cached.scope, expiresAt: cached.expiresAt };
    }
    const existing = this.inFlight.get(creds.shopDomain);
    if (existing) {
      const t = await existing;
      return { accessToken: t.accessToken, scope: t.scope, expiresAt: t.expiresAt };
    }
    const promise = this.fetchToken(creds);
    this.inFlight.set(creds.shopDomain, promise);
    try {
      const fresh = await promise;
      this.cache.set(creds.shopDomain, fresh);
      return { accessToken: fresh.accessToken, scope: fresh.scope, expiresAt: fresh.expiresAt };
    } finally {
      this.inFlight.delete(creds.shopDomain);
    }
  }

  /** Force-evict a cached token (e.g. on 401 from a downstream API call). */
  invalidate(shopDomain: string): void {
    this.cache.delete(shopDomain);
  }

  private async fetchToken(creds: ShopifyTokenServiceCredentials): Promise<CachedToken> {
    const url = `https://${creds.shopDomain}/admin/oauth/access_token`;
    const body = new URLSearchParams({
      client_id: creds.clientId,
      client_secret: creds.clientSecret,
      grant_type: 'client_credentials',
    });
    const res = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(
        `ShopifyTokenService: ${creds.shopDomain} returned ${res.status} on token exchange: ${text}`,
      );
    }
    const json = (await res.json()) as { access_token?: string; scope?: string; expires_in?: number };
    if (!json.access_token) {
      throw new Error(
        `ShopifyTokenService: ${creds.shopDomain} returned no access_token in response`,
      );
    }
    // expires_in absent → treat as 1h (conservative default). Real Shopify
    // returns ~86399 (1 day).
    const ttlSeconds = json.expires_in ?? 3600;
    return {
      accessToken: json.access_token,
      scope: json.scope ?? '',
      expiresAt: this.now() + ttlSeconds * 1000,
    };
  }
}
