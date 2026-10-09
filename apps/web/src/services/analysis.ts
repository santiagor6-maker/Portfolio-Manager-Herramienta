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
  CorporateAction,
  CurrencyCode,
  EngineInput,
  FxSeries,
  IncomeEvent,
  IndexId,
  IndexSeries,
  Instrument,
  ISODate,
  MarketData,
  MonthlyRow,
  PerformanceSummary,
  Portfolio,
  PositionPerformance,
  PriceSeries,
  RealizedGain,
  RiskMetrics,
  Transaction,
  Valuation,
  ValidationIssue,
} from '@pm/core';
import { addDays } from '../lib/ids';
import { pendingCloses, type PendingClose } from '../lib/pendingCloses';

export interface Dataset {
  portfolios: (Portfolio & { isDemo?: boolean })[];
  transactions: Transaction[];
  instruments: Instrument[];
  prices: PriceSeries[];
  fx: FxSeries[];
  manualPrices: PriceSeries[];
  indexSeries?: IndexSeries[];
  corporateActions?: CorporateAction[];
  /** Suggestion keys (`${portfolioId}|${txId}`) the user dismissed. */
  dismissedSuggestions?: string[];
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
  /** Net invested carried forward with inflation (what contributions must be worth to keep purchasing power). */
  investedRealBase?: number;
}

export interface Mover {
  instrumentId: string;
  /** Date of the latest price; the change is versus the previous available close. */
  date: ISODate;
  prevDate: ISODate;
  changePct: number;
  changeBase: number;
  price: number;
  prevPrice: number;
}

export interface UpcomingDividend {
  instrumentId: string;
  exDate?: ISODate;
  payDate: ISODate;
  amountPerShare?: number;
  currency: CurrencyCode;
  quantity: number;
  grossBase: number;
  netBase: number;
  withholdingRate: number;
  /** 'provider' = announced by the data provider; 'history' = projected from last year's payments. */
  source: 'provider' | 'history';
}

export interface Suggestion {
  key: string;
  transaction: Transaction;
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
  /** Per-position performance since inception and year to date. */
  positions: PositionPerformance[];
  positionsYtd: PositionPerformance[];
  /** Inflation index used for real returns (IPC_CO for COP, IPCA for BRL...), when loaded. */
  inflationIndex?: IndexId;
  /** Rate indices compared against (CDI, IBR...), when loaded. */
  rateIndices: IndexId[];
  /** Last month covered when a "% of index" was derived from partial index data. */
  indexCoverage: Record<string, string>;
  upcomingDividends: UpcomingDividend[];
  /** Corporate-action transactions suggested from provider data (not yet recorded). */
  suggestions: Suggestion[];
  reviewActions: CorporateAction[];
  pendingCloses: PendingClose[];
  /** Engine diagnostics from replaying the ledger (negative cash, oversells, implicit FX...). */
  diagnostics: core.Diagnostic[];
  /** Most recent price date across holdings (to flag stale data). */
  latestPriceDate?: ISODate;
  issues: { errors: ValidationIssue[]; warnings: ValidationIssue[] };
  /** Engine failures by step (e.g. "monthlyPerformance not implemented yet"). */
  engineErrors: Record<string, string>;
  computeMs: number;
}

const ALLOCATION_DIMS: AllocationDimension[] = ['country', 'currency', 'assetClass', 'sector', 'account', 'instrument'];

/** Default inflation index per reporting currency (matches the engine's own defaults). */
export const INFLATION_BY_CURRENCY: Record<string, IndexId> = { COP: 'IPC_CO', BRL: 'IPCA', USD: 'CPI_US', EUR: 'HICP_EA' };
export const RATE_INDICES: IndexId[] = ['CDI', 'IBR', 'SELIC'];

/** Typical dividend withholding by country of the payer (non-resident, no treaty relief). */
const DEFAULT_WITHHOLDING: Record<string, number> = { US: 0.3, ES: 0.19, NL: 0.15, DE: 0.26375, FR: 0.25, CO: 0.1, BR: 0, GB: 0, IE: 0, CH: 0.35, MX: 0.1, CL: 0.35, PE: 0.05 };

