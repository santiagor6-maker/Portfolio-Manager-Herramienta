/**
 * W40: the reporting currency is only as good as the FX series behind it. When a currency in scope
 * cannot be converted to the reporting currency (the pair was never downloaded), the engine values it
 * at 0, which used to show "R$ 0,00" everywhere and fake benchmark differences against those zeros.
 *
 * `missingFxCurrencies` finds those currencies (no route at the valuation date); `blankUnconvertible` turns every reporting-currency figure into NaN so formatters
 * print "—" and derived differences (vs. benchmark, alpha…) are "—" too. Index and benchmark returns
 * are kept: they do not depend on the missing rate.
 */
import type { CurrencyCode, ISODate, Instrument, MarketData, Transaction } from '@pm/core';

export function missingFxCurrencies(
  base: CurrencyCode,
  txs: Transaction[],
  instruments: Instrument[],
  market: Pick<MarketData, 'fx'>,
  asOf: ISODate,
  portfolioBases: CurrencyCode[] = [],
): CurrencyCode[] {
  const byId = new Map(instruments.map((i) => [i.id, i]));
  const used = new Set<CurrencyCode>(portfolioBases);
  for (const t of txs) {
    used.add(t.currency);
    if (t.toCurrency) used.add(t.toCurrency);
    if (t.instrumentId) {
      const c = byId.get(t.instrumentId)?.currency;
      if (c) used.add(c);
    }
  }
  used.delete(base);
  // Checked on the valuation date only: for older dates the engine falls back to the nearest rate,
  // so a series that starts after the first trade still converts (W40 review).
  return [...used].filter((c) => c && !ok(market.fx(c, base, asOf))).sort();
}

/** Base currencies of the portfolios in the selected scope ('all' = every portfolio). */
export function scopeBases(ds: { portfolios: { id: string; baseCurrency: CurrencyCode }[]; selectedPortfolioId: string }): CurrencyCode[] {
  return ds.portfolios.filter((p) => ds.selectedPortfolioId === 'all' || p.id === ds.selectedPortfolioId).map((p) => p.baseCurrency);
}

function ok(rate: number | undefined): boolean {
  return rate !== undefined && Number.isFinite(rate) && rate > 0;
}

/** Sets every numeric `…Base` field of an object (one level) to NaN. */
function nanBase<T extends object>(o: T): T {
  const out = { ...o } as Record<string, unknown>;
  for (const [k, v] of Object.entries(out)) if (typeof v === 'number' && k.endsWith('Base')) out[k] = NaN;
  return out as T;
}

/** Return fields that are computed from reporting-currency values. */
const RETURN_KEYS = ['twr', 'cumulativeTwr', 'localReturn', 'fxReturn', 'realTwr', 'cumulativeRealTwr', 'weight'] as const;

function nanReturns<T extends object>(o: T): T {
  const out = nanBase(o) as Record<string, unknown>;
  for (const k of RETURN_KEYS) if (typeof out[k] === 'number') out[k] = NaN;
  delete out.percentOfIndex;
  return out as T;
}

export interface Blankable {
  valuation?: { holdings: object[]; cash: object[] } & object;
  summaries: Record<string, unknown>;
  series: unknown[];
  dailySeries: unknown[];
  monthly: object[];
  risk?: unknown;
  benchmarkRisk: Record<string, unknown>;
  allocations: Record<string, unknown>;
  income: object[];
  realized: object[];
  movers: object[];
  positions: object[];
  positionsYtd: object[];
  upcomingDividends: object[];
}

/** Guards the UI against figures converted with a missing rate (the engine reports them as 0). */
export function blankUnconvertible<A extends Blankable>(a: A): A {
  if (a.valuation) {
    const v = nanBase(a.valuation);
    v.holdings = a.valuation.holdings.map(nanReturns);
    v.cash = a.valuation.cash.map(nanBase);
    a.valuation = v;
  }
  a.summaries = {};
  a.series = [];
  a.dailySeries = [];
  a.monthly = a.monthly.map(nanReturns);
  a.risk = undefined;
  a.benchmarkRisk = {};
  a.allocations = {};
  a.income = a.income.map(nanBase);
  a.realized = a.realized.map(nanBase);
  a.movers = a.movers.map(nanReturns);
  a.positions = a.positions.map(nanReturns);
  a.positionsYtd = a.positionsYtd.map(nanReturns);
  a.upcomingDividends = a.upcomingDividends.map(nanBase);
  return a;
}
