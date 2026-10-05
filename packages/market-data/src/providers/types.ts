import type { CurrencyCode, FxPoint, ISODate, PricePoint, ProviderId } from '@pm/core';
import type { PriceAdjustment, Quote, SearchResult } from '../types';

export interface DividendEvent {
  date: ISODate;
  amount: number;
}

export interface SplitEvent {
  date: ISODate;
  /** New shares per old share (2 = 2-for-1; 0.1 = 1-for-10 reverse split). */
  ratio: number;
}

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
}

export type ProviderQuote = Omit<Quote, 'instrumentId' | 'requested'> & {
  providerExchange?: string;
  providerType?: string;
};

/** A source of security prices (Yahoo today; others can be added behind the same interface). */
export interface PriceProvider {
  readonly id: ProviderId;
  search(query: string, opts?: { limit?: number }): Promise<SearchResult[]>;
  quote(symbol: string): Promise<ProviderQuote>;
  /** Daily closes in [from, to] (inclusive, exchange-local dates). */
  dailyHistory(symbol: string, from: ISODate, to: ISODate, opts?: { adjust?: PriceAdjustment }): Promise<ProviderHistory>;
}

/** A source of FX rates. `daily` returns units of `quote` per 1 `base`, sorted ascending. */
export interface FxProvider {
  readonly id: ProviderId;
  /** True if this provider publishes the pair (directly or inverted). */
  supports(base: CurrencyCode, quote: CurrencyCode): boolean;
  /** Official central-bank / government source (vs. market data such as Yahoo). */
  readonly official: boolean;
  daily(base: CurrencyCode, quote: CurrencyCode, from: ISODate, to: ISODate): Promise<FxPoint[]>;
}