export function previousBusinessDay(date: ISODate): ISODate {
  let d = addDays(date, -1);
  for (let i = 0; i < 4; i++) {
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (dow !== 0 && dow !== 6) break;
    d = addDays(d, -1);
  }
  return d;
}

function engineOptions(ds: Dataset): EngineInput['options'] {
  const loaded = new Set((ds.indexSeries ?? []).map((s) => s.id));
  const inflation = INFLATION_BY_CURRENCY[ds.reportingCurrency];
  return {
    asOf: ds.asOf,
    inflationIndex: inflation && loaded.has(inflation) ? inflation : null,
    indices: RATE_INDICES.filter((i) => loaded.has(i)),
  };
}

/** Builds the engine input for the selected portfolio or the consolidated view. */
export function buildEngineInput(ds: Dataset, market: MarketData): EngineInput | undefined {
  const options = engineOptions(ds);
  if (ds.selectedPortfolioId === 'all') {
    const consolidated: Portfolio = {
      id: 'all',
      name: 'Todos',
      baseCurrency: ds.reportingCurrency,
      costMethod: ds.portfolios[0]?.costMethod ?? ds.defaultCostMethod,
      createdAt: ds.portfolios.map((p) => p.createdAt).sort()[0] ?? ds.asOf,
      benchmarks: ds.benchmarks,
    };
    return { portfolio: consolidated, transactions: ds.transactions, instruments: ds.instruments, market, baseCurrency: ds.reportingCurrency, options };
  }
  const portfolio = ds.portfolios.find((p) => p.id === ds.selectedPortfolioId);
  if (!portfolio) return undefined;
  return {
    portfolio,
    transactions: ds.transactions.filter((t) => t.portfolioId === portfolio.id),
    instruments: ds.instruments,
    market,
    baseCurrency: ds.reportingCurrency,
    options,
  };
}

