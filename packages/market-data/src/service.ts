/**
 * MarketDataService: the facade used by apps/server (and usable directly in Node scripts).
 * Resolves ids/symbols through the catalog, fetches from providers through the cache, builds
 * month-end series, and routes FX to official sources.
 */
import type { CorporateAction, FxSeries, Instrument, ISODate, PriceSeries } from '@pm/core';
import { DAY, historyTtlMs, TieredCache, TTL, type PersistentStore } from './cache';
import { InstrumentCatalog } from './catalog';
import { daysBetween, isISODate, todayISO } from './dates';
import { MarketDataError, errorMessage } from './errors';
import { FxRouter } from './fx-router';
import { HttpClient, type FetchLike, type HttpClientOptions } from './http';
import { BanrepTrmProvider } from './providers/banrep';
import { BcbPtaxProvider, BcbSgsProvider } from './providers/bcb';
import { EcbProvider } from './providers/ecb';
import type { FxProvider, ProviderHistory } from './providers/types';
import { YahooFxProvider, YahooProvider } from './providers/yahoo';
import { toMonthEnd } from './series';
import {
  assetClassFromYahoo,
  looksLikeInstrumentId,
  marketByMic,
  parseYahooSymbol,
  yahooSymbolForInstrument,
  yahooSymbolFromId,
} from './symbols';
import type {
  ApiErrorBody,
  BatchRequest,
  BatchResponse,
  FxRequest,
  FxResponse,
  HistoryRequest,
  HistoryResponse,
  Interval,
  Quote,
  SearchResult,
  Settled,
} from './types';

export interface MarketDataServiceOptions {
  fetch?: FetchLike;
  http?: HttpClient;
  httpOptions?: HttpClientOptions;
  cache?: TieredCache;
  /** Persistent store for the default cache (ignored when `cache` is given). */
  store?: PersistentStore;
  catalog?: InstrumentCatalog;
  now?: () => Date;
  /** Override the FX provider chain (official ones first, market fallback last). */
  fxProviders?: FxProvider[];
  yahooBaseUrl?: string;
  trmAppToken?: string;
  /** TTL for quotes (default 10 min). */
  quoteTtlMs?: number;
  limits?: { maxBatchItems?: number; maxRangeDays?: number };
}

export const BATCH_LIMIT = 200;

export class MarketDataService {
  readonly http: HttpClient;
  readonly cache: TieredCache;
  readonly catalog: InstrumentCatalog;
  readonly yahoo: YahooProvider;
  readonly fx: FxRouter;
  private readonly now: () => Date;
  private readonly quoteTtlMs: number;
  private readonly maxBatch: number;
  private readonly maxRangeDays: number;

  constructor(opts: MarketDataServiceOptions = {}) {
    this.now = opts.now ?? (() => new Date());
    this.http =
      opts.http ??
      new HttpClient({
        fetch: opts.fetch,
        hostPolicies: {
          'query1.finance.yahoo.com': { concurrency: 4, minIntervalMs: 120 },
          'query2.finance.yahoo.com': { concurrency: 4, minIntervalMs: 120 },
          'www.datos.gov.co': { concurrency: 2, minIntervalMs: 200 },
          'olinda.bcb.gov.br': { concurrency: 2, minIntervalMs: 200 },
          'api.bcb.gov.br': { concurrency: 2, minIntervalMs: 200 },
          'data-api.ecb.europa.eu': { concurrency: 2, minIntervalMs: 200 },
        },
        ...opts.httpOptions,
      });
    this.cache = opts.cache ?? new TieredCache({ maxEntries: 2000, store: opts.store, now: () => this.now().getTime() });
    this.catalog = opts.catalog ?? new InstrumentCatalog();
    this.yahoo = new YahooProvider({ http: this.http, cache: this.cache, baseUrl: opts.yahooBaseUrl, now: this.now });
    const fxProviders = opts.fxProviders ?? [
      new BanrepTrmProvider({ http: this.http, appToken: opts.trmAppToken }),
      new BcbPtaxProvider({ http: this.http }),
      new BcbSgsProvider({ http: this.http }),
      new EcbProvider({ http: this.http }),
      new YahooFxProvider(this.yahoo),
    ];
    this.fx = new FxRouter({ providers: fxProviders, cache: this.cache, today: () => this.today() });
    this.quoteTtlMs = opts.quoteTtlMs ?? TTL.QUOTE;
    this.maxBatch = opts.limits?.maxBatchItems ?? BATCH_LIMIT;
    this.maxRangeDays = opts.limits?.maxRangeDays ?? 366 * 60;
  }

  today(): ISODate {
    return todayISO(this.now());
  }

  // -------------------------------------------------------------------------- resolution

