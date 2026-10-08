/**
 * Memoized engine (C20). One ledger pass and one daily valuation chain serve every period
 * summary, chart series and position report for the same input:
 *   const eng = createEngine(input); eng.summary('YTD', asOf); eng.summary('1Y', asOf); ...
 *
 * Cache safety (C23):
 * - An Engine takes a SNAPSHOT of its input (transactions, instruments, portfolio and options are
 *   copied), so later edits to the caller's objects never leak into it. Call createEngine again
 *   (or use the stateless API) after editing data.
 * - The stateless API functions look engines up by a structural CONTENT HASH of the input
 *   (every transaction field, instruments, portfolio, options, reporting currency) plus the
 *   identity and optional `revision` of the market-data object: in-place edits, a changed
 *   options.asOf or a changed portfolio.baseCurrency produce a new engine. Rows are fingerprinted
 *   incrementally (only changed rows are re-hashed). Market data built by createMarketData is
 *   immutable; a custom MarketData that changes in place must bump `revision`, otherwise its
 *   results are never cached. For the web, prefer an explicit createEngine(input) handle.
 * - Every value returned is a fresh copy: callers may sort/reverse/mutate results freely.
 *
 * Daily chain: for every day d in the grid, V(d) (close) and, on days with external flows, the
 * pre-flow value P(d) (see performance.ts). Index I(d) = prod of daily growth; the TWR between
 * any two days is I(b) / I(a) - 1, identical to the monthly table's chained sub-periods.
 */
import type {
  IncomeEvent,
  ISODate,
  MonthlyRow,
  PerformanceSummary,
  PositionPerformance,
  RealizedGain,
  Valuation,
} from './types';
import type { EngineInput, PeriodKey } from './api';
import type { MarketData, Transaction } from './types';
import { addDays, addMonths, dayToIso, isoToDay, todayIso, yearFraction } from './dates';
import { type Diagnostic, type EngineContext, type ExternalFlow, Ledger, createContext, runLedger } from './ledger';
import {
  type MonthlyOptions,
  flowDayReturn,
  flowScale,
  inflationIndexFor,
  monthlyFromContext,
  rateIndicesFor,
  subReturn,
} from './performance';
import { positionPerformanceImpl } from './positions';
import { type ValueIssues, buildValuation, newIssues, totalValue, valueAggregates } from './valuation';
import { xirrDetailed } from './xirr';
import { type GoalProjectionOptions, type GoalProjectionResult, goalProjection } from './goals';
import { riskMetricsImpl } from './risk';

/** First day included in the period (start value is measured at the end of the previous day). */
export function periodStart(period: PeriodKey, asOf: ISODate, inception: ISODate | undefined, custom?: { from: ISODate; to: ISODate }): ISODate {
  const y = asOf.slice(0, 4);
  switch (period) {
    case 'MTD':
      return `${asOf.slice(0, 7)}-01`;
    case 'QTD': {
      const q = Math.floor((Number(asOf.slice(5, 7)) - 1) / 3) * 3 + 1;
      return `${y}-${String(q).padStart(2, '0')}-01`;
    }
    case 'YTD':
      return `${y}-01-01`;
    case '1M':
      return addDays(addMonths(asOf, -1), 1);
    case '3M':
      return addDays(addMonths(asOf, -3), 1);
    case '6M':
      return addDays(addMonths(asOf, -6), 1);
    case '1Y':
      return addDays(addMonths(asOf, -12), 1);
    case '3Y':
      return addDays(addMonths(asOf, -36), 1);
    case '5Y':
      return addDays(addMonths(asOf, -60), 1);
    case 'CUSTOM':
      return custom?.from ?? inception ?? asOf;
    case 'SI':
    default:
      return inception ?? asOf;
  }
}

export interface DailyChain {
  start: number;
  end: number;
  V: Float64Array;
  I: Float64Array;
  cash: Float64Array;
  U: Float64Array;
  UFx: Float64Array;
  issues: Map<number, ValueIssues>;
  warnings: Map<number, string[]>;
}

function lowerBound<T>(arr: T[], day: number, key: (t: T) => number): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (key(arr[mid] as T) <= day) lo = mid + 1;
    else hi = mid;
  }
  return lo; // first index with key > day
}

/** Elements with key in (a, b]. Arrays must be sorted by key. */
function inRange<T>(arr: T[], a: number, b: number, key: (t: T) => number): T[] {
  return arr.slice(lowerBound(arr, a, key), lowerBound(arr, b, key));
}

