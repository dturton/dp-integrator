import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, ApiError, type AdminOrdersResponse, type OrdersQuery, type RecentOrderRow } from '@/lib/api';
import { cn } from '@/lib/utils';

const PAGE_SIZE = 25;

type StatusFilter = 'all' | 'imported' | 'parked' | 'ignored';

/**
 * Paginated browser over order_sync_log. Filter by status; search by order
 * number / email / NS internal id (free-text). Connection-id filter is a
 * future slice — for now we surface the connectionId in the table.
 */
export function Orders(): React.ReactElement {
  const [data, setData] = useState<AdminOrdersResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [offset, setOffset] = useState(0);
  const [status, setStatus] = useState<StatusFilter>('all');
  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');

  // Debounce free-text search so we don't fire on every keystroke.
  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchInput.trim()), 250);
    return (): void => clearTimeout(t);
  }, [searchInput]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const query: OrdersQuery = {
      limit: PAGE_SIZE,
      offset,
      ...(status !== 'all' ? { status } : {}),
      ...(debouncedSearch ? { search: debouncedSearch } : {}),
    };
    api
      .orders(query)
      .then((r) => {
        if (!cancelled) {
          setData(r);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          const msg =
            e instanceof ApiError ? `${e.status}: ${e.message}` : (e as Error).message ?? 'unknown';
          setError(msg);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return (): void => {
      cancelled = true;
    };
  }, [offset, status, debouncedSearch]);

  const total = data?.total ?? 0;
  const pageStart = offset + 1;
  const pageEnd = offset + (data?.rows.length ?? 0);
  const canPrev = offset > 0;
  const canNext = data?.nextOffset !== null && data?.nextOffset !== undefined;

  return (
    <div className="space-y-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold">Orders</h1>
        <p className="text-sm text-muted-foreground">
          Per-order ledger from `order_sync_log`. Filter or search to narrow.
        </p>
      </header>

      <Card>
        <CardHeader className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative max-w-xs flex-1">
              <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search order #, email, NS id…"
                value={searchInput}
                onChange={(e) => {
                  setSearchInput(e.target.value);
                  setOffset(0);
                }}
                className="pl-8"
              />
            </div>
            <div className="flex items-center gap-1">
              {(['all', 'imported', 'parked', 'ignored'] as const).map((opt) => (
                <Button
                  key={opt}
                  variant={status === opt ? 'default' : 'outline'}
                  size="sm"
                  onClick={() => {
                    setStatus(opt);
                    setOffset(0);
                  }}
                >
                  {opt === 'all' ? 'All' : opt[0]!.toUpperCase() + opt.slice(1)}
                </Button>
              ))}
            </div>
          </div>
          <CardTitle className="sr-only">Orders list</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {error && (
            <p className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">
              {error}
            </p>
          )}
          <OrdersTable rows={data?.rows ?? []} loading={loading} />
          <div className="flex items-center justify-between pt-2 text-xs text-muted-foreground">
            <div>
              {total === 0
                ? 'No orders matched.'
                : `Showing ${pageStart.toLocaleString()}–${pageEnd.toLocaleString()} of ${total.toLocaleString()}`}
            </div>
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="sm"
                disabled={!canPrev}
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              >
                <ChevronLeft className="h-3.5 w-3.5" />
                Prev
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!canNext}
                onClick={() => data?.nextOffset !== null && setOffset(data?.nextOffset ?? offset)}
              >
                Next
                <ChevronRight className="h-3.5 w-3.5" />
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

interface OrdersTableProps {
  rows: ReadonlyArray<RecentOrderRow>;
  loading: boolean;
}

function OrdersTable({ rows, loading }: OrdersTableProps): React.ReactElement {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-24 sm:w-32">Order</TableHead>
          <TableHead className="hidden sm:table-cell">Customer</TableHead>
          <TableHead className="w-24 sm:w-32">Total</TableHead>
          <TableHead className="w-24 sm:w-28">Status</TableHead>
          <TableHead className="hidden lg:table-cell w-32">Connection</TableHead>
          <TableHead className="hidden md:table-cell w-28">NS</TableHead>
          <TableHead className="hidden md:table-cell w-48">When</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {loading && (
          <TableRow>
            <TableCell colSpan={7} className="text-center text-muted-foreground">
              Loading…
            </TableCell>
          </TableRow>
        )}
        {!loading && rows.length === 0 && (
          <TableRow>
            <TableCell colSpan={7} className="text-center text-muted-foreground">
              No orders match the current filter.
            </TableCell>
          </TableRow>
        )}
        {rows.map((row) => (
          <TableRow key={`${row.connectionId}:${row.shopifyOrderId}`}>
            <TableCell className="font-mono text-xs">
              <Link
                to={`/orders/${row.shopifyOrderId}?connection=${encodeURIComponent(row.connectionId)}`}
                className="hover:underline"
              >
                {row.shopifyOrderName ?? `#${row.shopifyOrderId}`}
              </Link>
            </TableCell>
            <TableCell className={cn('hidden sm:table-cell text-muted-foreground truncate max-w-[16rem]', !row.customerEmail && 'italic')}>
              {row.customerEmail ?? 'guest'}
            </TableCell>
            <TableCell className="font-mono text-xs whitespace-nowrap">
              {row.totalPrice ? `${row.currencyCode ?? ''} ${Number(row.totalPrice).toFixed(2)}` : '—'}
            </TableCell>
            <TableCell>
              <StatusBadge status={row.status} />
            </TableCell>
            <TableCell className="hidden lg:table-cell text-xs">{row.connectionId}</TableCell>
            <TableCell className="hidden md:table-cell font-mono text-xs">
              {row.nsInternalId ? `SO ${row.nsInternalId}` : '—'}
            </TableCell>
            <TableCell className="hidden md:table-cell text-xs text-muted-foreground">
              {formatWhen(row.syncedAt ?? row.updatedAt)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function StatusBadge({ status }: { status: 'imported' | 'parked' | 'ignored' }): React.ReactElement {
  if (status === 'imported') return <Badge variant="success">synced</Badge>;
  if (status === 'parked') return <Badge variant="destructive">parked</Badge>;
  return <Badge variant="secondary">ignored</Badge>;
}

function formatWhen(iso: string): string {
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}
