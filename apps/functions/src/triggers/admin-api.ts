import {
  app,
  type HttpRequest,
  type HttpResponseInit,
  type InvocationContext,
} from '@azure/functions';
import type pg from 'pg';
import type { Connection, ConnectionsRepo, Environment } from '@dpi/core';
import {
  runReconciliation,
  type ReconciliationDeps,
} from './reconciliation-sweep.js';

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
  /** For /api/admin/connections — exposed read-only. */
  readonly connections: ConnectionsRepo;
  /**
   * For /api/admin/reconcile/run — runs the sweep handler on-demand.
   * Optional so a Slice-A-only env can boot without it.
   */
  readonly reconciliation?: ReconciliationDeps;
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

export async function handleAdminConnections(deps: AdminApiDeps): Promise<HttpResponseInit> {
  const list = await deps.connections.listEnabled(deps.environment);
  // Strip secret refs from the response — refs are not secrets, but exposing
  // them on a UI surface is unnecessary detail. Operators have CLI access if
  // they need to inspect the refs.
  const safeRows = list.map((c: Connection) => ({
    connectionId: c.connectionId,
    environment: c.environment,
    shopifyStore: c.shopifyStore,
    nsAccountId: c.nsAccountId,
    nsSubsidiary: c.nsSubsidiary,
    nsLocation: c.nsLocation ?? null,
    baseCurrency: c.baseCurrency,
    taxEngine: c.taxEngine,
    orderTarget: c.orderTarget,
    mapVersion: c.mapVersion,
    enabled: c.enabled,
    defaultShipItemId: c.defaultShipItemId ?? null,
    defaultDiscountItemId: c.defaultDiscountItemId ?? null,
    writeTagsOnImport: c.writeTagsOnImport ?? false,
    extraOrderHeaderMappingsCount: c.extraOrderHeaderMappings?.length ?? 0,
  }));
  return { status: 200, jsonBody: { rows: safeRows } };
}

export async function handleAdminReconcileRun(
  deps: AdminApiDeps,
  body: string,
): Promise<HttpResponseInit> {
  if (!deps.reconciliation) {
    return { status: 503, jsonBody: { ok: false, reason: 'not_ready' } };
  }
  let parsed: { daysBack?: number } = {};
  if (body) {
    try {
      parsed = JSON.parse(body) as { daysBack?: number };
    } catch {
      // Empty / malformed body → use defaults (most callers POST {} or nothing).
    }
  }
  const daysBack = Math.max(1, Math.min(7, Number(parsed.daysBack ?? 1)));
  const outcome = await runReconciliation(deps.reconciliation, {
    schedule: '',
    daysBack,
    totalToleranceAmount: 0.05,
  });
  return {
    status: 200,
    jsonBody: {
      ok: true,
      perConnection: outcome.perConnection.map((r) => ({
        connectionId: r.connectionId,
        businessDate: r.businessDate,
        drift: r.drift,
        skipped: r.skipped ?? null,
        snapshot:
          r.snapshot !== undefined
            ? {
                shopifyOrderCount: r.snapshot.shopifyOrderCount,
                nsTxnCount: r.snapshot.nsTxnCount,
                shopifyTotal: r.snapshot.shopifyTotal,
                nsTotal: r.snapshot.nsTotal,
                discrepancy: r.snapshot.discrepancy,
              }
            : null,
      })),
    },
  };
}