export function createMarket(ds: Pick<Dataset, 'prices' | 'fx' | 'manualPrices' | 'indexSeries' | 'corporateActions'>): MarketData {
  return core.createMarketData({
    prices: ds.prices,
    fx: ds.fx,
    manualPrices: ds.manualPrices,
    indexSeries: ds.indexSeries ?? [],
    corporateActions: (ds.corporateActions ?? []).filter((a) => a.type === 'DIVIDEND'),
  });
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
    positions: [],
    positionsYtd: [],
    rateIndices: [],
    indexCoverage: {},
    upcomingDividends: [],
    suggestions: [],
    reviewActions: [],
    pendingCloses: [],
    diagnostics: [],
    issues: { errors: [], warnings: [] },
    engineErrors,
    computeMs: 0,
  };

  const market = attempt('createMarketData', () => createMarket(ds));
  if (!market) return finish(out, t0);

  const input = buildEngineInput(ds, market);
  if (!input) return finish(out, t0);
  const opts = input.options!;
  out.inflationIndex = opts.inflationIndex ?? undefined;
  out.rateIndices = opts.indices ?? [];

  const txs = input.transactions;
  out.hasTransactions = txs.length > 0;
  if (!txs.length) return finish(out, t0);
  const firstDate = txs.reduce((min, t) => (t.date < min ? t.date : min), txs[0]!.date);
  out.firstDate = firstDate;

  // One explicit engine per input change: every call below shares the ledger pass and its caches
  // (≈0.5 ms per call vs ≈10 ms for the stateless API on 30k transactions).
  const E = core.createEngine(input);

  const issues = attempt('validateTransactions', () => core.validateTransactions(txs, ds.instruments, { today: ds.asOf }));
  if (issues) out.issues = issues;

  out.valuation = attempt('valuePortfolio', () => E.valuation(ds.asOf));

  const periods: [SummaryKey, core.PeriodKey][] = [
    ['MTD', 'MTD'],
    ['YTD', 'YTD'],
    ['1Y', '1Y'],
    ['3Y', '3Y'],
    ['SI', 'SI'],
  ];
  for (const [key, period] of periods) {
    const s = attempt(`performanceSummary.${key}`, () => E.summary(period, ds.asOf));
    if (s) out.summaries[key] = s;
  }

  const spanDays = (Date.parse(ds.asOf) - Date.parse(firstDate)) / 86_400_000;
  out.series = attempt('valueSeries', () => E.series({ from: firstDate, to: ds.asOf, step: spanDays > 730 ? 'week' : 'day' })) ?? [];
  const dailyFrom = addDays(ds.asOf, -400) > firstDate ? addDays(ds.asOf, -400) : firstDate;
  out.dailySeries =
    spanDays > 730 ? (attempt('valueSeries.daily', () => E.series({ from: dailyFrom, to: ds.asOf, step: 'day' })) ?? []) : out.series;
  if (out.inflationIndex && market.indexLevel) {
    out.series = withRealInvested(out.series, market, out.inflationIndex);
    out.dailySeries = withRealInvested(out.dailySeries, market, out.inflationIndex);
  }

  const benchmarks = ds.benchmarks.filter((b) => ds.prices.some((p) => p.instrumentId === b));
  out.monthly = attempt('monthlyPerformance', () => E.monthly({ to: ds.asOf.slice(0, 7), benchmarks, asOf: ds.asOf })) ?? [];

  // Rate indices often lag (BanRep/BCB publish with delay): when the engine leaves a period's
  // "% of index" empty, derive it from the months the index covers and record that coverage.
  for (const s of Object.values(out.summaries)) {
    if (!s || !out.rateIndices.length) continue;
    for (const id of out.rateIndices) {
      if (s.percentOfIndex?.[id] !== undefined) continue;
      const rows = out.monthly.filter((m) => m.month >= s.from.slice(0, 7) && m.month <= s.to.slice(0, 7) && m.indexReturns?.[id] !== undefined);
      if (!rows.length) continue;
      const idx = rows.reduce((c, m) => c * (1 + m.indexReturns![id]!), 1) - 1;
      const twr = rows.reduce((c, m) => c * (1 + m.twr), 1) - 1;
      if (Math.abs(idx) < 1e-9) continue;
      s.indexReturns = { ...(s.indexReturns ?? {}), [id]: idx };
      s.percentOfIndex = { ...(s.percentOfIndex ?? {}), [id]: twr / idx };
      out.indexCoverage[id] = rows[rows.length - 1]!.month;
    }
  }

  if (out.monthly.length) {
    out.risk = attempt('riskMetrics', () =>
      core.riskMetrics(out.monthly, {
        riskFreeAnnual: ds.riskFreeRate,
        benchmarkMonthly: benchmarks[0] ? out.monthly.map((m) => m.benchmarkReturns?.[benchmarks[0]!] ?? 0) : undefined,
        benchmarkId: benchmarks[0],
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

  out.positions = attempt('positionPerformance', () => E.positions('SI', ds.asOf)) ?? [];
  out.positionsYtd = attempt('positionPerformance.YTD', () => E.positions('YTD', ds.asOf)) ?? [];
  out.income = attempt('incomeEvents', () => E.income()) ?? [];
  out.realized = attempt('realizedGains', () => E.realized()) ?? [];

  if (out.valuation) out.upcomingDividends = upcomingDividends(ds, out.valuation, out.income, market);
  const sug = attempt('applyCorporateActions', () => suggestions(ds, txs));
  if (sug) {
    out.suggestions = sug.suggestions;
    out.reviewActions = sug.review;
  }
  out.diagnostics = attempt('ledgerDiagnostics', () => E.diagnostics()) ?? [];
  out.pendingCloses = attempt('pendingCloses', () => pendingCloses(txs, ds.instruments, ds.manualPrices, ds.asOf)) ?? [];

  return finish(out, t0);
}

/** Adds the inflation-adjusted invested line: previous value grown by inflation + new net flows. */
function withRealInvested(series: SeriesPoint[], market: MarketData, index: IndexId): SeriesPoint[] {
  let real: number | undefined;
  let prev: SeriesPoint | undefined;
  return series.map((p) => {
    if (!prev || real === undefined) real = p.netInvestedBase;
    else {
      const l0 = market.indexLevel?.(index, prev.date);
      const l1 = market.indexLevel?.(index, p.date);
      const g = l0 && l1 ? l1 / l0 : 1;
      real = real * g + (p.netInvestedBase - prev.netInvestedBase);
    }
    prev = p;
    return { ...p, investedRealBase: real };
  });
}

function suggestions(ds: Dataset, txs: Transaction[]): { suggestions: Suggestion[]; review: CorporateAction[] } {
  const actions = ds.corporateActions ?? [];
  if (!actions.length) return { suggestions: [], review: [] };
  const dismissed = new Set(ds.dismissedSuggestions ?? []);
  const pids = [...new Set(txs.map((t) => t.portfolioId))].filter((pid) => !ds.portfolios.find((p) => p.id === pid)?.isDemo);
  const outS: Suggestion[] = [];
  const review = new Map<string, CorporateAction>();
  for (const pid of pids) {
    const r = core.applyCorporateActions(
      txs.filter((t) => t.portfolioId === pid),
      actions,
      ds.instruments,
      { portfolioId: pid },
    );
    for (const t of r.suggested) {
      if (t.date > ds.asOf) continue;
      const key = `${pid}|${t.id}`;
      if (!dismissed.has(key)) outS.push({ key, transaction: t });
    }
    for (const a of r.review) review.set(`${a.instrumentId}|${a.type}|${a.date}`, a);
  }
  return { suggestions: outS.sort((a, b) => (a.transaction.date < b.transaction.date ? 1 : -1)), review: [...review.values()] };
}

function upcomingDividends(ds: Dataset, v: Valuation, income: IncomeEvent[], market: MarketData): UpcomingDividend[] {
  const held = new Map(v.holdings.filter((h) => h.quantity > 0).map((h) => [h.instrumentId, h]));
  const inst = new Map(ds.instruments.map((i) => [i.id, i]));
  const horizon = addDays(ds.asOf, 365);
  // Effective withholding observed in the user's own history per instrument.
  const observed = new Map<string, { g: number; t: number }>();
  for (const e of income) {
    if (!e.instrumentId || e.type !== 'DIVIDEND' || !e.gross) continue;
    const o = observed.get(e.instrumentId) ?? { g: 0, t: 0 };
    o.g += e.gross;
    o.t += e.taxes;
    observed.set(e.instrumentId, o);
  }
  const rate = (id: string) => {
    const o = observed.get(id);
    if (o && o.g > 0) return o.t / o.g;
    return DEFAULT_WITHHOLDING[inst.get(id)?.country ?? ''] ?? 0;
  };
  const out: UpcomingDividend[] = [];
  const announced = new Set<string>();
  for (const a of ds.corporateActions ?? []) {
    if (a.type !== 'DIVIDEND' || !a.amountPerShare) continue;
    const h = held.get(a.instrumentId);
    if (!h) continue;
    const pay = a.payDate ?? a.date;
    if (pay <= ds.asOf || pay > horizon) continue;
    const ccy = a.currency ?? inst.get(a.instrumentId)?.currency ?? h.currency;
    const fx = market.fx(ccy, ds.reportingCurrency, ds.asOf) ?? 0;
    const w = a.subtype === 'JCP' ? 0.15 : rate(a.instrumentId);
    const gross = a.amountPerShare * h.quantity * fx;
    out.push({ instrumentId: a.instrumentId, exDate: a.exDate ?? a.date, payDate: pay, amountPerShare: a.amountPerShare, currency: ccy, quantity: h.quantity, grossBase: gross, netBase: gross * (1 - w), withholdingRate: w, source: 'provider' });
    announced.add(`${a.instrumentId}|${pay.slice(0, 7)}`);
  }
  // Projection: last year's payments of instruments still held, one year later.
  const from = addDays(ds.asOf, -365);
  for (const e of income) {
    if (e.type !== 'DIVIDEND' || !e.instrumentId || e.date <= from || e.date > ds.asOf) continue;
    const h = held.get(e.instrumentId);
    if (!h) continue;
    const pay = addDays(e.date, 365);
    if (announced.has(`${e.instrumentId}|${pay.slice(0, 7)}`)) continue;
    out.push({ instrumentId: e.instrumentId, payDate: pay, currency: e.currency, quantity: h.quantity, grossBase: e.net ? (e.netBase * e.gross) / e.net : e.netBase, netBase: e.netBase, withholdingRate: e.gross ? e.taxes / e.gross : 0, source: 'history' });
  }
  return out.sort((a, b) => (a.payDate < b.payDate ? -1 : 1));
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
      prevDate: prev[0],
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
