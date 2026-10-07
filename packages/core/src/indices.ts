/**
 * Rate and inflation indices (CDI, SELIC, IPCA, IPC Colombia, IBR, UVR...).
 *
 * Every series is turned into an accumulated level C(d) so that the growth between two
 * dates is C(b) / C(a):
 * - 'level'       : the published level, geometric interpolation between points.
 * - 'periodRate'  : period 'month' -> chained into month-end levels (IPCA/IPC monthly variation);
 *                   period 'day'   -> C(d) = prod over rate days j < d of (1 + r_j)  (CDI/Selic:
 *                   the rate of day j is earned from j to j+1).
 * - 'annualRate'  : rate valid from its date; between points the level grows with the day count
 *                   (BUS/252 and ACT/365 effective, ACT/360 nominal compounded daily, 30/360).
 *
 * "% of index" (110 % do CDI) scales each periodic rate (exact for daily/annual rates) or the
 * total variation for level series. Extrapolation beyond the last point is only done when asked
 * (accrual of fixed income, real returns "to date"): level series continue with the growth of
 * their last interval (e.g. last month's IPCA), rate series with their last rate; at most
 * MAX_PROJECTION_DAYS. Callers flag projected values as estimated (`lastDay`).
 * BUS/252 counts business days with the series' holiday calendar (ANBIMA for CDI/SELIC/BRL).
 * "% of index" on annual rates scales the DAILY rate (market convention): (1 + p * d)^n with
 * d = (1 + r)^(1/252) - 1 for BUS/252.
 */

export const MAX_PROJECTION_DAYS = 62;
import type { DayCount, IndexSeries } from './types';
import { days360, isoToDay, lastIndexAtOrBefore, monthEnd } from './dates';
import { type CalendarId, businessDaysIn } from './calendars';

export interface IndexData {
  id: string;
  kind: IndexSeries['kind'];
  firstDay: number;
  lastDay: number;
  /** Growth factor between day a and day b (end of day). undefined when not covered. */
  factor(a: number, b: number, opts?: { percent?: number; extrapolate?: boolean }): number | undefined;
  /** Accumulated level at day d (1 at the first point). */
  level(d: number, extrapolate?: boolean): number | undefined;
}

function rateOf(v: number, unit: IndexSeries['unit']): number {
  return unit === 'decimal' ? v : v / 100;
}

/** Periods and per-period rate for a day count (used to scale "% of index"). */
function periods(rate: number, from: number, to: number, dc: DayCount, cal: CalendarId): { n: number; per: number } {
  switch (dc) {
    case 'BUS/252':
      return { n: businessDaysIn(from, to, cal), per: Math.pow(1 + rate, 1 / 252) - 1 };
    case 'ACT/360':
      return { n: to - from, per: rate / 360 };
    case '30/360':
      return { n: days360(from, to), per: Math.pow(1 + rate, 1 / 360) - 1 };
    case 'ACT/ACT':
    case 'ACT/365':
    default:
      return { n: to - from, per: Math.pow(1 + rate, 1 / 365) - 1 };
  }
}

/** Growth of an annual rate between two days; `percent` scales the per-period (daily) rate. */
function growth(rate: number, from: number, to: number, dc: DayCount, cal: CalendarId = 'WEEKDAYS', percent = 1): number {
  if (to <= from) return 1;
  if (dc === 'ACT/ACT' && percent === 1) {
    // calendar years: exact for whole years regardless of leap days
    const A = new Date(from * 86_400_000);
    let y = 0;
    while (Math.round(Date.UTC(A.getUTCFullYear() + y + 1, A.getUTCMonth(), A.getUTCDate()) / 86_400_000) <= to) y++;
    const s = Math.round(Date.UTC(A.getUTCFullYear() + y, A.getUTCMonth(), A.getUTCDate()) / 86_400_000);
    const e = Math.round(Date.UTC(A.getUTCFullYear() + y + 1, A.getUTCMonth(), A.getUTCDate()) / 86_400_000);
    return Math.pow(1 + rate, y + (to - s) / (e - s));
  }
  const { n, per } = periods(rate, from, to, dc, cal);
  return Math.pow(1 + percent * per, n);
}

