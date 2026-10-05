/** Date helpers. All dates are `YYYY-MM-DD` strings; arithmetic is done in UTC. */
import type { ISODate, YearMonth } from '@pm/core';

const ISO_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isISODate(s: unknown): s is ISODate {
  if (typeof s !== 'string' || !ISO_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

export function parseISO(d: ISODate): Date {
  return new Date(`${d}T00:00:00Z`);
}

export function formatISO(d: Date): ISODate {
  return d.toISOString().slice(0, 10);
}

export function addDays(d: ISODate, n: number): ISODate {
  const t = parseISO(d);
  t.setUTCDate(t.getUTCDate() + n);
  return formatISO(t);
}

/** Today's date in the given IANA time zone (default UTC). */
export function todayISO(now: Date = new Date(), timeZone = 'UTC'): ISODate {
  return dateInZone(now.getTime() / 1000, timeZone);
}

export function monthOf(d: ISODate): YearMonth {
  return d.slice(0, 7);
}

/** Last calendar day of the month containing `d`. */
export function endOfMonth(d: ISODate): ISODate {
  const y = Number(d.slice(0, 4));
  const m = Number(d.slice(5, 7));
  return formatISO(new Date(Date.UTC(y, m, 0)));
}

export function startOfMonth(d: ISODate): ISODate {
  return `${d.slice(0, 7)}-01`;
}

/** Every calendar day from `from` to `to` inclusive. */
export function eachDay(from: ISODate, to: ISODate): ISODate[] {
  const out: ISODate[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

export function daysBetween(a: ISODate, b: ISODate): number {
  return Math.round((parseISO(b).getTime() - parseISO(a).getTime()) / 86_400_000);
}

/** Unix seconds at 00:00 UTC of the date. */
export function toEpochSeconds(d: ISODate): number {
  return Math.floor(parseISO(d).getTime() / 1000);
}

const formatters = new Map<string, Intl.DateTimeFormat>();

/**
 * Calendar date of a unix timestamp in an IANA time zone. Falls back to a fixed UTC offset
 * (seconds) when the zone is unknown to the runtime.
 */
export function dateInZone(epochSeconds: number, timeZone?: string, fallbackOffsetSeconds = 0): ISODate {
  if (timeZone) {
    let f = formatters.get(timeZone);
    if (!f) {
      try {
        f = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
        formatters.set(timeZone, f);
      } catch {
        f = undefined;
      }
    }
    if (f) {
      const parts = f.formatToParts(new Date(epochSeconds * 1000));
      const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
      return `${get('year')}-${get('month')}-${get('day')}`;
    }
  }
  return formatISO(new Date((epochSeconds + fallbackOffsetSeconds) * 1000));
}

/** `DD/MM/YYYY` (BCB SGS) -> ISO. */
export function fromDMY(s: string): ISODate {
  const [d, m, y] = s.split('/');
  return `${y}-${m}-${d}`;
}

/** ISO -> `DD/MM/YYYY` (BCB SGS). */
export function toDMY(d: ISODate): string {
  return `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}`;
}

/** ISO -> `MM-DD-YYYY` (BCB PTAX OData). */
export function toMDY(d: ISODate): string {
  return `${d.slice(5, 7)}-${d.slice(8, 10)}-${d.slice(0, 4)}`;
}
