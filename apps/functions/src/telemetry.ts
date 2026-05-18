import { TelemetryClient } from 'applicationinsights';
import type { Environment } from '@dpi/core';

/**
 * Thin App Insights wrapper. Custom metrics + events for the dpi-integrator
 * pipeline land here so dashboards and alerts can be built on top of named
 * series without having to KQL-parse handler log lines.
 *
 * Initialization is lazy — first call to `getTelemetry()` constructs a
 * `TelemetryClient` if `APPLICATIONINSIGHTS_CONNECTION_STRING` is set, otherwise
 * returns a no-op stub. The Functions runtime already auto-collects requests,
 * dependencies, and traces; we intentionally do NOT call `appInsights.setup()`
 * so we don't double-instrument.
 *
 * What we emit (and what to query):
 *
 *   customMetrics — name = `dpi.<surface>.<outcome>`:
 *     dpi.order.import.success         — every imported order (1)
 *     dpi.order.import.parked          — every parked order (1) — dims: stage, errorClass
 *     dpi.order.import.ignored         — every ignored_by_eligibility (1) — dims: reason
 *     dpi.order.import.time_ms         — wall time from claim to recordSuccess
 *     dpi.catchup.observed             — orders observed in a poll iteration
 *     dpi.catchup.enqueued             — orders re-enqueued from a poll iteration
 *
 *   customEvents — surfaced separately so they can drive Azure Monitor alerts:
 *     dpi.auth_error                   — auth-classified exception (creds rotated /
 *                                        revoked / expired). One event per
 *                                        occurrence; dims include connectionId.
 *
 * Every metric and event carries `environment` + `connectionId` (where
 * applicable) as `properties` so dashboards can split / filter cleanly.
 */

let cached: Telemetry | undefined;

/**
 * Public surface — both real + stub implement this so callers don't have
 * to null-check. The stub does nothing; the real impl forwards to App
 * Insights.
 */
export interface Telemetry {
  trackImport(args: { environment: Environment; connectionId: string; durationMs: number }): void;
  trackPark(args: {
    environment: Environment;
    connectionId: string;
    stage: string;
    errorClass: string;
  }): void;
  trackIgnored(args: {
    environment: Environment;
    connectionId: string;
    reason: string;
  }): void;
  trackCatchupPoll(args: {
    environment: Environment;
    connectionId: string;
    observed: number;
    enqueued: number;
  }): void;
  trackAuthError(args: {
    environment: Environment;
    connectionId: string;
    flow: string;
    message: string;
  }): void;
  trackReconciliationDrift(args: {
    environment: Environment;
    connectionId: string;
    businessDate: string;
    countDiff: number;
    totalDiff: string;
  }): void;
  /**
   * Best-effort flush so a fast-completing function invocation doesn't
   * lose its last batch of telemetry. Errors are swallowed.
   */
  flush(): Promise<void>;
}

export function getTelemetry(): Telemetry {
  if (cached) return cached;
  const conn = process.env['APPLICATIONINSIGHTS_CONNECTION_STRING'];
  cached = conn && conn.length > 0 ? new AppInsightsTelemetry(conn) : new NoopTelemetry();
  return cached;
}

/** Test helper — reset the cached instance between test runs. */
export function resetTelemetryForTests(): void {
  cached = undefined;
}

class AppInsightsTelemetry implements Telemetry {
  private readonly client: TelemetryClient;

  constructor(connectionString: string) {
    this.client = new TelemetryClient(connectionString);
  }

  trackImport(args: { environment: Environment; connectionId: string; durationMs: number }): void {
    const props = baseProps(args.environment, args.connectionId);
    this.client.trackMetric({ name: 'dpi.order.import.success', value: 1, properties: props });
    this.client.trackMetric({
      name: 'dpi.order.import.time_ms',
      value: args.durationMs,
      properties: props,
    });
  }

  trackPark(args: {
    environment: Environment;
    connectionId: string;
    stage: string;
    errorClass: string;
  }): void {
    this.client.trackMetric({
      name: 'dpi.order.import.parked',
      value: 1,
      properties: {
        ...baseProps(args.environment, args.connectionId),
        stage: args.stage,
        errorClass: args.errorClass,
      },
    });
  }

  trackIgnored(args: {
    environment: Environment;
    connectionId: string;
    reason: string;
  }): void {
    this.client.trackMetric({
      name: 'dpi.order.import.ignored',
      value: 1,
      properties: {
        ...baseProps(args.environment, args.connectionId),
        reason: args.reason,
      },
    });
  }

  trackCatchupPoll(args: {
    environment: Environment;
    connectionId: string;
    observed: number;
    enqueued: number;
  }): void {
    const props = baseProps(args.environment, args.connectionId);
    this.client.trackMetric({
      name: 'dpi.catchup.observed',
      value: args.observed,
      properties: props,
    });
    this.client.trackMetric({
      name: 'dpi.catchup.enqueued',
      value: args.enqueued,
      properties: props,
    });
  }

  trackAuthError(args: {
    environment: Environment;
    connectionId: string;
    flow: string;
    message: string;
  }): void {
    // Auth errors are emitted both as a metric (countable for SLOs) and as a
    // customEvent (so Azure Monitor Alert rules can fire on the event stream).
    const props = {
      ...baseProps(args.environment, args.connectionId),
      flow: args.flow,
      message: args.message,
    };
    this.client.trackMetric({
      name: 'dpi.auth_error',
      value: 1,
      properties: props,
    });
    this.client.trackEvent({ name: 'dpi.auth_error', properties: props });
  }

  trackReconciliationDrift(args: {
    environment: Environment;
    connectionId: string;
    businessDate: string;
    countDiff: number;
    totalDiff: string;
  }): void {
    const props = {
      ...baseProps(args.environment, args.connectionId),
      businessDate: args.businessDate,
      countDiff: String(args.countDiff),
      totalDiff: args.totalDiff,
    };
    this.client.trackMetric({
      name: 'dpi.reconciliation.drift',
      value: 1,
      properties: props,
    });
    this.client.trackEvent({ name: 'dpi.reconciliation.drift', properties: props });
  }

  async flush(): Promise<void> {
    try {
      await this.client.flush();
    } catch {
      // best-effort — never let telemetry failures break the pipeline
    }
  }
}

class NoopTelemetry implements Telemetry {
  trackImport(): void {}
  trackPark(): void {}
  trackIgnored(): void {}
  trackCatchupPoll(): void {}
  trackAuthError(): void {}
  trackReconciliationDrift(): void {}
  async flush(): Promise<void> {}
}

function baseProps(environment: Environment, connectionId: string): Record<string, string> {
  return { environment, connectionId };
}
