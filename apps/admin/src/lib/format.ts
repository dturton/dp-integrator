/**
 * Minimal text-table renderer for the CLI status board. ANSI escapes only
 * when stdout is a TTY (so piping into less / grep stays clean).
 */

const TTY = process.stdout.isTTY === true;
const BOLD = TTY ? '\x1b[1m' : '';
const DIM = TTY ? '\x1b[2m' : '';
const RED = TTY ? '\x1b[31m' : '';
const GREEN = TTY ? '\x1b[32m' : '';
const YELLOW = TTY ? '\x1b[33m' : '';
const CYAN = TTY ? '\x1b[36m' : '';
const RESET = TTY ? '\x1b[0m' : '';

export function heading(s: string): string {
  return `${BOLD}${s}${RESET}`;
}

export function dim(s: string): string {
  return `${DIM}${s}${RESET}`;
}

export function statusColor(status: string): string {
  if (status === 'synced') return `${GREEN}${status}${RESET}`;
  if (status === 'error') return `${RED}${status}${RESET}`;
  if (status === 'pending') return `${YELLOW}${status}${RESET}`;
  if (status === 'deferred') return `${YELLOW}${status}${RESET}`;
  if (status === 'ignored') return `${CYAN}${status}${RESET}`;
  return status;
}

export function renderTable(rows: ReadonlyArray<Record<string, string>>): string {
  if (rows.length === 0) return dim('  (no rows)');
  const keys = Object.keys(rows[0]!);
  const widths = keys.map((k) =>
    Math.max(k.length, ...rows.map((r) => stripAnsi(r[k] ?? '').length)),
  );
  const header = keys.map((k, i) => k.padEnd(widths[i]!)).join('  ');
  const sep = keys.map((_, i) => '-'.repeat(widths[i]!)).join('  ');
  const body = rows
    .map((r) =>
      keys
        .map((k, i) => padToWidth(r[k] ?? '', widths[i]!))
        .join('  '),
    )
    .join('\n');
  return `${heading(header)}\n${dim(sep)}\n${body}`;
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function padToWidth(s: string, w: number): string {
  const visible = stripAnsi(s).length;
  if (visible >= w) return s;
  return s + ' '.repeat(w - visible);
}
