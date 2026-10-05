/**
 * Pure "analysis" step: turns the local dataset into everything the UI renders, using the
 * @pm/core engine. Runs inside a Web Worker (see worker/engine.worker.ts) and falls back to the
 * main thread when workers are unavailable (tests, old browsers).
 *
 * Every engine call is isolated with try/catch so one failing computation (or an engine function
 * that is not implemented yet) degrades a single widget instead of the whole app.
 */
import * as core from '@pm/core';
import type {
  AllocationDimension,
  AllocationSlice,
  CurrencyCode,
  EngineInput,
  FxSeries,
  IncomeEvent,
  Instrument,
  ISODate,
  MarketData,
  MonthlyRow,
  PerformanceSummary,
  Portfolio,
  PriceSeries,
  RealizedGain,
  RiskMetrics,
  Transaction,
  Valuation,
  ValidationIssue,
} from '@pm/core';
import { addDays } from '../lib/ids';

export interface Dataset {
  portfolios: Portfolio[];
  transactions: Transaction[];
  instruments: Instrument[];
  prices: PriceSeries[];
  fx: FxSeries[];
  manualPrices: PriceSeries[];
  /** Portfolio id or 'all'. */
  selectedPortfolioId: string;
  reportingCurrency: CurrencyCode;
  asOf: ISODate;
  benchmarks: string[];
  riskFreeRate: number;
  defaultCostMethod: Portfolio['costMethod'];
}

export type SummaryKey = 'DAY' | 'MTD' | 'YTD' | '1Y' | '3Y' | 'SI';

export interface SeriesPoint {
  date: ISODate;
  valueBase: number;
  netInvestedBase: number;
  cumulativeTwr: number;
}

export interface Mover {
  instrumentId: string;
  /** Date of the latest price; the change is versus the previous available close. */
  date: ISODate;
  changePct: number;
  changeBase: number;
  price: number;
  prevPrice: number;
}

export interface Analysis {
  asOf: ISODate;
  baseCurrency: CurrencyCode;
  portfolioId: string;
  hasTransactions: boolean;
  firstDate?: ISODate;
  valuation?: Valuation;
  summaries: Partial<Record<SummaryKey, PerformanceSummary>>;
  /** Weekly since inception (or daily if history < 2y). */
  series: SeriesPoint[];
  /** Daily, last ~13 months. */
  dailySeries: SeriesPoint[];
  monthly: MonthlyRow[];
  risk?: RiskMetrics;
  benchmarkRisk: Record<string, RiskMetrics>;
  allocations: Partial<Record<AllocationDimension, AllocationSlice[]>>;
  income: IncomeEvent[];
  realized: RealizedGain[];
  movers: Mover[];
  /** Most recent price date across holdings (to flag stale data). */
  latestPriceDate?: ISODate;
  issues: { errors: ValidationIssue[]; warnings: ValidationIssue[] };
  /** Engine failures by step (e.g. "monthlyPerformance not implemented yet"). */
  engineErrors: Record<string, string>;
  computeMs: number;
}

const ALLOCATION_DIMS: AllocationDimension[] = ['country', 'currency', 'assetClass', 'sector', 'account', 'instrument'];

export function previousBusinessDay(date: ISODate): ISODate {
  let d = addDays(date, -1);
  for (let i = 0; i < 4; i++) {
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (dow !== 0 && dow !== 6) break;
    d = addDays(d, -1);
  }
  return d;
}

/** Builds the engine input for the selected portfolio or the consolidated view. */
export function buildEngineInput(ds: Dataset, market: MarketData): EngineInput | undefined {
  if (ds.selectedPortfolioId === 'all') {
    const consolidated: Portfolio = {
      id: 'all',
      name: 'Todos',
      baseCurrency: ds.reportingCurrency,
      costMethod: ds.portfolios[0]?.costMethod ?? ds.defaultCostMethod,
      createdAt: ds.portfolios.map((p) => p.createdAt).sort()[0] ?? ds.asOf,
      benchmarks: ds.benchmarks,
    };
    return {
      portfolio: consolidated,
      transactions: ds.transactions,
      instruments: ds.instruments,
      market,
      baseCurrency: ds.reportingCurrency,
      options: { asOf: ds.asOf },
    };
  }
  const portfolio = ds.portfolios.find((p) => p.id === ds.selectedPortfolioId);
  if (!portfolio) return undefined;
  return {
    portfolio,
    transactions: ds.transactions.filter((t) => t.portfolioId === portfolio.id),
    instruments: ds.instruments,
    market,
    baseCurrency: ds.reportingCurrency,
    options: { asOf: ds.asOf },
  };
}

