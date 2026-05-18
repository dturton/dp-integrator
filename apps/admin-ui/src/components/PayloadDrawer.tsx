import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Copy, Download, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { api, ApiError } from '@/lib/api';
import { cn } from '@/lib/utils';

/**
 * Right-side drawer that renders the body of an archived blob (inbound
 * envelope, outbound NS request, or NS response).
 *
 * Avoids a Radix Dialog dependency — the admin-UI's UI stack is intentionally
 * minimal. Tailwind transitions + a portal + an Esc-key handler cover what
 * we need.
 *
 * Size handling: a HEAD request runs first. Payloads larger than 256 KB show
 * size + Download instead of rendering eagerly (Shopify orders with many
 * lines + tax breakdowns can exceed 1 MB).
 */

const LARGE_PAYLOAD_BYTES = 256 * 1024;

export interface PayloadDrawerProps {
  open: boolean;
  uri: string | null;
  title: string;
  /** Subtitle line — e.g. "attempt 2 · 422" so the user knows which artifact is shown. */
  subtitle?: string;
  onClose: () => void;
}

type FetchState =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'too_large'; size: number; contentType: string }
  | { kind: 'ready'; body: string; size: number; contentType: string }
  | { kind: 'error'; message: string };

export function PayloadDrawer({ open, uri, title, subtitle, onClose }: PayloadDrawerProps): React.ReactElement | null {
  const [state, setState] = useState<FetchState>({ kind: 'idle' });

  // Reset + fetch whenever the URI changes (i.e., a different button opened
  // the same drawer instance).
  useEffect(() => {
    if (!open || !uri) {
      setState({ kind: 'idle' });
      return;
    }
    let cancelled = false;
    setState({ kind: 'loading' });
    void (async () => {
      try {
        const head = await api.payloadHead(uri);
        if (cancelled) return;
        if (head.size > LARGE_PAYLOAD_BYTES) {
          setState({ kind: 'too_large', size: head.size, contentType: head.contentType });
          return;
        }
        const blob = await api.payload(uri);
        if (cancelled) return;
        setState({ kind: 'ready', body: blob.body, size: blob.size, contentType: blob.contentType });
      } catch (e) {
        if (cancelled) return;
        const msg = e instanceof ApiError ? `${e.status}: ${e.message}` : (e as Error).message;
        setState({ kind: 'error', message: msg });
      }
    })();
    return (): void => {
      cancelled = true;
    };
  }, [open, uri]);

  // Esc closes the drawer.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return (): void => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  const downloadRaw = useCallback((): void => {
    if (state.kind !== 'ready' || !uri) return;
    const blob = new Blob([state.body], { type: state.contentType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = uri.split('/').pop() ?? 'payload.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, [state, uri]);

  const downloadViaProxy = useCallback((): void => {
    if (!uri) return;
    // Hit the proxy directly so the browser handles the download.
    const params = new URLSearchParams({ uri });
    window.open(`/api/ops/payload?${params.toString()}`, '_blank', 'noreferrer');
  }, [uri]);

  const copyToClipboard = useCallback((): void => {
    if (state.kind !== 'ready') return;
    void navigator.clipboard.writeText(state.body).catch(() => undefined);
  }, [state]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <>
      {/* Backdrop — semi-transparent on md+, transparent click-shield on mobile so the bottom-sheet feel is preserved. */}
      <div
        aria-hidden={!open}
        className={cn(
          'fixed inset-0 z-40 bg-black/30 transition-opacity duration-150',
          open ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none',
        )}
        onClick={onClose}
      />
      <aside
        role="dialog"
        aria-modal="true"
        aria-hidden={!open}
        className={cn(
          'fixed right-0 top-0 z-50 flex h-full w-full flex-col border-l bg-background shadow-xl transition-transform duration-200 sm:max-w-2xl',
          open ? 'translate-x-0' : 'translate-x-full',
        )}
      >
        <header className="flex items-start justify-between gap-3 border-b px-4 py-3">
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold">{title}</h2>
            {subtitle && (
              <p className="truncate text-xs text-muted-foreground">{subtitle}</p>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {state.kind === 'ready' && (
              <>
                <Button variant="ghost" size="sm" onClick={copyToClipboard} title="Copy JSON to clipboard">
                  <Copy className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Copy</span>
                </Button>
                <Button variant="ghost" size="sm" onClick={downloadRaw} title="Download raw bytes">
                  <Download className="h-3.5 w-3.5" />
                  <span className="hidden sm:inline">Download</span>
                </Button>
              </>
            )}
            <Button variant="ghost" size="sm" onClick={onClose} aria-label="Close">
              <X className="h-4 w-4" />
            </Button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-auto p-4">
          {state.kind === 'idle' && (
            <p className="text-sm text-muted-foreground">No payload selected.</p>
          )}
          {state.kind === 'loading' && (
            <p className="text-sm text-muted-foreground">Loading…</p>
          )}
          {state.kind === 'error' && (
            <div className="rounded-md border border-destructive/50 bg-destructive/5 p-3 text-sm text-destructive">
              {state.message}
            </div>
          )}
          {state.kind === 'too_large' && (
            <div className="space-y-3 rounded-md border bg-muted/40 p-4 text-sm">
              <p>
                Payload is <strong>{formatBytes(state.size)}</strong> — too large to
                render inline. Download to inspect locally.
              </p>
              <Button variant="default" size="sm" onClick={downloadViaProxy}>
                <Download className="h-3.5 w-3.5" />
                Download
              </Button>
            </div>
          )}
          {state.kind === 'ready' && (
            <PayloadBody body={state.body} />
          )}
        </div>
      </aside>
    </>,
    document.body,
  );
}

function PayloadBody({ body }: { body: string }): React.ReactElement {
  // Try to pretty-print. If it isn't valid JSON, render as-is — preserves
  // headers / non-JSON blobs without forcing a parse.
  let pretty = body;
  try {
    pretty = JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    // body stays raw
  }
  return (
    <pre className="overflow-x-auto whitespace-pre rounded-md border bg-muted/40 p-3 font-mono text-xs leading-relaxed">
      {pretty}
    </pre>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
