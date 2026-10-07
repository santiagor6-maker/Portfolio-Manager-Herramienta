/**
 * User-defined price feeds (like Portfolio Performance's JSON / table providers): an instrument
 * gets its prices from any URL returning JSON (extracted with a small JSONPath subset) or CSV.
 * Feeds come from server-side configuration only (MD_CUSTOM_FEEDS_FILE), never from requests,
 * so they cannot be abused as an open proxy.
 *
 * Example (datos.gov.co FIC unit values):
 * {
 *   "id": "CUSTOM:MIFONDO", "name": "Mi fondo", "currency": "COP", "assetClass": "fund", "country": "CO",
 *   "feed": {
 *     "type": "json",
 *     "url": "https://www.datos.gov.co/resource/qhpu-8ixx.json?codigo_negocio=2852&$where=fecha_corte between '{FROM}T00:00:00' and '{TO}T00:00:00'",
 *     "rowsPath": "$[*]", "dateField": "fecha_corte", "closeField": "valor_unidad_operaciones"
 *   }
 * }
 * URL placeholders: {SYMBOL} {FROM} {TO} {FROM_DMY} {TO_DMY} {FROM_EPOCH} {TO_EPOCH}.
 */
import type { AssetClass, CountryCode, CurrencyCode, Instrument, ISODate, ProviderId } from '@pm/core';
import { addDays, fromDMY, toDMY, toEpochSeconds } from '../dates';
import { MarketDataError } from '../errors';
import type { HttpClient } from '../http';
import { parseCsv } from './ecb';
import { mapHttpError, simpleHistory } from './common';
import type { PriceProvider, PriceTarget, ProviderHistory } from './types';

export type FeedDateFormat = 'iso' | 'DD/MM/YYYY' | 'MM/DD/YYYY' | 'YYYYMMDD' | 'epoch' | 'epochms';

export interface CustomFeed {
  type: 'json' | 'csv';
  url: string;
  headers?: Record<string, string>;
  /**
   * JSON, preferred: path to the rows plus fields relative to each row, so a row that omits a field
   * (datos.gov.co drops null fields) is skipped instead of shifting every later value.
   * e.g. rowsPath `$[*]`, dateField `fecha_corte`, closeField `valor_unidad_operaciones`.
   */
  rowsPath?: string;
  dateField?: string;
  closeField?: string;
  /** JSON, alternative: paths to parallel date and close arrays, e.g. `$.data[*].date`, `$[*].valor`. */
  datePath?: string;
  closePath?: string;
  /** CSV: column names (or 0-based indexes) and format. */
  dateColumn?: string | number;
  closeColumn?: string | number;
  delimiter?: string;
  decimal?: '.' | ',';
  dateFormat?: FeedDateFormat;
  /** Divide closes by this (e.g. 100 for prices in cents). */
  divisor?: number;
}

export interface CustomFeedInstrument {
  id: string;
  name: string;
  currency: CurrencyCode;
  assetClass?: AssetClass;
  country?: CountryCode;
  symbol?: string;
  feed: CustomFeed;
}

/**
 * Tiny JSONPath subset: `$`, `.key`, `['key']`, `[n]`, `[*]`. Returns all matches. With
 * `keepMissing`, a missing key yields `undefined` in place (positions stay aligned).
 */
