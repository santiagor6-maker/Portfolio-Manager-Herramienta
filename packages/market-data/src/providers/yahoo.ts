/**
 * Yahoo Finance provider (unofficial public endpoints).
 *
 * - Prices/quotes: `v8/finance/chart/{symbol}` (no crumb needed). `v7/finance/quote` requires a
 *   cookie+crumb and answers 401 without it, so quotes come from the chart `meta` instead.
 * - Search: `v1/finance/search` (also resolves many ISINs: US0378331005 -> AAPL).
 * - Needs a browser User-Agent; 429s are retried with backoff by HttpClient.
 *
 * Data quirks handled here (all verified against recorded responses in test/fixtures/yahoo):
 * - `close` is split-adjusted retroactively (NVDA closed ~1,150 USD before the 2024-06-10
 *   10:1 split but Yahoo shows ~115), even for ranges that end before the split. Dividends too.
 *   We undo it with the symbol's full split history. If that history cannot be fetched the
 *   result is marked `degraded` (closes may still be adjusted) and is never cached long.
 * - "Splits" also encode bonificações (ITUB4 11:10) and spin-offs (GE 1253:1000); see corporate.ts.
 * - London equities quote in GBp (pence), dividends too: divided by 100 -> GBP. LSE ETFs
 *   often quote in USD/GBP; we always trust `meta.currency`. Occasional 100x glitches repaired.
 * - Suspended stocks keep getting bars after the last trade (CNEC.CL: last trade 2025-11-14 at
 *   5000, then zero-volume 5000s and months of 6240, one of them a duplicate of an old bar with
 *   its volume): bars dated after the last trade date (meta.regularMarketTime) are dropped.
 * - Holidays can come as null closes; the last daily bar can be a live bar.
 * - BVC (`.CL`) is reported with time zone America/New_York; bars still map to the right
 *   local date because they are stamped at the session open.
 */
import type { FxPoint, ISODate, PricePoint, ProviderId } from '@pm/core';
import type { TieredCache } from '../cache';
import { TTL } from '../cache';
import { addDays, dateInZone, todayISO, toEpochSeconds } from '../dates';
import { MarketDataError, errorMessage } from '../errors';
import { HttpError, type HttpClient } from '../http';
import { cleanPrice, combine, dedupeByDate, roundSig, sliceRange } from '../series';
import {
  assetClassFromYahoo,
  instrumentIdFromYahoo,
  isCryptoCurrency,
  marketByMic,
  normalizeCurrency,
  parseYahooSymbol,
  yahooFxSymbol,
} from '../symbols';
import type { SearchResult } from '../types';
import type { DividendEvent, FxProvider, PriceProvider, PriceTarget, ProviderHistory, ProviderQuote, SplitEvent } from './types';

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
  currentTradingPeriod?: { regular?: { start: number; end: number } };
}

export interface YahooChartResult {
  meta: YahooChartMeta;
  timestamp?: number[];
  indicators?: { quote?: { close?: (number | null)[]; volume?: (number | null)[] }[] };
  events?: {
    dividends?: Record<string, { amount: number; date: number }>;
    splits?: Record<string, { date: number; numerator: number; denominator: number; splitRatio?: string }>;
  };
}

interface YahooChartResponse {
  chart: { result: YahooChartResult[] | null; error: { code: string; description: string } | null };
}

export interface YahooSearchQuote {
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

/**
 * Dividends Yahoo reports in a currency different from the quote currency (UCITS ETFs that
 * declare distributions in USD but trade in GBP on the LSE). Verified on VUSA.L / VWRL.L:
 * Yahoo amounts match the USD distributions declared by Vanguard.
 */
export const DIVIDEND_CURRENCY_OVERRIDES: Readonly<Record<string, string>> = {
  'VUSA.L': 'USD',
  'VWRL.L': 'USD',
  'VHYL.L': 'USD',
  'VUKE.L': 'GBP',
  'IUSA.L': 'USD',
};

const SEARCH_TYPES = new Set(['EQUITY', 'ETF', 'MUTUALFUND', 'INDEX', 'CURRENCY', 'CRYPTOCURRENCY']);

const asSymbol = (t: string | PriceTarget) => (typeof t === 'string' ? t : t.yahoo);

export class YahooProvider implements PriceProvider {
  readonly id: ProviderId = 'yahoo';
  private readonly base: string;
  private readonly now: () => Date;

