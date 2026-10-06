/**
 * Performance engine: true time-weighted returns chained over sub-periods split at every
 * external flow, Modified Dietz as an alternative, local-vs-FX decomposition, money waterfall,
 * real (inflation-adjusted) returns, rate-index comparisons ("% do CDI") and benchmarks.
 *
 * Flow-day convention (round 2): the day is split at the moment of the transactions.
 *   V(f-1)  value at the close of the previous day
 *   P(f)    "pre-flow" value: holdings before the day's transactions, priced with the day's
 *           prices except instruments traded that day, which use their (first) trade price,
 *           at the day's FX
 *   V(f)    value at the close of day f (all transactions applied)
 *   r_a = P(f) / V(f-1) - 1                        market move until the trades
 *   r_b = V(f) / (P(f) + IN - OUT) - 1             from the trades to the close
 *         (if P + IN - OUT is ~0, e.g. a full exit: r_b = (V(f) + OUT) / (P(f) + IN) - 1)
 * Combined with trade prints used as price observations, a mid-month buy at 100 of a stock
 * that ends the month at 125 yields exactly +25 % even with month-end-only prices, and a
 * deposit that sits in cash does not dilute the day's market move of the existing holdings.
 * For a stretch [a, b] without flows r = V(b) / V(a) - 1.
 *
 * Degenerate sub-periods (denominator <= 1e-9 x the portfolio's flow scale, or negative)
 * contribute 0 and are reported in `warnings` (never silently).
 *
 * Local vs FX: the local return of a sub-period [a, b] re-prices the end positions with the
 * FX of day a: rL = V(b @ FX a) / V(a) - 1 (flows likewise at FX a). Over a month
 * localReturn = prod(1 + rL) - 1 and fxReturn = twr - localReturn (they add up exactly).
 */
import type { CurrencyCode, ISODate, MonthlyRow, YearMonth } from './types';
import type { EngineInput, EngineOptions } from './api';
import { addMonthsYm, dayToIso, isoToDay, monthEnd, monthRange, todayIso, ymOf } from './dates';
import { type Attribution, type EngineContext, type ExternalFlow, Ledger, createContext } from './ledger';
import { type ValueAggregates, type ValueIssues, newIssues, totalValue, valueAggregates } from './valuation';

export interface PeriodWaterfall {
  realized: number;
  realizedFx: number;
  income: number;
  otherCosts: number;
  fxConversion: number;
  spread: number;
  transfer: number;
  corporate: number;
  rateDiff: number;
  cashFx: number;
  unrealized: number;
  unrealizedFx: number;
}

export interface PeriodResult {
  startDay: number;
  endDay: number;
  startValue: number;
  endValue: number;
  /** Signed net external flows in base currency at flow-date FX. */
  netFlows: number;
  inflows: number;
  outflows: number;
  twr: number;
  localTwr: number;
  waterfall: PeriodWaterfall;
  issues: ValueIssues;
  stale: Set<string>;
  warnings: string[];
}

export interface PeriodComputation {
  periods: PeriodResult[];
  /** Fully processed ledger (all transactions). */
  ledger: Ledger;
  flows: ExternalFlow[];
}

/** Flow in base currency at the FX of `fxDay` (used for local returns). */
export function flowBase(ctx: EngineContext, f: ExternalFlow, fxDay: number): number {
  if (fxDay === f.day) return f.base;
  if (f.currency === ctx.base) return f.amount;
  const r = ctx.market.fxAt(f.currency, ctx.base, fxDay) ?? ctx.market.fxNearest(f.currency, ctx.base, fxDay) ?? f.rateHint ?? 0;
  return f.amount * r;
}

/** Scale of the portfolio for relative degeneracy thresholds. */
export function flowScale(flows: ExternalFlow[]): number {
  let s = 0;
  for (const f of flows) s = Math.max(s, Math.abs(f.base));
  return s > 0 ? s : 1;
}

/** Return of a sub-period with explicit degeneracy handling. */
export function subReturn(end: number, start: number, eps: number, warn: (code: string) => void): number {
  if (start > eps) return end / start - 1;
  if (Math.abs(start) <= eps && Math.abs(end) <= eps) return 0;
  warn(start < -eps ? 'NEGATIVE_VALUE_SUBPERIOD' : 'DEGENERATE_SUBPERIOD');
  return 0;
}

