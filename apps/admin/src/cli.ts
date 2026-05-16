#!/usr/bin/env node
/**
 * `dpi-admin` CLI entrypoint. M0 ships a stub so the bin link can be exercised
 * by `pnpm build` and packaging; the actual verbs (replay, list, quarantine)
 * land in M2 alongside the SQL-backed `ErrorStore` and REST handlers.
 */
const verb = process.argv[2] ?? 'help';
switch (verb) {
  case 'help':
  case '--help':
  case '-h':
    console.log(
      [
        'dpi-admin (v0 stub)',
        '',
        'Usage: dpi-admin <command>',
        '',
        'Commands (planned, M2):',
        '  list       List error_records with filters',
        '  replay     Replay one or many parked records (idempotent)',
        '  quarantine Move records to quarantine (stops further auto-retry)',
        '',
        'M0 only ships the package skeleton — verbs are wired in M2.',
      ].join('\n'),
    );
    break;
  default:
    console.error(`dpi-admin: '${verb}' not implemented in M0. Try 'dpi-admin help'.`);
    process.exit(2);
}
