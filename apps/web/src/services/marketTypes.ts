/**
 * Mirror of the subset of `@pm/market-data` HTTP types the web app uses.
 * Kept local so the web app compiles independently of that package's export surface.
 */
import type { CorporateAction, CurrencyCode, FxSeries, Instrument, ISODate, PriceSeries, ProviderId } from '@pm/core';

export interface Quote {
  instrumentId: string;
  requested: string;
  providerSymbol: string;
  name?: string;
  exchange?: string;
  currency: CurrencyCode;
  price: number;
  previousClose?: number;
  change?: number;
  changePct?: number;
  date: ISODate;
  time: string;
  source: ProviderId;
}

export interface HistoryRequest {
  symbol: string;
  from: ISODate;
  to?: ISODate;
  interval?: '1d' | '1mo';
  adjust?: 'none' | 'splits';
}

export interface HistoryResponse {
  requested: string;
  providerSymbol: string;
  instrument: Instrument;
  interval: '1d' | '1mo';
  series: PriceSeries;
  actions: CorporateAction[];
  notes?: string[];
}

export interface FxRequest {
  base: CurrencyCode;
  quote: CurrencyCode;
  from: ISODate;
  to?: ISODate;
  interval?: '1d' | '1mo';
  source?: 'auto' | 'official' | 'yahoo';
}

export interface FxResponse {
  series: FxSeries;
  interval: '1d' | '1mo';
  fallbacks?: { source: ProviderId; error: string }[];
}

export interface SearchResult extends Instrument {
  origin: 'catalog' | 'yahoo';
  providerType?: string;
  exchangeLabel?: string;
}

export interface BatchRequest {
  histories?: HistoryRequest[];
  fx?: FxRequest[];
  quotes?: string[];
}

export type Settled<T> = { ok: true; data: T } | { ok: false; error: { code: string; message: string } };

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
}
