import { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2 } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, ApiError, type ReconciliationResponse, type ReconciliationRow } from '@/lib/api';

/**
 * Reconciliation snapshots view (M3-B). Daily Shopify-vs-dpi-ledger
 * comparison; drift rows highlighted with reason + count/total deltas.
 */
export function Reconciliation(): React.ReactElement {
  const [data, setData] = useState<ReconciliationResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [driftOnly, setDriftOnly] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .reconciliation({ limit: 30, driftOnly })
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
  }, [driftOnly]);

  return (
    <div className="space-y-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold">Reconciliation</h1>
        <p className="text-sm text-muted-foreground">
          Daily Shopify vs dpi ledger comparison. Drift rows show count + total deltas.
        </p>
      </header>

      <Card>
        <CardHeader className="space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base">Snapshots</CardTitle>
              <CardDescription>Last 30 business days, newest first.</CardDescription>
            </div>
            <div className="flex items-center gap-1">
              <Button variant={driftOnly ? 'outline' : 'default'} size="sm" onClick={() => setDriftOnly(false)}>
                All
              </Button>
              <Button variant={driftOnly ? 'default' : 'outline'} size="sm" onClick={() => setDriftOnly(true)}>
                Drift only
              </Button>
            </div>
          </div>
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
                <TableHead className="w-32">Date</TableHead>
                <TableHead className="w-32">Connection</TableHead>
                <TableHead className="w-40">Shopify</TableHead>
                <TableHead className="w-40">dpi ledger</TableHead>
                <TableHead className="w-32">Status</TableHead>
                <TableHead>Drift detail</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && !data && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground">
                    Loading…
                  </TableCell>
                </TableRow>
              )}
              {!loading && (data?.rows.length ?? 0) === 0 && (
                <TableRow>
                  <TableCell colSpan={6} className="text-center text-muted-foreground">
                    {driftOnly ? '🎉 no drift in the window.' : 'No snapshots yet — sweep runs daily at 06:00 UTC.'}
                  </TableCell>
                </TableRow>
              )}
              {data?.rows.map((row) => (
                <Row key={`${row.businessDate}:${row.connectionId}`} row={row} />
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function Row({ row }: { row: ReconciliationRow }): React.ReactElement {
  const drift = row.discrepancy !== null;
  return (
    <TableRow>
      <TableCell className="font-mono text-xs">{row.businessDate}</TableCell>
      <TableCell className="text-xs">{row.connectionId}</TableCell>
      <TableCell className="font-mono text-xs">
        {row.shopifyOrderCount} / {Number(row.shopifyTotal).toFixed(2)}
      </TableCell>
      <TableCell className="font-mono text-xs">
        {row.nsTxnCount} / {Number(row.nsTotal).toFixed(2)}
      </TableCell>
      <TableCell>
        {drift ? (
          <Badge variant="destructive">
            <AlertTriangle className="mr-1 h-3 w-3" />
            drift
          </Badge>
        ) : (
          <Badge variant="success">
            <CheckCircle2 className="mr-1 h-3 w-3" />
            match
          </Badge>
        )}
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {drift && row.discrepancy ? <DriftDetail discrepancy={row.discrepancy} /> : '—'}
      </TableCell>
    </TableRow>
  );
}

function DriftDetail({ discrepancy }: { discrepancy: Record<string, unknown> }): React.ReactElement {
  const reason = String(discrepancy['reason'] ?? 'drift');
  const countDiff = discrepancy['countDiff'];
  const totalDiff = discrepancy['totalDiff'];
  return (
    <span>
      <span className="font-medium text-destructive">{reason}</span>
      {countDiff !== undefined && ` · Δcount=${String(countDiff)}`}
      {totalDiff !== undefined && ` · Δtotal=${String(totalDiff)}`}
    </span>
  );
}
