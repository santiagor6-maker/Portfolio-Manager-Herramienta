/**
 * Demo-data adapter. Prefers `createDemoData()` from @pm/core; falls back to the local
 * generator while the engine package does not provide it. Output is normalised to SeedData.
 */
import * as core from '@pm/core';
import type { FxSeries, Instrument, Portfolio, PriceSeries, Transaction } from '@pm/core';
import type { SeedData } from '../db/repo';
import { createFallbackDemo } from './demoFallback';

type AnyDemo = {
  portfolio?: Portfolio;
  portfolios?: Portfolio[];
  instruments?: Instrument[];
  transactions?: Transaction[];
  prices?: PriceSeries[];
  priceSeries?: PriceSeries[];
  fx?: FxSeries[];
  fxSeries?: FxSeries[];
  manualPrices?: PriceSeries[];
};

export function normaliseDemo(d: AnyDemo): SeedData | undefined {
  const portfolios = d.portfolios ?? (d.portfolio ? [d.portfolio] : []);
  if (!portfolios.length || !d.transactions?.length) return undefined;
  const manual = (d.manualPrices ?? []).flatMap((s) =>
    s.points.map((p) => ({ instrumentId: s.instrumentId, date: p.date, close: p.close, currency: s.currency, note: 'demo' })),
  );
  return {
    portfolios,
    instruments: d.instruments ?? [],
    transactions: d.transactions,
    prices: d.prices ?? d.priceSeries ?? [],
    fx: d.fx ?? d.fxSeries ?? [],
    manualPrices: manual,
  };
}

export function loadDemoData(): { data: SeedData; source: 'core' | 'fallback' } {
  const factory = (core as unknown as { createDemoData?: (...args: unknown[]) => AnyDemo }).createDemoData;
  if (typeof factory === 'function') {
    try {
      const data = normaliseDemo(factory());
      if (data) return { data, source: 'core' };
    } catch {
      /* fall through */
    }
  }
  return { data: createFallbackDemo(), source: 'fallback' };
}
