import type { ISODate, YearMonth } from '@pm/core';

const DAY_MS = 86_400_000;

export function toUtc(date: ISODate): number {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1);
}

export function fromUtc(ms: number): ISODate {
  return new Date(ms).toISOString().slice(0, 10);
}

export function daysBetween(from: ISODate, to: ISODate): number {
  return Math.round((toUtc(to) - toUtc(from)) / DAY_MS);
}

export function addDays(date: ISODate, days: number): ISODate {
  return fromUtc(toUtc(date) + days * DAY_MS);
}

/** Adds calendar years; 29-Feb maps to 28-Feb in non-leap years. */
export function addYears(date: ISODate, years: number): ISODate {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const ny = y + years;
  const last = daysInMonth(ny, m);
  return `${ny}-${pad(m)}-${pad(Math.min(d, last))}`;
}

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function monthOf(date: ISODate): YearMonth {
  return date.slice(0, 7);
}

export function yearOf(date: ISODate): number {
  return Number(date.slice(0, 4));
}

export function nextMonth(ym: YearMonth): YearMonth {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  return m === 12 ? `${y + 1}-01` : `${y}-${pad(m + 1)}`;
}

/** Inclusive list of months between two YearMonth values. */
export function monthRange(from: YearMonth, to: YearMonth): YearMonth[] {
  const out: YearMonth[] = [];
  for (let ym = from; ym <= to; ym = nextMonth(ym)) out.push(ym);
  return out;
}

export function lastDayOfMonth(ym: YearMonth): ISODate {
  const [y, m] = ym.split('-').map(Number) as [number, number];
  return `${ym}-${pad(daysInMonth(y, m))}`;
}

/** Gregorian Easter Sunday (Anonymous / Meeus algorithm). */
export function easterSunday(year: number): ISODate {
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
  return `${year}-${pad(month)}-${pad(day)}`;
}

/**
 * Brazilian national bank holidays used for DARF due dates: fixed national holidays (Lei 662/1949,
 * Lei 6.802/1980, Lei 14.759/2023 for 20-Nov) plus Carnival Monday/Tuesday, Good Friday and
 * Corpus Christi (no banking), and 31-Dec, which has no bank business ("não há expediente
 * bancário", FEBRABAN/PGFN), so guides due in December are paid by 30-Dec.
 * Local (state/municipal) holidays are not considered.
 */
export function brazilBankHolidays(year: number): Set<ISODate> {
  const fixed = ['01-01', '04-21', '05-01', '09-07', '10-12', '11-02', '11-15', '12-25', '12-31'];
  if (year >= 2024) fixed.push('11-20');
  const easter = easterSunday(year);
  const movable = [addDays(easter, -48), addDays(easter, -47), addDays(easter, -2), addDays(easter, 60)];
  return new Set([...fixed.map((md) => `${year}-${md}`), ...movable]);
}

export function isWeekend(date: ISODate): boolean {
  const dow = new Date(toUtc(date)).getUTCDay();
  return dow === 0 || dow === 6;
}

export function isBrazilBusinessDay(date: ISODate): boolean {
  return !isWeekend(date) && !brazilBankHolidays(yearOf(date)).has(date);
}

export function lastBrazilBusinessDayOfMonth(ym: YearMonth): ISODate {
  let d = lastDayOfMonth(ym);
  while (!isBrazilBusinessDay(d)) d = addDays(d, -1);
  return d;
}

/** Next Brazilian bank business day on or after `date`. */
export function nextBrazilBusinessDay(date: ISODate): ISODate {
  let d = date;
  while (!isBrazilBusinessDay(d)) d = addDays(d, 1);
  return d;
}

/** Adds N weekdays (Mon-Fri), ignoring holidays. Used for settlement-date estimates. */
export function addWeekdays(date: ISODate, n: number): ISODate {
  let d = date;
  let left = n;
  while (left > 0) {
    d = addDays(d, 1);
    if (!isWeekend(d)) left--;
  }
  return d;
}

function nthWeekday(year: number, month: number, weekday: number, n: number): ISODate {
  // weekday: 0=Sun..6=Sat; n>=1, or n=-1 for the last one
  if (n > 0) {
    const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
    const day = 1 + ((weekday - first + 7) % 7) + (n - 1) * 7;
    return `${year}-${pad(month)}-${pad(day)}`;
  }
  const lastDay = daysInMonth(year, month);
  const lastDow = new Date(Date.UTC(year, month - 1, lastDay)).getUTCDay();
  return `${year}-${pad(month)}-${pad(lastDay - ((lastDow - weekday + 7) % 7))}`;
}

/** Third Friday of a month (B3 option expiry convention). */
export function thirdFriday(year: number, month: number): ISODate {
  return nthWeekday(year, month, 5, 3);
}

function nextMonday(date: ISODate): ISODate {
  const dow = new Date(toUtc(date)).getUTCDay();
  return dow === 1 ? date : addDays(date, (8 - dow) % 7);
}

/**
 * Colombian public holidays (Ley 51 de 1983 "Ley Emiliani": several move to the next Monday).
 */
export function colombiaHolidays(year: number): Set<ISODate> {
  const fixed = ['01-01', '05-01', '07-20', '08-07', '12-08', '12-25'].map((md) => `${year}-${md}`);
  const emiliani = ['01-06', '03-19', '06-29', '08-15', '10-12', '11-01', '11-11'].map((md) => nextMonday(`${year}-${md}`));
  const e = easterSunday(year);
  const easterBased = [addDays(e, -3), addDays(e, -2), nextMonday(addDays(e, 39)), nextMonday(addDays(e, 60)), nextMonday(addDays(e, 68))];
  return new Set([...fixed, ...emiliani, ...easterBased]);
}

/** NYSE holidays (observed on Friday/Monday when on a weekend). */
export function usMarketHolidays(year: number): Set<ISODate> {
  const observed = (d: ISODate) => {
    const dow = new Date(toUtc(d)).getUTCDay();
    return dow === 6 ? addDays(d, -1) : dow === 0 ? addDays(d, 1) : d;
  };
  const days = [
    observed(`${year}-01-01`),
    nthWeekday(year, 1, 1, 3),
    nthWeekday(year, 2, 1, 3),
    addDays(easterSunday(year), -2),
    nthWeekday(year, 5, 1, -1),
    observed(`${year}-07-04`),
    nthWeekday(year, 9, 1, 1),
    nthWeekday(year, 11, 4, 4),
    observed(`${year}-12-25`),
  ];
  if (year >= 2022) days.push(observed(`${year}-06-19`));
  return new Set(days);
}

/** Adds N business days given a holiday calendar (weekends always skipped). */
export function addBusinessDays(date: ISODate, n: number, holidays: (year: number) => Set<ISODate>): ISODate {
  let d = date;
  let left = n;
  while (left > 0) {
    d = addDays(d, 1);
    if (!isWeekend(d) && !holidays(yearOf(d)).has(d)) left--;
  }
  return d;
}
