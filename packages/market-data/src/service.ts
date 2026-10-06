/**
 * MarketDataService: the facade used by apps/server (and usable directly in Node scripts).
 *
 * Prices: Yahoo first, cached in canonical per-symbol, per-year chunks of AS-TRADED closes
 * (closed years are immutable; the cache is bounded by symbols x years, not by request ranges).
 * If Yahoo fails, the request fails over to the next provider that covers the instrument
 * (Twelve Data / FMP / EODHD / Alpha Vantage when keys are configured, brapi for B3, stooq,
 * CoinGecko for crypto); those answers are cached briefly and reported in `fallbacks`.
 * Tesouro Direto, Colombian FICs and pension funds, and user-defined feeds have their own providers.
 */
import type { FxSeries, Instrument, ISODate } from '@pm/core';
import { aliasesTo, findAlias, renameInfo, type TickerAlias } from './aliases';
import { DAY, HOUR, MINUTE, historyTtlMs, TieredCache, TTL, type PersistentStore } from './cache';
import { InstrumentCatalog } from './catalog';
import { classifySplit } from './corporate';
import { addDays, daysBetween, isISODate, todayISO } from './dates';
import { MarketDataError, errorMessage } from './errors';
import { FxRouter } from './fx-router';
import { HttpClient, type FetchLike, type HttpClientOptions } from './http';
import { IndexService, INDEX_IDS } from './indices';
import { BanrepTrmProvider } from './providers/banrep';
import { BanrepSdmx, BanrepSdmxTrmProvider } from './providers/banrep-sdmx';
import { BcbPtaxProvider, BcbSgsProvider } from './providers/bcb';
import { BrapiProvider } from './providers/brapi';
import { CoinGeckoFxProvider, CoinGeckoProvider } from './providers/coingecko';
import { CustomFeedProvider, type CustomFeedInstrument } from './providers/custom';
import { EcbProvider } from './providers/ecb';
import { AlphaVantageProvider, EodhdProvider, FmpProvider, TwelveDataProvider } from './providers/keyed';
import { StooqProvider } from './providers/stooq';
import { SuperfinProvider } from './providers/superfin';
import { TesouroProvider } from './providers/tesouro';
import type { DividendEvent, FxProvider, PriceProvider, PriceTarget, ProviderHistory } from './providers/types';
import { splitFactorAfter, YahooFxProvider, YahooProvider } from './providers/yahoo';
import { toMonthEnd } from './series';
import {
  assetClassFromYahoo,
  GENERIC_EXCHANGE,
  instrumentIdFromYahoo,
  isValidSymbol,
  looksLikeInstrumentId,
  marketByMic,
  parseYahooSymbol,
  yahooSymbolForInstrument,
  yahooSymbolFromId,
} from './symbols';
import { searchTemplates } from './templates';
import { normalizeText } from './text';
import type {
  ApiErrorBody,
  BatchRequest,
  BatchResponse,
  FxRequest,
  FxResponse,
  HistoryRequest,
  HistoryResponse,
  IndexRequest,
  IndexResponse,
  Interval,
  MarketCorporateAction,
  MarketPricePoint,
  PriceAdjustment,
  Quote,
  SearchResult,
  Settled,
} from './types';

/** API keys and tokens; `keysFromEnv(process.env)` builds it on the server. */
export interface ProviderKeys {
  brapi?: string;
  stooq?: string;
  twelvedata?: string;
  fmp?: string;
  eodhd?: string;
  alphavantage?: string;
  alphavantagePremium?: boolean;
  coingecko?: string;
  socrata?: string;
}

export function keysFromEnv(env: Record<string, string | undefined>): ProviderKeys {
  return {
    brapi: env.BRAPI_TOKEN || undefined,
    stooq: env.STOOQ_API_KEY || undefined,
    twelvedata: env.TWELVEDATA_API_KEY || undefined,
    fmp: env.FMP_API_KEY || undefined,
    eodhd: env.EODHD_API_TOKEN || undefined,
    alphavantage: env.ALPHAVANTAGE_API_KEY || undefined,
    alphavantagePremium: env.ALPHAVANTAGE_PREMIUM === '1',
    coingecko: env.COINGECKO_API_KEY || undefined,
    socrata: env.SOCRATA_APP_TOKEN || undefined,
  };
}

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
  /** Override the fallback price providers tried after Yahoo. */
  priceProviders?: PriceProvider[];
  keys?: ProviderKeys;
  customFeeds?: CustomFeedInstrument[];
  yahooBaseUrl?: string;
  /** @deprecated use keys.socrata */
  trmAppToken?: string;
  /** TTL for quotes (default 10 min). */
  quoteTtlMs?: number;
  limits?: { maxBatchItems?: number; maxRangeDays?: number; maxBatchPoints?: number };
  /** Base URL overrides (tests, mirrors). */
  urls?: { tesouro?: string; sgs?: string; fred?: string; ecb?: string; banrepSdmx?: string; superfin?: string };
}

export const BATCH_LIMIT = 100;
export const BATCH_POINTS_LIMIT = 100_000;

interface Resolved {
  kind: 'market' | 'tesouro' | 'superfin' | 'custom';
  target: PriceTarget;
  instrument?: Instrument;
  alias?: TickerAlias;
}

interface MarketResult {
  h: ProviderHistory;
  fallbacks: { source: string; error: string }[];
}

