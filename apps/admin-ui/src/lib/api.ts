/**
 * Tiny fetch wrapper for the admin API.
 *
 * The UI always issues same-origin requests to `/api/ops/*`. In dev, the
 * Vite proxy (vite.config.ts) forwards them to the deployed function app
 * with the function-key header attached. In prod (Static Web Apps), the
 * SWA platform forwards to the linked function app and adds the
 * `x-ms-client-principal` header transparently — no manual auth here.
 */

export interface AdminStatusResponse {
  readonly environment: string;
  readonly counts: {
    readonly imported: number;
    readonly parked: number;
    readonly ignored: number;
    readonly total: number;
  };
  readonly last24h: {
    readonly imported: number;
    readonly parked: number;
  };
  readonly mostRecent: ReadonlyArray<RecentOrderRow>;
  readonly drift: {
    readonly snapshotsWithDrift: number;
    readonly mostRecentBusinessDate: string | null;
  };
}

export interface RecentOrderRow {
  readonly shopifyOrderId: string;
  readonly shopifyOrderName: string | null;
  readonly connectionId: string;
  readonly status: 'imported' | 'parked' | 'ignored';
  readonly customerEmail: string | null;
  readonly totalPrice: string | null;
  readonly currencyCode: string | null;
  readonly nsInternalId: string | null;
  readonly syncedAt: string | null;
  readonly updatedAt: string;
}

export interface AdminOrdersResponse {
  readonly rows: ReadonlyArray<RecentOrderRow>;
  readonly nextOffset: number | null;
  readonly total: number;
}

export interface OrdersQuery {
  readonly limit?: number;
  readonly offset?: number;
  readonly connectionId?: string;
  readonly status?: 'imported' | 'parked' | 'ignored';
  readonly search?: string;
}

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = 'ApiError';
  }
}

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, {
    headers: { Accept: 'application/json' },
    credentials: 'include',
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new ApiError(res.status, text || `${res.status} ${res.statusText}`);
  }
  return (await res.json()) as T;
}

export interface OrderDetail {
  readonly shopifyOrderGid: string;
  readonly shopifyOrderId: string;
  readonly shopifyOrderName: string | null;
  readonly connectionId: string;
  readonly status: 'imported' | 'parked' | 'ignored';
  readonly customerEmail: string | null;
  readonly currencyCode: string | null;
  readonly totalPrice: string | null;
  readonly subtotalPrice: string | null;
  readonly totalTax: string | null;
  readonly totalDiscounts: string | null;
  readonly totalShipping: string | null;
  readonly shopifyCreatedAt: string | null;
  readonly shopifyProcessedAt: string | null;
  readonly nsAccountId: string | null;
  readonly nsRecordType: string | null;
  readonly nsInternalId: string | null;
  readonly nsTranId: string | null;
  readonly parkStage: string | null;
  readonly parkDetail: string | null;
  readonly parkErrorClass: string | null;
  readonly ignoredReason: string | null;
  readonly syncedAt: string | null;
  readonly updatedAt: string;
}

export interface OrderAttempt {
  readonly deliveryCount: number;
  readonly outcome: string;
  readonly stage: string | null;
  readonly errorClass: string | null;
  readonly detail: string | null;
  readonly inboundEnvelopeUri: string | null;
  readonly outboundPayloadUri: string | null;
  readonly nsResponseUri: string | null;
  readonly nsResponseStatus: number | null;
  readonly shopifyPayloadUri: string | null;
  readonly payloadDigest: Record<string, unknown> | null;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
}

export interface OrderDetailResponse {
  readonly order: OrderDetail;
  readonly attempts: ReadonlyArray<OrderAttempt>;
}

export interface ReconciliationRow {
  readonly businessDate: string;
  readonly connectionId: string;
  readonly shopifyOrderCount: number;
  readonly nsTxnCount: number;
  readonly shopifyTotal: string;
  readonly nsTotal: string;
  readonly discrepancy: Record<string, unknown> | null;
  readonly createdAt: string;
}

export interface ReconciliationResponse {
  readonly rows: ReadonlyArray<ReconciliationRow>;
}

export interface ReplayResponse {
  readonly ok: boolean;
  readonly outcome?: 'replayed' | 'refused_already_synced' | 'unknown_connection';
  readonly previousStatus?: string;
  readonly sessionId?: string;
  readonly targetId?: string;
  readonly detail?: string;
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  });
  // For replay, 202 = success, 409 = refused_already_synced (still want body), 404 = unknown
  const json = (await res.json().catch(() => ({}))) as T;
  if (!res.ok && res.status !== 409 && res.status !== 404) {
    throw new ApiError(res.status, JSON.stringify(json));
  }
  return json;
}

