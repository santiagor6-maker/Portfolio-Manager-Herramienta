/** Test helpers (not exported from the package). */
import type { EngineInput, EngineOptions } from '../api';
import { createMarketData } from '../api';
import type { CostMethod, CurrencyCode, FxSeries, Instrument, PriceSeries, Transaction } from '../types';

let seq = 0;

export function tx(t: Omit<Transaction, 'id' | 'portfolioId'> & { id?: string }): Transaction {
  seq += 1;
  return { id: t.id ?? `t${seq}`, portfolioId: 'p1', ...t };
}

export function inst(id: string, currency: CurrencyCode, extra: Partial<Instrument> = {}): Instrument {
  const [exchange, symbol] = id.includes(':') ? (id.split(':') as [string, string]) : ['MANUAL', id];
  return { id, symbol, name: symbol, exchange, currency, country: extra.country ?? 'US', assetClass: 'equity', ...extra };
}

export function prices(instrumentId: string, currency: CurrencyCode, points: Record<string, number>): PriceSeries {
  return {
    instrumentId,
    currency,
    source: 'test',
    points: Object.entries(points)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([date, close]) => ({ date, close })),
  };
}

export function fxs(base: CurrencyCode, quote: CurrencyCode, points: Record<string, number>): FxSeries {
  return {
    base,
    quote,
    source: 'test',
    points: Object.entries(points)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([date, rate]) => ({ date, rate })),
  };
}

export function engine(opts: {
  base: CurrencyCode;
  transactions: Transaction[];
  instruments: Instrument[];
  prices?: PriceSeries[];
  fx?: FxSeries[];
  costMethod?: CostMethod;
  options?: EngineOptions;
  reportIn?: CurrencyCode;
  benchmarks?: string[];
}): EngineInput {
  return {
    portfolio: {
      id: 'p1',
      name: 'Test',
      baseCurrency: opts.base,
      costMethod: opts.costMethod ?? 'FIFO',
      createdAt: '2020-01-01',
      benchmarks: opts.benchmarks,
    },
    transactions: opts.transactions,
    instruments: opts.instruments,
    market: createMarketData({ prices: opts.prices ?? [], fx: opts.fx ?? [] }),
    baseCurrency: opts.reportIn,
    options: opts.options,
  };
}

/** Sum helper. */
export const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