/** Level series with geometric interpolation. */
function levelData(id: string, kind: IndexSeries['kind'], days: number[], levels: number[], tolerance: number): IndexData {
  const first = days[0] ?? 0;
  const last = days[days.length - 1] ?? 0;
  // daily growth of the last interval, for projections
  const n = days.length;
  const trend = n >= 2 ? Math.pow((levels[n - 1] as number) / (levels[n - 2] as number), 1 / ((days[n - 1] as number) - (days[n - 2] as number))) : 1;
  const trendFirst = n >= 2 ? Math.pow((levels[1] as number) / (levels[0] as number), 1 / ((days[1] as number) - (days[0] as number))) : 1;
  const at = (d: number, extrapolate: boolean): number | undefined => {
    if (days.length === 0) return undefined;
    if (d < first) {
      // short backward projection (a purchase a few days before the first published level)
      if (!extrapolate || first - d > MAX_PROJECTION_DAYS) return undefined;
      return (levels[0] as number) / Math.pow(trendFirst, first - d);
    }
    if (d >= last) {
      if (d <= last + tolerance) return levels[levels.length - 1];
      if (!extrapolate || d > last + MAX_PROJECTION_DAYS) return undefined;
      return (levels[levels.length - 1] as number) * Math.pow(trend, d - last);
    }
    const i = lastIndexAtOrBefore(days, d);
    const d0 = days[i] as number;
    const v0 = levels[i] as number;
    if (d0 === d) return v0;
    const d1 = days[i + 1] as number;
    const v1 = levels[i + 1] as number;
    return v0 * Math.pow(v1 / v0, (d - d0) / (d1 - d0));
  };
  const base = levels[0] ?? 1;
  return {
    id,
    kind,
    firstDay: first,
    lastDay: last,
    level: (d, ex = false) => {
      const v = at(d, ex);
      return v === undefined ? undefined : v / base;
    },
    factor(a, b, opts = {}) {
      if (b <= a) return 1;
      const la = at(a, true);
      const lb = at(b, opts.extrapolate ?? false);
      if (la === undefined || lb === undefined || la <= 0) return undefined;
      const g = lb / la;
      const p = opts.percent ?? 1;
      return p === 1 ? g : 1 + p * (g - 1);
    },
  };
}

/** Daily periodic rates (CDI / Selic). */
function dailyRateData(id: string, days: number[], rates: number[], cal: CalendarId): IndexData {
  const first = days[0] ?? 0;
  const last = days[days.length - 1] ?? 0;
  const cache = new Map<number, Float64Array>();
  const cumFor = (p: number): Float64Array => {
    let c = cache.get(p);
    if (!c) {
      c = new Float64Array(rates.length);
      let acc = 1;
      for (let i = 0; i < rates.length; i++) {
        acc *= 1 + p * (rates[i] as number);
        c[i] = acc;
      }
      cache.set(p, c);
    }
    return c;
  };
  /** C(d) = prod_{j < d} (1 + p r_j). */
  const C = (d: number, p: number, extrapolate: boolean): number | undefined => {
    if (days.length === 0) return undefined;
    // nothing accrues before the first rate day (a period starting on a weekend/holiday before it)
    if (d <= first) return first - d <= 5 ? 1 : undefined;
    const cum = cumFor(p);
    if (d > last + 1) {
      if (!extrapolate && d > last + 5) return undefined;
      if (d > last + MAX_PROJECTION_DAYS) return undefined;
      const extra = businessDaysIn(last, d - 1, cal);
      return (cum[cum.length - 1] as number) * Math.pow(1 + p * (rates[rates.length - 1] as number), extra);
    }
    const i = lastIndexAtOrBefore(days, d - 1);
    return i < 0 ? 1 : (cum[i] as number);
  };
  return {
    id,
    kind: 'periodRate',
    firstDay: first,
    lastDay: last,
    level: (d, ex = false) => C(d, 1, ex),
    factor(a, b, opts = {}) {
      if (b <= a) return 1;
      const p = opts.percent ?? 1;
      const ca = C(a, p, true);
      const cb = C(b, p, opts.extrapolate ?? false);
      return ca === undefined || cb === undefined ? undefined : cb / ca;
    },
  };
}

