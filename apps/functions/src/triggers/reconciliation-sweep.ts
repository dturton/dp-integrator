import {
  app,
  type InvocationContext,
  type Timer,
} from '@azure/functions';
import type {
  ConnectionsRepo,
  Environment,
  OrderSyncLogStore,
  ReconciliationSnapshot,
  ReconciliationStore,
} from '@dpi/core';
import type { ShopifyGateway } from '@dpi/shopify-client';
import type { Telemetry } from '../telemetry.js';

/**
 * Slice M3-B — daily reconciliation sweep.
 *
 * Once a day (timer trigger; manual via `dpi reconcile`), for each enabled
 * connection:
 *
 *   1. Ask Shopify for the count + total of non-test orders with
 *      `processed_at` inside the business-date window (UTC).
 *   2. Aggregate the same window from `order_sync_log` where
 *      `status='imported'`.
 *   3. Compare. If `count` or `total` differs beyond tolerance, mark
 *      drift. Emit `dpi.reconciliation.drift` customEvent.
 *   4. Upsert a row into `reconciliation_snapshots` either way.
 *
 * Brief invariant — "drift, not failure": a discrepancy here is NOT an
 * error to retry. It's a signal an operator needs to investigate. The
 * snapshot row + the custom event are the signal; no retry loop.
 */

export interface ReconciliationDeps {
  readonly environment: Environment;
  readonly connections: ConnectionsRepo;
  readonly shopify: ShopifyGateway;
  readonly orderSyncLog: OrderSyncLogStore | undefined;
  readonly reconciliationStore: ReconciliationStore | undefined;
  readonly telemetry?: Telemetry;
  readonly now?: () => Date;
}

export interface ReconciliationConfig {
  readonly schedule: string;
  /**
   * How many UTC days back to reconcile each fire. 1 = "yesterday" only.
   * Slightly higher (2-3) catches edge-of-day orders that processed close
   * to the boundary and may have synced into the next day's ledger.
   */
  readonly daysBack: number;
  /** Absolute total tolerance — totals within ±this count as agreement. */
  readonly totalToleranceAmount: number;
}

export const DEFAULT_RECONCILIATION_CONFIG: ReconciliationConfig = {
  // 06:00 UTC daily — past midnight in every US timezone so yesterday's
  // orders have finished arriving via webhook + the catch-up poller.
  schedule: '0 0 6 * * *',
  daysBack: 1,
  totalToleranceAmount: 0.05,
};

export interface ConnectionReconcileResult {
  readonly connectionId: string;
  readonly businessDate: string;
  readonly snapshot: ReconciliationSnapshot | undefined;
  readonly drift: boolean;
  readonly skipped?: 'not_ready';
}

export interface ReconcileOutcome {
  readonly perConnection: ReadonlyArray<ConnectionReconcileResult>;
}

/**
 * Run the sweep for a single (env, connection, business_date) tuple.
 * Exported for the `dpi reconcile` CLI verb.
 */
