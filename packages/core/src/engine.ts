/**
 * Memoized engine (C20). One ledger pass and one daily valuation chain serve every period
 * summary, chart series and position report for the same input:
 *   const eng = createEngine(input); eng.summary('YTD', asOf); eng.summary('1Y', asOf); ...
 * The public API functions use a cached engine per input object (WeakMap), so repeated calls
 * with the same input object reuse the work. Treat inputs as immutable (create a new input
 * object, or call createEngine again, after changing transactions or prices).
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
import { addDays, addMonths, dayToIso, isoToDay, yearFraction } from './dates';
import { type EngineContext, type ExternalFlow, Ledger, createContext, runLedger } from './ledger';
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

  constructor(readonly input: EngineInput) {
    this.ctx = createContext(input);
    this.ledger = runLedger(this.ctx);
    this.flowsSorted = this.ledger.flows.slice().sort((a, b) => a.day - b.day);
  }

  get inceptionDay(): number | undefined {
    return this.ctx.sorted[0]?.day;
  }

  get asOf(): ISODate {
    return this.input.options?.asOf ?? dayToIso(Math.max(this.ledger.lastDay, isoToDay(new Date().toISOString().slice(0, 10))));
  }

  // ---- data -----------------------------------------------------------------------------

  valuation(date: ISODate): Valuation {
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
    return rows;
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
    for (let k = 0; k < n; k++) {
      const d = start + k;
      const iss = newIssues();
      const ws: string[] = [];
      const warn = (c: string) => ws.push(c);
      const fl = k > 0 ? inOut.get(d) : undefined;
      let pre = 0;
      if (fl) {
        runner.applyUntil(d - 1);
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
      if (iss.missingFx.size || iss.missingPrices.size || iss.missingIndex.size) issues.set(d, iss);
      if (ws.length) warnings.set(d, ws);
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
      const f = ctx.market.index(infl)!.factor(baseDay, toDay);
      if (f !== undefined) {
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
    const st = this.valuation(to).stalePrices;
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

const cache = new WeakMap<EngineInput, { sig: unknown[]; engine: Engine }>();

function signature(input: EngineInput): unknown[] {
  return [input.transactions, input.transactions?.length, input.market, input.instruments, input.portfolio, input.baseCurrency, input.options];
}

/** Create a memoized engine for an input (C20). */
export function createEngine(input: EngineInput): Engine {
  return new Engine(input);
}

/** Cached engine for the API functions. */
export function engineFor(input: EngineInput): Engine {
  const sig = signature(input);
  const hit = cache.get(input);
  if (hit && hit.sig.length === sig.length && hit.sig.every((v, i) => v === sig[i])) return hit.engine;
  const engine = new Engine(input);
  cache.set(input, { sig, engine });
  return engine;
}