export interface ConnectionRow {
  readonly connectionId: string;
  readonly environment: string;
  readonly shopifyStore: string;
  readonly nsAccountId: string;
  readonly nsSubsidiary: string;
  readonly nsLocation: string | null;
  readonly baseCurrency: string;
  readonly taxEngine: 'suitetax' | 'legacy';
  readonly orderTarget: 'sales_order' | 'cash_sale';
  readonly mapVersion: string;
  readonly enabled: boolean;
  readonly defaultShipItemId: string | null;
  readonly defaultDiscountItemId: string | null;
  readonly defaultItemId: string | null;
  readonly writeTagsOnImport: boolean;
  readonly extraOrderHeaderMappingsCount: number;
}

export interface ConnectionsResponse {
  readonly rows: ReadonlyArray<ConnectionRow>;
}

export interface ReconcileRunResult {
  readonly ok: boolean;
  readonly perConnection: ReadonlyArray<{
    readonly connectionId: string;
    readonly businessDate: string;
    readonly drift: boolean;
    readonly skipped: string | null;
    readonly snapshot: {
      readonly shopifyOrderCount: number;
      readonly nsTxnCount: number;
      readonly shopifyTotal: string;
      readonly nsTotal: string;
      readonly discrepancy: Record<string, unknown> | null;
    } | null;
  }>;
}

export const api = {
  status: (): Promise<AdminStatusResponse> => get('/api/ops/status'),
  orders: (q: OrdersQuery = {}): Promise<AdminOrdersResponse> => {
    const params = new URLSearchParams();
    if (q.limit !== undefined) params.set('limit', String(q.limit));
    if (q.offset !== undefined) params.set('offset', String(q.offset));
    if (q.connectionId) params.set('connection', q.connectionId);
    if (q.status) params.set('status', q.status);
    if (q.search) params.set('search', q.search);
    const qs = params.toString();
    return get<AdminOrdersResponse>(`/api/ops/orders${qs ? `?${qs}` : ''}`);
  },
  orderDetail: (connectionId: string, orderId: string): Promise<OrderDetailResponse> => {
    const params = new URLSearchParams({ connection: connectionId, orderId });
    return get<OrderDetailResponse>(`/api/ops/orders/detail?${params.toString()}`);
  },
  reconciliation: (opts: { limit?: number; connection?: string; driftOnly?: boolean } = {}): Promise<ReconciliationResponse> => {
    const params = new URLSearchParams();
    if (opts.limit !== undefined) params.set('limit', String(opts.limit));
    if (opts.connection) params.set('connection', opts.connection);
    if (opts.driftOnly) params.set('drift', 'true');
    const qs = params.toString();
    return get<ReconciliationResponse>(`/api/ops/reconciliation${qs ? `?${qs}` : ''}`);
  },
  replay: (connectionId: string, orderGid: string, force = false): Promise<ReplayResponse> => {
    return postJson<ReplayResponse>('/api/ops/replay', { connectionId, orderGid, force });
  },
  connections: (): Promise<ConnectionsResponse> => get('/api/ops/connections'),
  reconcileRun: (daysBack = 1): Promise<ReconcileRunResult> =>
    postJson<ReconcileRunResult>('/api/ops/reconcile/run', { daysBack }),
  /**
   * Fetch the raw bytes of an archived payload (inbound envelope, outbound NS
   * request, or NS response). Returns the body as a string — the proxy always
   * serves application/json so callers can `JSON.parse(text)` for pretty
   * rendering and fall back to raw text on parse error.
   */
  payload: async (uri: string): Promise<{ body: string; size: number; contentType: string }> => {
    const params = new URLSearchParams({ uri });
    const res = await fetch(`/api/ops/payload?${params.toString()}`, {
      headers: { Accept: 'application/json' },
      credentials: 'include',
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new ApiError(res.status, text || `${res.status} ${res.statusText}`);
    }
    return {
      body: await res.text(),
      size: Number(res.headers.get('content-length') ?? 0),
      contentType: res.headers.get('content-type') ?? 'application/json',
    };
  },
  /**
   * HEAD the proxy to learn a payload's size before downloading it. UI uses
   * this to short-circuit rendering for large payloads (>256 KB).
   */
  payloadHead: async (uri: string): Promise<{ size: number; contentType: string }> => {
    const params = new URLSearchParams({ uri });
    const res = await fetch(`/api/ops/payload?${params.toString()}`, {
      method: 'HEAD',
      credentials: 'include',
    });
    if (!res.ok) {
      throw new ApiError(res.status, `${res.status} ${res.statusText}`);
    }
    return {
      size: Number(res.headers.get('content-length') ?? 0),
      contentType: res.headers.get('content-type') ?? 'application/json',
    };
  },
};