export async function reconcileOneDay(
  deps: ReconciliationDeps,
  connectionId: string,
  businessDate: string,
  config: ReconciliationConfig = DEFAULT_RECONCILIATION_CONFIG,
): Promise<ConnectionReconcileResult> {
  if (!deps.orderSyncLog || !deps.reconciliationStore) {
    return { connectionId, businessDate, snapshot: undefined, drift: false, skipped: 'not_ready' };
  }
  const connection = await deps.connections.findById({
    environment: deps.environment,
    connectionId,
  });
  if (!connection || !connection.enabled) {
    return { connectionId, businessDate, snapshot: undefined, drift: false, skipped: 'not_ready' };
  }

  const fromInclusive = `${businessDate}T00:00:00Z`;
  const toExclusive = nextUtcDay(businessDate) + 'T00:00:00Z';

  const shopifyAgg = await deps.shopify.getDailyOrderAggregate(connection, {
    fromInclusive,
    toExclusive,
  });

  // Pull ledger rows for this day. The ledger's `synced_at` lives in the
  // Postgres TIMESTAMPTZ; we filter on it via list(). InMemoryOrderSyncLogStore
  // doesn't have a date filter — we filter in-process after retrieval.
  const allLedger = await deps.orderSyncLog.list({
    environment: deps.environment,
    connectionId,
    status: 'imported',
    limit: 10_000, // wide cap; daily volumes are far below this in dev
  });
  const ledgerForDay = allLedger.filter((r) => {
    const t = r.syncedAt ?? r.updatedAt;
    return t >= new Date(fromInclusive) && t < new Date(toExclusive);
  });

  const nsTxnCount = ledgerForDay.length;
  let nsTotalNum = 0;
  for (const r of ledgerForDay) {
    const amt = Number.parseFloat(r.totalPrice ?? '0');
    if (Number.isFinite(amt)) nsTotalNum += amt;
  }
  const nsTotal = nsTotalNum.toFixed(2);

  // Shopify total in the connection's base currency. Mixed-currency stores
  // would need per-currency reconciliation; v1 dev is single-currency so
  // we look up the base and report 0 if nothing in that currency observed.
  const shopifyTotalNum = Number.parseFloat(
    shopifyAgg.totalsByCurrency[connection.baseCurrency] ?? '0',
  );
  const shopifyTotal = shopifyTotalNum.toFixed(2);

  const countDiff = shopifyAgg.count - nsTxnCount;
  const totalDiffNum = round2(shopifyTotalNum - nsTotalNum);
  const totalDriftsBeyondTolerance =
    Math.abs(totalDiffNum) > config.totalToleranceAmount;
  const countDrifts = countDiff !== 0;

  const drift = totalDriftsBeyondTolerance || countDrifts;
  const discrepancy = drift
    ? {
        countDiff,
        totalDiff: totalDiffNum.toFixed(2),
        toleranceAmount: config.totalToleranceAmount,
        reason:
          countDrifts && totalDriftsBeyondTolerance
            ? 'count_and_total_diff'
            : countDrifts
              ? 'count_diff'
              : 'total_diff',
      }
    : null;

  const snapshot = await deps.reconciliationStore.upsert({
    environment: deps.environment,
    connectionId,
    businessDate,
    shopifyOrderCount: shopifyAgg.count,
    nsTxnCount,
    shopifyTotal,
    nsTotal,
    discrepancy,
  });

  if (drift) {
    deps.telemetry?.trackReconciliationDrift({
      environment: deps.environment,
      connectionId,
      businessDate,
      countDiff,
      totalDiff: totalDiffNum.toFixed(2),
    });
  }

  return { connectionId, businessDate, snapshot, drift };
}

/**
 * Sweep across every enabled connection × every day in the lookback window.
 */
export async function runReconciliation(
  deps: ReconciliationDeps,
  config: ReconciliationConfig = DEFAULT_RECONCILIATION_CONFIG,
): Promise<ReconcileOutcome> {
  const now = (deps.now ?? (() => new Date()))();
  const enabledConnections = await deps.connections.listEnabled(deps.environment);
  const results: ConnectionReconcileResult[] = [];
  for (const connection of enabledConnections) {
    for (let i = 1; i <= config.daysBack; i++) {
      const businessDate = utcDayString(new Date(now.getTime() - i * 86400_000));
      results.push(await reconcileOneDay(deps, connection.connectionId, businessDate, config));
    }
  }
  return { perConnection: results };
}

export function registerReconciliationSweep(
  getDeps: () => ReconciliationDeps,
  config: ReconciliationConfig = DEFAULT_RECONCILIATION_CONFIG,
): void {
  app.timer('dailyReconciliationSweep', {
    schedule: config.schedule,
    handler: async (_timer: Timer, context: InvocationContext): Promise<void> => {
      const outcome = await runReconciliation(getDeps(), config);
      for (const r of outcome.perConnection) {
        const tail = r.skipped
          ? `skipped=${r.skipped}`
          : `drift=${r.drift} shopify=${r.snapshot?.shopifyOrderCount}/${r.snapshot?.shopifyTotal} ns=${r.snapshot?.nsTxnCount}/${r.snapshot?.nsTotal}`;
        context.log(
          `dailyReconciliationSweep connection=${r.connectionId} businessDate=${r.businessDate} ${tail}`,
        );
      }
    },
  });
}

// --- date helpers ----------------------------------------------------------

/** Returns the YYYY-MM-DD (UTC) representation of `d`. */
function utcDayString(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Given a YYYY-MM-DD string, returns the next day in the same format. */
function nextUtcDay(businessDate: string): string {
  const d = new Date(`${businessDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return utcDayString(d);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
