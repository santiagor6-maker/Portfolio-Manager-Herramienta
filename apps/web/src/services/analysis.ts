/**
 * Pure "analysis" step: turns the local dataset into everything the UI renders, using the
 * @pm/core engine. Runs inside a Web Worker (see worker/engine.worker.ts) and falls back to the
 * main thread when workers are unavailable (tests, old browsers).
 *
 * Every engine call is isolated with try/catch so one failing computation (or an engine function
 * that is not implemented yet) degrades a single widget instead of the whole app.
 */
import { mergeCorporateEvents, scopeImportHashes } from '../lib/consolidate';
import { reviewKey } from '../lib/pendingEvents';
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
import { addDays, addMonths, previousBusinessDay } from '../lib/ids';

export { previousBusinessDay };
import { pendingCloses, type PendingClose } from '../lib/pendingCloses';
import { bonusRatioWarnings } from '../lib/bonusRepair';
import { blankUnconvertible, missingFxCurrencies, scopeBases } from './fxCoverage';

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
  riskFreeAuto?: boolean;
  /** W31: real holdings valued only with the sample's synthetic series (mixed "Todos" view). */
  demoPricedInstruments?: string[];
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

export interface ImplicitFunding {
  date: string;
  month: string;
  currency: CurrencyCode;
  amount: number;
  amountBase?: number;
  transactionId?: string;
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
  /** W32: the currency's reference rate / inflation index when its series is not loaded (shown as "no disponible"). */
  missingRateIndex?: IndexId;
  missingInflation?: IndexId;
  /** Last month covered when a "% of index" was derived from partial index data. */
  indexCoverage: Record<string, string>;
  upcomingDividends: UpcomingDividend[];
  /** Corporate-action transactions suggested from provider data (not yet recorded). */
  suggestions: Suggestion[];
  reviewActions: CorporateAction[];
  pendingCloses: PendingClose[];
  /** Engine diagnostics from replaying the ledger (negative cash, oversells, implicit FX...). */
  diagnostics: core.Diagnostic[];
  /**
   * W22: purchases the engine funded with an implicit deposit (no cash recorded before them).
   * They inflate contributions and can leave phantom cash when a later deposit is dated today.
   */
  implicitFunding: ImplicitFunding[];
  /** W31: real holdings valued with sample (synthetic) prices. */
  demoPriced: string[];
  /**
   * W40: currencies in scope with no FX route to the reporting currency (pair not downloaded). When
   * non-empty every reporting-currency figure is NaN ("—"), never the engine's zeros.
   */
  fxMissing: CurrencyCode[];
  /** Most recent price date across holdings (to flag stale data). */
  latestPriceDate?: ISODate;
  /**
   * W49: months in which the portfolio held market-priced assets but none of them has a close: their
   * 0 % is "no price", not a flat month.
   */
  unpricedMonths: string[];
  /** W49: market-priced holdings whose last close is older than the previous business day. */
  staleMarket: { instrumentId: string; priceDate?: ISODate }[];
  /** Risk-free rate used by Sharpe/Sortino and where it came from (W29). */
  riskFree?: { rate: number; source: IndexId | 'setting' };
  /** Closes compared by the day change (W26). */
  dayRange?: { from: ISODate; to: ISODate };
  issues: { errors: ValidationIssue[]; warnings: ValidationIssue[] };
  /** Engine failures by step (e.g. "monthlyPerformance not implemented yet"). */
  engineErrors: Record<string, string>;
  computeMs: number;
}

const ALLOCATION_DIMS: AllocationDimension[] = ['country', 'currency', 'assetClass', 'sector', 'account', 'instrument'];

/** Default inflation index per reporting currency (matches the engine's own defaults). */
export const INFLATION_BY_CURRENCY: Record<string, IndexId> = { COP: 'IPC_CO', BRL: 'IPCA', USD: 'CPI_US', EUR: 'HICP_EA' };
export const RATE_INDICES: IndexId[] = ['CDI', 'IBR', 'SELIC'];
/** W32: reference rates of each reporting currency only: never compare a BRL portfolio with the IBR. */
export const RATE_INDICES_BY_CURRENCY: Record<string, IndexId[]> = { COP: ['IBR'], BRL: ['CDI', 'SELIC'] };