export class Engine {
  readonly ctx: EngineContext;
  readonly ledger: Ledger;
  private daily: DailyChain | undefined;
  private readonly valuations = new Map<number, Valuation>();
  private readonly monthlyCache = new Map<string, MonthlyRow[]>();
  private readonly flowsSorted: ExternalFlow[];

  readonly input: EngineInput;

  constructor(input: EngineInput) {
    this.input = snapshotInput(input);
    this.ctx = createContext(this.input);
    this.ledger = runLedger(this.ctx);
    this.flowsSorted = this.ledger.flows.slice().sort((a, b) => a.day - b.day);
  }

  get inceptionDay(): number | undefined {
    return this.ctx.sorted[0]?.day;
  }

  get asOf(): ISODate {
    return this.input.options?.asOf ?? todayIso();
  }

  // ---- data -----------------------------------------------------------------------------

  valuation(date: ISODate): Valuation {
    return structuredClone(this.valuationShared(date));
  }

  /** Cached valuation (internal, do not mutate). */
  private valuationShared(date: ISODate): Valuation {
    const day = isoToDay(date);
    let v = this.valuations.get(day);
    if (!v) {
      v = buildValuation(runLedger(this.ctx, day), day);
      if (this.valuations.size > 64) this.valuations.clear();
      this.valuations.set(day, v);
    }
    return v;
  }

  realized(from?: ISODate, to?: ISODate): RealizedGain[] {
    const a = from ? isoToDay(from) : -Infinity;
    const b = to ? isoToDay(to) : Infinity;
    return this.ledger.realized.filter((r) => r.day >= a && r.day <= b).map(({ day: _d, ...r }) => r);
  }

  income(from?: ISODate, to?: ISODate): IncomeEvent[] {
    const a = from ? isoToDay(from) : -Infinity;
    const b = to ? isoToDay(to) : Infinity;
    return this.ledger.income.filter((e) => e.day >= a && e.day <= b).map(({ day: _d, ...e }) => e);
  }

  monthly(opts: MonthlyOptions = {}): MonthlyRow[] {
    const key = JSON.stringify(opts);
    let rows = this.monthlyCache.get(key);
    if (!rows) {
      rows = monthlyFromContext(this.ctx, this.input, opts, this.ledger);
      this.monthlyCache.set(key, rows);
    }
    return structuredClone(rows);
  }

  diagnostics(): Diagnostic[] {
    return this.ledger.diagnostics.map((d) => ({ ...d }));
  }

  // ---- daily chain ----------------------------------------------------------------------

  /** Daily values and TWR index covering [start, end] (rebuilt only when the range grows). */
  dailyChain(start: number, end: number): DailyChain {
    const d0 = this.daily;
    if (d0 && d0.start <= start && d0.end >= end) return d0;
    const s = Math.min(start, d0?.start ?? start);
    const e = Math.max(end, d0?.end ?? end);
    this.daily = this.buildDaily(s, e);
    return this.daily;
  }

  private buildDaily(start: number, end: number): DailyChain {
    const ctx = this.ctx;
    const n = end - start + 1;
    const V = new Float64Array(n);
    const I = new Float64Array(n);
    const cash = new Float64Array(n);
    const U = new Float64Array(n);
    const UFx = new Float64Array(n);
    const issues = new Map<number, ValueIssues>();
    const warnings = new Map<number, string[]>();
    const inOut = new Map<number, { inB: number; outB: number }>();
    for (const f of this.ledger.flows) {
      let e = inOut.get(f.day);
      if (!e) inOut.set(f.day, (e = { inB: 0, outB: 0 }));
      if (f.base >= 0) e.inB += f.base;
      else e.outB -= f.base;
    }
    const eps = Math.max(1e-12, 1e-9 * flowScale(this.ledger.flows));
    const runner = new Ledger(ctx);
    let iss = newIssues();
    for (let k = 0; k < n; k++) {
      const d = start + k;
      let ws: string[] | undefined;
      const warn = (c: string) => (ws ??= []).push(c);
      const fl = k > 0 ? inOut.get(d) : undefined;
      let pre = 0;
      if (fl) {
        runner.applyStartOfDay(d);
        pre = totalValue(runner, d, d, ctx.firstTradePrice.get(d), iss);
      }
      runner.applyUntil(d);
      const a = valueAggregates(runner, d, iss);
      V[k] = a.total;
      cash[k] = a.cash;
      U[k] = a.unrealized;
      UFx[k] = a.unrealizedFx;
      if (k === 0) I[k] = 1;
      else {
        let g: number;
        if (fl) {
          const { ra, rb } = flowDayReturn(V[k - 1] as number, pre, a.total, fl.inB, fl.outB, eps, warn);
          g = (1 + ra) * (1 + rb);
        } else g = 1 + subReturn(a.total, V[k - 1] as number, eps, warn);
        I[k] = (I[k - 1] as number) * g;
      }
      if (iss.missingFx.size || iss.missingPrices.size || iss.missingIndex.size) {
        issues.set(d, iss);
        iss = newIssues(); // only allocate a new collector when this one was kept
      }
      if (ws) warnings.set(d, ws);
    }
    return { start, end, V, I, cash, U, UFx, issues, warnings };
  }