export function jsonPath(root: unknown, path: string, opts: { keepMissing?: boolean } = {}): unknown[] {
  if (!path.startsWith('$')) throw new MarketDataError('BAD_REQUEST', `JSONPath must start with $: ${path}`);
  const tokens = [...path.slice(1).matchAll(/\.([A-Za-z_$][\w$-]*)|\[(\*|\d+|'[^']*'|"[^"]*")\]/g)].map((m) => m[1] ?? m[2]!);
  let cur: unknown[] = [root];
  for (const t of tokens) {
    const next: unknown[] = [];
    for (const v of cur) {
      if (v == null || typeof v !== 'object') {
        if (opts.keepMissing) next.push(undefined);
        continue;
      }
      if (t === '*') next.push(...(Array.isArray(v) ? v : Object.values(v)));
      else if (/^\d+$/.test(t)) {
        if (Array.isArray(v)) next.push(v[Number(t)]);
      } else {
        const key = t.replace(/^['"]|['"]$/g, '');
        next.push((v as Record<string, unknown>)[key]);
      }
    }
    cur = opts.keepMissing ? next : next.filter((x) => x !== undefined);
  }
  return cur;
}

export function parseFeedDate(v: unknown, fmt: FeedDateFormat = 'iso'): ISODate | undefined {
  if (v == null) return undefined;
  const s = String(v).trim();
  switch (fmt) {
    case 'epoch':
      return new Date(Number(s) * 1000).toISOString().slice(0, 10);
    case 'epochms':
      return new Date(Number(s)).toISOString().slice(0, 10);
    case 'DD/MM/YYYY':
      return fromDMY(s.slice(0, 10));
    case 'MM/DD/YYYY':
      return `${s.slice(6, 10)}-${s.slice(0, 2)}-${s.slice(3, 5)}`;
    case 'YYYYMMDD':
      return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`;
    default:
      return s.slice(0, 10);
  }
}

function parseNumber(v: unknown, decimal: '.' | ',' = '.'): number {
  if (typeof v === 'number') return v;
  let s = String(v ?? '').trim();
  if (decimal === ',') s = s.replace(/\./g, '').replace(',', '.');
  else s = s.replace(/,/g, '');
  return Number(s);
}

export function expandFeedUrl(url: string, symbol: string, from: ISODate, to: ISODate): string {
  return url
    .replaceAll('{SYMBOL}', encodeURIComponent(symbol))
    .replaceAll('{FROM}', from)
    .replaceAll('{TO}', to)
    .replaceAll('{FROM_DMY}', toDMY(from))
    .replaceAll('{TO_DMY}', toDMY(to))
    .replaceAll('{FROM_EPOCH}', String(toEpochSeconds(from)))
    .replaceAll('{TO_EPOCH}', String(toEpochSeconds(addDays(to, 1))));
}

export class CustomFeedProvider implements PriceProvider {
  readonly id: ProviderId = 'custom';
  private readonly byId: Map<string, CustomFeedInstrument>;

  constructor(
    private readonly opts: { http: HttpClient; feeds: CustomFeedInstrument[] },
  ) {
    this.byId = new Map(opts.feeds.map((f) => [f.id.toUpperCase(), f]));
  }

  get instruments(): Instrument[] {
    return this.opts.feeds.map((f) => ({
      id: f.id,
      symbol: f.symbol ?? f.id.split(':').pop() ?? f.id,
      name: f.name,
      exchange: f.id.includes(':') ? f.id.split(':')[0]! : 'CUSTOM',
      currency: f.currency,
      country: f.country ?? '',
      assetClass: f.assetClass ?? 'other',
      providerSymbols: { custom: f.id },
      pricing: 'auto' as const,
    }));
  }

  feedFor(id: string): CustomFeedInstrument | undefined {
    return this.byId.get(id.toUpperCase());
  }

  supports(t: PriceTarget): boolean {
    return this.byId.has(t.instrumentId.toUpperCase());
  }

  async dailyHistory(t: PriceTarget, from: ISODate, to: ISODate): Promise<ProviderHistory> {
    const cfg = this.feedFor(t.instrumentId);
    if (!cfg) throw new MarketDataError('NOT_FOUND', `No custom feed for ${t.instrumentId}`);
    const f = cfg.feed;
    const url = expandFeedUrl(f.url, cfg.symbol ?? t.symbol, from, to);
    let pairs: { date: ISODate | undefined; close: number }[] = [];
    try {
      if (f.type === 'json') {
        const body = await this.opts.http.getJson(url, f.headers);
        const num = (v: unknown) => (v == null || v === '' ? Number.NaN : parseNumber(v, f.decimal));
        if (f.rowsPath || f.dateField || f.closeField) {
          pairs = jsonPath(body, f.rowsPath ?? '$[*]').map((row) => {
            const r = (row ?? {}) as Record<string, unknown>;
            return { date: parseFeedDate(r[f.dateField ?? 'date'], f.dateFormat), close: num(r[f.closeField ?? 'close']) };
          });
        } else {
          // Parallel arrays: keep holes so a row without a value cannot shift the following ones.
          const dates = jsonPath(body, f.datePath ?? '$[*].date', { keepMissing: true });
          const closes = jsonPath(body, f.closePath ?? '$[*].close', { keepMissing: true });
          if (dates.length !== closes.length) {
            throw new MarketDataError('UPSTREAM_ERROR', `custom feed ${cfg.id}: ${dates.length} dates vs ${closes.length} closes; use rowsPath/dateField/closeField`);
          }
          pairs = dates.map((d, i) => ({ date: parseFeedDate(d, f.dateFormat), close: num(closes[i]) }));
        }
      } else {
        const rows = parseCsv(f.delimiter && f.delimiter !== ',' ? (await this.opts.http.getText(url, f.headers)).replaceAll(f.delimiter, ',') : await this.opts.http.getText(url, f.headers));
        const header = rows[0] ?? [];
        const col = (c: string | number | undefined, def: number) =>
          typeof c === 'number' ? c : c ? header.findIndex((h) => h.trim().toLowerCase() === c.toLowerCase()) : def;
        const iDate = col(f.dateColumn, 0);
        const iClose = col(f.closeColumn, 1);
        if (iDate < 0 || iClose < 0) throw new MarketDataError('UPSTREAM_ERROR', `custom feed ${cfg.id}: columns not found`);
        pairs = rows.slice(1).map((r) => ({ date: parseFeedDate(r[iDate], f.dateFormat), close: parseNumber(r[iClose], f.decimal) }));
      }
    } catch (e) {
      mapHttpError(`custom:${cfg.id}`, e);
    }
    const points = pairs
      .filter((p): p is { date: ISODate; close: number } => !!p.date)
      .map((p) => ({ date: p.date, close: p.close / (f.divisor ?? 1) }));
    return simpleHistory(t, this.id, cfg.currency, points, from, to, 'as-traded', { name: cfg.name });
  }
}
