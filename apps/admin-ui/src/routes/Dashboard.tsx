import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, AlertTriangle, CheckCircle2, ParkingCircle, EyeOff } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, ApiError, type AdminStatusResponse } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * Top-level dashboard. Counts grid at the top, recent-activity table below.
 * No filters here — `/orders` is the place for that.
 */
export function Dashboard(): React.ReactElement {
  const [data, setData] = useState<AdminStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .status()
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
  }, []);

  return (
    <div className="space-y-6 p-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold">Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            Live state across every connection in this environment.
          </p>
        </div>
      </header>

      {error && (
        <Card className="border-destructive/50 bg-destructive/5">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <AlertTriangle className="h-4 w-4 text-destructive" />
              Couldn't load status
            </CardTitle>
            <CardDescription>{error}</CardDescription>
          </CardHeader>
        </Card>
      )}

      <section className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <CountCard
          title="Imported (total)"
          value={data?.counts.imported}
          loading={loading}
          icon={<CheckCircle2 className="h-4 w-4 text-emerald-600" />}
          delta={
            data
              ? `${data.last24h.imported.toLocaleString()} in last 24h`
              : undefined
          }
        />
        <CountCard
          title="Parked"
          value={data?.counts.parked}
          loading={loading}
          icon={<ParkingCircle className="h-4 w-4 text-amber-600" />}
          delta={
            data ? `${data.last24h.parked.toLocaleString()} in last 24h` : undefined
          }
        />
        <CountCard
          title="Ignored"
          value={data?.counts.ignored}
          loading={loading}
          icon={<EyeOff className="h-4 w-4 text-muted-foreground" />}
        />
        <CountCard
          title="Reconciliation drift"
          value={data?.drift.snapshotsWithDrift}
          loading={loading}
          icon={<AlertTriangle className="h-4 w-4 text-amber-600" />}
          delta={
            data?.drift.mostRecentBusinessDate
              ? `most recent: ${data.drift.mostRecentBusinessDate}`
              : undefined
          }
        />
      </section>

      <section>
        <Card>
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <div>
              <CardTitle className="text-base">Recent activity</CardTitle>
              <CardDescription>Last 10 terminal outcomes across the ledger.</CardDescription>
            </div>
            <Button variant="ghost" size="sm" asChild>
              <Link to="/orders">
                All orders <ArrowRight className="ml-1 h-3.5 w-3.5" />
              </Link>
            </Button>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-32">Order</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead className="w-32">Total</TableHead>
                  <TableHead className="w-28">Status</TableHead>
                  <TableHead className="w-28">NS</TableHead>
                  <TableHead className="w-48">When</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {loading && (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-muted-foreground">
                      Loading…
                    </TableCell>
                  </TableRow>
                )}
                {!loading && (data?.mostRecent.length ?? 0) === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-muted-foreground">
                      No recent activity.
                    </TableCell>
                  </TableRow>
                )}
                {data?.mostRecent.map((row) => (
                  <TableRow key={`${row.connectionId}:${row.shopifyOrderId}`}>
                    <TableCell className="font-mono text-xs">
                      <Link
                        to={`/orders/${row.shopifyOrderId}?connection=${encodeURIComponent(row.connectionId)}`}
                        className="hover:underline"
                      >
                        {row.shopifyOrderName ?? `#${row.shopifyOrderId}`}
                      </Link>
                    </TableCell>
                    <TableCell className="text-muted-foreground">
                      {row.customerEmail ?? '—'}
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {row.totalPrice
                        ? `${row.currencyCode ?? ''} ${Number(row.totalPrice).toFixed(2)}`
                        : '—'}
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={row.status} />
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      {row.nsInternalId ? `SO ${row.nsInternalId}` : '—'}
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatWhen(row.syncedAt ?? row.updatedAt)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}

interface CountCardProps {
  title: string;
  value: number | undefined;
  loading: boolean;
  icon: React.ReactNode;
  delta?: string | undefined;
}

function CountCard({ title, value, loading, icon, delta }: CountCardProps): React.ReactElement {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
        {icon}
      </CardHeader>
      <CardContent>
        <div className={cn('text-2xl font-semibold tabular-nums', loading && 'text-muted-foreground')}>
          {loading ? '—' : (value ?? 0).toLocaleString()}
        </div>
        {delta && <p className="mt-1 text-xs text-muted-foreground">{delta}</p>}
      </CardContent>
    </Card>
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
