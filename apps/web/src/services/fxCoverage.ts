/**
 * W40: the reporting currency is only as good as the FX series behind it. When a currency in scope
 * cannot be converted to the reporting currency (the pair was never downloaded), the engine values it
 * at 0, which used to show "R$ 0,00" everywhere and fake benchmark differences against those zeros.
 *
 * `missingFxCurrencies` finds those currencies (checked on the first day each one is used and on the
 * valuation date); `blankUnconvertible` turns every reporting-currency figure into NaN so formatters
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
  const firstUse = new Map<CurrencyCode, ISODate>();
  const use = (c: CurrencyCode | undefined, d: ISODate) => {
    if (!c || c === base) return;
    const prev = firstUse.get(c);
    if (!prev || d < prev) firstUse.set(c, d);
  };
  let first: ISODate | undefined;
  for (const t of txs) {
    if (!first || t.date < first) first = t.date;
    use(t.currency, t.date);
    use(t.toCurrency, t.date);
    if (t.instrumentId) use(byId.get(t.instrumentId)?.currency, t.date);
  }
  if (first) for (const c of portfolioBases) use(c, first);
  const missing: CurrencyCode[] = [];
  for (const [c, d] of firstUse) {
    const at = d > asOf ? asOf : d;
    if (!ok(market.fx(c, base, asOf)) || !ok(market.fx(c, base, at))) missing.push(c);
  }
  return missing.sort();
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
const RETURN_KEYS = ['twr', 'cumulativeTwr', 'localReturn', 'fxReturn', 'realTwr', 'cumulativeRealTwr', 'weight', 'changeBase'] as const;

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