export async function handleAdminOrderDetail(
  deps: AdminApiDeps,
  query: URLSearchParams,
): Promise<HttpResponseInit> {
  const env = deps.environment;
  const pool = deps.pgPool;

  const connectionId = (query.get('connection') ?? '').trim();
  const orderIdRaw = (query.get('orderId') ?? '').trim();
  if (!connectionId || !orderIdRaw) {
    return {
      status: 400,
      jsonBody: { ok: false, reason: 'bad_request', detail: 'connection + orderId required' },
    };
  }
  // Accept either the bare numeric id or the full GID; normalize to GID.
  const orderGid = /^gid:\/\/shopify\/Order\/\d+$/.test(orderIdRaw)
    ? orderIdRaw
    : /^\d+$/.test(orderIdRaw)
      ? `gid://shopify/Order/${orderIdRaw}`
      : undefined;
  if (orderGid === undefined) {
    return {
      status: 400,
      jsonBody: { ok: false, reason: 'bad_request', detail: 'orderId must be numeric or full GID' },
    };
  }

  // Order header from order_sync_log.
  const rowRes = await pool.query<RecentRowDb & {
    shopify_created_at: string | null;
    shopify_processed_at: string | null;
    subtotal_price: string | null;
    total_tax: string | null;
    total_discounts: string | null;
    total_shipping: string | null;
    park_stage: string | null;
    park_detail: string | null;
    park_error_class: string | null;
    ignored_reason: string | null;
    ns_record_type: string | null;
    ns_account_id: string | null;
    ns_tran_id: string | null;
  }>(
    `SELECT shopify_order_id, shopify_order_name, connection_id, status,
            customer_email, total_price::text AS total_price, currency_code,
            subtotal_price::text AS subtotal_price, total_tax::text AS total_tax,
            total_discounts::text AS total_discounts, total_shipping::text AS total_shipping,
            shopify_created_at::text AS shopify_created_at,
            shopify_processed_at::text AS shopify_processed_at,
            ns_internal_id, ns_record_type, ns_account_id, ns_tran_id,
            park_stage, park_detail, park_error_class, ignored_reason,
            synced_at::text AS synced_at, updated_at::text AS updated_at
       FROM order_sync_log
      WHERE environment=$1 AND connection_id=$2 AND shopify_order_gid=$3
      LIMIT 1`,
    [env, connectionId, orderGid],
  );
  if (rowRes.rows.length === 0) {
    return { status: 404, jsonBody: { ok: false, reason: 'not_found' } };
  }
  const head = rowRes.rows[0]!;

  // Attempts timeline (newest first so the view defaults to "latest delivery").
  const attemptsRes = await pool.query<{
    delivery_count: number;
    outcome: string;
    stage: string | null;
    error_class: string | null;
    detail: string | null;
    inbound_envelope_uri: string | null;
    outbound_payload_uri: string | null;
    payload_digest: Record<string, unknown> | null;
    started_at: string;
    finished_at: string;
    duration_ms: number;
  }>(
    `SELECT delivery_count, outcome, stage, error_class, detail,
            inbound_envelope_uri, outbound_payload_uri, payload_digest,
            started_at::text AS started_at, finished_at::text AS finished_at, duration_ms
       FROM order_attempt
      WHERE environment=$1 AND connection_id=$2 AND shopify_order_gid=$3
      ORDER BY started_at DESC
      LIMIT 50`,
    [env, connectionId, orderGid],
  );

  return {
    status: 200,
    jsonBody: {
      order: {
        shopifyOrderGid: orderGid,
        shopifyOrderId: head.shopify_order_id,
        shopifyOrderName: head.shopify_order_name,
        connectionId: head.connection_id,
        status: head.status,
        customerEmail: head.customer_email,
        currencyCode: head.currency_code,
        totalPrice: head.total_price,
        subtotalPrice: head.subtotal_price,
        totalTax: head.total_tax,
        totalDiscounts: head.total_discounts,
        totalShipping: head.total_shipping,
        shopifyCreatedAt: head.shopify_created_at,
        shopifyProcessedAt: head.shopify_processed_at,
        nsAccountId: head.ns_account_id,
        nsRecordType: head.ns_record_type,
        nsInternalId: head.ns_internal_id,
        nsTranId: head.ns_tran_id,
        parkStage: head.park_stage,
        parkDetail: head.park_detail,
        parkErrorClass: head.park_error_class,
        ignoredReason: head.ignored_reason,
        syncedAt: head.synced_at,
        updatedAt: head.updated_at,
      },
      attempts: attemptsRes.rows.map((a) => ({
        deliveryCount: a.delivery_count,
        outcome: a.outcome,
        stage: a.stage,
        errorClass: a.error_class,
        detail: a.detail,
        inboundEnvelopeUri: a.inbound_envelope_uri,
        outboundPayloadUri: a.outbound_payload_uri,
        payloadDigest: a.payload_digest,
        startedAt: a.started_at,
        finishedAt: a.finished_at,
        durationMs: a.duration_ms,
      })),
    },
  };
}

