/**
 * Public types of @pm/market-data and of the HTTP API exposed by apps/server.
 *
 * Browser-safe: no Node imports. Shared by the server (producer) and `client.ts` (consumer).
 */
import type {
  CorporateAction,
  CurrencyCode,
  FxSeries,
  Instrument,
  ISODate,
  PriceSeries,
  ProviderId,
} from '@pm/core';

export type Interval = '1d' | '1mo';

/**
 * - `auto`: official source for the pair if there is one (TRM, PTAX, ECB), Yahoo as fallback.
 * - `official`: official sources only (error if the pair has none / it fails).
 * - `yahoo`: Yahoo only.
 */
export type FxSourceMode = 'auto' | 'official' | 'yahoo';

/**
 * How prices are adjusted.
 * - `none` (default): as-traded closes. Yahoo split-adjusts history retroactively; we undo that,
 *   so a close never changes after the fact (closed months are immutable and cacheable forever),
 *   and it matches the quantities in the user's transactions (splits are SPLIT transactions).
 * - `splits`: split-adjusted closes (Yahoo's `close`), handy for charts of long histories.
 */
export type PriceAdjustment = 'none' | 'splits';

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
  source: ProviderId;
}

export interface HistoryRequest {
  /** Instrument id (`BVMF:PETR4`) or provider symbol (`PETR4.SA`). */
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
  series: PriceSeries;
  /** Dividends and splits in [from, to]. Amounts in instrument currency, as paid (not split-adjusted unless adjust=splits). */
  actions: CorporateAction[];
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
}

export interface FxResponse {
  series: FxSeries;
  interval: Interval;
  /** Sources that were tried and failed before the one that answered. */
  fallbacks?: { source: ProviderId; error: string }[];
}

export interface SearchResult extends Instrument {
  /** Where the result came from: curated catalog and/or provider search. */
  origin: 'catalog' | 'yahoo';
  /** Yahoo quoteType / typeDisp, e.g. EQUITY, ETF, INDEX. */
  providerType?: string;
  /** Free-text exchange label from the provider (e.g. 'São Paulo'). */
  exchangeLabel?: string;
}

export interface Benchmark {
  id: string;
  name: string;
  instrumentId: string;
  currency: CurrencyCode;
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
}

export type Settled<T> = { ok: true; data: T } | { ok: false; error: ApiErrorBody['error'] };

export interface BatchResponse {
  histories: Settled<HistoryResponse>[];
  fx: Settled<FxResponse>[];
  quotes: Settled<Quote>[];
  tookMs: number;
}

export interface HealthResponse {
  ok: boolean;
  service: string;
  version: string;
  time: string;
  cache?: { memoryEntries: number; persistent: boolean };
}

export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}
