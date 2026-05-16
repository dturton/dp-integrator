import { DefaultAzureCredential, type TokenCredential } from '@azure/identity';
import { SecretClient } from '@azure/keyvault-secrets';
import type { SecretProvider } from '@dpi/core';

const DEFAULT_TTL_MS = 5 * 60 * 1000;

/**
 * Production `SecretProvider` backed by Azure Key Vault.
 *
 * Authenticates via `DefaultAzureCredential` — in the Function App that
 * resolves to the system-assigned managed identity, which Bicep grants
 * `Key Vault Secrets User` on the vault. Locally it falls back to az-cli
 * / VS Code credentials, etc.
 *
 * In-process TTL cache (default 5 min) keeps the webhook hot-path under one
 * KV round-trip per shop secret. KV is durable and rotations are deliberate,
 * so a 5-min stale window is acceptable; bump down via constructor for tests
 * or hot rotation scenarios.
 */
export class KeyVaultSecretProvider implements SecretProvider {
  private readonly client: SecretClient;
  private readonly ttlMs: number;
  private readonly cache = new Map<string, { value: string; expiresAt: number }>();

  constructor(args: { vaultUri: string; ttlMs?: number; credential?: TokenCredential }) {
    const credential = args.credential ?? new DefaultAzureCredential();
    this.client = new SecretClient(args.vaultUri, credential);
    this.ttlMs = args.ttlMs ?? DEFAULT_TTL_MS;
  }

  async getSecret(ref: string): Promise<string> {
    const cached = this.cache.get(ref);
    if (cached && cached.expiresAt > Date.now()) return cached.value;

    const result = await this.client.getSecret(ref);
    if (!result.value) {
      throw new Error(`KeyVaultSecretProvider: secret '${ref}' has no value`);
    }
    this.cache.set(ref, { value: result.value, expiresAt: Date.now() + this.ttlMs });
    return result.value;
  }
}
