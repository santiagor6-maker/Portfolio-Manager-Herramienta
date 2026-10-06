/**
 * Keyed price providers, enabled by environment variables (see apps/server/README):
 *   TWELVEDATA_API_KEY, FMP_API_KEY, EODHD_API_TOKEN, ALPHAVANTAGE_API_KEY.
 * Implemented against each provider's documented API; none is reachable from the build
 * container, so they are tested with fixtures built from the documented response shapes.
 *
 * London is excluded except for Twelve Data (which reports the quote currency, e.g. GBp):
 * the others return LSE prices in pence without saying so.
 */
import type { ISODate, ProviderId } from '@pm/core';
import { MarketDataError } from '../errors';
import type { HttpClient } from '../http';
import { normalizeCurrency, US_MICS } from '../symbols';
import { mapHttpError, simpleHistory } from './common';
import type { PriceProvider, PriceTarget, ProviderHistory } from './types';

const isUS = (t: PriceTarget) => US_MICS.includes(t.exchange) && t.exchange !== 'OTC';

// ------------------------------------------------------------------------------------ Twelve Data

/**
 * GET https://api.twelvedata.com/time_series?symbol=AAPL&interval=1day&start_date=..&end_date=..
 *     &order=asc&adjust=none&mic_code=XBOG&apikey=KEY
 * -> { meta: { currency, exchange, mic_code }, values: [{ datetime, close }], status: 'ok' }
 */
export class TwelveDataProvider implements PriceProvider {
  readonly id: ProviderId = 'twelvedata';
  constructor(private readonly opts: { http: HttpClient; apiKey: string; baseUrl?: string }) {}

  supports(t: PriceTarget): boolean {
    return /^X[A-Z]{3}$|^BVMF$|^ARCX$|^BATS$/.test(t.exchange);
  }

  async dailyHistory(t: PriceTarget, from: ISODate, to: ISODate): Promise<ProviderHistory> {
    const qs = new URLSearchParams({
      symbol: t.symbol.replace('-', '.'),
      interval: '1day',
      start_date: from,
      end_date: to,
      order: 'asc',
      adjust: 'none',
      apikey: this.opts.apiKey,
    });
    if (!isUS(t)) qs.set('mic_code', t.exchange);
    let body: { status?: string; code?: number; message?: string; meta?: { currency?: string }; values?: { datetime: string; close: string }[] };
    try {
      body = await this.opts.http.getJson(`${this.opts.baseUrl ?? 'https://api.twelvedata.com'}/time_series?${qs.toString()}`);
    } catch (e) {
      mapHttpError('twelvedata', e);
    }
    if (body.status !== 'ok') {
      const code = body.code === 429 ? 'RATE_LIMITED' : body.code === 404 || body.code === 400 ? 'NOT_FOUND' : 'UPSTREAM_ERROR';
      throw new MarketDataError(code, `twelvedata: ${body.message ?? 'error'}`);
    }
    const cur = normalizeCurrency(body.meta?.currency) ?? { currency: t.currency ?? 'USD', divisor: 1 };
    const points = (body.values ?? []).map((v) => ({ date: v.datetime.slice(0, 10), close: Number(v.close) / cur.divisor }));
    return simpleHistory(t, this.id, cur.currency, points, from, to, 'as-traded');
  }
}

// ------------------------------------------------------------------------------------ FMP

/** Yahoo-style suffixes FMP uses for non-US listings (London and BVC excluded). */
const FMP_OK = new Set(['BVMF', 'XETR', 'XPAR', 'XAMS', 'XMAD', 'XMIL', 'XSWX', 'XMEX', 'XSGO', 'XTSE', 'XHKG', 'XTKS', 'XNSE', 'XASX']);

/**
 * GET https://financialmodelingprep.com/stable/historical-price-eod/full?symbol=AAPL&from=..&to=..&apikey=KEY
 * -> [{ symbol, date, open, high, low, close, volume }] (newest first). Closes are split-adjusted.
 */
export class FmpProvider implements PriceProvider {
  readonly id: ProviderId = 'fmp';
  constructor(private readonly opts: { http: HttpClient; apiKey: string; baseUrl?: string }) {}

  supports(t: PriceTarget): boolean {
    return isUS(t) || FMP_OK.has(t.exchange) || t.exchange === 'INDEX';
  }

  async dailyHistory(t: PriceTarget, from: ISODate, to: ISODate): Promise<ProviderHistory> {
    const qs = new URLSearchParams({ symbol: t.yahoo, from, to, apikey: this.opts.apiKey });
    let body: unknown;
    try {
      body = await this.opts.http.getJson(`${this.opts.baseUrl ?? 'https://financialmodelingprep.com/stable'}/historical-price-eod/full?${qs.toString()}`);
    } catch (e) {
      mapHttpError('fmp', e);
    }
    const rows = Array.isArray(body) ? (body as { date: string; close: number }[]) : ((body as { historical?: { date: string; close: number }[] }).historical ?? []);
    if (!Array.isArray(body) && (body as { 'Error Message'?: string })['Error Message']) {
      throw new MarketDataError('UPSTREAM_ERROR', `fmp: ${(body as { 'Error Message': string })['Error Message']}`);
    }
    const points = rows.map((r) => ({ date: r.date, close: Number(r.close) }));
    return simpleHistory(t, this.id, t.currency ?? 'USD', points, from, to, 'split-adjusted');
  }
}