  // ---- summary --------------------------------------------------------------------------

  summary(period: PeriodKey, asOf: ISODate, custom?: { from: ISODate; to: ISODate }): PerformanceSummary {
    const ctx = this.ctx;
    const incDay = this.inceptionDay;
    const inception = incDay !== undefined ? dayToIso(incDay) : undefined;
    const to = period === 'CUSTOM' && custom ? custom.to : asOf;
    let from = periodStart(period, to, inception, custom);
    if (inception && from < inception) from = inception;
    if (from > to) from = to;
    const fromDay = isoToDay(from);
    const toDay = isoToDay(to);
    const baseDay = fromDay - 1;
    const chain = this.dailyChain(Math.min(baseDay, (incDay ?? baseDay + 1) - 1), toDay);
    const at = (d: number) => d - chain.start;
    const V0 = chain.V[at(baseDay)] as number;
    const V1 = chain.V[at(toDay)] as number;
    const I0 = chain.I[at(baseDay)] as number;
    const I1 = chain.I[at(toDay)] as number;
    const twr = I0 !== 0 ? I1 / I0 - 1 : 0;

    const flows = inRange(this.flowsSorted, baseDay, toDay, (f) => f.day);
    const netFlows = flows.reduce((s, f) => s + f.base, 0);
    const attrs = inRange(this.ledger.attributions, baseDay, toDay, (a) => a.day);
    const sum = (k: keyof (typeof attrs)[number]) => attrs.reduce((s, a) => s + (a[k] as number), 0);
    const realizedRows = inRange(this.ledger.realized, baseDay, toDay, (r) => r.day);
    const realizedGainBase = realizedRows.reduce((s, r) => s + r.gainBase, 0);
    const realizedFx = realizedRows.reduce((s, r) => s + (r.fxGainBase ?? 0), 0);
    const incomeBase = inRange(this.ledger.income, baseDay, toDay, (e) => e.day).reduce((s, e) => s + e.netBase, 0);
    const feesBase = inRange(this.ledger.costs, baseDay, toDay, (c) => c.day).reduce((s, c) => s + c.feesBase, 0);
    const dU = (chain.U[at(toDay)] as number) - (chain.U[at(baseDay)] as number);
    const dUFx = (chain.UFx[at(toDay)] as number) - (chain.UFx[at(baseDay)] as number);
    const cashFx = (chain.cash[at(toDay)] as number) - (chain.cash[at(baseDay)] as number) - sum('cashBase');
    const years = yearFraction(baseDay, toDay);

    const s: PerformanceSummary = {
      from,
      to,
      baseCurrency: ctx.base,
      startValueBase: V0,
      endValueBase: V1,
      netFlowsBase: netFlows,
      gainBase: V1 - V0 - netFlows,
      incomeBase,
      feesBase,
      realizedGainBase,
      unrealizedGainBase: dU,
      twr,
      years,
      fxCashGainBase: cashFx,
      fxConversionResultBase: sum('fxConversion'),
      otherCostsBase: sum('otherCosts'),
      transferAdjustmentBase: sum('transfer'),
      corporateActionAdjustmentBase: sum('corporate'),
      rateDifferenceBase: sum('rateDiff'),
      fxGainBase: realizedFx + dUFx + cashFx,
      priceGainBase: realizedGainBase - realizedFx + dU - dUFx,
    };
    if (years >= 1 - 1e-12 && twr > -1) s.twrAnnualized = Math.pow(1 + twr, 1 / years) - 1;

    const eps = Math.max(1e-12, 1e-9 * flowScale(this.ledger.flows));
    const cf: { date: ISODate; amount: number }[] = [];
    if (Math.abs(V0) > eps) cf.push({ date: dayToIso(baseDay), amount: -V0 });
    for (const f of flows) cf.push({ date: dayToIso(f.day), amount: -f.base });
    cf.push({ date: to, amount: V1 });
    const x = xirrDetailed(cf, 0.1, 'ACT/ACT');
    if (x.rate !== undefined) {
      s.mwr = x.rate;
      // Not annualized: compounded over the span money was invested (first cash flow -> to).
      s.mwrPeriod = Math.pow(1 + x.rate, yearFraction(isoToDay(cf[0]!.date), toDay)) - 1;
    }
    if (x.multipleRoots) s.mwrMultipleRoots = true;

    const infl = inflationIndexFor(ctx);
    if (infl) {
      // C4: real return "to date": unpublished months use the last published variation (flagged).
      const idx = ctx.market.index(infl)!;
      const f = idx.factor(baseDay, toDay, { extrapolate: true });
      if (f !== undefined) {
        s.inflationThrough = dayToIso(Math.min(toDay, idx.lastDay));
        if (toDay > idx.lastDay) s.inflationEstimated = true;
        s.inflation = f - 1;
        s.realTwr = (1 + twr) / f - 1;
        if (years >= 1 - 1e-12 && s.realTwr > -1) s.realTwrAnnualized = Math.pow(1 + s.realTwr, 1 / years) - 1;
      }
    }
    const rateIds = rateIndicesFor(ctx, this.input.portfolio.benchmarks ?? []);
    if (rateIds.length) {
      const ir: Record<string, number> = {};
      const pc: Record<string, number> = {};
      for (const id of rateIds) {
        const f = ctx.market.index(id)!.factor(baseDay, toDay);
        if (f === undefined) continue;
        ir[id] = f - 1;
        if (f - 1 > 1e-12) pc[id] = twr / (f - 1);
      }
      if (Object.keys(ir).length) s.indexReturns = ir;
      if (Object.keys(pc).length) s.percentOfIndex = pc;
    }

    const mfx = new Set<string>();
    const mp = new Set<string>();
    const mi = new Set<string>();
    const ws = new Set<string>();
    for (const [d, iss] of chain.issues) {
      if (d <= baseDay || d > toDay) continue;
      iss.missingFx.forEach((c) => mfx.add(c));
      iss.missingPrices.forEach((c) => mp.add(c));
      iss.missingIndex.forEach((c) => mi.add(c));
    }
    for (const [d, w] of chain.warnings) if (d > baseDay && d <= toDay) w.forEach((c) => ws.add(c));
    if (mi.size) ws.add(`MISSING_INDEX:${Array.from(mi).join(',')}`);
    if (x.multipleRoots) ws.add('MWR_MULTIPLE_ROOTS');
    if (mfx.size) s.missingFx = Array.from(mfx).sort();
    if (mp.size) s.missingPrices = Array.from(mp).sort();
    const st = this.valuationShared(to).stalePrices;
    if (st?.length) s.stalePrices = st;
    if (ws.size) s.warnings = Array.from(ws);
    return s;
  }

