import type { Connection } from '@dpi/core';
import type { ShopifyOrder, ShopifyTaxLine } from '@dpi/shopify-client';

/**
 * The brief mandates we keep tax engine choice per-account and abstract it.
 * Per-engine payload building lands in M1; M0 only ships the interface +
 * stub implementations so the rest of the system can already depend on it.
 *
 * Each strategy returns:
 *   - `lineTax`     — per-NS-line tax detail (SuiteTax `taxDetailsList`, or
 *                     `taxcode`/`taxrate` for legacy)
 *   - `headerTax`   — totals to set on the NS record (where the engine wants it)
 *   - `taxItems`    — optional explicit tax items added as lines (engine-specific)
 *
 * In M0 these stubs throw — the mapping engine never calls them. M1 fills in
 * SuiteTax and Legacy with real payloads + fixture tests.
 */
export interface TaxPayloadPart {
  readonly lineTax: ReadonlyArray<Record<string, unknown>>;
  readonly headerTax: Record<string, unknown>;
  readonly taxItems: ReadonlyArray<Record<string, unknown>>;
}

export interface TaxStrategy {
  readonly engine: 'suitetax' | 'legacy';
  buildOrderTax(connection: Connection, order: ShopifyOrder): TaxPayloadPart;
  buildShippingTax(connection: Connection, shippingTax: readonly ShopifyTaxLine[]): TaxPayloadPart;
}

abstract class StubTaxStrategy implements TaxStrategy {
  abstract readonly engine: 'suitetax' | 'legacy';
  buildOrderTax(): TaxPayloadPart {
    throw new Error(
      `${this.constructor.name}: buildOrderTax not implemented in M0 (lands in M1 alongside the mapping engine).`,
    );
  }
  buildShippingTax(): TaxPayloadPart {
    throw new Error(
      `${this.constructor.name}: buildShippingTax not implemented in M0 (lands in M1).`,
    );
  }
}

/** SuiteTax engine — line-level tax via `taxDetailsList`. M1. */
export class SuiteTaxStrategy extends StubTaxStrategy {
  override readonly engine = 'suitetax' as const;
}

/** Legacy Tax engine — `taxcode`/`taxrate` per line. M1. */
export class LegacyTaxStrategy extends StubTaxStrategy {
  override readonly engine = 'legacy' as const;
}

/** Pick the strategy matching the connection. Connections store the choice as config. */
export function strategyFor(connection: Connection): TaxStrategy {
  switch (connection.taxEngine) {
    case 'suitetax':
      return new SuiteTaxStrategy();
    case 'legacy':
      return new LegacyTaxStrategy();
  }
}
