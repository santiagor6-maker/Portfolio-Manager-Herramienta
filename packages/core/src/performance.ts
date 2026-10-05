/**
 * Performance engine: true time-weighted returns chained over sub-periods split at every
 * external flow, Modified Dietz as an alternative, local-vs-FX decomposition, monthly table,
 * period summaries and chart series.
 *
 * Flow timing convention (same as Portfolio Performance's TTWROR):
 *   inflows happen at the START of their day, outflows at the END of their day.
 * For a flow day f the sub-period return is
 *   r_f = (V(f) + OUT_f) / (V(f-1) + IN_f) - 1
 * and for a stretch [a, b] without flows r = V(b) / V(a) - 1, where V(d) is the
 * end-of-day value (all transactions of day d applied, prices and FX of day d).
 *
 * Local vs FX: the local return of a sub-period [a, b] re-prices the end positions with
 * the FX of day a (prices of day b): rL = V(b @ FX a) / V(a) - 1 (flows likewise at FX a).
 * Over a month: localReturn = prod(1 + rL) - 1 and fxReturn = twr - localReturn, so the two
 * parts add up exactly to the month's TWR (fxReturn includes the price x FX cross term).
 */
import type { CurrencyCode, ISODate, MonthlyRow, PerformanceSummary, YearMonth } from './types';
import type { EngineInput, EngineOptions, PeriodKey } from './api';
import {
  addDays,
  addMonths,
  addMonthsYm,
  dayToIso,
  isoToDay,
  monthEnd,
  monthRange,
  todayIso,
  ymOf,
} from './dates';
import { type EngineContext, type ExternalFlow, Ledger, createContext } from './ledger';
import { buildValuation, totalValue } from './valuation';
import { xirrImpl } from './xirr';

const DENOM_EPS = 1e-2;

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
}

export interface PeriodComputation {
  periods: PeriodResult[];
  /** Fully processed ledger (all transactions). */
  ledger: Ledger;
  flows: ExternalFlow[];
}

export function flowBase(ctx: EngineContext, f: ExternalFlow, fxDay: number): number {
  if (f.currency === ctx.base) return f.amount;
  const r = ctx.market.fxAt(f.currency, ctx.base, fxDay) ?? f.rateHint ?? ctx.market.fxNearest(f.currency, ctx.base, fxDay) ?? 0;
  return f.amount * r;
}

interface Seg {
  start: number;
  end: number;
  period: number;
  flowDay: boolean;
  vEnd: number; // request index
  vEndLocal: number; // request index (-1 if not requested)
}

/**
 * Compute returns between consecutive breakpoints (sorted unique day numbers).
 * Breakpoint values are end-of-day values; flows dated on breakpoints[0] are excluded,
 * flows dated on later breakpoints belong to the period ending there.
 */