  // ---- series ---------------------------------------------------------------------------

  series(opts: { from: ISODate; to: ISODate; step: 'day' | 'week' | 'month' }): { date: ISODate; valueBase: number; netInvestedBase: number; cumulativeTwr: number }[] {
    const days = seriesDays(opts.from, opts.to, opts.step);
    if (days.length === 0) return [];
    const first = days[0] as number;
    const last = days[days.length - 1] as number;
    const inc = this.inceptionDay;
    const chain = this.dailyChain(Math.min(first, inc !== undefined ? inc - 1 : first), last);
    const I0 = chain.I[first - chain.start] as number;
    let fi = 0;
    let invested = 0;
    const out: { date: ISODate; valueBase: number; netInvestedBase: number; cumulativeTwr: number }[] = [];
    for (const d of days) {
      while (fi < this.flowsSorted.length && this.flowsSorted[fi]!.day <= d) invested += this.flowsSorted[fi++]!.base;
      const k = d - chain.start;
      out.push({ date: dayToIso(d), valueBase: chain.V[k] as number, netInvestedBase: invested, cumulativeTwr: I0 !== 0 ? (chain.I[k] as number) / I0 - 1 : 0 });
    }
    return out;
  }

  positions(period: PeriodKey, asOf: ISODate, custom?: { from: ISODate; to: ISODate }): PositionPerformance[] {
    return positionPerformanceImpl(this, period, asOf, custom);
  }

