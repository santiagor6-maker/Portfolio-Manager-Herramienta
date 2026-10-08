import { calendars, dates as coreDates, type CurrencyCode, type ISODate, type PricePoint, type ProviderId } from '@pm/core';
import { addDays, daysBetween, isISODate } from '../dates';
import { MarketDataError } from '../errors';
import { HttpError } from '../http';
import { dedupeByDate, sliceRange } from '../series';
import type { DividendEvent, PriceBasis, PriceTarget, ProviderHistory } from './types';

export function simpleHistory(
  target: PriceTarget,
  source: ProviderId,
  currency: CurrencyCode,
  points: PricePoint[],
  from: ISODate,
  to: ISODate,
  basis: PriceBasis,
  extra: { name?: string; dividends?: DividendEvent[]; notes?: string[] } = {},
): ProviderHistory {
  const pts = sliceRange(dedupeByDate(points.filter((p) => isISODate(p.date) && Number.isFinite(p.close) && p.close > 0)), from, to);
  if (!pts.length) throw new MarketDataError('NOT_FOUND', `${source}: no prices for ${target.yahoo} in ${from}..${to}`);
  const notes = [...(extra.notes ?? [])];
  if (basis === 'split-adjusted') notes.push(`${source} closes are split-adjusted (not as traded); cached briefly`);
  return {
    providerSymbol: target.yahoo,
    currency,
    name: extra.name,
    points: pts,
    dividends: (extra.dividends ?? []).filter((d) => d.date >= from && d.date <= to),
    splits: [],
    notes,
    basis,
    lastTradeDate: pts[pts.length - 1]!.date,
    source,
  };
}

/** Map provider HTTP failures to MarketDataError codes. */
export function mapHttpError(source: string, e: unknown): never {
  if (e instanceof MarketDataError) throw e;
  if (e instanceof HttpError) {
    if (e.status === 401 || e.status === 403) throw new MarketDataError('UPSTREAM_ERROR', `${source}: unauthorized/forbidden (${e.status}); check the API key or network egress`);
    if (e.status === 404) throw new MarketDataError('NOT_FOUND', `${source}: not found`);
    if (e.status === 429) throw new MarketDataError('RATE_LIMITED', `${source}: rate limited`);
    throw new MarketDataError('UPSTREAM_ERROR', `${source}: HTTP ${e.status}`);
  }
  throw new MarketDataError('UPSTREAM_ERROR', `${source}: ${e instanceof Error ? e.message : String(e)}`);
}

/** Smallest provider "range" token covering [from, today]. */
export function rangeToken(from: ISODate, today: ISODate, tokens: readonly [string, number][]): string {
  const days = daysBetween(from, today) + 5;
  for (const [tok, d] of tokens) if (days <= d) return tok;
  return tokens[tokens.length - 1]![0];
}

/** First B3 business day after a date (B3 ex-date = first trading day after the "data com"). */
export function nextWeekday(d: ISODate): ISODate {
  return coreDates.dayToIso(calendars.nextBusinessDay(coreDates.isoToDay(addDays(d, 1)), 'BR'));
}

/** YYYYMMDD -> ISO. */
export function fromCompact(d: string): ISODate {
  return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
}
