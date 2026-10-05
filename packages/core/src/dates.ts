/**
 * Calendar helpers. Internally the engine works with integer "day numbers"
 * (days since 1970-01-01, UTC calendar) which makes comparisons, binary search and
 * day arithmetic cheap and exact. ISO strings are only used at the API boundary.
 */
import type { ISODate, YearMonth } from './types';

const MS_PER_DAY = 86_400_000;

/** Parse `YYYY-MM-DD` (extra characters such as a time part are ignored) into a day number. */
export function isoToDay(iso: ISODate): number {
  const y = Number(iso.slice(0, 4));
  const m = Number(iso.slice(5, 7));
  const d = Number(iso.slice(8, 10));
  return Math.round(Date.UTC(y, m - 1, d) / MS_PER_DAY);
}

const isoCache = new Map<number, string>();

/** Day number to `YYYY-MM-DD` (memoized; the engine converts the same days repeatedly). */
export function dayToIso(day: number): ISODate {
  let s = isoCache.get(day);
  if (s === undefined) {
    s = new Date(day * MS_PER_DAY).toISOString().slice(0, 10);
    if (isoCache.size > 200_000) isoCache.clear();
    isoCache.set(day, s);
  }
  return s;
}

export function isValidIsoDate(iso: unknown): iso is ISODate {
  if (typeof iso !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return false;
  const day = isoToDay(iso);
  return Number.isFinite(day) && dayToIso(day) === iso;
}

export function addDays(iso: ISODate, n: number): ISODate {
  return dayToIso(isoToDay(iso) + n);
}

export function daysBetween(from: ISODate, to: ISODate): number {
  return isoToDay(to) - isoToDay(from);
}

export function ymOf(iso: ISODate): YearMonth {
  return iso.slice(0, 7);
}

export function ymOfDay(day: number): YearMonth {
  return dayToIso(day).slice(0, 7);
}

export function daysInMonth(year: number, month1: number): number {
  return new Date(Date.UTC(year, month1, 0)).getUTCDate();
}

/** Last calendar day of a month as ISO date. */
export function monthEnd(ym: YearMonth): ISODate {
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(5, 7));
  return `${ym}-${String(daysInMonth(y, m)).padStart(2, '0')}`;
}

export function monthStart(ym: YearMonth): ISODate {
  return `${ym}-01`;
}

export function addMonthsYm(ym: YearMonth, n: number): YearMonth {
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(5, 7)) - 1 + n;
  const yy = y + Math.floor(m / 12);
  const mm = ((m % 12) + 12) % 12;
  return `${String(yy).padStart(4, '0')}-${String(mm + 1).padStart(2, '0')}`;
}

/** Inclusive list of months between two YearMonths. */
export function monthRange(from: YearMonth, to: YearMonth): YearMonth[] {
  const out: YearMonth[] = [];
  for (let ym = from; ym <= to; ym = addMonthsYm(ym, 1)) out.push(ym);
  return out;
}

/**
 * Add calendar months to a date, clamping to the end of the target month
 * (2024-03-31 minus 1 month = 2024-02-29).
 */
export function addMonths(iso: ISODate, n: number): ISODate {
  const ym = addMonthsYm(ymOf(iso), n);
  const d = Number(iso.slice(8, 10));
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(5, 7));
  return `${ym}-${String(Math.min(d, daysInMonth(y, m))).padStart(2, '0')}`;
}

/** Today's date in the local time zone of the running machine. */
export function todayIso(): ISODate {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Index of the last element `<= x` in an ascending array, or -1. */
export function lastIndexAtOrBefore(sorted: ArrayLike<number>, x: number): number {
  let lo = 0;
  let hi = sorted.length - 1;
  if (hi < 0 || (sorted[0] as number) > x) return -1;
  if ((sorted[hi] as number) <= x) return hi;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((sorted[mid] as number) <= x) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** Index of the first element `>= x` in an ascending array, or -1. */
export function firstIndexAtOrAfter(sorted: ArrayLike<number>, x: number): number {
  const n = sorted.length;
  if (n === 0 || (sorted[n - 1] as number) < x) return -1;
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((sorted[mid] as number) >= x) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Exact `YYYY-MM-DD` that denotes a real calendar date (no time part, no time zone). */
export function isStrictIsoDate(s: unknown): s is ISODate {
  return isValidIsoDate(s);
}

/** Day of week for a day number: 0 = Sunday ... 6 = Saturday. */
export function weekday(day: number): number {
  return (((day + 4) % 7) + 7) % 7; // 1970-01-01 was a Thursday
}

/** Weekdays (Mon-Fri) in the half-open interval (a, b]. Negative when b < a. No holiday calendar. */
export function businessDaysBetween(a: number, b: number): number {
  if (b < a) return -businessDaysBetween(b, a);
  const full = Math.floor((b - a) / 7);
  let n = full * 5;
  for (let d = a + full * 7 + 1; d <= b; d++) {
    const w = weekday(d);
    if (w !== 0 && w !== 6) n++;
  }
  return n;
}

/** 30/360 (US/NASD-like) day count between two day numbers. */
export function days360(a: number, b: number): number {
  const A = dayToIso(a);
  const Bs = dayToIso(b);
  const y1 = Number(A.slice(0, 4));
  const m1 = Number(A.slice(5, 7));
  let d1 = Number(A.slice(8, 10));
  const y2 = Number(Bs.slice(0, 4));
  const m2 = Number(Bs.slice(5, 7));
  let d2 = Number(Bs.slice(8, 10));
  if (d1 === 31) d1 = 30;
  if (d2 === 31 && d1 === 30) d2 = 30;
  return (y2 - y1) * 360 + (m2 - m1) * 30 + (d2 - d1);
}

export function addYears(iso: ISODate, n: number): ISODate {
  return addMonths(iso, 12 * n);
}

/**
 * Calendar (ACT/ACT) year fraction between two dates: whole calendar years plus the remaining
 * days divided by the length of the following year-long interval. Exactly 1 for 2023-12-31 ->
 * 2024-12-31 even though 2024 is a leap year.
 */
export function yearFraction(a: number, b: number): number {
  if (b === a) return 0;
  if (b < a) return -yearFraction(b, a);
  const A = dayToIso(a);
  let k = Math.floor((b - a) / 366);
  while (isoToDay(addYears(A, k + 1)) <= b) k++;
  const s = isoToDay(addYears(A, k));
  const e = isoToDay(addYears(A, k + 1));
  return k + (b - s) / (e - s);
}