/** Flow-day return split at the trades (see module comment). */
export function flowDayReturn(
  prev: number,
  pre: number,
  close: number,
  inB: number,
  outB: number,
  eps: number,
  warn: (code: string) => void,
): { ra: number; rb: number } {
  const ra = subReturn(pre, prev, eps, warn);
  const d = pre + inB - outB;
  let rb: number;
  if (d > eps) rb = close / d - 1;
  else if (pre + inB > eps) rb = (close + outB) / (pre + inB) - 1;
  else rb = subReturn(close + outB, pre + inB, eps, warn);
  return { ra, rb };
}

interface Seg {
  start: number;
  end: number;
  period: number;
  flowDay: boolean;
  vEnd: number;
  vEndLocal: number;
  vPre: number;
  vPreLocal: number;
}

interface Req {
  stateDay: number;
  priceDay: number;
  fxDay: number;
  override: boolean;
  agg: boolean;
  period: number;
}

const zeroWaterfall = (): PeriodWaterfall => ({
  realized: 0,
  realizedFx: 0,
  income: 0,
  otherCosts: 0,
  fxConversion: 0,
  spread: 0,
  transfer: 0,
  corporate: 0,
  rateDiff: 0,
  cashFx: 0,
  unrealized: 0,
  unrealizedFx: 0,
});

/**
 * Compute returns and the money waterfall between consecutive breakpoints (end-of-day values).
 * Flows dated on breakpoints[0] are excluded; flows dated on later breakpoints belong to the
 * period ending there.
 */
