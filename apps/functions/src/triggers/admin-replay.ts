import {
  app,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from '@azure/functions';
import {
  requestReplay,
  type ConnectionsRepo,
  type Environment,
  type QueueProducer,
  type XrefStore,
  type OrderWebhookMessageBody,
} from '@dpi/core';

/**
 * REST admin: trigger a replay of a single order through the import pipeline.
 *
 * POST /api/admin/replay
 * Body:
 *   {
 *     "connectionId": "dev-store-1",
 *     "orderGid": "gid://shopify/Order/123" | "123",   // bare numeric id accepted
 *     "force": false                                    // override already_synced refusal
 *   }
 *
 * Auth: `function` level — caller must present `x-functions-key` matching the
 * function key. M2 acceptance ("REST + CLI replay (idempotent)") doesn't
 * require Entra; the function key gates ops access without the Easy-Auth +
 * app-registration setup. Upgrade path: layer Easy Auth via Bicep when more
 * than one operator needs the surface.
 *
 * Behavior maps 1:1 to `requestReplay` outcomes; status codes:
 *   replayed                   → 202 Accepted (work is enqueued; pipeline runs async)
 *   refused_already_synced     → 409 Conflict (use `force: true` to override)
 *   unknown_connection         → 404 Not Found
 *   bad_request                → 400 (missing field, malformed gid)
 *   not_ready                  → 503 (xrefStore not wired — bootstrap missing PG)
 */
export interface ReplayDeps {
  readonly environment: Environment;
  readonly connections: ConnectionsRepo;
  readonly xrefStore: XrefStore | undefined;
  readonly queue: QueueProducer<OrderWebhookMessageBody>;
}

interface RequestBody {
  connectionId?: string;
  orderGid?: string;
  force?: boolean;
  topic?: string;
}

export async function handleAdminReplay(
  deps: ReplayDeps,
  rawBody: string,
): Promise<HttpResponseInit> {
  if (!deps.xrefStore) {
    return {
      status: 503,
      jsonBody: { ok: false, reason: 'not_ready', detail: 'xref store not wired' },
    };
  }

  let parsed: RequestBody;
  try {
    parsed = JSON.parse(rawBody) as RequestBody;
  } catch {
    return {
      status: 400,
      jsonBody: { ok: false, reason: 'bad_request', detail: 'body is not valid JSON' },
    };
  }

  const { connectionId } = parsed;
  if (typeof connectionId !== 'string' || connectionId.length === 0) {
    return {
      status: 400,
      jsonBody: { ok: false, reason: 'bad_request', detail: 'connectionId required' },
    };
  }
  const orderGid = normalizeOrderGid(parsed.orderGid);
  if (orderGid === undefined) {
    return {
      status: 400,
      jsonBody: { ok: false, reason: 'bad_request', detail: 'orderGid required (gid:// or numeric)' },
    };
  }

  const outcome = await requestReplay(
    {
      xrefStore: deps.xrefStore,
      connections: deps.connections,
      queue: deps.queue,
    },
    {
      environment: deps.environment,
      connectionId,
      orderGid,
      ...(parsed.force ? { force: true } : {}),
      ...(parsed.topic ? { topic: parsed.topic } : {}),
    },
  );

  switch (outcome.outcome) {
    case 'replayed':
      return {
        status: 202,
        jsonBody: {
          ok: true,
          outcome: 'replayed',
          previousStatus: outcome.previousStatus,
          sessionId: outcome.sessionId,
        },
      };
    case 'refused_already_synced':
      return {
        status: 409,
        jsonBody: {
          ok: false,
          outcome: 'refused_already_synced',
          detail: 'order already imported; pass force=true to re-replay',
          targetId: outcome.targetId,
        },
      };
    case 'unknown_connection':
      return {
        status: 404,
        jsonBody: { ok: false, outcome: 'unknown_connection', connectionId },
      };
  }
}

/**
 * Accept either a bare numeric id ("123") or a full GID ("gid://shopify/Order/123").
 * Returns undefined for empty / non-matching input so the handler can 400.
 */
export function normalizeOrderGid(input: unknown): string | undefined {
  if (typeof input !== 'string' || input.length === 0) return undefined;
  if (/^gid:\/\/shopify\/Order\/\d+$/.test(input)) return input;
  if (/^\d+$/.test(input)) return `gid://shopify/Order/${input}`;
  return undefined;
}

export function registerAdminReplay(getDeps: () => ReplayDeps): void {
  app.http('adminReplay', {
    methods: ['POST'],
    authLevel: 'function',
    route: 'admin/replay',
    handler: async (
      request: HttpRequest,
      context: InvocationContext,
    ): Promise<HttpResponseInit> => {
      const rawBody = await request.text();
      const res = await handleAdminReplay(getDeps(), rawBody);
      const summary = summarize(res.jsonBody);
      context.log(`adminReplay status=${res.status} ${summary}`);
      return res;
    },
  });
}

function summarize(body: unknown): string {
  if (typeof body !== 'object' || body === null) return '';
  const b = body as Record<string, unknown>;
  return Object.entries(b)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' ');
}
