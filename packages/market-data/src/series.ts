/**
 * Series transforms: month-end aggregation, calendar fill, slicing, rounding.
 *
 * Why month-end from daily (and not Yahoo's `interval=1mo`)? Verified against recorded data
 * (test/fixtures/yahoo/chart-PETR4.SA-1mo.json vs -1d.json):
 *  - Yahoo labels monthly bars with the FIRST day of the month (2024-11-01 holds the November
 *    close), so a naive consumer shifts every value by one month.
 *  - The last monthly bar ignores `period2`: asking until 2025-03-14 returns the close of the
 *    whole month (or today's live price) labelled 2025-03-01.
 *  - Live check (LIVE=1, 2026-10-05, PETR4.SA / ECOPETROL.CL / AAPL, 2 years): for CLOSED
 *    months the bar close equals our month-end close in 23/23 months; the problems are the
 *    date label (day 01) and the partial/live last bar.
 * Building month-ends from daily closes gives the real last trading day and its date, and
 * lets us un-adjust splits and use the same daily cache for both intervals.
 */
import type { FxPoint, ISODate } from '@pm/core';
import { addDays, monthOf } from './dates';

export interface DatedValue {
  date: ISODate;
}

/** Keep the last point of each calendar month (input must be sorted ascending). */
export function toMonthEnd<T extends DatedValue>(points: readonly T[]): T[] {
  const out: T[] = [];
  for (const p of points) {
    const last = out[out.length - 1];
    if (last && monthOf(last.date) === monthOf(p.date)) out[out.length - 1] = p;
    else out.push(p);
  }
  return out;
}

/**
 * Fill every calendar day in [from, to] carrying the last known value forward.
 * Days before the first point are left out.
 */
export function fillCalendarDays<T extends DatedValue>(points: readonly T[], from: ISODate, to: ISODate): T[] {
  const out: T[] = [];
  let i = 0;
  let current: T | undefined;
  // Seed with the last point at or before `from`.
  while (i < points.length && points[i]!.date <= from) current = points[i++];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    while (i < points.length && points[i]!.date <= d) current = points[i++];
    if (current) out.push({ ...current, date: d });
  }
  return out;
}

export function sliceRange<T extends DatedValue>(points: readonly T[], from: ISODate, to: ISODate): T[] {
  return points.filter((p) => p.date >= from && p.date <= to);
}

/** Sort ascending and keep the LAST occurrence of a duplicated date. */
export function dedupeByDate<T extends DatedValue>(points: readonly T[]): T[] {
  const map = new Map<ISODate, T>();
  for (const p of points) map.set(p.date, p);
  return [...map.values()].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** Round to `digits` significant digits (Yahoo floats are float32: ~7 significant digits). */
export function roundSig(x: number, digits = 7): number {
  if (x === 0 || !Number.isFinite(x)) return x;
  return Number(x.toPrecision(digits));
}

export function round(x: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(x * f) / f;
}

/**
 * Round a provider float (Yahoo returns float32 noise like 36.189998626708984) to a sensible
 * number of decimals, never fewer than needed for small prices.
 */
export function cleanPrice(x: number, decimals: number): number {
  const d = Math.abs(x) < 1 ? Math.max(decimals, 6) : decimals;
  return round(x, d);
}

/** Multiply two series on the union of their dates (fill-forward), within [from, to]. */
export function combine(a: readonly FxPoint[], b: readonly FxPoint[], from: ISODate, to: ISODate): FxPoint[] {
  const dates = [...new Set([...a.map((p) => p.date), ...b.map((p) => p.date)])].sort();
  const out: FxPoint[] = [];
  let i = 0;
  let j = 0;
  let va: number | undefined;
  let vb: number | undefined;
  for (const d of dates) {
    while (i < a.length && a[i]!.date <= d) va = a[i++]!.rate;
    while (j < b.length && b[j]!.date <= d) vb = b[j++]!.rate;
    if (d < from || d > to || va === undefined || vb === undefined) continue;
    out.push({ date: d, rate: roundSig(va * vb, 10) });
  }
  return out;
}