export function computePeriods(
  ctx: EngineContext,
  breakDays: number[],
  opts: { withLocal: boolean; method?: 'daily' | 'modifiedDietz' },
): PeriodComputation {
  const method = opts.method ?? ctx.options.twrMethod;
  const full = new Ledger(ctx);
  full.applyAll();
  const flows = full.flows;
  const B = Array.from(new Set(breakDays)).sort((a, b) => a - b);
  const flowsByDay = new Map<number, ExternalFlow[]>();
  for (const f of flows) {
    let arr = flowsByDay.get(f.day);
    if (!arr) flowsByDay.set(f.day, (arr = []));
    arr.push(f);
  }
  const flowDays = Array.from(flowsByDay.keys()).sort((a, b) => a - b);

  // ---- value requests -------------------------------------------------------
  const reqDay: number[] = [];
  const reqFx: number[] = [];
  const req = (day: number, fxDay: number): number => {
    reqDay.push(day);
    reqFx.push(fxDay);
    return reqDay.length - 1;
  };
  if (B.length === 0) return { periods: [], ledger: full, flows };
  const v0Req = req(B[0] as number, B[0] as number);
  const segs: Seg[] = [];
  const periodEndReqLocal: number[] = []; // Modified Dietz local: V(end @ FX start)
  let fi = 0;
  while (fi < flowDays.length && (flowDays[fi] as number) <= (B[0] as number)) fi++;
  for (let i = 0; i + 1 < B.length; i++) {
    let cur = B[i] as number;
    const end = B[i + 1] as number;
    const pStart = cur;
    while (fi < flowDays.length && (flowDays[fi] as number) <= end) {
      const f = flowDays[fi] as number;
      if (method === 'daily') {
        if (f - 1 > cur) {
          segs.push({ start: cur, end: f - 1, period: i, flowDay: false, vEnd: req(f - 1, f - 1), vEndLocal: opts.withLocal ? req(f - 1, cur) : -1 });
        }
        segs.push({ start: f - 1, end: f, period: i, flowDay: true, vEnd: req(f, f), vEndLocal: opts.withLocal ? req(f, f - 1) : -1 });
        cur = f;
      }
      fi++;
    }
    if (method === 'daily') {
      if (end > cur) segs.push({ start: cur, end, period: i, flowDay: false, vEnd: req(end, end), vEndLocal: opts.withLocal ? req(end, cur) : -1 });
    } else {
      segs.push({ start: pStart, end, period: i, flowDay: false, vEnd: req(end, end), vEndLocal: -1 });
      periodEndReqLocal[i] = opts.withLocal ? req(end, pStart) : -1;
    }
  }

  // ---- evaluate (requests are generated in non-decreasing day order) ----------
  const values = new Float64Array(reqDay.length);
  const runner = new Ledger(ctx);
  for (let k = 0; k < reqDay.length; k++) {
    const d = reqDay[k] as number;
    runner.applyUntil(d);
    values[k] = totalValue(runner, d, reqFx[k] as number);
  }

  // ---- chain ---------------------------------------------------------------
  const nP = B.length - 1;
  const growth = new Float64Array(nP).fill(1);
  const growthL = new Float64Array(nP).fill(1);
  const periodEndValue = new Float64Array(nP);
  const flowSum = (day: number, fxDay: number, sign: 1 | -1): number => {
    let s = 0;
    for (const f of flowsByDay.get(day) ?? []) if (Math.sign(f.amount) === sign) s += flowBase(ctx, f, fxDay);
    return Math.abs(s);
  };

  if (method === 'daily') {
    let prevV = values[v0Req] as number;
    for (const s of segs) {
      const v1 = values[s.vEnd] as number;
      const v1L = s.vEndLocal >= 0 ? (values[s.vEndLocal] as number) : v1;
      let r = 0;
      let rL = 0;
      if (s.flowDay) {
        const inB = flowSum(s.end, s.end, 1);
        const outB = flowSum(s.end, s.end, -1);
        const den = prevV + inB;
        if (den > DENOM_EPS) r = (v1 + outB) / den - 1;
        if (opts.withLocal) {
          const inL = flowSum(s.end, s.start, 1);
          const outL = flowSum(s.end, s.start, -1);
          const denL = prevV + inL;
          if (denL > DENOM_EPS) rL = (v1L + outL) / denL - 1;
        }
      } else if (prevV > DENOM_EPS) {
        r = v1 / prevV - 1;
        rL = v1L / prevV - 1;
      }
      growth[s.period]! *= 1 + r;
      growthL[s.period]! *= 1 + rL;
      periodEndValue[s.period] = v1;
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
        const elapsed = f.amount > 0 ? f.day - 1 - s.start : f.day - s.start;
        const w = D > 0 ? (D - elapsed) / D : 0;
        const fb = flowBase(ctx, f, f.day);
        F += fb;
        W += w * fb;
        if (opts.withLocal) {
          const fl = flowBase(ctx, f, s.start);
          FL += fl;
          WL += w * fl;
        }
      }
      const den = prevV + W;
      const r = den > DENOM_EPS ? (v1 - prevV - F) / den : 0;
      let rL = r;
      const li = periodEndReqLocal[i] ?? -1;
      if (opts.withLocal && li >= 0) {
        const v1L = values[li] as number;
        const denL = prevV + WL;
        rL = denL > DENOM_EPS ? (v1L - prevV - FL) / denL : 0;
      }
      growth[i] = 1 + r;
      growthL[i] = 1 + rL;
      periodEndValue[i] = v1;
      prevV = v1;
    }
  }

  const periods: PeriodResult[] = [];
  let startValue = values[v0Req] as number;
  let flowIdx = 0;
  const sortedFlows = flows.slice().sort((a, b) => a.day - b.day);
  while (flowIdx < sortedFlows.length && (sortedFlows[flowIdx] as ExternalFlow).day <= (B[0] as number)) flowIdx++;
  for (let i = 0; i < nP; i++) {
    const startDay = B[i] as number;
    const endDay = B[i + 1] as number;
    let inflows = 0;
    let outflows = 0;
    while (flowIdx < sortedFlows.length && (sortedFlows[flowIdx] as ExternalFlow).day <= endDay) {
      const f = sortedFlows[flowIdx++] as ExternalFlow;
      const b = flowBase(ctx, f, f.day);
      if (b >= 0) inflows += b;
      else outflows -= b;
    }
    const endValue = periodEndValue[i] as number;
    periods.push({
      startDay,
      endDay,
      startValue,
      endValue,
      netFlows: inflows - outflows,
      inflows,
      outflows,
      twr: (growth[i] as number) - 1,
      localTwr: (growthL[i] as number) - 1,
    });
    startValue = endValue;
  }
  return { periods, ledger: full, flows };
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

