/**
 * Yahoo Finance provider (unofficial public endpoints).
 *
 * - Prices/quotes: `v8/finance/chart/{symbol}` (no crumb needed). `v7/finance/quote` requires a
 *   cookie+crumb and answers 401 without it, so quotes come from the chart `meta` instead.
 * - Search: `v1/finance/search`.
 * - Needs a browser User-Agent; 429s are retried with backoff by HttpClient.
 *
 * Data quirks handled here (all verified against recorded responses in test/fixtures/yahoo):
 * - `close` is split-adjusted retroactively (NVDA closed ~1,150 USD before the 2024-06-10
 *   10:1 split but Yahoo shows ~115). Dividends are split-adjusted too. We undo it using the
 *   full split history so closes are as traded (see `PriceAdjustment`).
 * - London equities quote in GBp (pence), dividends too: divided by 100 -> GBP. LSE ETFs
 *   often quote in USD/GBP; we always trust `meta.currency`. Occasional 100x glitches in
 *   GBp series are repaired.
 * - Daily bars: the last bar can be a live bar with timestamp = regularMarketTime, sometimes
 *   duplicating the date of the previous bar; holidays can come as null closes.
 * - BVC (`.CL`) is reported with time zone America/New_York; bars still map to the right
 *   local date because they are stamped at the session open.
 */
import type { ISODate, PricePoint, ProviderId } from '@pm/core';
import type { TieredCache } from '../cache';
import { TTL } from '../cache';
import { addDays, dateInZone, toEpochSeconds } from '../dates';
import { MarketDataError } from '../errors';
import { HttpError, type HttpClient } from '../http';
import { cleanPrice, dedupeByDate, roundSig, sliceRange } from '../series';
import {
  assetClassFromYahoo,
  instrumentIdFromYahoo,
  marketByMic,
  normalizeCurrency,
  parseYahooSymbol,
  yahooFxSymbol,
} from '../symbols';
import type { PriceAdjustment, SearchResult } from '../types';
import type { DividendEvent, FxProvider, PriceProvider, ProviderHistory, ProviderQuote, SplitEvent } from './types';

export interface YahooChartMeta {
  currency?: string | null;
  symbol: string;
  exchangeName?: string;
  fullExchangeName?: string;
  instrumentType?: string;
  gmtoffset?: number;
  exchangeTimezoneName?: string;
  regularMarketPrice?: number;
  regularMarketTime?: number;
  chartPreviousClose?: number;
  previousClose?: number;
  longName?: string;
  shortName?: string;
  priceHint?: number;
}

export interface YahooChartResult {
  meta: YahooChartMeta;
  timestamp?: number[];
  indicators?: { quote?: { close?: (number | null)[] }[] };
  events?: {
    dividends?: Record<string, { amount: number; date: number }>;
    splits?: Record<string, { date: number; numerator: number; denominator: number; splitRatio?: string }>;
  };
}

interface YahooChartResponse {
  chart: { result: YahooChartResult[] | null; error: { code: string; description: string } | null };
}

interface YahooSearchQuote {
  symbol: string;
  exchange?: string;
  exchDisp?: string;
  quoteType?: string;
  typeDisp?: string;
  shortname?: string;
  longname?: string;
  sector?: string;
  sectorDisp?: string;
  industry?: string;
  industryDisp?: string;
  isYahooFinance?: boolean;
}

export interface YahooOptions {
  http: HttpClient;
  /** Used for the per-symbol split history (TTL 1 day). */
  cache?: TieredCache;
  baseUrl?: string;
  now?: () => Date;
}

const SEARCH_TYPES = new Set(['EQUITY', 'ETF', 'MUTUALFUND', 'INDEX', 'CURRENCY', 'CRYPTOCURRENCY']);

export class YahooProvider implements PriceProvider {
  readonly id: ProviderId = 'yahoo';
  private readonly base: string;
  private readonly now: () => Date;

  constructor(private readonly opts: YahooOptions) {
    this.base = opts.baseUrl ?? 'https://query2.finance.yahoo.com';
    this.now = opts.now ?? (() => new Date());
  }

  // -------------------------------------------------------------------------- raw endpoints

