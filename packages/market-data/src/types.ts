/**
 * Public types of @pm/market-data and of the HTTP API exposed by apps/server.
 *
 * Browser-safe: no Node imports. Shared by the server (producer) and `client.ts` (consumer).
 */
import type {
  CorporateAction,
  CurrencyCode,
  FxSeries,
  IndexId,
  IndexSeries,
  Instrument,
  ISODate,
  PricePoint,
  PriceSeries,
  ProviderId,
} from '@pm/core';

export type Interval = '1d' | '1mo';

/**
 * - `auto`: official source for the pair if there is one (TRM, PTAX, ECB), Yahoo as fallback.
 * - `official`: official sources only (error if the pair has none / it fails).
 * - `yahoo`: Yahoo only (crypto pairs: Yahoo, then CoinGecko).
 */
export type FxSourceMode = 'auto' | 'official' | 'yahoo';

/** PTAX side: 'sell' (venda, default; contracts, most tax uses) or 'buy' (compra). */
export type FxSide = 'buy' | 'sell';

/**
 * How prices are adjusted.
 * - `none` (default): as-traded closes. Yahoo split-adjusts history retroactively; we undo that,
 *   so a close never changes after the fact and matches the quantities in the user's transactions.
 * - `splits`: split-adjusted closes (Yahoo's `close`), handy for charts of long histories.
 * - `total`: total-return index in price units (dividends reinvested at the ex-date close),
 *   starting at the first as-traded close. Use it for ETF-proxy benchmarks (ICOLCAP, URTH).
 */
export type PriceAdjustment = 'none' | 'splits' | 'total';

/** A price point with market-data extras. `provisional` = intraday / incomplete period. */
export interface MarketPricePoint extends PricePoint {
  provisional?: boolean;
  /**
   * The last real trade BEFORE the requested `from`, prepended when the window starts without a
   * trade (illiquid stocks, holidays), so a valuation at `from` has a price (review R4, M32).
   * Its date is outside the requested range.
   */
  carried?: boolean;
}

/** PriceSeries (core contract) plus freshness information. */
export interface MarketPriceSeries extends PriceSeries {
  points: MarketPricePoint[];
  /** Last date with a real trade (bars after it with no volume are dropped as phantom closes). */
  lastTradeDate?: ISODate;
  /** True when the last trade is older than 7 days (suspended, delisted or very illiquid). */
  stale?: boolean;
  /**
   * Set when the source covers only part of the requested range (review R4, M34): the local
   * snapshot has only the years this server recorded. `coverageFrom`/`coverageTo` are the first
   * and last dates the source actually has.
   */
  partial?: boolean;
  coverageFrom?: ISODate;
  coverageTo?: ISODate;
}

/**
 * Core CorporateAction (DIVIDEND | SPLIT | STOCK_DIVIDEND with subtype, exDate/payDate, currency,
 * targetInstrumentId, costFraction, reviewRequired, source, note) plus the provider price factor.
 */
export type MarketCorporateAction = CorporateAction & {
  /** Price factor the provider applied for this event (Yahoo numerator/denominator). */
  priceFactor?: number;
};

export interface RenameInfo {
  /**
   * 'rename': same company/security under a new ticker (history continues, 1:1).
   * 'merger' / 'conversion': the old security ceased to exist and holders received `ratio` new
   * shares (+ `cashPerShare`). The new ticker's history is NOT the old company's history.
   */
  kind: 'rename' | 'merger' | 'conversion';
  /** Old instrument id, e.g. XBOG:PFBCOLOM. */
  fromId: string;
  /** New instrument id, e.g. XBOG:PFCIBEST. */
  toId: string;
  /** New shares per old share. */
  ratio: number;
  /** First day of trading under the new ticker / of holding the new shares. */
  effective?: ISODate;
  /** Last trading day of the old ticker. */
  lastTradingDay?: ISODate;
  /** Cash paid per old share (Copel PNB conversion: R$0.7749). */
  cashPerShare?: number;
  cashPayDate?: ISODate;
  note?: string;
}

export interface Quote {
  /** Instrument id `${exchange}:${symbol}`. */
  instrumentId: string;
  /** What the caller asked for (id or provider symbol). */
  requested: string;
  /** Provider symbol actually queried, e.g. `PETR4.SA`. */
  providerSymbol: string;
  name?: string;
  exchange?: string;
  currency: CurrencyCode;
  price: number;
  previousClose?: number;
  change?: number;
  /** Decimal change, 0.012 = +1.2%. */
  changePct?: number;
  /** Local trading date of `price` in the exchange time zone. */
  date: ISODate;
  /** ISO-8601 timestamp of `price`. */
  time: string;
  /** True when the last price is older than 7 days (suspended, delisted or illiquid). */
  stale?: boolean;
  /** 'open' while the regular session is running (price is intraday), else 'closed'. */
  marketState?: 'open' | 'closed';
  renamedFrom?: RenameInfo;
  source: ProviderId;
}