export function computeAnalysis(ds: Dataset): Analysis {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const engineErrors: Record<string, string> = {};
  const attempt = <T>(step: string, fn: () => T): T | undefined => {
    try {
      return fn();
    } catch (e) {
      engineErrors[step] = e instanceof Error ? e.message : String(e);
      return undefined;
    }
  };

  const out: Analysis = {
    asOf: ds.asOf,
    baseCurrency: ds.reportingCurrency,
    portfolioId: ds.selectedPortfolioId,
    hasTransactions: false,
    summaries: {},
    series: [],
    dailySeries: [],
    monthly: [],
    benchmarkRisk: {},
    allocations: {},
    income: [],
    realized: [],
    movers: [],
    issues: { errors: [], warnings: [] },
    engineErrors,
    computeMs: 0,
  };

  const market = attempt('createMarketData', () =>
    core.createMarketData({ prices: ds.prices, fx: ds.fx, manualPrices: ds.manualPrices }),
  );
  if (!market) return finish(out, t0);

  const input = buildEngineInput(ds, market);
  if (!input) return finish(out, t0);

  const txs = input.transactions;
  out.hasTransactions = txs.length > 0;
  if (!txs.length) return finish(out, t0);
  const firstDate = txs.reduce((min, t) => (t.date < min ? t.date : min), txs[0]!.date);
  out.firstDate = firstDate;

  const issues = attempt('validateTransactions', () => core.validateTransactions(txs, ds.instruments));
  if (issues) out.issues = issues;

  out.valuation = attempt('valuePortfolio', () => core.valuePortfolio(input, ds.asOf));

  const prev = previousBusinessDay(ds.asOf);
  const periods: [SummaryKey, core.PeriodKey][] = [
    ['MTD', 'MTD'],
    ['YTD', 'YTD'],
    ['1Y', '1Y'],
    ['3Y', '3Y'],
    ['SI', 'SI'],
  ];
  for (const [key, period] of periods) {
    const s = attempt(`performanceSummary.${key}`, () => core.performanceSummary(input, period, ds.asOf));
    if (s) out.summaries[key] = s;
  }
  if (prev >= firstDate) {
    const s = attempt('performanceSummary.DAY', () =>
      core.performanceSummary(input, 'CUSTOM', ds.asOf, { from: prev, to: ds.asOf }),
    );
    if (s) out.summaries.DAY = s;
  }

  const spanDays = (Date.parse(ds.asOf) - Date.parse(firstDate)) / 86_400_000;
  out.series =
    attempt('valueSeries', () =>
      core.valueSeries(input, { from: firstDate, to: ds.asOf, step: spanDays > 730 ? 'week' : 'day' }),
    ) ?? [];
  const dailyFrom = addDays(ds.asOf, -400) > firstDate ? addDays(ds.asOf, -400) : firstDate;
  out.dailySeries =
    spanDays > 730
      ? (attempt('valueSeries.daily', () => core.valueSeries(input, { from: dailyFrom, to: ds.asOf, step: 'day' })) ?? [])
      : out.series;

  const benchmarks = ds.benchmarks.filter((b) => ds.prices.some((p) => p.instrumentId === b));
  out.monthly =
    attempt('monthlyPerformance', () =>
      core.monthlyPerformance(input, { to: ds.asOf.slice(0, 7), benchmarks }),
    ) ?? [];

  if (out.monthly.length) {
    out.risk = attempt('riskMetrics', () =>
      core.riskMetrics(out.monthly, {
        riskFreeAnnual: ds.riskFreeRate,
        benchmarkMonthly: benchmarks[0] ? out.monthly.map((m) => m.benchmarkReturns?.[benchmarks[0]!] ?? 0) : undefined,
      }),
    );
    for (const b of benchmarks) {
      const bm = out.monthly.map((m) => ({ ...m, twr: m.benchmarkReturns?.[b] ?? 0 }));
      let cum = 1;
      for (const m of bm) {
        cum *= 1 + m.twr;
        m.cumulativeTwr = cum - 1;
      }
      const r = attempt(`riskMetrics.${b}`, () => core.riskMetrics(bm, { riskFreeAnnual: ds.riskFreeRate }));
      if (r) out.benchmarkRisk[b] = r;
    }
  }

  if (out.valuation) {
    const valuation = out.valuation;
    for (const dim of ALLOCATION_DIMS) {
      const a = attempt(`allocation.${dim}`, () => core.allocation(valuation, ds.instruments, dim));
      if (a) out.allocations[dim] = a;
    }
    out.movers = computeMovers(valuation, ds, market);
    out.latestPriceDate = valuation.holdings.reduce<string | undefined>(
      (m, h) => (h.priceDate && (!m || h.priceDate > m) ? h.priceDate : m),
      undefined,
    );
  }

  out.income = attempt('incomeEvents', () => core.incomeEvents(input)) ?? [];
  out.realized = attempt('realizedGains', () => core.realizedGains(input)) ?? [];

  return finish(out, t0);
}

function computeMovers(v: Valuation, ds: Dataset, market: MarketData): Mover[] {
  // Change between each holding's last two available closes (manual prices override provider).
  const series = new Map<string, Map<string, number>>();
  for (const s of [...ds.prices, ...ds.manualPrices]) {
    const m = series.get(s.instrumentId) ?? new Map<string, number>();
    for (const p of s.points) if (p.date <= ds.asOf) m.set(p.date, p.close);
    series.set(s.instrumentId, m);
  }
  const movers: Mover[] = [];
  for (const h of v.holdings) {
    if (!h.quantity) continue;
    const pts = [...(series.get(h.instrumentId)?.entries() ?? [])].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    const last = pts[pts.length - 1];
    const prev = pts[pts.length - 2];
    if (!last || !prev || !prev[1]) continue;
    const fx = market.fx(h.currency, ds.reportingCurrency, last[0]) ?? 0;
    movers.push({
      instrumentId: h.instrumentId,
      date: last[0],
      price: last[1],
      prevPrice: prev[1],
      changePct: last[1] / prev[1] - 1,
      changeBase: (last[1] - prev[1]) * h.quantity * fx,
    });
  }
  return movers.sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct));
}

function finish(a: Analysis, t0: number): Analysis {
  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  a.computeMs = Math.round(t1 - t0);
  return a;
}