  async chart(symbol: string, params: Record<string, string | number>): Promise<YahooChartResult> {
    const qs = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
    const url = `${this.base}/v8/finance/chart/${encodeURIComponent(symbol)}?${qs.toString()}`;
    let body: YahooChartResponse;
    try {
      body = await this.opts.http.getJson<YahooChartResponse>(url);
    } catch (e) {
      if (e instanceof HttpError && (e.status === 404 || e.status === 400)) {
        throw new MarketDataError('NOT_FOUND', `Yahoo: symbol not found or no data: ${symbol}`, parseYahooError(e.body));
      }
      if (e instanceof HttpError) throw new MarketDataError('UPSTREAM_ERROR', `Yahoo error ${e.status} for ${symbol}`);
      throw e;
    }
    const err = body?.chart?.error;
    if (err) {
      const code = /not found|delisted/i.test(`${err.code} ${err.description}`) ? 'NOT_FOUND' : 'UPSTREAM_ERROR';
      throw new MarketDataError(code, `Yahoo: ${err.description || err.code} (${symbol})`);
    }
    const result = body?.chart?.result?.[0];
    if (!result?.meta) throw new MarketDataError('NOT_FOUND', `Yahoo: empty chart for ${symbol}`);
    return result;
  }

  // -------------------------------------------------------------------------- search

  async search(query: string, opts: { limit?: number } = {}): Promise<SearchResult[]> {
    const qs = new URLSearchParams({
      q: query,
      quotesCount: String(opts.limit ?? 15),
      newsCount: '0',
      listsCount: '0',
      enableFuzzyQuery: 'false',
    });
    const body = await this.opts.http.getJson<{ quotes?: YahooSearchQuote[] }>(`${this.base}/v1/finance/search?${qs.toString()}`);
    return (body.quotes ?? [])
      .filter((q) => q.symbol && q.isYahooFinance !== false && SEARCH_TYPES.has((q.quoteType ?? '').toUpperCase()))
      .map((q) => searchResultFromYahoo(q));
  }

  // -------------------------------------------------------------------------- quote

  async quote(symbol: string): Promise<ProviderQuote> {
    const r = await this.chart(symbol, { range: '1d', interval: '1d' });
    const m = r.meta;
    if (m.regularMarketPrice == null || m.regularMarketTime == null) {
      throw new MarketDataError('NOT_FOUND', `Yahoo: no market price for ${symbol}`);
    }
    const cur = normalizeCurrency(m.currency) ?? { currency: inferCurrency(symbol, m.exchangeName), divisor: 1 };
    const decimals = (m.priceHint ?? 2) + (cur.divisor > 1 ? 2 : 0);
    const price = cleanPrice(m.regularMarketPrice / cur.divisor, decimals);
    const prevRaw = m.chartPreviousClose ?? m.previousClose;
    const previousClose = prevRaw != null ? cleanPrice(prevRaw / cur.divisor, decimals) : undefined;
    const change = previousClose != null ? cleanPrice(price - previousClose, decimals) : undefined;
    return {
      providerSymbol: m.symbol ?? symbol,
      name: m.longName ?? m.shortName,
      exchange: m.fullExchangeName ?? m.exchangeName,
      providerExchange: m.exchangeName,
      providerType: m.instrumentType,
      currency: cur.currency,
      price,
      previousClose,
      change,
      changePct: previousClose ? round6(price / previousClose - 1) : undefined,
      date: dateInZone(m.regularMarketTime, m.exchangeTimezoneName, m.gmtoffset ?? 0),
      time: new Date(m.regularMarketTime * 1000).toISOString(),
      source: 'yahoo',
    };
  }

  // -------------------------------------------------------------------------- history

  /** Full split history of a symbol (cached one day). */
  async splits(symbol: string): Promise<SplitEvent[]> {
    const load = async () => {
      const r = await this.chart(symbol, {
        period1: 0,
        period2: Math.floor(this.now().getTime() / 1000) + 86_400,
        interval: '3mo',
        events: 'splits',
      });
      return parseSplits(r);
    };
    if (!this.opts.cache) return load();
    return (await this.opts.cache.getOrLoad(`yahoo:splits:${symbol}`, TTL.SPLITS, load)).value;
  }

