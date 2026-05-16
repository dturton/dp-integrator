export type Environment = 'dev' | 'sandbox' | 'prod';

export const ENVIRONMENTS: readonly Environment[] = ['dev', 'sandbox', 'prod'] as const;

export function isEnvironment(value: unknown): value is Environment {
  return typeof value === 'string' && (ENVIRONMENTS as readonly string[]).includes(value);
}