export function computePeriods(
  ctx: EngineContext,
  breakDays: number[],
  opts: { withLocal: boolean; method?: 'daily' | 'modifiedDietz'; ledger?: Ledger },
): PeriodComputation {
  const method = opts.method ?? ctx.options.twrMethod;
  let full = opts.ledger;
  if (!full) {
    full = new Ledger(ctx);
    full.applyAll();
  }
  const flows = full.flows;
  const B = Array.from(new Set(breakDays)).sort((a, b) => a - b);
  const flowsByDay = new Map<number, ExternalFlow[]>();
  for (const f of flows) {
    let arr = flowsByDay.get(f.day);
    if (!arr) flowsByDay.set(f.day, (arr = []));
    arr.push(f);
  }
  const flowDays = Array.from(flowsByDay.keys()).sort((a, b) => a - b);
  const eps = Math.max(1e-12, 1e-9 * flowScale(flows));
  if (B.length === 0) return { periods: [], ledger: full, flows };

  // ---- value requests (generated in non-decreasing state-day order) --------------------
  const reqs: Req[] = [];
  const req = (stateDay: number, priceDay: number, fxDay: number, period: number, override = false, agg = false): number => {
    reqs.push({ stateDay, priceDay, fxDay, override, agg, period });
    return reqs.length - 1;
  };
  const b0 = B[0] as number;
  const v0Req = req(b0, b0, b0, 0, false, true);
  const segs: Seg[] = [];
  const periodEndReq: number[] = [];
  const periodEndReqLocal: number[] = [];
  let fi = 0;
  while (fi < flowDays.length && (flowDays[fi] as number) <= b0) fi++;
  for (let i = 0; i + 1 < B.length; i++) {
    let cur = B[i] as number;
    const end = B[i + 1] as number;
    const pStart = cur;
    while (fi < flowDays.length && (flowDays[fi] as number) <= end) {
      const f = flowDays[fi] as number;
      if (method === 'daily') {
        if (f - 1 > cur) {
          segs.push({ start: cur, end: f - 1, period: i, flowDay: false, vEnd: req(f - 1, f - 1, f - 1, i), vEndLocal: opts.withLocal ? req(f - 1, f - 1, cur, i) : -1, vPre: -1, vPreLocal: -1 });
        }
        const vPre = req(f - 1, f, f, i, true);
        const vPreLocal = opts.withLocal ? req(f - 1, f, f - 1, i, true) : -1;
        const vEnd = req(f, f, f, i, false, f === end);
        const vEndLocal = opts.withLocal ? req(f, f, f - 1, i) : -1;
        segs.push({ start: f - 1, end: f, period: i, flowDay: true, vEnd, vEndLocal, vPre, vPreLocal });
        cur = f;
      }
      fi++;
    }
    if (method === 'daily') {
      if (end > cur) segs.push({ start: cur, end, period: i, flowDay: false, vEnd: req(end, end, end, i, false, true), vEndLocal: opts.withLocal ? req(end, end, cur, i) : -1, vPre: -1, vPreLocal: -1 });
    } else {
      segs.push({ start: pStart, end, period: i, flowDay: false, vEnd: req(end, end, end, i, false, true), vEndLocal: -1, vPre: -1, vPreLocal: -1 });
      periodEndReqLocal[i] = opts.withLocal ? req(end, end, pStart, i) : -1;
    }
    periodEndReq[i] = segs[segs.length - 1]!.vEnd;
  }

  // ---- evaluate ---------------------------------------------------------------------------
  const nP = B.length - 1;
  const issues: ValueIssues[] = Array.from({ length: Math.max(nP, 1) }, newIssues);
  const stale: Set<string>[] = Array.from({ length: Math.max(nP, 1) }, () => new Set<string>());
  const values = new Float64Array(reqs.length);
  const aggs = new Map<number, ValueAggregates>();
  const runner = new Ledger(ctx);
  for (let k = 0; k < reqs.length; k++) {
    const r = reqs[k] as Req;
    runner.applyUntil(r.stateDay);
    const iss = issues[Math.min(r.period, issues.length - 1)];
    if (r.agg) {
      const a = valueAggregates(runner, r.priceDay, iss, k === v0Req ? undefined : stale[r.period]);
      aggs.set(k, a);
      values[k] = a.total;
    } else {
      const ov = r.override ? ctx.firstTradePrice.get(r.priceDay) : undefined;
      values[k] = totalValue(runner, r.priceDay, r.fxDay, ov, iss);
    }
  }

  // ---- chain --------------------------------------------------------------------------
  const growth = new Float64Array(nP).fill(1);
  const growthL = new Float64Array(nP).fill(1);
  const warnings: Set<string>[] = Array.from({ length: Math.max(nP, 1) }, () => new Set<string>());
  const flowSum = (day: number, fxDay: number, sign: 1 | -1): number => {
    let s = 0;
    for (const f of flowsByDay.get(day) ?? []) if (Math.sign(f.amount) === sign) s += flowBase(ctx, f, fxDay);
    return Math.abs(s);
  };

  if (method === 'daily') {
    let prevV = values[v0Req] as number;
    for (const s of segs) {
      const warn = (c: string) => warnings[s.period]!.add(c);
      const v1 = values[s.vEnd] as number;
      let g = 1;
      let gL = 1;
      if (s.flowDay) {
        const pre = values[s.vPre] as number;
        const { ra, rb } = flowDayReturn(prevV, pre, v1, flowSum(s.end, s.end, 1), flowSum(s.end, s.end, -1), eps, warn);
        g = (1 + ra) * (1 + rb);
        if (opts.withLocal) {
          const preL = values[s.vPreLocal] as number;
          const v1L = values[s.vEndLocal] as number;
          const l = flowDayReturn(prevV, preL, v1L, flowSum(s.end, s.start, 1), flowSum(s.end, s.start, -1), eps, () => undefined);
          gL = (1 + l.ra) * (1 + l.rb);
        }
      } else {
        g = 1 + subReturn(v1, prevV, eps, warn);
        gL = opts.withLocal ? 1 + subReturn(values[s.vEndLocal] as number, prevV, eps, () => undefined) : g;
      }
      growth[s.period]! *= g;
      growthL[s.period]! *= opts.withLocal ? gL : g;
      prevV = v1;
    }
  } else {
    let prevV = values[v0Req] as number;
    for (const s of segs) {
      const i = s.period;
      const v1 = values[s.vEnd] as number;
      const D = s.end - s.start;
      let F = 0;
      let W = 0;
      let FL = 0;
      let WL = 0;
      for (const f of flows) {
        if (f.day <= s.start || f.day > s.end) continue;
        // Modified Dietz weights: inflows from the start of their day, outflows from its end.
        const elapsed = f.amount > 0 ? f.day - 1 - s.start : f.day - s.start;
        const w = D > 0 ? (D - elapsed) / D : 0;
        F += f.base;
        W += w * f.base;
        if (opts.withLocal) {
          const fl = flowBase(ctx, f, s.start);
          FL += fl;
          WL += w * fl;
        }
      }
      const den = prevV + W;
      let r = 0;
      if (den > eps) r = (v1 - prevV - F) / den;
      else if (Math.abs(v1 - prevV - F) > eps) warnings[i]!.add('DEGENERATE_SUBPERIOD');
      let rL = r;
      const li = periodEndReqLocal[i] ?? -1;
      if (opts.withLocal && li >= 0) {
        const denL = prevV + WL;
        rL = denL > eps ? ((values[li] as number) - prevV - FL) / denL : 0;
      }
      growth[i] = 1 + r;
      growthL[i] = 1 + rL;
      prevV = v1;
    }
  }

  // ---- period results with waterfall -------------------------------------------------------
  const periods: PeriodResult[] = [];
  const sortedFlows = flows.slice().sort((a, b) => a.day - b.day);
  let flowIdx = 0;
  while (flowIdx < sortedFlows.length && sortedFlows[flowIdx]!.day <= b0) flowIdx++;
  const attrs = full.attributions;
  let ai = 0;
  while (ai < attrs.length && attrs[ai]!.day <= b0) ai++;
  const realized = full.realized;
  let ri = 0;
  while (ri < realized.length && realized[ri]!.day <= b0) ri++;
  let startAgg = aggs.get(v0Req) as ValueAggregates;
  for (let i = 0; i < nP; i++) {
    const startDay = B[i] as number;
    const endDay = B[i + 1] as number;
    let inflows = 0;
    let outflows = 0;
    while (flowIdx < sortedFlows.length && sortedFlows[flowIdx]!.day <= endDay) {
      const b = sortedFlows[flowIdx++]!.base;
      if (b >= 0) inflows += b;
      else outflows -= b;
    }
    const w = zeroWaterfall();
    let cashMoves = 0;
    while (ai < attrs.length && attrs[ai]!.day <= endDay) {
      const a = attrs[ai++] as Attribution;
      w.realized += a.realized;
      w.realizedFx += a.realizedFx;
      w.income += a.income;
      w.otherCosts += a.otherCosts;
      w.fxConversion += a.fxConversion;
      w.spread += a.spread;
      w.transfer += a.transfer;
      w.corporate += a.corporate;
      w.rateDiff += a.rateDiff;
      cashMoves += a.cashBase;
    }
    while (ri < realized.length && realized[ri]!.day <= endDay) ri++;
    const endAgg = aggs.get(periodEndReq[i] as number) as ValueAggregates;
    w.unrealized = endAgg.unrealized - startAgg.unrealized;
    w.unrealizedFx = endAgg.unrealizedFx - startAgg.unrealizedFx;
    w.cashFx = endAgg.cash - startAgg.cash - cashMoves;
    periods.push({
      startDay,
      endDay,
      startValue: startAgg.total,
      endValue: endAgg.total,
      netFlows: inflows - outflows,
      inflows,
      outflows,
      twr: (growth[i] as number) - 1,
      localTwr: (growthL[i] as number) - 1,
      waterfall: w,
      issues: issues[i] as ValueIssues,
      stale: stale[i] as Set<string>,
      warnings: Array.from(warnings[i] as Set<string>),
    });
    startAgg = endAgg;
  }
  return { periods, ledger: full, flows };
}