/** Typical dividend withholding by country of the payer (non-resident, no treaty relief). */
const DEFAULT_WITHHOLDING: Record<string, number> = { US: 0.3, ES: 0.19, NL: 0.15, DE: 0.26375, FR: 0.25, CO: 0.1, BR: 0, GB: 0, IE: 0, CH: 0.35, MX: 0.1, CL: 0.35, PE: 0.05 };


function engineOptions(ds: Dataset): EngineInput['options'] {
  const loaded = new Set((ds.indexSeries ?? []).map((s) => s.id));
  const inflation = INFLATION_BY_CURRENCY[ds.reportingCurrency];
  return {
    asOf: ds.asOf,
    inflationIndex: inflation && loaded.has(inflation) ? inflation : null,
    indices: (RATE_INDICES_BY_CURRENCY[ds.reportingCurrency] ?? []).filter((i) => loaded.has(i)),
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
    // W68: one ledger for every portfolio — each corporate event once, import hashes per portfolio.
    const transactions = scopeImportHashes(mergeCorporateEvents(ds.transactions));
    // W68: and each portfolio's cash apart (one portfolio's cash never funds another's purchase), so
    // "Todos" is the sum of the portfolios.
    const portfolioBaseCurrencies = Object.fromEntries(ds.portfolios.map((p) => [p.id, p.baseCurrency]));
    return { portfolio: consolidated, transactions, instruments: ds.instruments, market, baseCurrency: ds.reportingCurrency, options: { ...options, isolatePortfolioCash: true, portfolioBaseCurrencies } };
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
    implicitFunding: [],
    demoPriced: ds.demoPricedInstruments ?? [],
    fxMissing: [],
    unpricedMonths: [],
    staleMarket: [],
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
  const homeRate = RATE_INDICES_BY_CURRENCY[ds.reportingCurrency]?.[0];
  if (homeRate && !out.rateIndices.includes(homeRate)) out.missingRateIndex = homeRate;
  const homeInfl = INFLATION_BY_CURRENCY[ds.reportingCurrency];
  if (homeInfl && !opts.inflationIndex) out.missingInflation = homeInfl;

  const txs = input.transactions;
  out.hasTransactions = txs.length > 0;
  if (!txs.length) return finish(out, t0);
  const firstDate = txs.reduce((min, t) => (t.date < min ? t.date : min), txs[0]!.date);
  out.firstDate = firstDate;
  out.fxMissing = attempt('fxCoverage', () => missingFxCurrencies(ds.reportingCurrency, txs, ds.instruments, market, ds.asOf, scopeBases(ds))) ?? [];

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

  // W29: the reporting currency's own reference rate (IBR for COP, CDI for BRL), realized over the
  // last 12 covered months, instead of a fixed 4 % for every currency.
  const RF_INDEX: Partial<Record<string, IndexId>> = { COP: 'IBR', BRL: 'CDI' };
  const rfId = RF_INDEX[ds.reportingCurrency];
  const rfRows = rfId ? out.monthly.filter((m) => m.indexReturns?.[rfId] !== undefined).slice(-12) : [];
  out.riskFree =
    ds.riskFreeAuto !== false && rfId && rfRows.length >= 6
      ? { rate: Math.pow(rfRows.reduce((c, m) => c * (1 + m.indexReturns![rfId]!), 1), 12 / rfRows.length) - 1, source: rfId }
      : { rate: ds.riskFreeRate, source: 'setting' };
  const riskFreeAnnual = out.riskFree.rate;

  if (out.monthly.length) {
    out.risk = attempt('riskMetrics', () =>
      core.riskMetrics(out.monthly, {
        riskFreeAnnual,
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
      const r = attempt(`riskMetrics.${b}`, () => core.riskMetrics(bm, { riskFreeAnnual }));
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
    // W26: day change between the last two market closes (manual / accrual assets excluded).
    // Each holding is valued at its own last close on or before each date, so holdings with
    // older closes simply contribute no change instead of hiding the figure.
    const dates = new Set<string>();
    const manual = new Set(ds.instruments.filter((i) => i.pricing === 'manual' || i.accrual).map((i) => i.id));
    const held = new Set(valuation.holdings.filter((h) => h.quantity && !manual.has(h.instrumentId)).map((h) => h.instrumentId));
    for (const ps of ds.prices) if (held.has(ps.instrumentId)) for (const p of ps.points) if (p.date <= ds.asOf) dates.add(p.date);
    const sorted = [...dates].sort();
    const to = sorted[sorted.length - 1];
    const from = sorted[sorted.length - 2];
    if (to && from) {
      const d = attempt('performanceSummary.DAY', () => E.summary('CUSTOM', to, { from, to }));
      if (d) out.summaries.DAY = d;
      out.dayRange = { from, to };
    }
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
  out.diagnostics.push(...(attempt('bonusRatioWarnings', () => bonusRatioWarnings(txs)) ?? []));
  out.implicitFunding =
    attempt('implicitFunding', () =>
      E.ledger.flows
        .filter((fl) => fl.kind === 'IMPLICIT_DEPOSIT' && fl.amount > 0)
        .map((fl) => {
          const date = new Date(fl.day * 86_400_000).toISOString().slice(0, 10);
          return { date, month: date.slice(0, 7), currency: fl.currency, amount: fl.amount, amountBase: fl.base, transactionId: fl.transactionId };
        })
        .sort((a, b) => (a.date < b.date ? -1 : 1)),
    ) ?? [];
  out.pendingCloses = attempt('pendingCloses', () => pendingCloses(txs, ds.instruments, ds.manualPrices, ds.asOf)) ?? [];
  Object.assign(out, attempt('priceCoverage', () => priceCoverage(ds, txs, out.valuation)));

  return finish(out, t0);
}

/**
 * W49: months in which the portfolio held a market-priced asset but none of those held has a close
 * ("sin precio", not 0 %), and market-priced holdings of real portfolios whose last close is stale.
 */
export function priceCoverage(
  ds: Pick<Dataset, 'instruments' | 'prices' | 'asOf'> & { portfolios?: Dataset['portfolios'] },
  txs: Transaction[],
  valuation: Valuation | undefined,
): { unpricedMonths: string[]; staleMarket: { instrumentId: string; priceDate?: ISODate }[] } {
  const market = new Set(ds.instruments.filter((i) => i.pricing !== 'manual' && !i.accrual && i.assetClass !== 'cash').map((i) => i.id));
  // Months each market-priced asset was held (from the buy to the month it was sold out).
  const held = new Map<string, Set<string>>();
  const byInst = new Map<string, Transaction[]>();
  for (const t of txs) {
    if (!t.instrumentId || !market.has(t.instrumentId)) continue;
    const list = byInst.get(t.instrumentId);
    if (list) list.push(t);
    else byInst.set(t.instrumentId, [t]);
  }
  const endMonth = ds.asOf.slice(0, 7);
  for (const [id, list] of byInst) {
    list.sort((a, b) => (a.date < b.date ? -1 : 1));
    let q = 0;
    let from: string | undefined;
    const add = (a: string, b: string) => {
      for (let m = a; m <= b; m = addMonths(m, 1)) {
        const set = held.get(m) ?? new Set<string>();
        set.add(id);
        held.set(m, set);
      }
    };
    for (const t of list) {
      const n = t.quantity ?? 0;
      if (t.type === 'BUY' || t.type === 'TRANSFER_IN' || t.type === 'STOCK_DIVIDEND') q += n;
      else if (t.type === 'SELL' || t.type === 'TRANSFER_OUT') q -= n;
      else if (t.type === 'SPLIT' && t.ratio) q *= t.ratio;
      if (q > 1e-9 && !from) from = t.date.slice(0, 7);
      if (q <= 1e-9 && from) {
        add(from, t.date.slice(0, 7));
        from = undefined;
      }
    }
    if (from) add(from, endMonth);
  }
  const pricedIn = new Map<string, Set<string>>();
  for (const ps of ds.prices) if (byInst.has(ps.instrumentId)) for (const p of ps.points) {
    const m = p.date.slice(0, 7);
    pricedIn.set(m, (pricedIn.get(m) ?? new Set()).add(ps.instrumentId));
  }
  const unpricedMonths = [...held.entries()]
    .filter(([m, ids]) => m <= endMonth && ![...ids].some((id) => pricedIn.get(m)?.has(id)))
    .map(([m]) => m)
    .sort();
  // The frozen sample's prices end on purpose: only assets of real portfolios are "stale".
  const demo = new Set((ds.portfolios ?? []).filter((p) => p.isDemo).map((p) => p.id));
  const real = new Set(txs.filter((t) => t.instrumentId && !demo.has(t.portfolioId)).map((t) => t.instrumentId!));
  const cutoff = previousBusinessDay(ds.asOf);
  const staleMarket = (valuation?.holdings ?? [])
    .filter((h) => h.quantity > 0 && market.has(h.instrumentId) && real.has(h.instrumentId) && (!h.priceDate || h.priceDate < cutoff))
    .map((h) => ({ instrumentId: h.instrumentId, priceDate: h.priceDate }));
  return { unpricedMonths, staleMarket };
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
    for (const a of r.review) if (!dismissed.has(reviewKey(a))) review.set(`${a.instrumentId}|${a.type}|${a.date}`, a);
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
    announced.add(`${e.instrumentId}|${pay.slice(0, 7)}`);
  }
  // W12: positions bought recently have no payments of their own yet. Project the provider's
  // past year of dividends (quarterly AAPL, PETR4...) one year ahead, at the current quantity.
  for (const a of ds.corporateActions ?? []) {
    if (a.type !== 'DIVIDEND' || !a.amountPerShare) continue;
    const h = held.get(a.instrumentId);
    if (!h) continue;
    const paid = a.payDate ?? a.date;
    if (paid <= from || paid > ds.asOf) continue;
    const pay = addDays(paid, 365);
    if (pay <= ds.asOf || pay > horizon || announced.has(`${a.instrumentId}|${pay.slice(0, 7)}`)) continue;
    const ccy = a.currency ?? inst.get(a.instrumentId)?.currency ?? h.currency;
    const fx = market.fx(ccy, ds.reportingCurrency, ds.asOf) ?? 0;
    const w = a.subtype === 'JCP' ? 0.15 : rate(a.instrumentId);
    const gross = a.amountPerShare * h.quantity * fx;
    out.push({ instrumentId: a.instrumentId, payDate: pay, amountPerShare: a.amountPerShare, currency: ccy, quantity: h.quantity, grossBase: gross, netBase: gross * (1 - w), withholdingRate: w, source: 'history' });
    announced.add(`${a.instrumentId}|${pay.slice(0, 7)}`);
  }
  return out.sort((a, b) => (a.payDate < b.payDate ? -1 : 1));
}

function computeMovers(v: Valuation, ds: Dataset, market: MarketData): Mover[] {
  // Change between each market-priced holding's last two closes; each row keeps its own dates (W26).
  const series = new Map<string, Map<string, number>>();
  for (const s of ds.prices) {
    const m = series.get(s.instrumentId) ?? new Map<string, number>();
    for (const p of s.points) if (p.date <= ds.asOf) m.set(p.date, p.close);
    series.set(s.instrumentId, m);
  }
  const movers: Mover[] = [];
  const manual = new Set(ds.instruments.filter((i) => i.pricing === 'manual' || i.accrual).map((i) => i.id));
  for (const h of v.holdings) {
    if (!h.quantity || manual.has(h.instrumentId)) continue;
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
  if (a.fxMissing.length) blankUnconvertible(a);
  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  a.computeMs = Math.round(t1 - t0);
  return a;
}