/** Annualized rates valid from their date (IBR, DTF, CDI annualized). */
function annualRateData(id: string, days: number[], rates: number[], dc: DayCount, cal: CalendarId): IndexData {
  const first = days[0] ?? 0;
  const last = days[days.length - 1] ?? 0;
  const cache = new Map<number, Float64Array>();
  const levelsFor = (p: number): Float64Array => {
    let l = cache.get(p);
    if (!l) {
      l = new Float64Array(rates.length);
      let acc = 1;
      for (let i = 0; i < rates.length; i++) {
        if (i > 0) acc *= growth(rates[i - 1] as number, days[i - 1] as number, days[i] as number, dc, cal, p);
        l[i] = acc;
      }
      cache.set(p, l);
    }
    return l;
  };
  const C = (d: number, p: number, extrapolate: boolean): number | undefined => {
    if (days.length === 0 || d < first) return undefined;
    // An annual rate is valid until the next point: accrual may use it indefinitely (flagged as
    // estimated by callers when older than a month); benchmarks only up to 31 days.
    if (!extrapolate && d > last + 31) return undefined;
    const lv = levelsFor(p);
    const i = lastIndexAtOrBefore(days, d);
    return (lv[i] as number) * growth(rates[i] as number, days[i] as number, d, dc, cal, p);
  };
  return {
    id,
    kind: 'annualRate',
    firstDay: first,
    lastDay: last,
    level: (d, ex = false) => C(d, 1, ex),
    factor(a, b, opts = {}) {
      if (b <= a) return 1;
      const p = opts.percent ?? 1;
      const ca = C(a, p, true);
      const cb = C(b, p, opts.extrapolate ?? false);
      return ca === undefined || cb === undefined ? undefined : cb / ca;
    },
  };
}

export function buildIndex(s: IndexSeries): IndexData | undefined {
  const pts = (s.points ?? [])
    .filter((p) => p && typeof p.date === 'string' && Number.isFinite(p.value))
    .map((p) => ({ day: isoToDay(p.date), value: p.value, date: p.date }))
    .filter((p) => Number.isFinite(p.day))
    .sort((a, b) => a.day - b.day);
  // de-duplicate by day (last wins)
  const uniq: typeof pts = [];
  for (const p of pts) {
    if (uniq.length && uniq[uniq.length - 1]!.day === p.day) uniq[uniq.length - 1] = p;
    else uniq.push(p);
  }
  if (uniq.length === 0) return undefined;
  if (s.kind === 'level') {
    const ok = uniq.filter((p) => p.value > 0);
    if (!ok.length) return undefined;
    return levelData(s.id, 'level', ok.map((p) => p.day), ok.map((p) => p.value), 0);
  }
  if (s.kind === 'periodRate' && (s.period ?? 'day') === 'month') {
    // Chain monthly variations into month-end levels; base 1 at the previous month end.
    const byMonth = new Map<string, number>();
    for (const p of uniq) byMonth.set(p.date.slice(0, 7), rateOf(p.value, s.unit));
    const months = Array.from(byMonth.keys()).sort();
    const days: number[] = [];
    const levels: number[] = [];
    const firstYm = months[0] as string;
    const prevEnd = isoToDay(monthEnd(firstYm)) - Number(monthEnd(firstYm).slice(8, 10));
    days.push(prevEnd);
    levels.push(1);
    let acc = 1;
    for (const ym of months) {
      acc *= 1 + (byMonth.get(ym) as number);
      days.push(isoToDay(monthEnd(ym)));
      levels.push(acc);
    }
    return levelData(s.id, 'periodRate', days, levels, 0);
  }
  const cal: CalendarId = s.id === 'CDI' || s.id === 'SELIC' || s.currency === 'BRL' ? 'BR' : s.currency === 'COP' ? 'CO' : 'WEEKDAYS';
  if (s.kind === 'periodRate') {
    return dailyRateData(s.id, uniq.map((p) => p.day), uniq.map((p) => rateOf(p.value, s.unit)), cal);
  }
  const dc: DayCount = s.dayCount ?? (s.id === 'CDI' || s.id === 'SELIC' ? 'BUS/252' : 'ACT/365');
  return annualRateData(s.id, uniq.map((p) => p.day), uniq.map((p) => rateOf(p.value, s.unit)), dc, cal);
}

/** Growth of a fixed annual rate between two days with a day count and holiday calendar. */
export function fixedGrowth(rate: number, a: number, b: number, dc: DayCount, cal: CalendarId = 'WEEKDAYS'): number {
  return growth(rate, a, b, dc, cal);
}
