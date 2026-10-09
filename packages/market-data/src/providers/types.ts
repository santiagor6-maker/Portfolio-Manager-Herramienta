import type { CurrencyCode, FxPoint, ISODate, PricePoint, ProviderId } from '@pm/core';
import type { Quote, SearchResult } from '../types';

export interface DividendEvent {
  /** Ex-date. */
  date: ISODate;
  amount: number;
  payDate?: ISODate;
  /** 'JCP' (juros sobre capital próprio), 'ORDINARY', or 'COUPON' (bond interest, e.g. Tesouro NTN-B/NTN-F). */
  kind?: 'JCP' | 'ORDINARY' | 'COUPON';
  /** Set when the amount is NOT in the instrument currency (e.g. VUSA.L pays USD, quotes GBP). */
  currency?: CurrencyCode;
  /** Estimated or unknown amount: confirm before booking. */
  reviewRequired?: boolean;
  note?: string;
}

export interface SplitEvent {
  date: ISODate;
  /** Price/share factor (numerator / denominator). */
  ratio: number;
  numerator?: number;
  denominator?: number;
}

/** What a price provider's closes are. Only 'as-traded' data is cached as immutable. */
export type PriceBasis = 'as-traded' | 'split-adjusted';

export interface ProviderHistory {
  providerSymbol: string;
  /** ISO currency after minor-unit normalization (GBp -> GBP). */
  currency: CurrencyCode;
  name?: string;
  /** Provider exchange code (Yahoo `exchangeName`, e.g. SAO, BVC, NMS). */
  providerExchange?: string;
  /** Provider instrument type (EQUITY, ETF, INDEX, CURRENCY...). */
  providerType?: string;
  timeZone?: string;
  /** Daily closes sorted ascending. */
  points: PricePoint[];
  dividends: DividendEvent[];
  splits: SplitEvent[];
  notes: string[];
  basis: PriceBasis;
  /** Local date of the last real trade (phantom bars after it are removed). */
  lastTradeDate?: ISODate;
  /** Local date of the first trade the provider has (Yahoo `firstTradeDate`). */
  firstTradeDate?: ISODate;
  /** Regular session of the latest trading day (epoch seconds), for provisional detection. */
  session?: { start: number; end: number };
  /** Dates whose bar had no close and could not be completed (holidays or not-yet-final days). */
  missingCloseDates?: ISODate[];
  /** Reasons the data is incomplete; degraded data is never cached long. */
  degraded?: string[];
  source: ProviderId;
}

export type ProviderQuote = Omit<Quote, 'instrumentId' | 'requested'> & {
  providerExchange?: string;
  providerType?: string;
};

/** What a price provider is asked to price. */
export interface PriceTarget {
  /** Our instrument id, e.g. BVMF:PETR4. */
  instrumentId: string;
  /** MIC / pseudo exchange (XNAS, BVMF, INDEX, CRYPTO, YAHOO...). */
  exchange: string;
  /** Local symbol (PETR4, AAPL, BTC-USD). */
  symbol: string;
  /** Yahoo symbol (PETR4.SA) — the lingua franca for mapping to other providers. */
  yahoo: string;
  currency?: CurrencyCode;
}

/** A source of security prices behind a common interface (Yahoo, brapi, stooq, keyed APIs, custom feeds). */
export interface PriceProvider {
  readonly id: ProviderId;
  /** Whether this provider can price the target (exchange coverage, API key present...). */
  supports(target: PriceTarget): boolean;
  /** Daily closes in [from, to] (inclusive, exchange-local dates). */
  dailyHistory(target: PriceTarget, from: ISODate, to: ISODate): Promise<ProviderHistory>;
  quote?(target: PriceTarget): Promise<ProviderQuote>;
  search?(query: string, opts?: { limit?: number }): Promise<SearchResult[]>;
}

/** A source of FX rates. `daily` returns units of `quote` per 1 `base`, sorted ascending. */
export interface FxProvider {
  readonly id: ProviderId;
  /** True if this provider publishes the pair (directly or inverted). */
  supports(base: CurrencyCode, quote: CurrencyCode): boolean;
  /** Official central-bank / government source (vs. market data such as Yahoo). */
  readonly official: boolean;
  daily(base: CurrencyCode, quote: CurrencyCode, from: ISODate, to: ISODate, opts?: { side?: 'buy' | 'sell' }): Promise<FxPoint[]>;
}
