import {
  app,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from '@azure/functions';
import type pg from 'pg';
import type { Environment } from '@dpi/core';

/**
 * Admin API surface backing the dpi admin UI (apps/admin-ui).
 *
 * Routes:
 *   GET /api/admin/status   — counts by status + last24h activity + recent rows + drift summary
 *   GET /api/admin/orders   — paginated order_sync_log with filter / search
 *
 * Both are function-key authenticated for now. In prod (Azure Static Web
 * Apps), the SWA-to-FunctionApp link covers auth via the linked-backend
 * contract; the function key is still required at the edge but injected by
 * the SWA platform.
 *
 * The handlers are pg.Pool-only (no XrefStore / OrderSyncLogStore abstractions)
 * because the UI's query shapes are read-mostly and don't fit the dedup-focused
 * interfaces cleanly. Trade-off: a small amount of SQL duplication here vs
 * fattening the store interfaces with admin-shaped methods.
 */

export interface AdminApiDeps {
  readonly environment: Environment;
  readonly pgPool: pg.Pool;
}

interface RecentOrderRow {
  shopifyOrderId: string;
  shopifyOrderName: string | null;
  connectionId: string;
  status: 'imported' | 'parked' | 'ignored';
  customerEmail: string | null;
  totalPrice: string | null;
  currencyCode: string | null;
  nsInternalId: string | null;
  syncedAt: string | null;
  updatedAt: string;
}

export async function handleAdminStatus(deps: AdminApiDeps): Promise<HttpResponseInit> {
  const env = deps.environment;
  const pool = deps.pgPool;

  // Counts by status across the whole ledger.
  const countsRes = await pool.query<{ status: string; count: string }>(
    `SELECT status, COUNT(*)::text AS count
       FROM order_sync_log
      WHERE environment = $1
      GROUP BY status`,
    [env],
  );
  const counts = { imported: 0, parked: 0, ignored: 0, total: 0 };
  for (const r of countsRes.rows) {
    const n = Number(r.count);
    if (r.status === 'imported') counts.imported = n;
    else if (r.status === 'parked') counts.parked = n;
    else if (r.status === 'ignored') counts.ignored = n;
  }
  counts.total = counts.imported + counts.parked + counts.ignored;

  // 24h activity windows.
  const last24Res = await pool.query<{ status: string; count: string }>(
    `SELECT status, COUNT(*)::text AS count
       FROM order_sync_log
      WHERE environment = $1
        AND COALESCE(synced_at, updated_at) >= NOW() - INTERVAL '24 hours'
      GROUP BY status`,
    [env],
  );
  const last24h = { imported: 0, parked: 0 };
  for (const r of last24Res.rows) {
    const n = Number(r.count);
    if (r.status === 'imported') last24h.imported = n;
    else if (r.status === 'parked') last24h.parked = n;
  }

  // Most recent 10 outcomes.
  const recentRes = await pool.query<RecentRowDb>(
    `SELECT shopify_order_id, shopify_order_name, connection_id, status,
            customer_email, total_price::text AS total_price, currency_code,
            ns_internal_id, synced_at::text AS synced_at, updated_at::text AS updated_at
       FROM order_sync_log
      WHERE environment = $1
      ORDER BY COALESCE(synced_at, updated_at) DESC
      LIMIT 10`,
    [env],
  );

  // Drift summary from reconciliation_snapshots.
  const driftRes = await pool.query<{ count: string; most_recent: string | null }>(
    `SELECT COUNT(*)::text AS count, MAX(business_date)::text AS most_recent
       FROM reconciliation_snapshots
      WHERE environment = $1 AND discrepancy IS NOT NULL`,
    [env],
  );
  const driftRow = driftRes.rows[0];

  return {
    status: 200,
    jsonBody: {
      environment: env,
      counts,
      last24h,
      mostRecent: recentRes.rows.map(toRecentOrderRow),
      drift: {
        snapshotsWithDrift: Number(driftRow?.count ?? '0'),
        mostRecentBusinessDate: driftRow?.most_recent ?? null,
      },
    },
  };
}

export async function handleAdminOrders(
  deps: AdminApiDeps,
  query: URLSearchParams,
): Promise<HttpResponseInit> {
  const env = deps.environment;
  const pool = deps.pgPool;

  // Parse query params with safe defaults + bounds.
  const limit = clampInt(query.get('limit'), 25, 1, 200);
  const offset = Math.max(0, Number.parseInt(query.get('offset') ?? '0', 10) || 0);
  const connectionId = query.get('connection') ?? undefined;
  const statusParam = query.get('status');
  const status =
    statusParam === 'imported' || statusParam === 'parked' || statusParam === 'ignored'
      ? statusParam
      : undefined;
  const search = (query.get('search') ?? '').trim();

  const clauses: string[] = ['environment = $1'];
  const params: unknown[] = [env];
  if (connectionId) {
    params.push(connectionId);
    clauses.push(`connection_id = $${params.length}`);
  }
  if (status) {
    params.push(status);
    clauses.push(`status = $${params.length}`);
  }
  if (search) {
    // Free-text against the three columns most useful for "find this order":
    // shopify_order_id, customer_email, ns_internal_id. ILIKE keeps it
    // case-insensitive; we anchor each pattern with %…%.
    params.push(`%${search}%`);
    const idx = params.length;
    clauses.push(
      `(shopify_order_id ILIKE $${idx} OR customer_email ILIKE $${idx} OR ns_internal_id ILIKE $${idx} OR shopify_order_name ILIKE $${idx})`,
    );
  }

  // Total + page in parallel — the count is for the pagination footer.
  const where = clauses.join(' AND ');
  const totalRes = await pool.query<{ total: string }>(
    `SELECT COUNT(*)::text AS total FROM order_sync_log WHERE ${where}`,
    params,
  );
  const total = Number(totalRes.rows[0]?.total ?? '0');

  params.push(limit);
  const limitIdx = params.length;
  params.push(offset);
  const offsetIdx = params.length;
  const rowsRes = await pool.query<RecentRowDb>(
    `SELECT shopify_order_id, shopify_order_name, connection_id, status,
            customer_email, total_price::text AS total_price, currency_code,
            ns_internal_id, synced_at::text AS synced_at, updated_at::text AS updated_at
       FROM order_sync_log
      WHERE ${where}
      ORDER BY COALESCE(synced_at, updated_at) DESC
      LIMIT $${limitIdx} OFFSET $${offsetIdx}`,
    params,
  );

  const rows = rowsRes.rows.map(toRecentOrderRow);
  const nextOffset = offset + rows.length < total ? offset + rows.length : null;

  return {
    status: 200,
    jsonBody: { rows, nextOffset, total },
  };
}

interface RecentRowDb {
  shopify_order_id: string;
  shopify_order_name: string | null;
  connection_id: string;
  status: 'imported' | 'parked' | 'ignored';
  customer_email: string | null;
  total_price: string | null;
  currency_code: string | null;
  ns_internal_id: string | null;
  synced_at: string | null;
  updated_at: string;
}

function toRecentOrderRow(r: RecentRowDb): RecentOrderRow {
  return {
    shopifyOrderId: r.shopify_order_id,
    shopifyOrderName: r.shopify_order_name,
    connectionId: r.connection_id,
    status: r.status,
    customerEmail: r.customer_email,
    totalPrice: r.total_price,
    currencyCode: r.currency_code,
    nsInternalId: r.ns_internal_id,
    syncedAt: r.synced_at,
    updatedAt: r.updated_at,
  };
}

function clampInt(raw: string | null, fallback: number, lo: number, hi: number): number {
  if (raw === null) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

export function registerAdminApi(getDeps: () => AdminApiDeps | undefined): void {
  app.http('adminStatus', {
    methods: ['GET'],
    authLevel: 'function',
    route: 'admin/status',
    handler: async (
      _request: HttpRequest,
      context: InvocationContext,
    ): Promise<HttpResponseInit> => {
      const deps = getDeps();
      if (!deps) {
        context.log('adminStatus not_ready');
        return { status: 503, jsonBody: { ok: false, reason: 'not_ready' } };
      }
      return handleAdminStatus(deps);
    },
  });

  app.http('adminOrders', {
    methods: ['GET'],
    authLevel: 'function',
    route: 'admin/orders',
    handler: async (
      request: HttpRequest,
      context: InvocationContext,
    ): Promise<HttpResponseInit> => {
      const deps = getDeps();
      if (!deps) {
        context.log('adminOrders not_ready');
        return { status: 503, jsonBody: { ok: false, reason: 'not_ready' } };
      }
      const url = new URL(request.url);
      return handleAdminOrders(deps, url.searchParams);
    },
  });
}
