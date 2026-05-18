import {
  app,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from '@azure/functions';
import type { NetSuiteGateway } from '@dpi/netsuite-client';

/**
 * Diagnostic HTTP endpoint: GET /api/ns-diagnostic
 *
 * Exercises NetSuite from the Function App's network path and credential
 * resolution. Returns a JSON report of which calls succeeded / failed —
 * lets us tell, when prod NS write fails but local works, whether it's
 *   - reads-vs-writes (would show GET ok + PUT fail)
 *   - clock skew (would show all calls fail)
 *   - IP allowlist (would show all fail with a specific NS error)
 *   - SDK-vs-Function-host quirk (would show specific call type failing)
 *
 * Function-key gated and opt-in via bootstrap. Read probes always run; the
 * write probe is separately gated by `allowWrites`.
 */

export interface NsDiagnosticDeps {
  readonly ns: NetSuiteGateway;
  readonly nsAccountId: string;
  readonly nsSubsidiary: string;
  readonly allowWrites: boolean;
}

export function registerNsDiagnostic(getDeps: () => NsDiagnosticDeps): void {
  app.http('nsDiagnostic', {
    methods: ['GET'],
    authLevel: 'function',
    route: 'ns-diagnostic',
    handler: async (
      _request: HttpRequest,
      context: InvocationContext,
    ): Promise<HttpResponseInit> => {
      const deps = getDeps();
      const probes: Array<{ name: string; ok: boolean; detail: string }> = [];

      // Probe 1: clock — NS rejects OAuth timestamps drifted >5min from server.
      const nodeNow = new Date();
      probes.push({
        name: 'clock',
        ok: true,
        detail: `node now=${nodeNow.toISOString()} (Az host time; NS expects <5 min drift)`,
      });

      // Probe 2: read via SuiteQL by finding a customer.
      try {
        const r = await deps.ns.findByExternalId({
          nsAccountId: deps.nsAccountId,
          recordType: 'customer' as Parameters<NetSuiteGateway['findByExternalId']>[0]['recordType'],
          externalId: 'definitely-does-not-exist-' + Date.now(),
        });
        probes.push({
          name: 'read (findByExternalId customer)',
          ok: true,
          detail: r === null ? 'no row (expected)' : 'row returned',
        });
      } catch (err) {
        probes.push({
          name: 'read (findByExternalId customer)',
          ok: false,
          detail: errMsg(err),
        });
      }

      if (deps.allowWrites) {
        // Probe 3: write via upsertByExternalId — the path that's failing.
        const externalId = `diag-${Date.now()}`;
        try {
          const r = await deps.ns.upsertByExternalId({
            nsAccountId: deps.nsAccountId,
            recordType: 'customer' as Parameters<NetSuiteGateway['upsertByExternalId']>[0]['recordType'],
            externalId,
            payload: {
              isperson: true,
              firstname: 'Diag',
              lastname: 'Probe',
              email: 'diagnostic-probe@example.com',
              phone: '+15555550100',
              subsidiary: deps.nsSubsidiary,
            },
          });
          probes.push({
            name: 'write (upsertByExternalId customer)',
            ok: true,
            detail: `internalId=${r.internalId} created=${r.created}`,
          });
        } catch (err) {
          probes.push({
            name: 'write (upsertByExternalId customer)',
            ok: false,
            detail: errMsg(err),
          });
        }
      } else {
        probes.push({
          name: 'write (upsertByExternalId customer)',
          ok: true,
          detail: 'skipped (ENABLE_NS_DIAGNOSTIC_WRITES!=true)',
        });
      }

      context.log(`ns-diagnostic probes: ${JSON.stringify(probes)}`);
      return {
        status: 200,
        jsonBody: {
          accountId: deps.nsAccountId,
          subsidiary: deps.nsSubsidiary,
          probes,
        },
      };
    },
  });
}

function errMsg(err: unknown): string {
  const e = err as { name?: string; message?: string; status?: number; code?: string; details?: unknown };
  return `${e.name ?? '?'} status=${e.status ?? '?'} code=${e.code ?? '?'} message=${e.message ?? String(err)} details=${JSON.stringify(e.details).slice(0, 400)}`;
}
