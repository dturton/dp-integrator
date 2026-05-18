import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, ChevronRight, RefreshCw, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, ApiError, type RecentOrderRow } from '@/lib/api';
import { cn } from '@/lib/utils';

const PAGE_SIZE = 25;

/**
 * Parked queue — every order with status='parked'. Inline one-click replay
 * per row. No filter chips (the whole view is the filter); paginated.
 */
export function Parked(): React.ReactElement {
  const [rows, setRows] = useState<ReadonlyArray<RecentOrderRow>>([]);
  const [total, setTotal] = useState(0);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [replayBusyGid, setReplayBusyGid] = useState<string | null>(null);
  const [replayMessage, setReplayMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  function rowKey(row: RecentOrderRow): string {
    return `${row.connectionId}:${row.shopifyOrderId}`;
  }

  function toggleRow(row: RecentOrderRow): void {
    setSelected((prev) => {
      const next = new Set(prev);
      const k = rowKey(row);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }

  function toggleAll(): void {
    setSelected((prev) => {
      if (prev.size === rows.length) return new Set();
      return new Set(rows.map(rowKey));
    });
  }

  async function handleBulkReplay(): Promise<void> {
    if (selected.size === 0) return;
    setBulkBusy(true);
    setReplayMessage(null);
    const targets = rows.filter((r) => selected.has(rowKey(r)));
    let ok = 0;
    let fail = 0;
    // Serialize so we don't burst NS / SB; small sets, slow path is fine.
    for (const row of targets) {
      try {
        const gid = `gid://shopify/Order/${row.shopifyOrderId}`;
        const result = await api.replay(row.connectionId, gid);
        if (result.outcome === 'replayed') ok += 1;
        else fail += 1;
      } catch {
        fail += 1;
      }
    }
    setBulkBusy(false);
    setSelected(new Set());
    setReplayMessage({
      kind: fail === 0 ? 'ok' : 'err',
      text: `Bulk replay: ${ok} ok, ${fail} failed across ${targets.length} orders`,
    });
    setTimeout(() => load(), 1500);
  }

  const load = useCallback(() => {
    let cancelled = false;
    setLoading(true);
    api
      .orders({ status: 'parked', limit: PAGE_SIZE, offset })
      .then((r) => {
        if (!cancelled) {
          setRows(r.rows);
          setTotal(r.total);
          setNextOffset(r.nextOffset);
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
  }, [offset]);

  useEffect(() => {
    const cleanup = load();
    return cleanup;
  }, [load]);

  async function handleReplay(row: RecentOrderRow): Promise<void> {
    const gid = `gid://shopify/Order/${row.shopifyOrderId}`;
    setReplayBusyGid(gid);
    setReplayMessage(null);
    try {
      const r = await api.replay(row.connectionId, gid);
      if (r.outcome === 'replayed') {
        setReplayMessage({ kind: 'ok', text: `replayed ${row.shopifyOrderName ?? gid}` });
        // Optimistic refresh — parked row may flip to imported/synced.
        setTimeout(() => load(), 1200);
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
      setReplayBusyGid(null);
    }
  }

  const pageStart = total === 0 ? 0 : offset + 1;
  const pageEnd = offset + rows.length;

  return (
    <div className="space-y-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold">Parked queue</h1>
        <p className="text-sm text-muted-foreground">
          Orders the handler stopped on — park reason in the right column. Click <em>Replay</em> after fixing root cause.
        </p>
      </header>

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

      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:space-y-0">
          <div>
            <CardTitle className="text-base">
              {total > 0 ? `${total.toLocaleString()} parked` : 'No parked orders'}
            </CardTitle>
            <CardDescription>
              Each row links to the full order detail with the SB attempt timeline.
            </CardDescription>
          </div>
          {selected.size > 0 && (
            <Button onClick={handleBulkReplay} disabled={bulkBusy} size="sm">
              <RefreshCw className={cn('h-3.5 w-3.5', bulkBusy && 'animate-spin')} />
              Replay selected ({selected.size})
            </Button>
          )}
        </CardHeader>
        <CardContent className="space-y-3">
          {error && (
            <p className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">
              {error}
            </p>
          )}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8">
                  <input
                    type="checkbox"
                    aria-label="select all"
                    checked={rows.length > 0 && selected.size === rows.length}
                    onChange={toggleAll}
                  />
                </TableHead>
                <TableHead className="w-24 sm:w-32">Order</TableHead>
                <TableHead className="hidden lg:table-cell w-32">Connection</TableHead>
                <TableHead className="hidden sm:table-cell">Customer</TableHead>
                <TableHead className="hidden md:table-cell w-28">Total</TableHead>
                <TableHead className="hidden md:table-cell w-44">When</TableHead>
                <TableHead className="w-24 text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-muted-foreground">
                    Loading…
                  </TableCell>
                </TableRow>
              )}
              {!loading && rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-muted-foreground">
                    🎉 nothing parked.
                  </TableCell>
                </TableRow>
              )}
              {rows.map((row) => {
                const gid = `gid://shopify/Order/${row.shopifyOrderId}`;
                const busy = replayBusyGid === gid;
                const key = rowKey(row);
                const isSelected = selected.has(key);
                return (
                  <TableRow key={key} data-state={isSelected ? 'selected' : undefined}>
                    <TableCell>
                      <input
                        type="checkbox"
                        aria-label={`select ${row.shopifyOrderName ?? row.shopifyOrderId}`}
                        checked={isSelected}
                        onChange={() => toggleRow(row)}
                      />
                    </TableCell>
                    <TableCell className="font-mono text-xs">
                      <Link
                        to={`/orders/${row.shopifyOrderId}?connection=${encodeURIComponent(row.connectionId)}`}
                        className="hover:underline"
                      >
                        {row.shopifyOrderName ?? `#${row.shopifyOrderId}`}
                      </Link>
                    </TableCell>
                    <TableCell className="hidden lg:table-cell text-xs">{row.connectionId}</TableCell>
                    <TableCell className={cn('hidden sm:table-cell text-muted-foreground text-xs truncate max-w-[16rem]', !row.customerEmail && 'italic')}>
                      {row.customerEmail ?? 'guest'}
                    </TableCell>
                    <TableCell className="hidden md:table-cell font-mono text-xs whitespace-nowrap">
                      {row.totalPrice ? `${row.currencyCode ?? ''} ${Number(row.totalPrice).toFixed(2)}` : '—'}
                    </TableCell>
                    <TableCell className="hidden md:table-cell text-xs text-muted-foreground">
                      {formatWhen(row.syncedAt ?? row.updatedAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleReplay(row)}
                        disabled={busy}
                      >
                        <RefreshCw className={cn('h-3.5 w-3.5', busy && 'animate-spin')} />
                        <span className="hidden sm:inline">Replay</span>
                      </Button>
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
          <div className="flex items-center justify-between pt-2 text-xs text-muted-foreground">
            <div>
              {total === 0
                ? ''
                : `Showing ${pageStart.toLocaleString()}–${pageEnd.toLocaleString()} of ${total.toLocaleString()}`}
            </div>
            <div className="flex items-center gap-1">
              <Button
                variant="outline"
                size="sm"
                disabled={offset === 0}
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
              >
                <ChevronLeft className="h-3.5 w-3.5" />
                Prev
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={nextOffset === null}
                onClick={() => nextOffset !== null && setOffset(nextOffset)}
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

function formatWhen(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}