  constructor(private readonly opts: YahooOptions) {
    this.base = opts.baseUrl ?? 'https://query2.finance.yahoo.com';
    this.now = opts.now ?? (() => new Date());
  }

  supports(target: PriceTarget): boolean {
    return !!target.yahoo;
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

  async quote(t: string | PriceTarget): Promise<ProviderQuote> {
    const symbol = asSymbol(t);
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
    const reg = m.currentTradingPeriod?.regular;
    const nowS = this.now().getTime() / 1000;
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
      marketState: reg && nowS >= reg.start && nowS < reg.end ? 'open' : 'closed',
      source: 'yahoo',
    };
  }

  // -------------------------------------------------------------------------- history

  /** Full split history of a symbol (cached one day; failures are not cached). */
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

  /**
   * As-traded daily closes in [from, to]. When the range ends in the past, the full split
   * history is needed to undo later splits; if it cannot be fetched the result is `degraded`.
   */
  async dailyHistory(t: string | PriceTarget, from: ISODate, to: ISODate): Promise<ProviderHistory> {
    const symbol = asSymbol(t);
    const r = await this.chart(symbol, {
      period1: toEpochSeconds(addDays(from, -1)),
      period2: toEpochSeconds(addDays(to, 2)),
      interval: '1d',
      events: 'div,splits',
      includeAdjustedClose: 'false',
    });
    const inRange = parseSplits(r);
    const reachesPresent = to >= addDays(todayISO(this.now()), -3);
    let splits = inRange;
    const degraded: string[] = [];
    if (!reachesPresent) {
      try {
        splits = mergeSplits(inRange, await this.splits(symbol));
      } catch (e) {
        degraded.push(`split-history-unavailable: ${errorMessage(e)}`);
      }
    }
    const h = buildHistory(r, symbol, from, to, splits);
    if (degraded.length) {
      h.degraded = degraded;
      h.notes.push('split history unavailable: closes may be split-adjusted for later splits (not cached)');
    }
    return h;
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
    .map((s) => ({ date: dateInZone(s.date, tz, off), ratio: s.numerator / s.denominator, numerator: s.numerator, denominator: s.denominator }))
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

/**
 * Build an as-traded history from a chart response. `splits` must contain every split after
 * `from` that Yahoo applied (range events + full split history).
 */
export function buildHistory(
  r: YahooChartResult,
  symbol: string,
  from: ISODate,
  to: ISODate,
  splits: SplitEvent[],
  opts: { decimals?: number; adjusted?: boolean } = {},
): ProviderHistory {
  const m = r.meta;
  const notes: string[] = [];
  const tz = m.exchangeTimezoneName;
  const off = m.gmtoffset ?? 0;
  const cur = normalizeCurrency(m.currency) ?? { currency: inferCurrency(symbol, m.exchangeName), divisor: 1 };
  if (!m.currency) notes.push(`currency missing in provider data; inferred ${cur.currency}`);
  if (cur.divisor !== 1) notes.push(`prices quoted in ${m.currency} normalized to ${cur.currency} (/${cur.divisor})`);
  const decimals = opts.decimals ?? Math.max(2, (m.priceHint ?? 2) + (cur.divisor > 1 ? 2 : 0));
  const lastTradeDate = m.regularMarketTime ? dateInZone(m.regularMarketTime, tz, off) : undefined;

  const ts = r.timestamp ?? [];
  const q = r.indicators?.quote?.[0];
  const closes = q?.close ?? [];
  let raw: PricePoint[] = [];
  let phantom = 0;
  for (let i = 0; i < ts.length; i++) {
    const c = closes[i];
    if (c == null || !Number.isFinite(c) || c <= 0) continue;
    const date = dateInZone(ts[i]!, tz, off);
    // Bars after the last real trade (meta.regularMarketTime) are carried-forward or duplicated
    // phantom closes: CNEC.CL repeats a 6240 bar (copy of 2025-11-04, even with its volume)
    // weeks after its last trade at 5000 on 2025-11-14.
    if (lastTradeDate && date > lastTradeDate) {
      phantom++;
      continue;
    }
    raw.push({ date, close: c });
  }
  if (phantom) notes.push(`dropped ${phantom} phantom bar(s) dated after the last trade on ${lastTradeDate}`);
  raw = dedupeByDate(raw);

  if (cur.divisor !== 1) {
    const rep = repairHundredfoldGlitches(raw);
    if (rep.fixed) notes.push(`repaired ${rep.fixed} close(s) with 100x unit glitches`);
    raw = rep.points;
  }

  const unadjust = !opts.adjusted;
  const points = sliceRange(raw, from, to).map((p) => ({
    date: p.date,
    close: cleanPrice(((unadjust ? splitFactorAfter(splits, p.date) : 1) * p.close) / cur.divisor, decimals),
  }));

  const divCurrency = DIVIDEND_CURRENCY_OVERRIDES[symbol.toUpperCase()];
  const dividends: DividendEvent[] = Object.values(r.events?.dividends ?? {})
    .map((d) => {
      const date = dateInZone(d.date, tz, off);
      const f = unadjust ? splitFactorAfter(splits, date) : 1;
      // An override currency means the amount is already in major units of that currency.
      const divisor = divCurrency ? 1 : cur.divisor;
      const ev: DividendEvent = { date, amount: cleanPrice((d.amount * f) / divisor, 6) };
      if (divCurrency && divCurrency !== cur.currency) ev.currency = divCurrency;
      return ev;
    })
    .filter((d) => d.date >= from && d.date <= to && d.amount > 0)
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  if (divCurrency && divCurrency !== cur.currency) notes.push(`dividends declared in ${divCurrency} (instrument quotes in ${cur.currency})`);

  const reg = m.currentTradingPeriod?.regular;
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
    basis: unadjust ? 'as-traded' : 'split-adjusted',
    ...(lastTradeDate ? { lastTradeDate } : {}),
    ...(reg ? { session: { start: reg.start, end: reg.end } } : {}),
    source: 'yahoo',
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

/** Yahoo FX as universal fallback (`COP=X`, `EURUSD=X`, `BTC-USD`...). */
export class YahooFxProvider implements FxProvider {
  readonly id: ProviderId = 'yahoo';
  readonly official = false;

  constructor(private readonly yahoo: YahooProvider) {}

  supports(base: string, quote: string): boolean {
    return /^[A-Z]{3,5}$/.test(base) && /^[A-Z]{3,5}$/.test(quote) && base !== quote;
  }

  async daily(base: string, quote: string, from: ISODate, to: ISODate): Promise<FxPoint[]> {
    if (base !== 'USD' && quote !== 'USD') {
      // Crosses such as BRLCOP=X have little or no history on Yahoo: triangulate through the
      // liquid USD legs (BRL=X, COP=X), carrying values forward over each market's holidays.
      const padded = addDays(from, -10);
      const [a, b] = await Promise.all([this.direct(base, 'USD', padded, to), this.direct('USD', quote, padded, to)]);
      return combine(a, b, from, to).map((p) => ({ date: p.date, rate: roundSig(p.rate, 7) }));
    }
    return this.direct(base, quote, from, to);
  }

  private async direct(base: string, quote: string, from: ISODate, to: ISODate): Promise<FxPoint[]> {
    // Prefer the liquid direction (USD/XXX, EUR/USD, GBP/USD, BTC-USD) and invert when needed.
    const majorsOverUsd = ['EUR', 'GBP', 'AUD', 'NZD'];
    let symbol = yahooFxSymbol(base, quote);
    let invert = false;
    if (isCryptoCurrency(base)) {
      symbol = `${base}-${quote}`;
    } else if (isCryptoCurrency(quote)) {
      symbol = `${quote}-${base}`;
      invert = true;
    } else if (quote === 'USD' && !majorsOverUsd.includes(base)) {
      symbol = yahooFxSymbol('USD', base);
      invert = true;
    } else if (base === 'USD' && majorsOverUsd.includes(quote)) {
      symbol = yahooFxSymbol(quote, 'USD');
      invert = true;
    }
    const r = await this.yahoo.chart(symbol, {
      period1: toEpochSeconds(addDays(from, -1)),
      period2: toEpochSeconds(addDays(to, 2)),
      interval: '1d',
    });
    const h = buildHistory(r, symbol, from, to, [], { decimals: 10, adjusted: true });
    return h.points.map((p) => ({ date: p.date, rate: roundSig(invert ? 1 / p.close : p.close, 7) }));
  }
}