export async function handleAdminReconciliation(
  deps: AdminApiDeps,
  query: URLSearchParams,
): Promise<HttpResponseInit> {
  const env = deps.environment;
  const pool = deps.pgPool;

  const limit = clampInt(query.get('limit'), 30, 1, 200);
  const connectionId = query.get('connection') ?? undefined;
  const driftOnly = query.get('drift') === 'true';

  const clauses: string[] = ['environment = $1'];
  const params: unknown[] = [env];
  if (connectionId) {
    params.push(connectionId);
    clauses.push(`connection_id = $${params.length}`);
  }
  if (driftOnly) {
    clauses.push(`discrepancy IS NOT NULL`);
  }
  params.push(limit);
  const limitIdx = params.length;

  const r = await pool.query<{
    business_date: string;
    connection_id: string;
    shopify_order_count: number;
    ns_txn_count: number;
    shopify_total: string;
    ns_total: string;
    discrepancy: Record<string, unknown> | null;
    created_at: string;
  }>(
    `SELECT business_date::text, connection_id,
            shopify_order_count, ns_txn_count,
            shopify_total::text, ns_total::text,
            discrepancy, created_at::text
       FROM reconciliation_snapshots
      WHERE ${clauses.join(' AND ')}
      ORDER BY business_date DESC, connection_id
      LIMIT $${limitIdx}`,
    params,
  );

  return {
    status: 200,
    jsonBody: {
      rows: r.rows.map((row) => ({
        businessDate: row.business_date,
        connectionId: row.connection_id,
        shopifyOrderCount: Number(row.shopify_order_count),
        nsTxnCount: Number(row.ns_txn_count),
        shopifyTotal: row.shopify_total,
        nsTotal: row.ns_total,
        discrepancy: row.discrepancy,
        createdAt: row.created_at,
      })),
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
    authLevel: 'anonymous',
    route: 'ops/status',
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
    authLevel: 'anonymous',
    route: 'ops/orders',
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

  app.http('adminOrderDetail', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'ops/orders/detail',
    handler: async (
      request: HttpRequest,
      context: InvocationContext,
    ): Promise<HttpResponseInit> => {
      const deps = getDeps();
      if (!deps) {
        context.log('adminOrderDetail not_ready');
        return { status: 503, jsonBody: { ok: false, reason: 'not_ready' } };
      }
      const url = new URL(request.url);
      return handleAdminOrderDetail(deps, url.searchParams);
    },
  });

  app.http('adminReconciliation', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'ops/reconciliation',
    handler: async (
      request: HttpRequest,
      context: InvocationContext,
    ): Promise<HttpResponseInit> => {
      const deps = getDeps();
      if (!deps) {
        context.log('adminReconciliation not_ready');
        return { status: 503, jsonBody: { ok: false, reason: 'not_ready' } };
      }
      const url = new URL(request.url);
      return handleAdminReconciliation(deps, url.searchParams);
    },
  });

  app.http('adminConnections', {
    methods: ['GET'],
    authLevel: 'anonymous',
    route: 'ops/connections',
    handler: async (
      _request: HttpRequest,
      context: InvocationContext,
    ): Promise<HttpResponseInit> => {
      const deps = getDeps();
      if (!deps) {
        context.log('adminConnections not_ready');
        return { status: 503, jsonBody: { ok: false, reason: 'not_ready' } };
      }
      return handleAdminConnections(deps);
    },
  });

  app.http('adminReconcileRun', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'ops/reconcile/run',
    handler: async (
      request: HttpRequest,
      context: InvocationContext,
    ): Promise<HttpResponseInit> => {
      const deps = getDeps();
      if (!deps) {
        context.log('adminReconcileRun not_ready');
        return { status: 503, jsonBody: { ok: false, reason: 'not_ready' } };
      }
      const body = await request.text();
      return handleAdminReconcileRun(deps, body);
    },
  });
}
