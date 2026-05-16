/**
 * Abstracts where secrets live (Key Vault in prod, env vars in dev).
 *
 * `ref` is opaque — for Key Vault it's the secret name; for env it's the env-var name.
 * Connections store these refs, never raw values.
 */
export interface SecretProvider {
  /** Fetch a secret by reference. Throws if not found — secrets should never silently fall back. */
  getSecret(ref: string): Promise<string>;
}

/**
 * Resolves secrets from `process.env`. Intended for local development and tests.
 * Production callers wire a Key Vault–backed implementation in its place.
 */
export class EnvSecretProvider implements SecretProvider {
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

  async getSecret(ref: string): Promise<string> {
    const value = this.env[ref];
    if (value === undefined || value === '') {
      throw new Error(`EnvSecretProvider: secret '${ref}' is not set in process.env`);
    }
    return value;
  }
}

/** In-memory secret provider for tests. */
export class InMemorySecretProvider implements SecretProvider {
  private readonly secrets = new Map<string, string>();

  constructor(seed: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(seed)) this.secrets.set(k, v);
  }

  set(ref: string, value: string): void {
    this.secrets.set(ref, value);
  }

  async getSecret(ref: string): Promise<string> {
    const v = this.secrets.get(ref);
    if (v === undefined) throw new Error(`InMemorySecretProvider: secret '${ref}' not seeded`);
    return v;
  }
}
