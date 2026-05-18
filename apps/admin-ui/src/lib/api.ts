/**
 * Tiny fetch wrapper for the admin API.
 *
 * The UI always issues same-origin requests to `/api/admin/*`. In dev, the
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

export const api = {
  status: (): Promise<AdminStatusResponse> => get('/api/admin/status'),
  orders: (q: OrdersQuery = {}): Promise<AdminOrdersResponse> => {
    const params = new URLSearchParams();
    if (q.limit !== undefined) params.set('limit', String(q.limit));
    if (q.offset !== undefined) params.set('offset', String(q.offset));
    if (q.connectionId) params.set('connection', q.connectionId);
    if (q.status) params.set('status', q.status);
    if (q.search) params.set('search', q.search);
    const qs = params.toString();
    return get<AdminOrdersResponse>(`/api/admin/orders${qs ? `?${qs}` : ''}`);
  },
};