// ---------------------------------------------------------------------------
// Indices, inflation and benchmarks
// ---------------------------------------------------------------------------

const DEFAULT_INFLATION: Record<string, string> = { COP: 'IPC_CO', BRL: 'IPCA', USD: 'CPI_US', EUR: 'HICP_EA' };
const DEFAULT_RATE: Record<string, string[]> = { BRL: ['CDI'], COP: ['IBR'] };

export function inflationIndexFor(ctx: EngineContext): string | undefined {
  const o = ctx.raw.inflationIndex;
  if (o === null) return undefined;
  const id = o ?? DEFAULT_INFLATION[ctx.base];
  return id && ctx.market.index(id) ? id : undefined;
}

export function rateIndicesFor(ctx: EngineContext, benchmarks: string[] = []): string[] {
  const ids = new Set<string>((ctx.raw.indices ?? DEFAULT_RATE[ctx.base] ?? []).filter((id) => ctx.market.index(id)));
  for (const b of benchmarks) if (ctx.market.index(b)) ids.add(b);
  return Array.from(ids);
}

/** Benchmark return between two end-of-day dates, in base currency. */
export function benchmarkReturn(ctx: EngineContext, id: string, a: number, b: number): { r: number; kind: 'price' | 'total' | 'rate' } | undefined {
  const idx = ctx.market.index(id);
  if (idx) {
    const f = idx.factor(a, b);
    return f === undefined ? undefined : { r: f - 1, kind: 'rate' };
  }
  const m = ctx.market;
  const pa = m.priceAt(id, a);
  const pb = m.priceAt(id, b);
  if (pa === undefined || pb === undefined || pa <= 0) return undefined;
  const pc: CurrencyCode = m.priceCurrency(id) ?? ctx.instruments.get(id)?.currency ?? ctx.base;
  const xa = pc === ctx.base ? 1 : m.fxAt(pc, ctx.base, a);
  const xb = pc === ctx.base ? 1 : m.fxAt(pc, ctx.base, b);
  if (xa === undefined || xb === undefined) return undefined;
  const divs = m.dividends(id, a, b);
  const override = ctx.raw.benchmarkKinds?.[id];
  const kind: 'price' | 'total' = override ?? (divs !== undefined ? 'total' : 'price');
  // Unadjusted prices drop on split/bonus ex-dates: multiply the factor back.
  let factor = ((pb * xb) / (pa * xa)) * m.splitFactor(id, a, b);
  if (kind === 'total' && divs) {
    for (const d of divs) {
      const cum = m.priceAt(id, d.day - 1);
      if (!cum || cum <= 0) continue;
      let amt = d.amount;
      if (d.currency && d.currency !== pc) {
        const r = m.fxAt(d.currency, pc, d.day) ?? m.fxNearest(d.currency, pc, d.day);
        if (r === undefined) continue;
        amt *= r;
      }
      factor *= 1 + amt / cum;
    }
  }
  return { r: factor - 1, kind };
}

