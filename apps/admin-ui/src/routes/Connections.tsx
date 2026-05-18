import { useEffect, useState } from 'react';
import { CheckCircle2, XCircle } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { api, ApiError, type ConnectionRow, type ConnectionsResponse } from '@/lib/api';

/**
 * Connections view (read-only). Shows the live `DPI_CONNECTIONS_JSON`
 * config parsed by the function app — operators can sanity-check the
 * connection set without opening the Azure portal.
 *
 * Editing connection config lands in a future slice; that needs the
 * function app's MI to have "Website Contributor" on itself so it can
 * write back to its own app settings.
 */
export function Connections(): React.ReactElement {
  const [data, setData] = useState<ConnectionsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .connections()
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
  }, []);

  return (
    <div className="space-y-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold">Connections</h1>
        <p className="text-sm text-muted-foreground">
          Live read of the function app's <code>DPI_CONNECTIONS_JSON</code> setting. Read-only for
          now — edits go through the Azure portal or <code>az functionapp config appsettings set</code>.
        </p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">
            {data ? `${data.rows.length} connection${data.rows.length === 1 ? '' : 's'}` : 'Connections'}
          </CardTitle>
          <CardDescription>One row per (shopify_store → ns_account) mapping.</CardDescription>
        </CardHeader>
        <CardContent>
          {error && (
            <p className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">
              {error}
            </p>
          )}
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-32">Connection</TableHead>
                <TableHead>Shopify store</TableHead>
                <TableHead className="w-32">NS account</TableHead>
                <TableHead className="w-20">Sub</TableHead>
                <TableHead className="w-20">Loc</TableHead>
                <TableHead className="w-24">Target</TableHead>
                <TableHead className="w-24">Tax</TableHead>
                <TableHead className="w-32">Discount item</TableHead>
                <TableHead className="w-20">Tag-back</TableHead>
                <TableHead className="w-16">On</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {loading && !data && (
                <TableRow>
                  <TableCell colSpan={10} className="text-center text-muted-foreground">
                    Loading…
                  </TableCell>
                </TableRow>
              )}
              {data?.rows.length === 0 && (
                <TableRow>
                  <TableCell colSpan={10} className="text-center text-muted-foreground">
                    No connections configured.
                  </TableCell>
                </TableRow>
              )}
              {data?.rows.map((c) => (
                <ConnectionRowView key={c.connectionId} c={c} />
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function ConnectionRowView({ c }: { c: ConnectionRow }): React.ReactElement {
  return (
    <TableRow>
      <TableCell className="font-mono text-xs font-medium">{c.connectionId}</TableCell>
      <TableCell className="text-xs">{c.shopifyStore}</TableCell>
      <TableCell className="font-mono text-xs">{c.nsAccountId}</TableCell>
      <TableCell className="font-mono text-xs">{c.nsSubsidiary}</TableCell>
      <TableCell className="font-mono text-xs">{c.nsLocation ?? '—'}</TableCell>
      <TableCell>
        <Badge variant={c.orderTarget === 'sales_order' ? 'default' : 'secondary'}>
          {c.orderTarget === 'sales_order' ? 'SO' : 'CS'}
        </Badge>
      </TableCell>
      <TableCell>
        <Badge variant="outline">{c.taxEngine}</Badge>
      </TableCell>
      <TableCell className="font-mono text-xs">{c.defaultDiscountItemId ?? '—'}</TableCell>
      <TableCell>
        {c.writeTagsOnImport ? (
          <CheckCircle2 className="h-4 w-4 text-emerald-600" />
        ) : (
          <XCircle className="h-4 w-4 text-muted-foreground" />
        )}
      </TableCell>
      <TableCell>
        {c.enabled ? (
          <Badge variant="success">on</Badge>
        ) : (
          <Badge variant="secondary">off</Badge>
        )}
      </TableCell>
    </TableRow>
  );
}