  async dailyHistory(
    symbol: string,
    from: ISODate,
    to: ISODate,
    opts: { adjust?: PriceAdjustment } = {},
  ): Promise<ProviderHistory> {
    const adjust = opts.adjust ?? 'none';
    // Pad the window: bars are stamped in exchange time and we slice by local date afterwards.
    const r = await this.chart(symbol, {
      period1: toEpochSeconds(addDays(from, -1)),
      period2: toEpochSeconds(addDays(to, 2)),
      interval: '1d',
      events: 'div,splits',
      includeAdjustedClose: 'false',
    });
    const allSplits = adjust === 'none' ? mergeSplits(parseSplits(r), await this.splits(symbol).catch(() => [])) : parseSplits(r);
    return buildHistory(r, symbol, from, to, adjust, allSplits);
  }
}

// ---------------------------------------------------------------------------- pure helpers

function round6(x: number): number {
  return Math.round(x * 1e6) / 1e6;
}

function parseYahooError(body: string): unknown {
  try {
    return (JSON.parse(body) as YahooChartResponse).chart?.error ?? undefined;
  } catch {
    return undefined;
  }
}

function inferCurrency(symbol: string, exchange?: string): string {
  const p = parseYahooSymbol(symbol, exchange);
  return p.currency ?? 'USD';
}

export function parseSplits(r: YahooChartResult): SplitEvent[] {
  const tz = r.meta.exchangeTimezoneName;
  const off = r.meta.gmtoffset ?? 0;
  return Object.values(r.events?.splits ?? {})
    .filter((s) => s.numerator > 0 && s.denominator > 0)
    .map((s) => ({ date: dateInZone(s.date, tz, off), ratio: s.numerator / s.denominator }))
    .sort((a, b) => (a.date < b.date ? -1 : 1));
}

function mergeSplits(a: SplitEvent[], b: SplitEvent[]): SplitEvent[] {
  const map = new Map<string, SplitEvent>();
  for (const s of [...a, ...b]) map.set(s.date, s);
  return [...map.values()].sort((x, y) => (x.date < y.date ? -1 : 1));
}

/** Cumulative product of split ratios strictly after `date` (factor to undo Yahoo's adjustment). */
export function splitFactorAfter(splits: readonly SplitEvent[], date: ISODate): number {
  let f = 1;
  for (const s of splits) if (s.date > date) f *= s.ratio;
  return f;
}

/**
 * Repair isolated 100x unit glitches in minor-unit series (an LSE stock in GBp that reports a
 * few closes in GBP, or vice versa). Compares each value to the median of its neighbours.
 */
export function repairHundredfoldGlitches(points: PricePoint[]): { points: PricePoint[]; fixed: number } {
  let fixed = 0;
  const closes = points.map((p) => p.close);
  const out = points.map((p, i) => {
    const neighbours = [...closes.slice(Math.max(0, i - 5), i), ...closes.slice(i + 1, i + 6)].sort((a, b) => a - b);
    if (neighbours.length < 3) return p;
    const median = neighbours[Math.floor(neighbours.length / 2)]!;
    const r = p.close / median;
    if (r > 70 && r < 140) {
      fixed++;
      return { ...p, close: p.close / 100 };
    }
    if (r > 1 / 140 && r < 1 / 70) {
      fixed++;
      return { ...p, close: p.close * 100 };
    }
    return p;
  });
  return { points: out, fixed };
}