  /**
   * Goal projection from the portfolio (C35). Defaults: start value = value at asOf, monthly
   * contribution = average net external flow of the last 12 months (>= 0), expected return =
   * annualized TWR since inception (clamped to [-20 %, 30 %]), volatility = annualized monthly
   * volatility, inflation = last 12 months of the base currency's inflation index.
   */
  goalProjection(asOf: ISODate, opts: Partial<GoalProjectionOptions> = {}): GoalProjectionResult {
    const si = this.summary('SI', asOf);
    const y = this.summary('1Y', asOf);
    const years = si.years ?? 0;
    const annual = si.twrAnnualized ?? (years > 0.25 && si.twr > -1 ? Math.pow(1 + si.twr, 1 / years) - 1 : 0.08);
    const monthsInYear = Math.max(1, Math.min(12, Math.round((y.years ?? 1) * 12)));
    const rows = this.monthly({ asOf });
    const risk = riskMetricsImpl(rows);
    let inflation: number | undefined;
    const infl = inflationIndexFor(this.ctx);
    if (infl) {
      const to = isoToDay(asOf);
      const f = this.ctx.market.index(infl)!.factor(isoToDay(addMonths(asOf, -12)), to, { extrapolate: true });
      if (f !== undefined) inflation = f - 1;
    }
    return goalProjection({
      startValue: si.endValueBase,
      startDate: asOf,
      monthlyContribution: Math.max(0, y.netFlowsBase / monthsInYear),
      expectedReturn: Math.min(0.3, Math.max(-0.2, annual)),
      volatility: risk.volatility > 0 ? risk.volatility : 0.15,
      ...(inflation !== undefined ? { inflation } : {}),
      ...opts,
    });
  }
}