  /** Map an instrument id, benchmark id, ISIN or provider symbol to a Yahoo symbol (+ catalog entry). */
  resolve(input: string): { providerSymbol: string; instrument?: Instrument } {
    const key = (input ?? '').trim();
    if (!key) throw new MarketDataError('BAD_REQUEST', 'Empty symbol');
    const inst = this.catalog.resolve(key);
    if (inst) {
      const y = yahooSymbolForInstrument(inst);
      if (!y) throw new MarketDataError('UNSUPPORTED', `No provider symbol for ${inst.id}`);
      return { providerSymbol: y, instrument: inst };
    }
    if (looksLikeInstrumentId(key)) {
      const y = yahooSymbolFromId(key);
      if (!y) throw new MarketDataError('BAD_REQUEST', `Unknown exchange in instrument id "${key}". Use MIC:SYMBOL, e.g. BVMF:PETR4, XBOG:ECOPETROL`);
      return { providerSymbol: y, instrument: this.catalog.byYahooSymbol(y) };
    }
    if (!/^[\w.^=\-&]{1,32}$/.test(key)) throw new MarketDataError('BAD_REQUEST', `Invalid symbol "${key}"`);
    return { providerSymbol: key.toUpperCase() };
  }

  private instrumentFor(providerSymbol: string, h: Pick<ProviderHistory, 'currency' | 'name' | 'providerExchange' | 'providerType'>, known?: Instrument): Instrument {
    if (known) return known.currency === h.currency ? known : { ...known, currency: h.currency };
    const p = parseYahooSymbol(providerSymbol, h.providerExchange);
    const market = marketByMic(p.exchange);
    return {
      id: `${p.exchange}:${p.symbol}`,
      symbol: p.symbol,
      name: h.name ?? providerSymbol,
      exchange: p.exchange,
      currency: h.currency,
      country: p.country ?? market?.country ?? '',
      assetClass: assetClassFromYahoo(h.providerType, providerSymbol, h.name),
      providerSymbols: { yahoo: providerSymbol },
      pricing: 'auto',
    };
  }

  // -------------------------------------------------------------------------- search

  async search(query: string, limit = 20): Promise<{ results: SearchResult[]; warnings?: string[] }> {
    const q = (query ?? '').trim();
    if (!q) throw new MarketDataError('BAD_REQUEST', 'Missing search query (q)');
    if (q.length > 64) throw new MarketDataError('BAD_REQUEST', 'Search query too long (max 64 chars)');
    const local = this.catalog.search(q, limit);
    let remote: SearchResult[] = [];
    const warnings: string[] = [];
    try {
      remote = (await this.cache.getOrLoad(`search:yahoo:${q.toLowerCase()}`, TTL.SEARCH, () => this.yahoo.search(q, { limit: 15 }))).value;
    } catch (e) {
      warnings.push(`provider search unavailable: ${errorMessage(e)}`);
    }
    const seen = new Set(local.map((r) => (r.providerSymbols?.yahoo ?? r.id).toUpperCase()));
    const merged: SearchResult[] = [...local];
    for (const r of remote) {
      const y = (r.providerSymbols?.yahoo ?? '').toUpperCase();
      if (seen.has(y)) continue;
      seen.add(y);
      const known = this.catalog.byYahooSymbol(y);
      merged.push(known ? { ...known, origin: 'catalog', providerType: r.providerType, exchangeLabel: r.exchangeLabel } : r);
    }
    return { results: merged.slice(0, limit), ...(warnings.length ? { warnings } : {}) };
  }

  // -------------------------------------------------------------------------- quotes

  async quote(input: string): Promise<Quote> {
    const { providerSymbol, instrument } = this.resolve(input);
    const { value: q } = await this.cache.getOrLoad(`quote:yahoo:${providerSymbol}`, this.quoteTtlMs, () => this.yahoo.quote(providerSymbol));
    const inst = this.instrumentFor(providerSymbol, { currency: q.currency, name: q.name, providerExchange: q.providerExchange, providerType: q.providerType }, instrument);
    const { providerExchange: _pe, providerType: _pt, ...rest } = q;
    const stale = daysBetween(q.date, this.today()) > 7;
    return { ...rest, instrumentId: inst.id, requested: input, name: inst.name ?? q.name, ...(stale ? { stale } : {}) };
  }

  async quotes(inputs: string[]): Promise<Settled<Quote>[]> {
    this.checkBatchSize(inputs.length, 'quotes');
    return Promise.all(inputs.map((i) => settle(() => this.quote(i))));
  }

  // -------------------------------------------------------------------------- history

  private validateRange(from: unknown, to: unknown): { from: ISODate; to: ISODate } {
    const today = this.today();
    if (!isISODate(from)) throw new MarketDataError('BAD_REQUEST', `Invalid or missing "from" date (YYYY-MM-DD): ${String(from)}`);
    const end = to === undefined || to === null || to === '' ? today : to;
    if (!isISODate(end)) throw new MarketDataError('BAD_REQUEST', `Invalid "to" date (YYYY-MM-DD): ${String(to)}`);
    if (from > end) throw new MarketDataError('BAD_REQUEST', `"from" (${from}) is after "to" (${end})`);
    if (from > today) throw new MarketDataError('BAD_REQUEST', `"from" (${from}) is in the future`);
    if (daysBetween(from, end) > this.maxRangeDays) throw new MarketDataError('BAD_REQUEST', 'Date range too long');
    return { from, to: end > today ? today : end };
  }

