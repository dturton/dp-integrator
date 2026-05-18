import { useCallback, useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, RefreshCw, ExternalLink, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import {
  api,
  ApiError,
  type OrderAttempt,
  type OrderDetail as OrderDetailT,
  type OrderDetailResponse,
} from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * Single-order drill-down. Layout: order header card (Shopify totals +
 * NS link), Service Bus delivery timeline (newest first), and a replay
 * button that POSTs to /api/ops/replay.
 */
export function OrderDetail(): React.ReactElement {
  const params = useParams<{ orderId: string }>();
  const [search] = useSearchParams();
  const connectionId = search.get('connection') ?? '';
  const orderId = params.orderId ?? '';

  const [data, setData] = useState<OrderDetailResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [replayBusy, setReplayBusy] = useState(false);
  const [replayMessage, setReplayMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  const load = useCallback(() => {
    if (!connectionId || !orderId) return;
    let cancelled = false;
    setLoading(true);
    api
      .orderDetail(connectionId, orderId)
      .then((r) => {
        if (!cancelled) {
          setData(r);
          setError(null);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          const msg = e instanceof ApiError ? `${e.status}: ${e.message}` : (e as Error).message;
          setError(msg);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return (): void => {
      cancelled = true;
    };
  }, [connectionId, orderId]);

  useEffect(() => {
    const cleanup = load();
    return cleanup;
  }, [load]);

  async function handleReplay(force = false): Promise<void> {
    if (!data) return;
    setReplayBusy(true);
    setReplayMessage(null);
    try {
      const r = await api.replay(data.order.connectionId, data.order.shopifyOrderGid, force);
      if (r.outcome === 'replayed') {
        setReplayMessage({
          kind: 'ok',
          text: `replayed (previousStatus=${r.previousStatus ?? '?'})`,
        });
        // Refresh after a short pause so the new attempt row shows up.
        setTimeout(() => load(), 1500);
      } else if (r.outcome === 'refused_already_synced') {
        setReplayMessage({
          kind: 'err',
          text: 'already synced — use Force to replay anyway',
        });
      } else {
        setReplayMessage({
          kind: 'err',
          text: `${r.outcome ?? 'failed'}: ${r.detail ?? ''}`,
        });
      }
    } catch (e) {
      setReplayMessage({
        kind: 'err',
        text: e instanceof Error ? e.message : 'replay failed',
      });
    } finally {
      setReplayBusy(false);
    }
  }

  if (!connectionId || !orderId) {
    return (
      <div className="p-6">
        <p className="text-sm text-destructive">
          Missing connection or orderId. Use <code>/orders/&lt;numericId&gt;?connection=&lt;id&gt;</code>.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-4 sm:p-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" asChild>
            <Link to="/orders">
              <ArrowLeft className="h-3.5 w-3.5" />
              <span className="hidden sm:inline">All orders</span>
            </Link>
          </Button>
          <div className="min-w-0">
            <h1 className="text-xl sm:text-2xl font-semibold truncate">
              {data?.order.shopifyOrderName ?? `Order #${orderId}`}
            </h1>
            <p className="text-xs text-muted-foreground truncate">
              {connectionId} · {orderId}
            </p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => handleReplay(false)}
            disabled={replayBusy || !data}
          >
            <RefreshCw className={cn('h-3.5 w-3.5', replayBusy && 'animate-spin')} />
            Replay
          </Button>
          {data?.order.status === 'imported' && (
            <Button
              variant="destructive"
              size="sm"
              onClick={() => handleReplay(true)}
              disabled={replayBusy}
            >
              <RefreshCw className={cn('h-3.5 w-3.5', replayBusy && 'animate-spin')} />
              Force replay
            </Button>
          )}
        </div>
      </div>

      {replayMessage && (
        <div
          className={cn(
            'flex items-center gap-2 rounded-md border px-3 py-2 text-sm',
            replayMessage.kind === 'ok'
              ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
              : 'border-destructive/50 bg-destructive/5 text-destructive',
          )}
        >
          {replayMessage.kind === 'ok' ? (
            <CheckCircle2 className="h-4 w-4" />
          ) : (
            <AlertTriangle className="h-4 w-4" />
          )}
          {replayMessage.text}
        </div>
      )}

      {error && (
        <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {loading && !data && <p className="text-sm text-muted-foreground">Loading…</p>}

      {data && <OrderHeaderCard order={data.order} />}
      {data && <AttemptsCard attempts={data.attempts} />}
    </div>
  );
}

function OrderHeaderCard({ order }: { order: OrderDetailT }): React.ReactElement {
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">Order</CardTitle>
          <StatusBadge status={order.status} />
        </div>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <DetailField label="Customer" value={order.customerEmail ?? '— (guest)'} />
        <DetailField label="Currency" value={order.currencyCode ?? '—'} />
        <DetailField label="Connection" value={order.connectionId} />
        <DetailField label="Subtotal" value={formatMoney(order.subtotalPrice, order.currencyCode)} />
        <DetailField label="Tax" value={formatMoney(order.totalTax, order.currencyCode)} />
        <DetailField label="Shipping" value={formatMoney(order.totalShipping, order.currencyCode)} />
        <DetailField label="Discount" value={formatMoney(order.totalDiscounts, order.currencyCode, true)} />
        <DetailField label="Total" value={formatMoney(order.totalPrice, order.currencyCode)} />
        <DetailField
          label="NS record"
          value={order.nsInternalId ? `${order.nsRecordType ?? 'salesorder'} ${order.nsInternalId}` : '— (not synced)'}
        />
        <DetailField label="Shopify processed_at" value={formatWhen(order.shopifyProcessedAt)} />
        <DetailField label="Synced at" value={formatWhen(order.syncedAt)} />
        <DetailField label="Updated at" value={formatWhen(order.updatedAt)} />
        {order.parkStage && (
          <div className="md:col-span-3">
            <DetailField
              label={`Parked at stage=${order.parkStage} · class=${order.parkErrorClass ?? '?'}`}
              value={order.parkDetail ?? '—'}
              mono
            />
          </div>
        )}
        {order.ignoredReason && (
          <div className="md:col-span-3">
            <DetailField label="Ignored — reason" value={order.ignoredReason} mono />
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function AttemptsCard({ attempts }: { attempts: ReadonlyArray<OrderAttempt> }): React.ReactElement {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Service Bus delivery timeline</CardTitle>
        <CardDescription>
          Newest first. Outbound payload links open the archived NS-bound JSON for that attempt.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-12 sm:w-16">#</TableHead>
              <TableHead className="w-28 sm:w-40">Outcome</TableHead>
              <TableHead className="hidden md:table-cell w-32">Stage</TableHead>
              <TableHead className="hidden sm:table-cell">Detail</TableHead>
              <TableHead className="hidden lg:table-cell w-24 text-right">Duration</TableHead>
              <TableHead className="hidden md:table-cell w-32">Payload</TableHead>
              <TableHead className="hidden lg:table-cell w-44">Started</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {attempts.length === 0 && (
              <TableRow>
                <TableCell colSpan={7} className="text-center text-muted-foreground">
                  No attempts recorded yet.
                </TableCell>
              </TableRow>
            )}
            {attempts.map((a, i) => (
              <TableRow key={`${a.startedAt}-${a.deliveryCount}-${i}`}>
                <TableCell className="font-mono text-xs">{a.deliveryCount}</TableCell>
                <TableCell>
                  <OutcomeBadge outcome={a.outcome} />
                </TableCell>
                <TableCell className="hidden md:table-cell text-xs text-muted-foreground">{a.stage ?? '—'}</TableCell>
                <TableCell className="hidden sm:table-cell text-xs text-muted-foreground">
                  {a.detail ? <span className="line-clamp-2">{a.detail}</span> : '—'}
                </TableCell>
                <TableCell className="hidden lg:table-cell text-right font-mono text-xs">{a.durationMs}ms</TableCell>
                <TableCell className="hidden md:table-cell">
                  {a.outboundPayloadUri ? (
                    <a
                      href={a.outboundPayloadUri}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex items-center gap-1 text-xs underline-offset-2 hover:underline"
                    >
                      view <ExternalLink className="h-3 w-3" />
                    </a>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="hidden lg:table-cell text-xs text-muted-foreground">{formatWhen(a.startedAt)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function DetailField({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}): React.ReactElement {
  return (
    <div>
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className={cn('text-sm', mono && 'font-mono text-xs')}>{value}</div>
    </div>
  );
}

function StatusBadge({ status }: { status: 'imported' | 'parked' | 'ignored' }): React.ReactElement {
  if (status === 'imported') return <Badge variant="success">synced</Badge>;
  if (status === 'parked') return <Badge variant="destructive">parked</Badge>;
  return <Badge variant="secondary">ignored</Badge>;
}

function OutcomeBadge({ outcome }: { outcome: string }): React.ReactElement {
  if (outcome === 'imported') return <Badge variant="success">imported</Badge>;
  if (outcome === 'parked' || outcome === 'quarantined') return <Badge variant="destructive">{outcome}</Badge>;
  if (outcome === 'already_synced' || outcome === 'already_claimed' || outcome === 'ignored' || outcome === 'ignored_by_eligibility') {
    return <Badge variant="secondary">{outcome}</Badge>;
  }
  if (outcome === 'transient_throw' || outcome === 'auth_throw') return <Badge variant="warning">{outcome}</Badge>;
  return <Badge variant="outline">{outcome}</Badge>;
}

function formatMoney(amount: string | null, currency: string | null, negative = false): string {
  if (!amount) return '—';
  const n = Number.parseFloat(amount);
  if (!Number.isFinite(n)) return amount;
  const sign = negative && n > 0 ? '-' : '';
  return `${sign}${currency ? `${currency} ` : ''}${n.toFixed(2)}`;
}

function formatWhen(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}