function asOfOf(input: EngineInput, explicit?: ISODate): ISODate {
  return explicit ?? input.options?.asOf ?? todayIso();
}

export function benchmarkValue(ctx: EngineContext, id: string, day: number): number | undefined {
  const p = ctx.market.priceAt(id, day);
  if (p === undefined || p <= 0) return undefined;
  const ccy: CurrencyCode = ctx.instruments.get(id)?.currency ?? ctx.market.priceCurrency(id) ?? ctx.base;
  const pc = ctx.market.priceCurrency(id) ?? ccy;
  const r = pc === ctx.base ? 1 : ctx.market.fxAt(pc, ctx.base, day);
  return r === undefined ? undefined : p * r;
}

export function monthlyPerformanceImpl(input: EngineInput, opts: MonthlyOptions = {}): MonthlyRow[] {
  const extra: EngineOptions = {};
  if (opts.twrMethod) extra.twrMethod = opts.twrMethod;
  const ctx = createContext(input, extra);
  if (ctx.sorted.length === 0 && !opts.from) return [];
  const asOf = asOfOf(input, opts.asOf);
  const asOfDay = isoToDay(asOf);
  const firstYm = ctx.sorted.length ? ymOf(dayToIso((ctx.sorted[0] as { day: number }).day)) : (opts.from as YearMonth);
  const fromYm = opts.from ?? firstYm;
  let toYm = opts.to ?? ymOf(asOf);
  if (toYm > ymOf(asOf)) toYm = ymOf(asOf);
  if (fromYm > toYm) return [];
  const months = monthRange(fromYm, toYm);
  const B = [isoToDay(monthEnd(addMonthsYm(fromYm, -1)))];
  for (const ym of months) B.push(Math.min(isoToDay(monthEnd(ym)), Math.max(asOfDay, isoToDay(`${ym}-01`))));
  const { periods, ledger } = computePeriods(ctx, B, { withLocal: true });
  const benchmarks = opts.benchmarks ?? input.portfolio.benchmarks ?? [];

  const rows: MonthlyRow[] = [];
  let cum = 1;
  let ii = 0;
  let ci = 0;
  const income = ledger.income;
  const costs = ledger.costs.slice().sort((a, b) => a.day - b.day);
  months.forEach((ym, i) => {
    const p = periods[i] as PeriodResult;
    let incomeBase = 0;
    while (ii < income.length && (income[ii] as { day: number }).day <= p.endDay) {
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
    };
    if (benchmarks.length) {
      const br: Record<string, number> = {};
      for (const id of benchmarks) {
        const a = benchmarkValue(ctx, id, p.startDay);
        const b = benchmarkValue(ctx, id, p.endDay);
        if (a !== undefined && b !== undefined) br[id] = b / a - 1;
      }
      row.benchmarkReturns = br;
    }
    rows.push(row);
  });
  return rows;
}

// ---------------------------------------------------------------------------
// Period summary
// ---------------------------------------------------------------------------

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