// ---------------------------------------------------------------------------
// Monthly table
// ---------------------------------------------------------------------------

export interface MonthlyOptions {
  from?: YearMonth;
  to?: YearMonth;
  benchmarks?: string[];
  /** Cut-off date for the current month (defaults to options.asOf or today). */
  asOf?: ISODate;
  twrMethod?: 'daily' | 'modifiedDietz';
}

export function asOfOf(input: EngineInput, explicit?: ISODate): ISODate {
  return explicit ?? input.options?.asOf ?? todayIso();
}

export function monthlyFromContext(ctx: EngineContext, input: EngineInput, opts: MonthlyOptions = {}, ledger?: Ledger): MonthlyRow[] {
  if (ctx.sorted.length === 0 && !opts.from) return [];
  const asOf = asOfOf(input, opts.asOf);
  const asOfDay = isoToDay(asOf);
  const firstYm = ctx.sorted.length ? ymOf(dayToIso(ctx.sorted[0]!.day)) : (opts.from as YearMonth);
  const fromYm = opts.from ?? firstYm;
  let toYm = opts.to ?? ymOf(asOf);
  if (toYm > ymOf(asOf)) toYm = ymOf(asOf);
  if (fromYm > toYm) return [];
  const months = monthRange(fromYm, toYm);
  const B = [isoToDay(monthEnd(addMonthsYm(fromYm, -1)))];
  const ends: number[] = [];
  for (const ym of months) {
    const me = isoToDay(monthEnd(ym));
    const e = Math.min(me, Math.max(asOfDay, isoToDay(`${ym}-01`)));
    B.push(e);
    ends.push(me);
  }
  const { periods, ledger: full } = computePeriods(ctx, B, { withLocal: true, method: opts.twrMethod, ledger });
  const benchmarks = opts.benchmarks ?? input.portfolio.benchmarks ?? [];
  const inflId = inflationIndexFor(ctx);
  const rateIds = rateIndicesFor(ctx, benchmarks);

  const rows: MonthlyRow[] = [];
  let cum = 1;
  let cumReal: number | undefined = 1;
  let ii = 0;
  let ci = 0;
  const income = full.income;
  const costs = full.costs.slice().sort((a, b) => a.day - b.day);
  months.forEach((ym, i) => {
    const p = periods[i] as PeriodResult;
    let incomeBase = 0;
    while (ii < income.length && income[ii]!.day <= p.endDay) {
      const e = income[ii++]!;
      if (e.day > p.startDay) incomeBase += e.netBase;
    }
    let feesBase = 0;
    let taxesBase = 0;
    while (ci < costs.length && costs[ci]!.day <= p.endDay) {
      const c = costs[ci++]!;
      if (c.day > p.startDay) {
        feesBase += c.feesBase;
        taxesBase += c.taxesBase;
      }
    }
    cum *= 1 + p.twr;
    const w = p.waterfall;
    const row: MonthlyRow = {
      month: ym,
      startValueBase: p.startValue,
      endValueBase: p.endValue,
      netFlowsBase: p.netFlows,
      incomeBase,
      feesBase,
      taxesBase,
      gainBase: p.endValue - p.startValue - p.netFlows,
      twr: p.twr,
      cumulativeTwr: cum - 1,
      localReturn: p.localTwr,
      fxReturn: p.twr - p.localTwr,
      realizedGainBase: w.realized,
      unrealizedGainBase: w.unrealized,
      fxGainBase: w.realizedFx + w.unrealizedFx + w.cashFx,
      fxSpreadBase: w.spread,
    };
    if (p.endDay < (ends[i] as number)) row.partial = true;
    if (inflId) {
      const f = ctx.market.index(inflId)!.factor(p.startDay, p.endDay);
      if (f !== undefined) {
        row.inflation = f - 1;
        row.realTwr = (1 + p.twr) / f - 1;
        if (cumReal !== undefined) cumReal *= 1 + row.realTwr;
      } else cumReal = undefined;
      if (cumReal !== undefined) row.cumulativeRealTwr = cumReal - 1;
    }
    if (rateIds.length) {
      const ir: Record<string, number> = {};
      const pc: Record<string, number> = {};
      for (const id of rateIds) {
        const f = ctx.market.index(id)!.factor(p.startDay, p.endDay);
        if (f === undefined) continue;
        ir[id] = f - 1;
        if (f - 1 > 1e-12) pc[id] = p.twr / (f - 1);
      }
      if (Object.keys(ir).length) row.indexReturns = ir;
      if (Object.keys(pc).length) row.percentOfIndex = pc;
    }
    if (benchmarks.length) {
      const br: Record<string, number> = {};
      const bk: Record<string, 'price' | 'total' | 'rate'> = {};
      for (const id of benchmarks) {
        const r = benchmarkReturn(ctx, id, p.startDay, p.endDay);
        if (r) {
          br[id] = r.r;
          bk[id] = r.kind;
        }
      }
      row.benchmarkReturns = br;
      row.benchmarkKinds = bk;
    }
    if (p.issues.missingFx.size) row.missingFx = Array.from(p.issues.missingFx).sort();
    if (p.issues.missingPrices.size) row.missingPrices = Array.from(p.issues.missingPrices).sort();
    if (p.stale.size) row.stalePrices = Array.from(p.stale).sort();
    const warns = [...p.warnings];
    if (p.issues.missingIndex.size) warns.push(`MISSING_INDEX:${Array.from(p.issues.missingIndex).join(',')}`);
    if (warns.length) row.warnings = warns;
    rows.push(row);
  });
  return rows;
}

export function monthlyPerformanceImpl(input: EngineInput, opts: MonthlyOptions = {}): MonthlyRow[] {
  const extra: EngineOptions = {};
  if (opts.twrMethod) extra.twrMethod = opts.twrMethod;
  return monthlyFromContext(createContext(input, extra), input, opts);
}
