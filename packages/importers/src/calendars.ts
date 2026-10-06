/**
 * Exchange business-day calendars (B3, BVC, NYSE) used to match trades with their settlements
 * (D+2 crossing weekends/holidays) and to compare dates across sources in business days.
 */
import type { ISODate } from '@pm/core';

export type CalendarId = 'BR' | 'CO' | 'US' | 'WEEKDAYS';

const DAY = 86400000;

export function dayNumber(iso: ISODate): number {
  return Math.floor(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / DAY);
}

export function fromDayNumber(n: number): ISODate {
  return new Date(n * DAY).toISOString().slice(0, 10);
}

/** Gregorian Easter Sunday (anonymous algorithm) as day number. */
function easter(y: number): number {
  const a = y % 19;
  const b = Math.floor(y / 100);
  const c = y % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return Math.floor(Date.UTC(y, month - 1, day) / DAY);
}

const ymd = (y: number, m: number, d: number) => Math.floor(Date.UTC(y, m - 1, d) / DAY);
const weekday = (n: number) => (n + 4) % 7; // 0 = Sunday (1970-01-01 was a Thursday)
/** Next Monday on or after the date (Colombian "Ley Emiliani"). */
const nextMonday = (n: number) => n + ((8 - weekday(n)) % 7);
/** n-th weekday (0=Sun) of a month; n = -1 → last. */
function nthWeekday(y: number, m: number, wd: number, n: number): number {
  if (n > 0) {
    const first = ymd(y, m, 1);
    return first + ((wd - weekday(first) + 7) % 7) + (n - 1) * 7;
  }
  const last = ymd(y, m + 1, 0);
  return last - ((weekday(last) - wd + 7) % 7);
}
/** US observed rule: Saturday → Friday, Sunday → Monday. */
const observed = (n: number) => (weekday(n) === 6 ? n - 1 : weekday(n) === 0 ? n + 1 : n);

function holidays(cal: CalendarId, y: number): Set<number> {
  const e = easter(y);
  const s = new Set<number>();
  if (cal === 'BR') {
    [ymd(y, 1, 1), e - 48, e - 47, e - 2, ymd(y, 4, 21), ymd(y, 5, 1), e + 60, ymd(y, 9, 7), ymd(y, 10, 12), ymd(y, 11, 2),
      ymd(y, 11, 15), ymd(y, 12, 24), ymd(y, 12, 25), ymd(y, 12, 31)].forEach((d) => s.add(d));
    if (y >= 2024) s.add(ymd(y, 11, 20)); // Consciência Negra (national since 2024)
    if (y <= 2021) [ymd(y, 1, 25), ymd(y, 7, 9)].forEach((d) => s.add(d)); // São Paulo holidays (B3 closed until 2021)
  } else if (cal === 'CO') {
    [ymd(y, 1, 1), ymd(y, 5, 1), ymd(y, 7, 20), ymd(y, 8, 7), ymd(y, 12, 8), ymd(y, 12, 25), ymd(y, 12, 31), e - 3, e - 2,
      e + 43, e + 64, e + 71].forEach((d) => s.add(d));
    [[1, 6], [3, 19], [6, 29], [8, 15], [10, 12], [11, 1], [11, 11]].forEach(([m, d]) => s.add(nextMonday(ymd(y, m!, d!))));
  } else if (cal === 'US') {
    const ny = ymd(y, 1, 1);
    if (weekday(ny) !== 6) s.add(observed(ny));
    [nthWeekday(y, 1, 1, 3), nthWeekday(y, 2, 1, 3), e - 2, nthWeekday(y, 5, 1, -1), observed(ymd(y, 7, 4)),
      nthWeekday(y, 9, 1, 1), nthWeekday(y, 11, 4, 4), observed(ymd(y, 12, 25))].forEach((d) => s.add(d));
    if (y >= 2022) s.add(observed(ymd(y, 6, 19)));
  }
  return s;
}

const cache = new Map<string, Set<number>>();
function holidaySet(cal: CalendarId, y: number): Set<number> {
  const k = `${cal}${y}`;
  let s = cache.get(k);
  if (!s) {
    s = holidays(cal, y);
    cache.set(k, s);
  }
  return s;
}

export function isBusinessDayN(n: number, cal: CalendarId): boolean {
  const wd = weekday(n);
  if (wd === 0 || wd === 6) return false;
  if (cal === 'WEEKDAYS') return true;
  return !holidaySet(cal, new Date(n * DAY).getUTCFullYear()).has(n);
}

export function isBusinessDay(iso: ISODate, cal: CalendarId): boolean {
  return isBusinessDayN(dayNumber(iso), cal);
}

/** Business days from `a` to `b` (exclusive of a, inclusive of b); negative when b < a. */
export function businessDaysBetween(a: ISODate | number, b: ISODate | number, cal: CalendarId): number {
  let x = typeof a === 'number' ? a : dayNumber(a);
  let y = typeof b === 'number' ? b : dayNumber(b);
  const sign = y >= x ? 1 : -1;
  if (sign < 0) [x, y] = [y, x];
  let n = 0;
  for (let d = x + 1; d <= y; d++) if (isBusinessDayN(d, cal)) n++;
  return sign * n;
}

export function addBusinessDays(iso: ISODate, days: number, cal: CalendarId): ISODate {
  let d = dayNumber(iso);
  let left = days;
  while (left > 0) {
    d++;
    if (isBusinessDayN(d, cal)) left--;
  }
  return fromDayNumber(d);
}

/** Calendar for an instrument id / exchange / currency. */
export function calendarFor(exchangeOrId?: string, currency?: string): CalendarId {
  const ex = exchangeOrId?.split(':')[0]?.toUpperCase();
  if (ex === 'BVMF' || currency === 'BRL') return 'BR';
  if (ex === 'XBOG' || currency === 'COP') return 'CO';
  if (ex && ['XNYS', 'XNAS', 'ARCX', 'XASE', 'BATS', 'OTC', 'US'].includes(ex)) return 'US';
  if (!ex && currency === 'USD') return 'US';
  return 'WEEKDAYS';
}