// ------------------------------------------------------------------------------------ EODHD

const EODHD_EXCHANGE: Record<string, string> = {
  XETR: 'XETRA', XPAR: 'PA', XAMS: 'AS', XMAD: 'MC', XMIL: 'MI', XSWX: 'SW', BVMF: 'SA', XMEX: 'MX',
  XSGO: 'SN', XTSE: 'TO', XBRU: 'BR', XLIS: 'LS', XHKG: 'HK', XASX: 'AU', XJSE: 'JSE',
};

/**
 * GET https://eodhd.com/api/eod/AAPL.US?from=..&to=..&fmt=json&api_token=KEY
 * -> [{ date, open, high, low, close, adjusted_close, volume }] — `close` is as traded.
 */
export class EodhdProvider implements PriceProvider {
  readonly id: ProviderId = 'eodhd';
  constructor(private readonly opts: { http: HttpClient; apiToken: string; baseUrl?: string }) {}

  code(t: PriceTarget): string | undefined {
    if (isUS(t)) return `${t.symbol.replace('-', '.')}.US`;
    const ex = EODHD_EXCHANGE[t.exchange];
    return ex ? `${t.symbol}.${ex}` : undefined;
  }

  supports(t: PriceTarget): boolean {
    return !!this.code(t);
  }

  async dailyHistory(t: PriceTarget, from: ISODate, to: ISODate): Promise<ProviderHistory> {
    const code = this.code(t);
    if (!code) throw new MarketDataError('UNSUPPORTED', `eodhd does not cover ${t.instrumentId}`);
    const qs = new URLSearchParams({ from, to, fmt: 'json', api_token: this.opts.apiToken });
    let rows: { date: string; close: number }[];
    try {
      rows = await this.opts.http.getJson(`${this.opts.baseUrl ?? 'https://eodhd.com/api'}/eod/${encodeURIComponent(code)}?${qs.toString()}`);
    } catch (e) {
      mapHttpError('eodhd', e);
    }
    if (!Array.isArray(rows)) throw new MarketDataError('UPSTREAM_ERROR', 'eodhd: unexpected response');
    return simpleHistory(t, this.id, t.currency ?? 'USD', rows.map((r) => ({ date: r.date, close: Number(r.close) })), from, to, 'as-traded');
  }
}

// ------------------------------------------------------------------------------------ Alpha Vantage

const AV_SUFFIX: Record<string, string> = { BVMF: '.SAO', XETR: '.DEX', XTSE: '.TRT' };

/**
 * GET https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=AAPL&outputsize=compact&apikey=KEY
 * -> { "Time Series (Daily)": { "2025-01-03": { "4. close": "243.36" } } }; quota exceeded ->
 * { "Information": "..."} or { "Note": "..." }. Free keys only get the last 100 days (compact);
 * set ALPHAVANTAGE_PREMIUM=1 for outputsize=full. Closes are as traded.
 */
export class AlphaVantageProvider implements PriceProvider {
  readonly id: ProviderId = 'alphavantage';
  constructor(private readonly opts: { http: HttpClient; apiKey: string; premium?: boolean; baseUrl?: string }) {}

  supports(t: PriceTarget): boolean {
    return isUS(t) || !!AV_SUFFIX[t.exchange];
  }

  async dailyHistory(t: PriceTarget, from: ISODate, to: ISODate): Promise<ProviderHistory> {
    const symbol = isUS(t) ? t.symbol.replace('-', '.') : `${t.symbol}${AV_SUFFIX[t.exchange] ?? ''}`;
    const qs = new URLSearchParams({
      function: 'TIME_SERIES_DAILY',
      symbol,
      outputsize: this.opts.premium ? 'full' : 'compact',
      apikey: this.opts.apiKey,
    });
    let body: Record<string, unknown>;
    try {
      body = await this.opts.http.getJson(`${this.opts.baseUrl ?? 'https://www.alphavantage.co'}/query?${qs.toString()}`);
    } catch (e) {
      mapHttpError('alphavantage', e);
    }
    const series = body['Time Series (Daily)'] as Record<string, Record<string, string>> | undefined;
    if (!series) {
      const msg = String(body['Information'] ?? body['Note'] ?? body['Error Message'] ?? 'no data');
      throw new MarketDataError(/rate limit|per day|frequency|premium/i.test(msg) ? 'RATE_LIMITED' : 'NOT_FOUND', `alphavantage: ${msg.slice(0, 160)}`);
    }
    const points = Object.entries(series).map(([date, v]) => ({ date, close: Number(v['4. close']) }));
    const notes = this.opts.premium ? [] : ['alphavantage free tier: only the last 100 trading days'];
    return simpleHistory(t, this.id, t.currency ?? 'USD', points, from, to, 'as-traded', { notes });
  }
}