const YEAR_CHUNK_VERSION = 'v2';

export class MarketDataService {
  readonly http: HttpClient;
  readonly cache: TieredCache;
  readonly catalog: InstrumentCatalog;
  readonly yahoo: YahooProvider;
  readonly fx: FxRouter;
  readonly indices: IndexService;
  readonly tesouro: TesouroProvider;
  readonly superfin: SuperfinProvider;
  readonly custom: CustomFeedProvider;
  readonly brapi: BrapiProvider;
  /** Price providers tried after Yahoo, in order. */
  readonly fallbackProviders: PriceProvider[];
  private readonly now: () => Date;
  private readonly quoteTtlMs: number;
  private readonly maxBatch: number;
  private readonly maxBatchPoints: number;
  private readonly maxRangeDays: number;
  private readonly fxProviderIds: string[];

  constructor(opts: MarketDataServiceOptions = {}) {
    this.now = opts.now ?? (() => new Date());
    const keys = { ...opts.keys, socrata: opts.keys?.socrata ?? opts.trmAppToken };
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
          'totoro.banrep.gov.co': { concurrency: 2, minIntervalMs: 300 },
          'api.coingecko.com': { concurrency: 1, minIntervalMs: 2500 },
          'www.alphavantage.co': { concurrency: 1, minIntervalMs: 1200 },
          'api.twelvedata.com': { concurrency: 1, minIntervalMs: 8000 },
        },
        ...opts.httpOptions,
      });
    this.cache = opts.cache ?? new TieredCache({ maxEntries: 3000, store: opts.store, now: () => this.now().getTime() });
    this.catalog = opts.catalog ?? new InstrumentCatalog();
    const http = this.http;
    this.yahoo = new YahooProvider({ http, cache: this.cache, baseUrl: opts.yahooBaseUrl, now: this.now });
    const sdmx = new BanrepSdmx({ http, cache: this.cache, baseUrl: opts.urls?.banrepSdmx });
    const coingecko = new CoinGeckoProvider({ http, apiKey: keys.coingecko, now: this.now });
    this.brapi = new BrapiProvider({ http, token: keys.brapi, now: this.now });
    this.tesouro = new TesouroProvider({ http, cache: this.cache, url: opts.urls?.tesouro, now: this.now });
    this.superfin = new SuperfinProvider({ http, cache: this.cache, baseUrl: opts.urls?.superfin, appToken: keys.socrata, now: this.now });
    this.custom = new CustomFeedProvider({ http, feeds: opts.customFeeds ?? [] });

    const keyed: PriceProvider[] = [];
    if (keys.twelvedata) keyed.push(new TwelveDataProvider({ http, apiKey: keys.twelvedata }));
    if (keys.fmp) keyed.push(new FmpProvider({ http, apiKey: keys.fmp }));
    if (keys.eodhd) keyed.push(new EodhdProvider({ http, apiToken: keys.eodhd }));
    if (keys.alphavantage) keyed.push(new AlphaVantageProvider({ http, apiKey: keys.alphavantage, premium: keys.alphavantagePremium }));
    this.fallbackProviders = opts.priceProviders ?? [...keyed, this.brapi, new StooqProvider({ http, apiKey: keys.stooq }), coingecko];

    const fxProviders = opts.fxProviders ?? [
      new BanrepTrmProvider({ http, appToken: keys.socrata }),
      new BanrepSdmxTrmProvider(sdmx),
      new BcbPtaxProvider({ http }),
      new BcbSgsProvider({ http, sgsBaseUrl: opts.urls?.sgs }),
      new EcbProvider({ http, baseUrl: opts.urls?.ecb ? `${opts.urls.ecb}/EXR` : undefined }),
      new YahooFxProvider(this.yahoo),
      new CoinGeckoFxProvider(coingecko),
    ];
    this.fxProviderIds = fxProviders.map((p) => String(p.id));
    this.fx = new FxRouter({ providers: fxProviders, cache: this.cache, today: () => this.today() });
    this.indices = new IndexService({
      http,
      cache: this.cache,
      sdmx,
      today: () => this.today(),
      sgsBaseUrl: opts.urls?.sgs,
      fredBaseUrl: opts.urls?.fred,
      ecbBaseUrl: opts.urls?.ecb,
    });
    this.quoteTtlMs = opts.quoteTtlMs ?? TTL.QUOTE;
    this.maxBatch = opts.limits?.maxBatchItems ?? BATCH_LIMIT;
    this.maxBatchPoints = opts.limits?.maxBatchPoints ?? BATCH_POINTS_LIMIT;
    this.maxRangeDays = opts.limits?.maxRangeDays ?? 366 * 60;
  }

  today(): ISODate {
    return todayISO(this.now());
  }

  providers(): { prices: string[]; fx: string[]; indices: string[] } {
    return {
      prices: ['yahoo', ...this.fallbackProviders.map((p) => String(p.id)), 'tesouro', 'superfin', ...(this.custom.instruments.length ? ['custom'] : [])],
      fx: this.fxProviderIds,
      indices: INDEX_IDS,
    };
  }

  // -------------------------------------------------------------------------- resolution

  /**
   * Map an instrument id, benchmark id, ISIN, old (renamed) ticker or provider symbol to a price
   * target. Every symbol is validated before it can reach a provider URL.
   */
  resolve(input: string): Resolved {
    let key = (typeof input === 'string' ? input : '').trim();
    if (!key) throw new MarketDataError('BAD_REQUEST', 'Empty symbol');
    if (key.length > 64) throw new MarketDataError('BAD_REQUEST', 'Symbol too long (max 64 chars)');
    const alias = findAlias(key);
    if (alias) key = alias.toId;

    const feed = this.custom.feedFor(key);
    if (feed) {
      const inst = this.custom.instruments.find((i) => i.id.toUpperCase() === key.toUpperCase())!;
      return { kind: 'custom', instrument: inst, target: { instrumentId: inst.id, exchange: inst.exchange, symbol: inst.symbol, yahoo: '', currency: inst.currency } };
    }

    const inst = this.catalog.resolve(key);
    if (inst) {
      const y = yahooSymbolForInstrument(inst);
      if (!y) throw new MarketDataError('UNSUPPORTED', `No provider symbol for ${inst.id}`);
      return { kind: 'market', instrument: inst, alias, target: this.target(y, inst) };
    }
    if (looksLikeInstrumentId(key)) {
      const i = key.indexOf(':');
      const exchange = key.slice(0, i).toUpperCase();
      const sym = key.slice(i + 1);
      if (!isValidSymbol(sym)) throw new MarketDataError('BAD_REQUEST', `Invalid symbol "${sym}" in id "${key}"`);
      if (exchange === 'TD') return { kind: 'tesouro', target: { instrumentId: `TD:${sym.toUpperCase()}`, exchange, symbol: sym.toUpperCase(), yahoo: '', currency: 'BRL' } };
      if (exchange === 'FIC' || exchange === 'AFP') return { kind: 'superfin', target: { instrumentId: `${exchange}:${sym}`, exchange, symbol: sym, yahoo: '', currency: 'COP' } };
      const y = yahooSymbolFromId(key);
      if (!y) {
        throw new MarketDataError('BAD_REQUEST', `Unknown exchange in instrument id "${key}". Use MIC:SYMBOL, e.g. BVMF:PETR4, XBOG:ECOPETROL, or YAHOO:<yahoo symbol>`);
      }
      return { kind: 'market', alias, instrument: this.catalog.byYahooSymbol(y), target: this.target(y) };
    }
    if (!isValidSymbol(key)) throw new MarketDataError('BAD_REQUEST', `Invalid symbol "${key}"`);
    const y = key.toUpperCase();
    return { kind: 'market', alias, instrument: this.catalog.byYahooSymbol(y), target: this.target(y) };
  }

  private target(yahoo: string, inst?: Instrument): PriceTarget {
    const p = parseYahooSymbol(yahoo);
    return {
      instrumentId: inst?.id ?? `${p.exchange}:${p.symbol}`,
      exchange: inst?.exchange ?? p.exchange,
      symbol: inst?.symbol ?? p.symbol,
      yahoo,
      currency: inst?.currency ?? p.currency,
    };
  }

  private instrumentFor(r: Resolved, h: Pick<ProviderHistory, 'currency' | 'name' | 'providerExchange' | 'providerType'>): Instrument {
    const known = r.instrument;
    if (known) return known.currency === h.currency ? known : { ...known, currency: h.currency };
    if (r.kind !== 'market') {
      return {
        id: r.target.instrumentId,
        symbol: r.target.symbol,
        name: h.name ?? r.target.instrumentId,
        exchange: r.target.exchange,
        currency: h.currency,
        country: r.kind === 'tesouro' ? 'BR' : 'CO',
        assetClass: r.kind === 'tesouro' ? 'fixed_income' : 'fund',
        pricing: 'auto',
      };
    }
    const providerSymbol = r.target.yahoo;
    const p = parseYahooSymbol(providerSymbol, h.providerExchange);
    const market = marketByMic(p.exchange);
    return {
      id: p.exchange === GENERIC_EXCHANGE ? `${GENERIC_EXCHANGE}:${providerSymbol}` : instrumentIdFromYahoo(providerSymbol, h.providerExchange),
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

  async search(query: string, limit = 20, opts: { preferredCountries?: string[] } = {}): Promise<{ results: SearchResult[]; warnings?: string[] }> {
    const q = (typeof query === 'string' ? query : '').trim();
    if (!q) throw new MarketDataError('BAD_REQUEST', 'Missing search query (q)');
    if (q.length > 64) throw new MarketDataError('BAD_REQUEST', 'Search query too long (max 64 chars)');
    const warnings: string[] = [];
    const out: SearchResult[] = [];
    const seen = new Set<string>();
    const push = (r: SearchResult) => {
      const k = (r.providerSymbols?.yahoo ?? r.id).toUpperCase();
      if (seen.has(k) || seen.has(r.id.toUpperCase())) return;
      seen.add(k);
      seen.add(r.id.toUpperCase());
      out.push(r);
    };

    const alias = findAlias(q);
    if (alias) {
      const inst = this.catalog.get(alias.toId);
      if (inst) push({ ...inst, origin: 'alias', renamedFrom: renameInfo(alias) });
    }
    const local = this.catalog.search(q, limit);
    for (const r of local) push(r);
    const nq = normalizeText(q);
    for (const c of this.custom.instruments) if (normalizeText(`${c.id} ${c.name}`).includes(nq)) push({ ...c, origin: 'catalog' });
    for (const t of searchTemplates(q)) push(t);

    const exactSymbol = local.some((r) => normalizeText(r.symbol) === nq);
    const tasks: Promise<void>[] = [];
    const guard = (label: string, p: Promise<SearchResult[]>) =>
      tasks.push(
        p.then(
          (rs) => void rs.forEach((r) => pending.push(r)),
          (e) => void warnings.push(`${label} search unavailable: ${errorMessage(e)}`),
        ),
      );
    const pending: SearchResult[] = [];
    guard(
      'provider',
      this.cache.getOrLoad(`search:yahoo:${q.toLowerCase()}`, TTL.SEARCH, () => this.yahoo.search(q, { limit: 15 })).then((r) => this.filterNoise(q, r.value)),
    );
    if (/tesouro|\bntn|\bltn|\blft|ipca\+|selic|prefixado|renda\+|educa\+/i.test(q)) {
      guard('tesouro', this.tesouro.searchTitles(q).then((rs) => rs.map((r) => ({ ...r, origin: 'tesouro' as const }))));
    }
    if (!exactSymbol && nq.length >= 4) {
      guard('fic', this.superfin.searchFic(q, 10).then((rs) => rs.map((r) => ({ ...r, origin: 'fic' as const }))));
      guard('afp', this.superfin.searchAfp(q, 10).then((rs) => rs.map((r) => ({ ...r, origin: 'afp' as const }))));
    }
    await Promise.all(tasks);
    const order = ['tesouro', 'fic', 'afp', 'yahoo'];
    const pref = opts.preferredCountries ?? ['CO', 'BR'];
    pending.sort((a, b) => {
      const oa = order.indexOf(a.origin) - order.indexOf(b.origin);
      if (oa) return oa;
      return Number(!pref.includes(a.country)) - Number(!pref.includes(b.country));
    });
    for (const r of pending) {
      const known = r.providerSymbols?.yahoo ? this.catalog.byYahooSymbol(r.providerSymbols.yahoo) : undefined;
      push(known ? { ...known, origin: 'catalog', providerType: r.providerType, exchangeLabel: r.exchangeLabel } : r);
    }
    return { results: out.slice(0, limit), ...(warnings.length ? { warnings } : {}) };
  }

  /** Drop provider results that share no word prefix with the query ('itau' -> ITA, 'isa' -> Visa). */
  private filterNoise(q: string, results: SearchResult[]): SearchResult[] {
    if (/^[A-Z]{2}[A-Z0-9]{9}\d$/i.test(q.trim())) return results; // ISIN: trust the provider
    const tokens = normalizeText(q).split(' ').filter((t) => t.length >= 2);
    if (!tokens.length) return results;
    return results.filter((r) => {
      const sym = normalizeText(r.providerSymbols?.yahoo ?? r.symbol).replace(/ /g, '');
      const words = normalizeText(r.name).split(' ');
      return tokens.every((t) => sym.startsWith(t) || words.some((w) => w.startsWith(t)));
    });
  }

  // -------------------------------------------------------------------------- quotes

  async quote(input: string): Promise<Quote> {
    const r = this.resolve(input);
    const renamedFrom = r.alias ? renameInfo(r.alias) : undefined;
    if (r.kind === 'market') {
      try {
        const { value: q } = await this.cache.getOrLoad(`quote:yahoo:${r.target.yahoo}`, this.quoteTtlMs, () => this.yahoo.quote(r.target));
        const inst = this.instrumentFor(r, { currency: q.currency, name: q.name, providerExchange: q.providerExchange, providerType: q.providerType });
        const { providerExchange: _pe, providerType: _pt, ...rest } = q;
        const stale = daysBetween(q.date, this.today()) > 7;
        return { ...rest, instrumentId: inst.id, requested: input, name: inst.name ?? q.name, ...(stale ? { stale } : {}), ...(renamedFrom ? { renamedFrom } : {}) };
      } catch (e) {
        if (e instanceof MarketDataError && e.code === 'BAD_REQUEST') throw e;
        // fall through to the last close of the provider chain
      }
    }
    const h = await this.history({ symbol: input, from: addDays(this.today(), -20) });
    const pts = h.series.points;
    const last = pts[pts.length - 1];
    if (!last) throw new MarketDataError('NOT_FOUND', `No recent price for ${input}`);
    const prev = pts[pts.length - 2];
    return {
      instrumentId: h.instrument.id,
      requested: input,
      providerSymbol: h.providerSymbol,
      name: h.instrument.name,
      currency: h.series.currency,
      price: last.close,
      ...(prev ? { previousClose: prev.close, change: last.close - prev.close, changePct: last.close / prev.close - 1 } : {}),
      date: last.date,
      time: `${last.date}T00:00:00.000Z`,
      ...(h.series.stale ? { stale: true } : {}),
      ...(renamedFrom ? { renamedFrom } : {}),
      source: h.series.source,
    };
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
    if (from > today) throw new MarketDataError('BAD_REQUEST', `"from" (${from}) is in the future (today is ${today})`);
    if (from > end) throw new MarketDataError('BAD_REQUEST', `"from" (${from}) is after "to" (${end})`);
    if (daysBetween(from, end) > this.maxRangeDays) throw new MarketDataError('BAD_REQUEST', 'Date range too long');
    return { from, to: end > today ? today : end };
  }

  private validateInterval(i: unknown): Interval {
    if (i === undefined || i === null || i === '') return '1d';
    if (i === '1d' || i === '1mo') return i;
    throw new MarketDataError('BAD_REQUEST', `Invalid interval "${String(i)}" (use 1d or 1mo)`);
  }

  /** As-traded Yahoo history assembled from per-year chunks (fetching only missing years). */
  async yahooChunked(symbol: string, from: ISODate, to: ISODate): Promise<ProviderHistory> {
    const today = this.today();
    const y0 = Number(from.slice(0, 4));
    const y1 = Number(to.slice(0, 4));
    const key = (y: number) => `hist:${YEAR_CHUNK_VERSION}:yahoo:${symbol}:${y}`;
    const chunks = new Map<number, ProviderHistory>();
    await Promise.all(
      Array.from({ length: y1 - y0 + 1 }, (_, i) => y0 + i).map(async (y) => {
        const c = await this.cache.get<ProviderHistory>(key(y));
        if (c) chunks.set(y, c);
      }),
    );
    // Fetch each contiguous run of missing years in one request.
    let y = y0;
    while (y <= y1) {
      if (chunks.has(y)) {
        y++;
        continue;
      }
      let yb = y;
      while (yb + 1 <= y1 && !chunks.has(yb + 1)) yb++;
      const gStart = `${y}-01-01`;
      const gEnd = `${yb}-12-31` < today ? `${yb}-12-31` : today;
      const h = await this.yahoo.dailyHistory(symbol, gStart, gEnd);
      for (let yy = y; yy <= yb; yy++) {
        const chunk = sliceHistory(h, `${yy}-01-01`, `${yy}-12-31`);
        const closedYear = `${yy}-12-31` < today;
        const ttl = h.degraded ? 5 * MINUTE : closedYear ? TTL.IMMUTABLE : historyTtlMs(gEnd, today);
        await this.cache.set(key(yy), chunk, ttl, { persist: !h.degraded });
        chunks.set(yy, chunk);
      }
      y = yb + 1;
    }
    const parts = [...chunks.entries()].sort((a, b) => a[0] - b[0]).map(([, c]) => c);
    const last = parts[parts.length - 1]!;
    const merged: ProviderHistory = {
      ...last,
      points: parts.flatMap((p) => p.points),
      dividends: parts.flatMap((p) => p.dividends),
      splits: parts.flatMap((p) => p.splits),
      notes: [...new Set(parts.flatMap((p) => p.notes))],
      ...(parts.some((p) => p.degraded) ? { degraded: [...new Set(parts.flatMap((p) => p.degraded ?? []))] } : {}),
    };
    return sliceHistory(merged, from, to);
  }

  private async marketDaily(r: Resolved, from: ISODate, to: ISODate): Promise<MarketResult> {
    const fallbacks: MarketResult['fallbacks'] = [];
    try {
      return { h: await this.yahooChunked(r.target.yahoo, from, to), fallbacks };
    } catch (e) {
      fallbacks.push({ source: 'yahoo', error: errorMessage(e) });
    }
    for (const p of this.fallbackProviders.filter((x) => x.supports(r.target))) {
      try {
        const ttl = Math.min(HOUR, historyTtlMs(to, this.today()));
        const { value: h } = await this.cache.getOrLoad(`hist:alt:${p.id}:${r.target.instrumentId}:${from}:${to}`, ttl, () => p.dailyHistory(r.target, from, to), {
          persist: false,
        });
        return { h: { ...h, notes: [...h.notes, `served by ${p.id} (fallback after: ${fallbacks.map((f) => f.source).join(', ')})`] }, fallbacks };
      } catch (e) {
        fallbacks.push({ source: String(p.id), error: errorMessage(e) });
      }
    }
    const notFound = fallbacks.every((f) => /not found|no prices|no data|delisted|unsupported/i.test(f.error));
    const suggest = this.catalog.search(r.target.symbol, 1)[0]?.id;
    throw new MarketDataError(notFound ? 'NOT_FOUND' : 'UPSTREAM_ERROR', `No price source could serve ${r.target.instrumentId}`, {
      fallbacks,
      ...(suggest && suggest !== r.target.instrumentId ? { suggest } : {}),
    });
  }

  private async otherDaily(r: Resolved, from: ISODate, to: ISODate): Promise<MarketResult> {
    const p = r.kind === 'tesouro' ? this.tesouro : r.kind === 'superfin' ? this.superfin : this.custom;
    const ttl = Math.min(r.kind === 'custom' ? HOUR : 6 * HOUR, historyTtlMs(to, this.today()));
    const { value: h } = await this.cache.getOrLoad(`hist:${p.id}:${r.target.instrumentId}:${from}:${to}`, ttl, () => p.dailyHistory(r.target, from, to));
    return { h, fallbacks: [] };
  }

  /** Prepend history of renamed tickers when the provider still has it under the old symbol. */
  private async stitchRenames(r: Resolved, h: ProviderHistory, from: ISODate, instId: string): Promise<{ h: ProviderHistory; actions: MarketCorporateAction[]; notes: string[] }> {
    const aliases = r.kind === 'market' ? aliasesTo(r.target.instrumentId) : [];
    const first = h.points[0]?.date;
    if (!aliases.length || (first && first <= addDays(from, 7))) return { h, actions: [], notes: [] };
    const notes: string[] = [];
    const actions: MarketCorporateAction[] = [];
    for (const a of aliases) {
      try {
        const end = first ? addDays(first, -1) : this.today();
        const old = await this.yahooChunked(a.fromYahoo, from, end);
        if (!old.points.length) continue;
        h = { ...h, points: [...old.points, ...h.points], dividends: [...old.dividends, ...h.dividends], splits: [...old.splits, ...h.splits] };
        const change = first ?? addDays(old.points[old.points.length - 1]!.date, 1);
        actions.push({
          instrumentId: a.fromId,
          date: a.effective ?? change,
          type: 'SPLIT',
          subtype: 'TICKER_CHANGE',
          ratio: a.ratio,
          targetInstrumentId: instId,
          source: 'catalog',
          note: a.note,
        });
        notes.push(`history before ${change} stitched from old ticker ${a.fromYahoo}`);
        break;
      } catch (e) {
        notes.push(`old ticker ${a.fromYahoo} has no data at the provider (${errorMessage(e).slice(0, 60)})`);
      }
    }
    return { h, actions, notes };
  }

  async history(req: HistoryRequest): Promise<HistoryResponse> {
    if (!req || typeof req !== 'object') throw new MarketDataError('BAD_REQUEST', 'History request must be an object {symbol, from, to?, interval?, adjust?}');
    const { from, to } = this.validateRange(req.from, req.to);
    const interval = this.validateInterval(req.interval);
    const adjust: PriceAdjustment = req.adjust ?? 'none';
    if (adjust !== 'none' && adjust !== 'splits' && adjust !== 'total') throw new MarketDataError('BAD_REQUEST', `Invalid adjust "${String(adjust)}" (none|splits|total)`);
    if (typeof req.symbol !== 'string') throw new MarketDataError('BAD_REQUEST', 'Missing "symbol"');
    const r = this.resolve(req.symbol);
    const asOf = this.now().toISOString();
    const { h: raw, fallbacks } = r.kind === 'market' ? await this.marketDaily(r, from, to) : await this.otherDaily(r, from, to);
    const inst = this.instrumentFor(r, raw);
    const stitched = await this.stitchRenames(r, raw, from, inst.id);
    const h = stitched.h;
    const notes = [...h.notes, ...stitched.notes];
    if (r.instrument && r.instrument.currency !== h.currency) notes.push(`catalog currency ${r.instrument.currency} differs from provider ${h.currency}; using provider`);

    // Corporate actions -----------------------------------------------------------------
    let dividends = h.dividends;
    if (r.kind === 'market' && r.target.exchange === 'BVMF' && dividends.length && this.brapi.supports(r.target)) {
      const br = await this.brapiDividends(r.target);
      if (br.ok) dividends = mergeBrapiDividends(dividends, br.data);
      else notes.push(`brapi dividend details unavailable: ${br.error.slice(0, 80)}`);
    }
    const actions: MarketCorporateAction[] = [
      ...dividends.map((d) => dividendAction(inst.id, d, h.source)),
      ...h.splits.map((s) =>
        classifySplit(h.providerSymbol, { date: s.date, numerator: s.numerator ?? Math.round(s.ratio * 1000), denominator: s.denominator ?? 1000 }, inst.id),
      ),
      ...stitched.actions,
    ].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

    // Adjustment ------------------------------------------------------------------------
    let points: MarketPricePoint[] = h.points;
    if (adjust === 'splits') {
      if (h.basis === 'as-traded') {
        const all = h.source === 'yahoo' ? await this.yahoo.splits(r.target.yahoo) : h.splits;
        points = points.map((p) => ({ date: p.date, close: roundTo(p.close / splitFactorAfter(all, p.date), 8) }));
      }
    } else if (adjust === 'total') {
      points = totalReturn(points, actions);
      notes.push('total-return index: dividends reinvested at the ex-date close (price units of the first close)');
    }
    if (interval === '1mo') points = toMonthEnd(points);

    // Freshness ---------------------------------------------------------------------------
    const today = this.today();
    const nowS = this.now().getTime() / 1000;
    const open = !!h.session && nowS >= h.session.start && nowS < h.session.end;
    const last = points[points.length - 1];
    if (last) {
      const intradayLast = open && last.date === h.lastTradeDate && last.date === today;
      const currentMonth = interval === '1mo' && last.date.slice(0, 7) === today.slice(0, 7);
      if (intradayLast || currentMonth) points = [...points.slice(0, -1), { ...last, provisional: true }];
    }
    const lastTradeDate = h.lastTradeDate;
    const stale = !!lastTradeDate && daysBetween(lastTradeDate, today) > 7;
    if (stale) notes.push(`no trades since ${lastTradeDate}: instrument suspended, delisted or illiquid`);
    if (h.basis === 'split-adjusted' && adjust === 'none') notes.push('closes from a split-adjusted source: not guaranteed as traded');

    const renamedFrom = r.alias ? renameInfo(r.alias) : undefined;
    return {
      requested: req.symbol,
      providerSymbol: h.providerSymbol || r.target.instrumentId,
      instrument: inst,
      interval,
      series: {
        instrumentId: inst.id,
        currency: h.currency,
        points,
        source: h.source,
        ...(lastTradeDate ? { lastTradeDate } : {}),
        ...(stale ? { stale } : {}),
      },
      actions,
      ...(fallbacks.length ? { fallbacks } : {}),
      ...(h.degraded?.length ? { degraded: true } : {}),
      asOf,
      ...(h.session ? { marketState: open ? ('open' as const) : ('closed' as const) } : {}),
      ...(renamedFrom ? { renamedFrom } : {}),
      ...(notes.length ? { notes: [...new Set(notes)] } : {}),
    };
  }

  /** brapi dividend details (JCP vs dividend, pay date), cached 1 day; failures cached 1 hour. */
  private async brapiDividends(t: PriceTarget): Promise<{ ok: true; data: DividendEvent[] } | { ok: false; error: string }> {
    const { value } = await this.cache.getOrLoad(
      `brapi:divs:${t.symbol}`,
      (v: { ok: boolean }) => (v.ok ? DAY : HOUR),
      async () => {
        try {
          return { ok: true as const, data: await this.brapi.dividends(t, '2000-01-01') };
        } catch (e) {
          return { ok: false as const, error: errorMessage(e) };
        }
      },
    );
    return value;
  }

  /** Drop cached data for a symbol (all years, quotes, fallbacks). */
  async invalidate(symbol: string): Promise<{ removed: number }> {
    const r = this.resolve(symbol);
    let removed = 0;
    for (const prefix of [`hist:${YEAR_CHUNK_VERSION}:yahoo:${r.target.yahoo}:`, `quote:yahoo:${r.target.yahoo}`, `yahoo:splits:${r.target.yahoo}`, `hist:alt:`]) {
      if (prefix === 'hist:alt:') {
        for (const p of this.fallbackProviders) {
          const x = await this.cache.deletePrefix(`hist:alt:${p.id}:${r.target.instrumentId}:`);
          removed += x.memory + x.store;
        }
        continue;
      }
      const x = await this.cache.deletePrefix(prefix);
      removed += x.memory + x.store;
    }
    return { removed };
  }

  // -------------------------------------------------------------------------- FX / indices

  async fxSeries(req: FxRequest): Promise<FxResponse> {
    if (!req || typeof req !== 'object') throw new MarketDataError('BAD_REQUEST', 'FX request must be an object {base, quote, from, ...}');
    const base = String(req.base ?? '').toUpperCase();
    const quote = String(req.quote ?? '').toUpperCase();
    if (!/^[A-Z]{3,5}$/.test(base) || !/^[A-Z]{3,5}$/.test(quote)) {
      throw new MarketDataError('BAD_REQUEST', `Invalid currency pair "${req.base}/${req.quote}" (ISO 4217 codes or crypto tickers, e.g. base=USD&quote=COP)`);
    }
    const { from, to } = this.validateRange(req.from, req.to);
    const interval = this.validateInterval(req.interval);
    const mode = req.source ?? 'auto';
    if (mode !== 'auto' && mode !== 'official' && mode !== 'yahoo') {
      throw new MarketDataError('BAD_REQUEST', `Invalid source "${String(mode)}" (auto|official|yahoo)`);
    }
    const side = req.side ?? 'sell';
    if (side !== 'buy' && side !== 'sell') throw new MarketDataError('BAD_REQUEST', `Invalid side "${String(side)}" (buy|sell)`);
    const r = await this.fx.daily(base, quote, from, to, mode, side);
    const series: FxSeries = { base, quote, points: interval === '1mo' ? toMonthEnd(r.points) : r.points, source: r.source };
    return { series, interval, ...(side === 'buy' ? { side } : {}), ...(r.fallbacks.length ? { fallbacks: r.fallbacks } : {}) };
  }

  async index(req: IndexRequest): Promise<IndexResponse> {
    if (!req || typeof req !== 'object' || typeof req.id !== 'string' || !req.id) {
      throw new MarketDataError('BAD_REQUEST', `Index request must be {id, from, to?}; ids: ${INDEX_IDS.join(', ')}`);
    }
    const { from, to } = this.validateRange(req.from, req.to);
    return this.indices.get(req.id, from, to);
  }

  // -------------------------------------------------------------------------- batch

  private checkBatchSize(n: number, what: string): void {
    if (n > this.maxBatch) throw new MarketDataError('BAD_REQUEST', `Too many ${what} in one request (max ${this.maxBatch})`);
  }

  /** Rough number of points a batch would return (to refuse amplification before fetching). */
  estimatePoints(req: BatchRequest): number {
    const today = this.today();
    const span = (r: { from?: unknown; to?: unknown; interval?: unknown }) => {
      const f = isISODate(r?.from) ? r.from : today;
      const t = isISODate(r?.to) ? r.to : today;
      const d = Math.max(1, daysBetween(f, t) + 1);
      return r?.interval === '1mo' ? Math.ceil(d / 30) : d;
    };
    return [...(req.histories ?? []), ...(req.fx ?? []), ...(req.indices ?? [])].reduce((s, r) => s + span(r as never), 0) + (req.quotes?.length ?? 0);
  }

  async batch(req: BatchRequest): Promise<BatchResponse> {
    const started = Date.now();
    if (!req || typeof req !== 'object' || Array.isArray(req)) throw new MarketDataError('BAD_REQUEST', 'Batch body must be a JSON object');
    const histories = req.histories ?? [];
    const fx = req.fx ?? [];
    const quotes = req.quotes ?? [];
    const indices = req.indices ?? [];
    if (![histories, fx, quotes, indices].every(Array.isArray)) {
      throw new MarketDataError('BAD_REQUEST', 'histories, fx, quotes and indices must be arrays');
    }
    this.checkBatchSize(histories.length + fx.length + quotes.length + indices.length, 'items');
    const pts = this.estimatePoints({ histories, fx, quotes, indices });
    if (pts > this.maxBatchPoints) {
      throw new MarketDataError('BAD_REQUEST', `Batch too large: ~${pts} points (max ${this.maxBatchPoints}). Use interval=1mo or shorter ranges.`);
    }
    const objectOr = <T>(x: unknown, what: string, fn: () => Promise<T>) =>
      settle(() => {
        if (!x || typeof x !== 'object' || Array.isArray(x)) throw new MarketDataError('BAD_REQUEST', `Each ${what} item must be an object`);
        return fn();
      });
    const [h, f, q, i] = await Promise.all([
      Promise.all(histories.map((r) => objectOr(r, 'histories', () => this.history(r)))),
      Promise.all(fx.map((r) => objectOr(r, 'fx', () => this.fxSeries(r)))),
      Promise.all(
        quotes.map((s) =>
          settle(() => {
            if (typeof s !== 'string') throw new MarketDataError('BAD_REQUEST', 'Each quotes item must be a string id or symbol');
            return this.quote(s);
          }),
        ),
      ),
      Promise.all(indices.map((r) => objectOr(r, 'indices', () => this.index(r)))),
    ]);
    return { histories: h, fx: f, quotes: q, indices: i, tookMs: Date.now() - started };
  }
}

// ---------------------------------------------------------------------------- helpers

function roundTo(x: number, d: number): number {
  const f = 10 ** d;
  return Math.round(x * f) / f;
}

export function sliceHistory(h: ProviderHistory, from: ISODate, to: ISODate): ProviderHistory {
  const inR = (d: ISODate) => d >= from && d <= to;
  return { ...h, points: h.points.filter((p) => inR(p.date)), dividends: h.dividends.filter((d) => inR(d.date)), splits: h.splits.filter((s) => inR(s.date)) };
}

function dividendAction(instrumentId: string, d: DividendEvent, source: string): MarketCorporateAction {
  return {
    instrumentId,
    date: d.date,
    type: 'DIVIDEND',
    amountPerShare: d.amount,
    exDate: d.date,
    ...(d.payDate ? { payDate: d.payDate } : {}),
    ...(d.kind ? { subtype: d.kind } : {}),
    ...(d.currency ? { currency: d.currency } : {}),
    source,
  };
}

/**
 * Itemize Yahoo dividends with brapi's events (JCP vs dividend, payment date). A Yahoo dividend
 * is replaced by the brapi events whose ex-date is within 3 days of it (dated on Yahoo's
 * ex-date); unmatched Yahoo dividends are kept and unmatched brapi events ignored (Yahoo stays
 * authoritative for ex-dates, avoiding duplicates).
 */
export function mergeBrapiDividends(yahoo: DividendEvent[], brapi: DividendEvent[]): DividendEvent[] {
  const out: DividendEvent[] = [];
  const used = new Set<DividendEvent>();
  for (const y of yahoo) {
    const matches = brapi.filter((b) => !used.has(b) && Math.abs(daysBetween(y.date, b.date)) <= 3);
    if (!matches.length) {
      out.push(y);
      continue;
    }
    for (const m of matches) {
      used.add(m);
      out.push({ ...m, date: y.date });
    }
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/**
 * Total-return index from as-traded closes: on each ex-date the holder reinvests dividends and
 * receives split / bonificação / spin-off value (price factor), so
 * TR_t = TR_{t-1} * (close_t * factor_t + dividend_t) / close_{t-1}.
 */
export function totalReturn(points: readonly MarketPricePoint[], actions: readonly MarketCorporateAction[]): MarketPricePoint[] {
  if (!points.length) return [];
  const factor = new Map<ISODate, number>();
  const divs = new Map<ISODate, number>();
  const nextPointDate = (d: ISODate) => points.find((p) => p.date >= d)?.date;
  for (const a of actions) {
    const at = nextPointDate(a.date);
    if (!at) continue;
    if (a.type === 'DIVIDEND') {
      if (a.currency || !a.amountPerShare) continue;
      divs.set(at, (divs.get(at) ?? 0) + a.amountPerShare);
    } else if (a.subtype !== 'TICKER_CHANGE') {
      const f = a.priceFactor ?? a.ratio ?? 1;
      factor.set(at, (factor.get(at) ?? 1) * f);
    }
  }
  const out: MarketPricePoint[] = [{ date: points[0]!.date, close: points[0]!.close }];
  for (let i = 1; i < points.length; i++) {
    const p = points[i]!;
    const prev = points[i - 1]!;
    const tr = out[i - 1]!.close * ((p.close * (factor.get(p.date) ?? 1) + (divs.get(p.date) ?? 0)) / prev.close);
    out.push({ date: p.date, close: roundTo(tr, 6) });
  }
  return out;
}

export function toErrorBody(e: unknown): ApiErrorBody['error'] {
  if (e instanceof MarketDataError) {
    return { code: e.code, message: e.message, ...(e.details !== undefined ? { details: e.details } : {}) };
  }
  // Never leak internal JavaScript errors verbatim.
  return { code: 'INTERNAL', message: 'Internal error' };
}

async function settle<T>(fn: () => Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (e) {
    return { ok: false, error: toErrorBody(e) };
  }
}

