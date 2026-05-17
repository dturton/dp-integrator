import { execFileSync } from 'node:child_process';

/**
 * Thin wrapper around `az monitor app-insights query`. We shell out instead
 * of pulling in @azure/monitor-query because the CLI is a developer-facing
 * tool — every machine that runs it already has az installed + authenticated.
 *
 * The App Insights GUID is read from env (DPI_AI_APP_ID); for our current
 * dev env it's `0826386f-654a-4518-9b5e-90f684f00171` but coding that in
 * would break the second environment.
 */
export function runKql<T = unknown>(query: string): T[] {
  const appId = process.env['DPI_AI_APP_ID'];
  if (!appId) {
    throw new Error('dpi cli: DPI_AI_APP_ID is not set (App Insights component appId).');
  }
  const raw = execFileSync(
    'az',
    ['monitor', 'app-insights', 'query', '--app', appId, '--analytics-query', query, '-o', 'json'],
    { encoding: 'utf8', maxBuffer: 1024 * 1024 * 8 },
  );
  const parsed = JSON.parse(raw) as { tables?: Array<{ columns: Array<{ name: string }>; rows: unknown[][] }> };
  const table = parsed.tables?.[0];
  if (!table) return [];
  const names = table.columns.map((c) => c.name);
  return table.rows.map((row) => {
    const obj: Record<string, unknown> = {};
    for (let i = 0; i < names.length; i++) obj[names[i]!] = row[i];
    return obj as T;
  });
}
