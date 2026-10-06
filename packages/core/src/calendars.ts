/**
 * Business-day calendars (C29), generated algorithmically so they never go out of date.
 *
 * BR (ANBIMA / B3 national holidays): Jan 1, Carnival Monday and Tuesday (Easter - 48 / - 47),
 *   Good Friday (Easter - 2), Tiradentes Apr 21, Labour Day May 1, Corpus Christi (Easter + 60),
 *   Independence Sep 7, Our Lady Aparecida Oct 12, All Souls Nov 2, Republic Nov 15,
 *   Black Consciousness Nov 20 (national from 2024), Christmas Dec 25.
 * CO (Ley 51 de 1983, "Ley Emiliani"): fixed Jan 1, May 1, Jul 20, Aug 7, Dec 8, Dec 25;
 *   Holy Thursday and Good Friday (Easter - 3 / - 2); moved to the following Monday: Jan 6, Mar 19,
 *   Jun 29, Aug 15, Oct 12, Nov 1, Nov 11, Ascension (Easter + 43), Corpus Christi (Easter + 64),
 *   Sacred Heart (Easter + 71).
 * 'WEEKDAYS' = Monday to Friday only.
 */
import { lastIndexAtOrBefore, weekday } from './dates';

export type CalendarId = 'BR' | 'CO' | 'WEEKDAYS';

const dayOf = (y: number, m: number, d: number) => Math.round(Date.UTC(y, m - 1, d) / 86_400_000);

/** Gregorian Easter Sunday (anonymous algorithm). */
export function easter(year: number): number {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
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
  return dayOf(year, month, day);
}

/** Next Monday on or after a day (Ley Emiliani). */
function emiliani(day: number): number {
  const w = weekday(day);
  return w === 1 ? day : day + ((8 - w) % 7);
}

export function holidaysOfYear(cal: CalendarId, year: number): number[] {
  if (cal === 'WEEKDAYS') return [];
  const E = easter(year);
  const out: number[] = [];
  if (cal === 'BR') {
    out.push(dayOf(year, 1, 1), E - 48, E - 47, E - 2, dayOf(year, 4, 21), dayOf(year, 5, 1), E + 60);
    out.push(dayOf(year, 9, 7), dayOf(year, 10, 12), dayOf(year, 11, 2), dayOf(year, 11, 15), dayOf(year, 12, 25));
    if (year >= 2024) out.push(dayOf(year, 11, 20));
  } else {
    out.push(dayOf(year, 1, 1), dayOf(year, 5, 1), dayOf(year, 7, 20), dayOf(year, 8, 7), dayOf(year, 12, 8), dayOf(year, 12, 25));
    out.push(E - 3, E - 2);
    for (const [m, d] of [[1, 6], [3, 19], [6, 29], [8, 15], [10, 12], [11, 1], [11, 11]] as const) out.push(emiliani(dayOf(year, m, d)));
    out.push(E + 43, E + 64, E + 71);
  }
  return Array.from(new Set(out)).sort((a, b) => a - b);
}

const cache = new Map<string, { from: number; to: number; days: Int32Array }>();

/** Sorted holidays falling on weekdays for the years covering [a, b]. */
function weekdayHolidays(cal: CalendarId, a: number, b: number): Int32Array {
  const ya = new Date(a * 86_400_000).getUTCFullYear() - 1;
  const yb = new Date(b * 86_400_000).getUTCFullYear() + 1;
  const hit = cache.get(cal);
  if (hit && hit.from <= ya && hit.to >= yb) return hit.days;
  const from = Math.min(ya, hit?.from ?? ya, 1990);
  const to = Math.max(yb, hit?.to ?? yb, 2060);
  const all: number[] = [];
  for (let y = from; y <= to; y++) for (const d of holidaysOfYear(cal, y)) if (weekday(d) !== 0 && weekday(d) !== 6) all.push(d);
  const days = Int32Array.from(all.sort((x, y) => x - y));
  cache.set(cal, { from, to, days });
  return days;
}

export function isHoliday(day: number, cal: CalendarId): boolean {
  if (cal === 'WEEKDAYS') return false;
  const h = weekdayHolidays(cal, day, day);
  const i = lastIndexAtOrBefore(h, day);
  return i >= 0 && h[i] === day;
}

export function isBusinessDay(day: number, cal: CalendarId): boolean {
  const w = weekday(day);
  return w !== 0 && w !== 6 && !isHoliday(day, cal);
}

/** First business day on or after `day`. */
export function nextBusinessDay(day: number, cal: CalendarId): number {
  let d = day;
  while (!isBusinessDay(d, cal)) d++;
  return d;
}

/** Add n business days (n >= 0). */
export function addBusinessDays(day: number, n: number, cal: CalendarId): number {
  let d = day;
  let k = 0;
  while (k < n) {
    d++;
    if (isBusinessDay(d, cal)) k++;
  }
  return d;
}

/** Business days in the half-open interval (a, b]; negative when b < a. */
export function businessDaysIn(a: number, b: number, cal: CalendarId = 'WEEKDAYS'): number {
  if (b < a) return -businessDaysIn(b, a, cal);
  if (b === a) return 0;
  const full = Math.floor((b - a) / 7);
  let n = full * 5;
  for (let d = a + full * 7 + 1; d <= b; d++) {
    const w = weekday(d);
    if (w !== 0 && w !== 6) n++;
  }
  if (cal !== 'WEEKDAYS') {
    const h = weekdayHolidays(cal, a, b);
    n -= lastIndexAtOrBefore(h, b) - lastIndexAtOrBefore(h, a);
  }
  return n;
}

/** Default calendar for a currency (BRL -> ANBIMA, COP -> Colombia). */
export function calendarForCurrency(ccy: string | undefined): CalendarId {
  return ccy === 'BRL' ? 'BR' : ccy === 'COP' ? 'CO' : 'WEEKDAYS';
}