export interface HistoryRequest {
  /** Instrument id (`BVMF:PETR4`), provider symbol (`PETR4.SA`), ISIN or benchmark id. */
  symbol: string;
  from: ISODate;
  /** Defaults to today. */
  to?: ISODate;
  /** `1mo` = month-end series built from daily closes (last trading day of each month). */
  interval?: Interval;
  adjust?: PriceAdjustment;
}

export interface HistoryResponse {
  /** Echo of the request symbol. */
  requested: string;
  providerSymbol: string;
  instrument: Instrument;
  interval: Interval;
  series: MarketPriceSeries;
  /** Dividends, splits, bonificações, spin-offs and ticker changes in [from, to]. */
  actions: MarketCorporateAction[];
  /** Provider chain failures before `series.source` answered. */
  fallbacks?: { source: string; error: string }[];
  /** True when the data is known to be incomplete (e.g. split history unavailable). Never cached long. */
  degraded?: boolean;
  /** When the data was obtained (ISO timestamp). */
  asOf: string;
  /** 'open' while the instrument's regular session is running: the last point is intraday. */
  marketState?: 'open' | 'closed';
  renamedFrom?: RenameInfo;
  /** Set when the requested security no longer trades (merger / conversion): see actions MERGER. */
  delisted?: RenameInfo;
  /** Diagnostic notes, e.g. 'currency GBp normalized to GBP'. */
  notes?: string[];
}

export interface FxRequest {
  base: CurrencyCode;
  quote: CurrencyCode;
  from: ISODate;
  to?: ISODate;
  interval?: Interval;
  source?: FxSourceMode;
  /** PTAX side for BRL pairs (default 'sell'). */
  side?: FxSide;
}

export interface FxResponse {
  series: FxSeries;
  interval: Interval;
  side?: FxSide;
  /** Sources that were tried and failed before the one that answered. */
  fallbacks?: { source: ProviderId; error: string }[];
}

/** Rate / inflation index request (`/api/index`). */
export interface IndexRequest {
  id: IndexId;
  from: ISODate;
  to?: ISODate;
}

export interface IndexInfo {
  id: IndexId;
  name: string;
  country: string;
  description: string;
  /** How the series is obtained (dataset / series code). */
  sourceDetail: string;
  frequency: 'daily' | 'monthly';
}

/** `series` follows core's IndexSeries exactly; `info` documents it. */
export interface IndexResponse {
  series: IndexSeries;
  info: IndexInfo;
  /** Last observation date available from the source. */
  lastObservation?: ISODate;
  /** True when every source failed and cached observations are served. */
  stale?: boolean;
  /** Sources that failed before the answer. */
  fallbacks?: { source: string; error: string }[];
  notes?: string[];
}

export type SearchOrigin = 'catalog' | 'yahoo' | 'tesouro' | 'fic' | 'afp' | 'template' | 'crypto' | 'alias';

export interface SearchResult extends Instrument {
  /** Where the result came from. */
  origin: SearchOrigin;
  /** Provider quoteType / typeDisp, e.g. EQUITY, ETF, INDEX. */
  providerType?: string;
  /** Free-text exchange label from the provider (e.g. 'São Paulo'). */
  exchangeLabel?: string;
  renamedFrom?: RenameInfo;
  /** Template instruments (CDT, CDB...) are to be cloned by the user, not traded as-is. */
  template?: boolean;
  note?: string;
}

export interface Benchmark {
  id: string;
  name: string;
  instrumentId: string;
  currency: CurrencyCode;
  /** Suggested price adjustment for comparisons ('total' for ETF proxies). */
  adjust?: PriceAdjustment;
  note?: string;
}

export interface Catalog {
  version: string;
  updated: ISODate;
  instruments: Instrument[];
  benchmarks: Benchmark[];
}

export interface BatchRequest {
  histories?: HistoryRequest[];
  fx?: FxRequest[];
  quotes?: string[];
  indices?: IndexRequest[];
}

export type Settled<T> = { ok: true; data: T } | { ok: false; error: ApiErrorBody['error'] };

export interface BatchResponse {
  histories: Settled<HistoryResponse>[];
  fx: Settled<FxResponse>[];
  quotes: Settled<Quote>[];
  indices: Settled<IndexResponse>[];
  tookMs: number;
}

export interface HealthResponse {
  ok: boolean;
  service: string;
  version: string;
  time: string;
  cache?: { memoryEntries: number; persistent: boolean };
  providers?: { prices: string[]; fx: string[]; indices: string[] };
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}