export function performanceSummaryImpl(
  input: EngineInput,
  period: PeriodKey,
  asOf: ISODate,
  custom?: { from: ISODate; to: ISODate },
): PerformanceSummary {
  const ctx = createContext(input);
  const inception = ctx.sorted.length ? dayToIso(ctx.sorted[0]!.day) : undefined;
  const to = period === 'CUSTOM' && custom ? custom.to : asOf;
  let from = periodStart(period, to, inception, custom);
  if (inception && from < inception) from = inception;
  if (from > to) from = to;
  const fromDay = isoToDay(from);
  const toDay = isoToDay(to);
  const baseDay = fromDay - 1;
  const { periods, ledger, flows } = computePeriods(ctx, [baseDay, toDay], { withLocal: false });
  const p = periods[0];
  const startValue = p?.startValue ?? 0;
  const endValue = p?.endValue ?? startValue;

  const inRange = (d: number) => d > baseDay && d <= toDay;
  const realizedGainBase = ledger.realized.filter((r) => inRange(r.day)).reduce((s, r) => s + r.gainBase, 0);
  const incomeBase = ledger.income.filter((e) => inRange(e.day)).reduce((s, e) => s + e.netBase, 0);
  const feesBase = ledger.costs.filter((c) => inRange(c.day)).reduce((s, c) => s + c.feesBase, 0);

  const unrealizedAt = (day: number): number => {
    const l = new Ledger(ctx);
    l.applyUntil(day);
    return buildValuation(l, day).holdings.reduce((s, h) => s + (h.unrealizedGainBase ?? 0), 0);
  };
  const unrealizedGainBase = unrealizedAt(toDay) - unrealizedAt(baseDay);

  const twr = p?.twr ?? 0;
  const days = toDay - baseDay;
  const summary: PerformanceSummary = {
    from,
    to,
    baseCurrency: ctx.base,
    startValueBase: startValue,
    endValueBase: endValue,
    netFlowsBase: p?.netFlows ?? 0,
    gainBase: endValue - startValue - (p?.netFlows ?? 0),
    incomeBase,
    feesBase,
    realizedGainBase,
    unrealizedGainBase,
    twr,
  };
  if (days > 365 && twr > -1) summary.twrAnnualized = Math.pow(1 + twr, 365.25 / days) - 1;

  const cf: { date: ISODate; amount: number }[] = [];
  if (Math.abs(startValue) > DENOM_EPS) cf.push({ date: dayToIso(baseDay), amount: -startValue });
  for (const f of flows) if (inRange(f.day)) cf.push({ date: dayToIso(f.day), amount: -flowBase(ctx, f, f.day) });
  cf.push({ date: to, amount: endValue });
  const mwr = xirrImpl(cf);
  if (mwr !== undefined) summary.mwr = mwr;
  return summary;
}

// ---------------------------------------------------------------------------
// Chart series
// ---------------------------------------------------------------------------

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
    for (let ym = ymOf(from); ; ym = addMonthsYm(ym, 1)) {
      const e = isoToDay(monthEnd(ym));
      if (e >= b) break;
      if (e > a) out.push(e);
    }
    if (out[out.length - 1] !== b) out.push(b);
  }
  return out;
}

export function valueSeriesImpl(
  input: EngineInput,
  opts: { from: ISODate; to: ISODate; step: 'day' | 'week' | 'month' },
): { date: ISODate; valueBase: number; netInvestedBase: number; cumulativeTwr: number }[] {
  const ctx = createContext(input);
  const days = seriesDays(opts.from, opts.to, opts.step);
  if (days.length === 0) return [];
  const { periods, flows } = computePeriods(ctx, days, { withLocal: false });
  const sorted = flows.slice().sort((a, b) => a.day - b.day);
  let fi = 0;
  let invested = 0;
  const investedAt = (day: number): number => {
    while (fi < sorted.length && sorted[fi]!.day <= day) {
      const f = sorted[fi++]!;
      invested += flowBase(ctx, f, f.day);
    }
    return invested;
  };
  const out: { date: ISODate; valueBase: number; netInvestedBase: number; cumulativeTwr: number }[] = [];
  let firstValue: number;
  if (periods.length) firstValue = periods[0]!.startValue;
  else {
    const l = new Ledger(ctx);
    l.applyUntil(days[0]!);
    firstValue = totalValue(l, days[0]!);
  }
  out.push({ date: dayToIso(days[0]!), valueBase: firstValue, netInvestedBase: investedAt(days[0]!), cumulativeTwr: 0 });
  let g = 1;
  for (const p of periods) {
    g *= 1 + p.twr;
    out.push({ date: dayToIso(p.endDay), valueBase: p.endValue, netInvestedBase: investedAt(p.endDay), cumulativeTwr: g - 1 });
  }
  return out;
}
