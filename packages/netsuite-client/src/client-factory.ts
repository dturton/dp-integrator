import { NetSuiteClient, type NetSuiteConfig, type OAuthConfig } from 'netsuite-sdk';
import type { GovernorBackingStore, GovernorConfig, SecretProvider } from '@dpi/core';
import { governorMiddleware } from './governor-middleware.js';

/**
 * Stable refs for hydrating TBA credentials from the SecretProvider. One ref
 * per OAuth field — keeps Key Vault organized one-secret-per-value.
 */
export interface NsCredentialRefs {
  readonly consumerKeyRef: string;
  readonly consumerSecretRef: string;
  readonly tokenKeyRef: string;
  readonly tokenSecretRef: string;
}

export interface NsAccountConfig {
  /**
   * NetSuite account ID. Sandbox uses `_SB1` suffix per the SDK's
   * `NetSuiteConfig.accountId` docstring; SDK normalizes for URL use.
   */
  readonly accountId: string;
  readonly credentials: NsCredentialRefs;
  readonly timeoutMs?: number;
  /**
   * SDK's own internal-transport retry count for transient HTTP errors. Default 3.
   * Each retry consumes a governor slot — see governor-middleware.ts.
   */
  readonly maxRetries?: number;
}

/**
 * Caches `NetSuiteClient` instances per NS account. One client per (accountId,
 * processInstance); the governor lives a level up and is shared across them so
 * many clients can sit on top of one shared budget.
 *
 * Multi-NS-account support is the whole point of this class — never construct
 * `new NetSuiteClient` directly outside this package.
 */
export class NetSuiteClientFactory {
  private readonly cache = new Map<string, NetSuiteClient>();

  constructor(
    private readonly secrets: SecretProvider,
    private readonly governorStore: GovernorBackingStore,
    private readonly governorConfig: GovernorConfig,
  ) {}

  /**
   * Get (or hydrate) a client for an account. First call resolves the four
   * credential refs from the SecretProvider and installs the governor
   * middleware on the SDK client.
   */
  async get(account: NsAccountConfig): Promise<NetSuiteClient> {
    const cached = this.cache.get(account.accountId);
    if (cached) return cached;

    const auth = await this.hydrateOAuth(account);
    const config: NetSuiteConfig = {
      auth,
      accountId: account.accountId,
      ...(account.timeoutMs !== undefined ? { timeout: account.timeoutMs } : {}),
      ...(account.maxRetries !== undefined ? { maxRetries: account.maxRetries } : {}),
    };
    const client = new NetSuiteClient(config);
    client.use(
      governorMiddleware({
        store: this.governorStore,
        nsAccountId: account.accountId,
        config: this.governorConfig,
      }),
    );
    this.cache.set(account.accountId, client);
    return client;
  }

  private async hydrateOAuth(account: NsAccountConfig): Promise<OAuthConfig> {
    const [consumerKey, consumerSecret, tokenKey, tokenSecret] = await Promise.all([
      this.secrets.getSecret(account.credentials.consumerKeyRef),
      this.secrets.getSecret(account.credentials.consumerSecretRef),
      this.secrets.getSecret(account.credentials.tokenKeyRef),
      this.secrets.getSecret(account.credentials.tokenSecretRef),
    ]);
    return {
      consumerKey,
      consumerSecret,
      tokenKey,
      tokenSecret,
      // `realm` is the OAuth realm — same as the account id for NS TBA.
      realm: account.accountId,
    };
  }
}