  private validateInterval(i: unknown): Interval {
    if (i === undefined || i === null || i === '') return '1d';
    if (i === '1d' || i === '1mo') return i;
    throw new MarketDataError('BAD_REQUEST', `Invalid interval "${String(i)}" (use 1d or 1mo)`);
  }

  async history(req: HistoryRequest): Promise<HistoryResponse> {
    const { from, to } = this.validateRange(req.from, req.to);
    const interval = this.validateInterval(req.interval);
    const adjust = req.adjust ?? 'none';
    if (adjust !== 'none' && adjust !== 'splits') throw new MarketDataError('BAD_REQUEST', `Invalid adjust "${String(adjust)}" (none|splits)`);
    const { providerSymbol, instrument } = this.resolve(req.symbol);
    const today = this.today();
    const ttl = adjust === 'none' ? historyTtlMs(to, today) : Math.min(DAY, historyTtlMs(to, today));
    const { value: h } = await this.cache.getOrLoad(`hist:yahoo:${providerSymbol}:${from}:${to}:${adjust}`, ttl, () =>
      this.yahoo.dailyHistory(providerSymbol, from, to, { adjust }),
    );
    const inst = this.instrumentFor(providerSymbol, h, instrument);
    const notes = [...h.notes];
    if (instrument && instrument.currency !== h.currency) notes.push(`catalog currency ${instrument.currency} differs from provider ${h.currency}; using provider`);
    const points = interval === '1mo' ? toMonthEnd(h.points) : h.points;
    const series: PriceSeries = { instrumentId: inst.id, currency: h.currency, points, source: 'yahoo' };
    const actions: CorporateAction[] = [
      ...h.dividends.map((d) => ({ instrumentId: inst.id, date: d.date, type: 'DIVIDEND' as const, amountPerShare: d.amount })),
      ...h.splits.map((s) => ({ instrumentId: inst.id, date: s.date, type: 'SPLIT' as const, ratio: s.ratio })),
    ].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    return {
      requested: req.symbol,
      providerSymbol: h.providerSymbol,
      instrument: inst,
      interval,
      series,
      actions,
      ...(notes.length ? { notes } : {}),
    };
  }

  // -------------------------------------------------------------------------- FX

  async fxSeries(req: FxRequest): Promise<FxResponse> {
    const base = String(req.base ?? '').toUpperCase();
    const quote = String(req.quote ?? '').toUpperCase();
    if (!/^[A-Z]{3}$/.test(base) || !/^[A-Z]{3}$/.test(quote)) {
      throw new MarketDataError('BAD_REQUEST', `Invalid currency pair "${req.base}/${req.quote}" (ISO 4217 codes, e.g. base=USD&quote=COP)`);
    }
    const { from, to } = this.validateRange(req.from, req.to);
    const interval = this.validateInterval(req.interval);
    const mode = req.source ?? 'auto';
    if (mode !== 'auto' && mode !== 'official' && mode !== 'yahoo') {
      throw new MarketDataError('BAD_REQUEST', `Invalid source "${String(mode)}" (auto|official|yahoo)`);
    }
    const r = await this.fx.daily(base, quote, from, to, mode);
    const series: FxSeries = {
      base,
      quote,
      points: interval === '1mo' ? toMonthEnd(r.points) : r.points,
      source: r.source,
    };
    return { series, interval, ...(r.fallbacks.length ? { fallbacks: r.fallbacks } : {}) };
  }

  // -------------------------------------------------------------------------- batch

  private checkBatchSize(n: number, what: string): void {
    if (n > this.maxBatch) throw new MarketDataError('BAD_REQUEST', `Too many ${what} in one request (max ${this.maxBatch})`);
  }

  async batch(req: BatchRequest): Promise<BatchResponse> {
    const started = Date.now();
    const histories = req.histories ?? [];
    const fx = req.fx ?? [];
    const quotes = req.quotes ?? [];
    if (!Array.isArray(histories) || !Array.isArray(fx) || !Array.isArray(quotes)) {
      throw new MarketDataError('BAD_REQUEST', 'histories, fx and quotes must be arrays');
    }
    this.checkBatchSize(histories.length + fx.length + quotes.length, 'items');
    const [h, f, q] = await Promise.all([
      Promise.all(histories.map((r) => settle(() => this.history(r)))),
      Promise.all(fx.map((r) => settle(() => this.fxSeries(r)))),
      Promise.all(quotes.map((s) => settle(() => this.quote(s)))),
    ]);
    return { histories: h, fx: f, quotes: q, tookMs: Date.now() - started };
  }
}

export function toErrorBody(e: unknown): ApiErrorBody['error'] {
  if (e instanceof MarketDataError) {
    return { code: e.code, message: e.message, ...(e.details !== undefined ? { details: e.details } : {}) };
  }
  return { code: 'INTERNAL', message: errorMessage(e) };
}

async function settle<T>(fn: () => Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    return { ok: false, error: toErrorBody(e) };
  }
}