export function buildHistory(
  r: YahooChartResult,
  symbol: string,
  from: ISODate,
  to: ISODate,
  adjust: PriceAdjustment,
  splits: SplitEvent[],
  decimalsOverride?: number,
): ProviderHistory {
  const m = r.meta;
  const notes: string[] = [];
  const tz = m.exchangeTimezoneName;
  const off = m.gmtoffset ?? 0;
  const cur = normalizeCurrency(m.currency) ?? { currency: inferCurrency(symbol, m.exchangeName), divisor: 1 };
  if (!m.currency) notes.push(`currency missing in provider data; inferred ${cur.currency}`);
  if (cur.divisor !== 1) notes.push(`prices quoted in ${m.currency} normalized to ${cur.currency} (/${cur.divisor})`);
  const decimals = decimalsOverride ?? Math.max(2, (m.priceHint ?? 2) + (cur.divisor > 1 ? 2 : 0));

  const ts = r.timestamp ?? [];
  const closes = r.indicators?.quote?.[0]?.close ?? [];
  let raw: PricePoint[] = [];
  for (let i = 0; i < ts.length; i++) {
    const c = closes[i];
    if (c == null || !Number.isFinite(c) || c <= 0) continue;
    raw.push({ date: dateInZone(ts[i]!, tz, off), close: c });
  }
  raw = dedupeByDate(raw);

  if (cur.divisor !== 1) {
    const rep = repairHundredfoldGlitches(raw);
    if (rep.fixed) notes.push(`repaired ${rep.fixed} close(s) with 100x unit glitches`);
    raw = rep.points;
  }

  const unadjust = adjust === 'none';
  if (unadjust && splits.some((s) => s.date > from)) {
    notes.push('split adjustment removed: closes are as traded');
  }
  const points = sliceRange(raw, from, to).map((p) => ({
    date: p.date,
    close: cleanPrice(((unadjust ? splitFactorAfter(splits, p.date) : 1) * p.close) / cur.divisor, decimals),
  }));

  const dividends: DividendEvent[] = Object.values(r.events?.dividends ?? {})
    .map((d) => {
      const date = dateInZone(d.date, tz, off);
      const f = unadjust ? splitFactorAfter(splits, date) : 1;
      return { date, amount: cleanPrice((d.amount * f) / cur.divisor, 6) };
    })
    .filter((d) => d.date >= from && d.date <= to && d.amount > 0)
    .sort((a, b) => (a.date < b.date ? -1 : 1));

  return {
    providerSymbol: m.symbol ?? symbol,
    currency: cur.currency,
    name: m.longName ?? m.shortName,
    providerExchange: m.exchangeName,
    providerType: m.instrumentType,
    timeZone: tz,
    points,
    dividends,
    splits: splits.filter((s) => s.date >= from && s.date <= to),
    notes,
  };
}

export function searchResultFromYahoo(q: YahooSearchQuote): SearchResult {
  const parsed = parseYahooSymbol(q.symbol, q.exchange);
  const market = marketByMic(parsed.exchange);
  const name = q.longname ?? q.shortname ?? q.symbol;
  const result: SearchResult = {
    id: instrumentIdFromYahoo(q.symbol, q.exchange),
    symbol: parsed.symbol,
    name,
    exchange: parsed.exchange,
    currency: parsed.currency ?? market?.currency ?? 'USD',
    country: parsed.country ?? market?.country ?? '',
    assetClass: assetClassFromYahoo(q.quoteType, q.symbol, name),
    providerSymbols: { yahoo: q.symbol },
    pricing: 'auto',
    origin: 'yahoo',
    providerType: q.quoteType,
    exchangeLabel: q.exchDisp,
  };
  const sector = q.sectorDisp ?? q.sector;
  const industry = q.industryDisp ?? q.industry;
  if (sector) result.sector = sector;
  if (industry) result.industry = industry;
  return result;
}

// ---------------------------------------------------------------------------- FX

/** Yahoo FX as universal fallback (`COP=X`, `EURUSD=X`, `BRLCOP=X`...). */
export class YahooFxProvider implements FxProvider {
  readonly id: ProviderId = 'yahoo';
  readonly official = false;

  constructor(private readonly yahoo: YahooProvider) {}

  supports(base: string, quote: string): boolean {
    return /^[A-Z]{3}$/.test(base) && /^[A-Z]{3}$/.test(quote) && base !== quote;
  }

  async daily(base: string, quote: string, from: ISODate, to: ISODate) {
    // Prefer the liquid direction (USD/XXX, EUR/USD, GBP/USD) and invert when needed.
    const majorsOverUsd = ['EUR', 'GBP', 'AUD', 'NZD'];
    let symbol = yahooFxSymbol(base, quote);
    let invert = false;
    if (quote === 'USD' && !majorsOverUsd.includes(base)) {
      symbol = yahooFxSymbol('USD', base);
      invert = true;
    }
    const r = await this.yahoo.chart(symbol, {
      period1: toEpochSeconds(addDays(from, -1)),
      period2: toEpochSeconds(addDays(to, 2)),
      interval: '1d',
    });
    const h = buildHistory(r, symbol, from, to, 'splits', [], 10);
    return h.points.map((p) => ({ date: p.date, rate: roundSig(invert ? 1 / p.close : p.close, 7) }));
  }
}