export function seriesDays(from: ISODate, to: ISODate, step: 'day' | 'week' | 'month'): number[] {
  const a = isoToDay(from);
  const b = isoToDay(to);
  if (!(b >= a)) return [];
  const out: number[] = [];
  if (step === 'day') for (let d = a; d <= b; d++) out.push(d);
  else if (step === 'week') {
    for (let d = a; d <= b; d += 7) out.push(d);
    if (out[out.length - 1] !== b) out.push(b);
  } else {
    out.push(a);
    let d = a;
    for (;;) {
      const dt = new Date(d * 86_400_000);
      const me = Math.round(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth() + 1, 0) / 86_400_000);
      if (me >= b) break;
      if (me > a) out.push(me);
      d = me + 1;
    }
    if (out[out.length - 1] !== b) out.push(b);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Snapshots and content-addressed cache (C23)
// ---------------------------------------------------------------------------

function clonePlain<T>(v: T): T {
  return v === undefined || v === null ? v : (JSON.parse(JSON.stringify(v)) as T);
}

/** Copy everything the engine reads, except the (immutable) market data object. */
export function snapshotInput(input: EngineInput): EngineInput {
  return {
    portfolio: clonePlain(input.portfolio),
    transactions: (input.transactions ?? []).map((t) => ({ ...t })),
    instruments: (input.instruments ?? []).map((i) => clonePlain(i)),
    market: input.market,
    baseCurrency: input.baseCurrency,
    options: clonePlain(input.options),
  };
}

const marketIds = new WeakMap<object, number>();
let nextMarketId = 1;

const TX_FIELDS = [
  'id', 'date', 'type', 'instrumentId', 'quantity', 'price', 'currency', 'amount', 'fees', 'taxes', 'ratio', 'toCurrency',
  'toAmount', 'fxRateToBase', 'account', 'subtype', 'targetInstrumentId', 'costFraction', 'portfolioId',
] as const;

const f64 = new Float64Array(1);
const u32 = new Uint32Array(f64.buffer);

// Two 32-bit hash lanes as module state (no closures in the hot path).
let H0 = 0;
let H1 = 0;
function hashReset(): void {
  H0 = 2166136261;
  H1 = 0x811c9dc5 ^ 0x5bd1e995;
}
function hashStep(x: number): void {
  H0 = Math.imul(H0 ^ x, 16777619);
  H1 = Math.imul(H1 ^ (x + 0x9e3779b9), 0x01000193) ^ (H1 >>> 15);
}
function hashValue(v: unknown): void {
  if (v === undefined || v === null) hashStep(0x7e);
  else if (typeof v === 'number') {
    f64[0] = v;
    hashStep(u32[0] as number);
    hashStep(u32[1] as number);
  } else {
    const str = typeof v === 'string' ? v : String(v);
    for (let i = 0; i < str.length; i++) hashStep(str.charCodeAt(i));
    hashStep(0x1f);
  }
}

/**
 * Per-transaction-object cache (C41): the field values seen last time and their hash. On the
 * next call each field is compared with `===` (pointer-cheap for unchanged strings) and only
 * rows that really changed are re-hashed, so in-place edits are still detected.
 */
const rowCache = new WeakMap<object, { vals: unknown[]; a: number; b: number }>();

/** Unrolled named-property comparison (monomorphic loads, ~10x faster than keyed access). */
function sameRow(v: unknown[], t: Transaction): boolean {
  return (
    v[0] === t.id &&
    v[1] === t.date &&
    v[2] === t.type &&
    v[3] === t.instrumentId &&
    v[4] === t.quantity &&
    v[5] === t.price &&
    v[6] === t.currency &&
    v[7] === t.amount &&
    v[8] === t.fees &&
    v[9] === t.taxes &&
    v[10] === t.ratio &&
    v[11] === t.toCurrency &&
    v[12] === t.toAmount &&
    v[13] === t.fxRateToBase &&
    v[14] === t.account &&
    v[15] === t.subtype &&
    v[16] === t.targetInstrumentId &&
    v[17] === t.costFraction &&
    v[18] === t.portfolioId
  );
}

function rowValues(t: Transaction): unknown[] {
  return [t.id, t.date, t.type, t.instrumentId, t.quantity, t.price, t.currency, t.amount, t.fees, t.taxes, t.ratio, t.toCurrency, t.toAmount, t.fxRateToBase, t.account, t.subtype, t.targetInstrumentId, t.costFraction, t.portfolioId];
}

function rowHash(t: Transaction): { a: number; b: number } {
  const hit = rowCache.get(t);
  if (hit && sameRow(hit.vals, t)) return hit;
  const vals = rowValues(t);
  const s0 = H0;
  const s1 = H1;
  hashReset();
  for (let i = 0; i < vals.length; i++) hashValue(vals[i]);
  const e = { vals, a: H0, b: H1 };
  H0 = s0;
  H1 = s1;
  rowCache.set(t, e);
  return e;
}

/**
 * Structural hash of everything that affects results. Returns undefined for a custom MarketData
 * (not built by createMarketData) without a `revision`: its content cannot be fingerprinted, so
 * results are never cached for it (C41).
 */
export function inputHash(input: EngineInput): string | undefined {
  const m = input.market as unknown as (MarketData & { engineMarket?: boolean }) | undefined;
  if (m && !m.engineMarket && m.revision === undefined) return undefined;
  let mid = m ? marketIds.get(m) : 0;
  if (m && mid === undefined) marketIds.set(m, (mid = nextMarketId++));
  hashReset();
  hashValue(mid ?? 0);
  hashValue(m?.revision ?? 0);
  hashValue(`${input.baseCurrency ?? ''}|${JSON.stringify(input.portfolio)}|${JSON.stringify(input.options ?? null)}`);
  hashValue(JSON.stringify(input.instruments ?? []));
  const txs = input.transactions ?? [];
  for (let i = 0; i < txs.length; i++) {
    const r = rowHash(txs[i] as Transaction);
    hashStep(r.a);
    hashStep(r.b);
  }
  return `${(H0 >>> 0).toString(36)}.${(H1 >>> 0).toString(36)}.${txs.length}`;
}

const engineCache = new Map<string, Engine>();
const MAX_CACHED_ENGINES = 8;

/** Create an engine (snapshot of the input) (C20). */
export function createEngine(input: EngineInput): Engine {
  return new Engine(input);
}

/** Engine for the stateless API: reused only when the input CONTENT is identical. */
export function engineFor(input: EngineInput): Engine {
  const key = inputHash(input);
  if (key === undefined) return new Engine(input); // mutable custom MarketData without revision
  const hit = engineCache.get(key);
  if (hit) {
    engineCache.delete(key); // refresh LRU position
    engineCache.set(key, hit);
    return hit;
  }
  const engine = new Engine(input);
  engineCache.set(key, engine);
  while (engineCache.size > MAX_CACHED_ENGINES) engineCache.delete(engineCache.keys().next().value as string);
  return engine;
}
