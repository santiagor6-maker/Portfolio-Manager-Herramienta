import { indexName } from './indexNames';
import type { Instrument } from '@pm/core';

/**
 * Benchmarks offered for comparison. Ids match the @pm/market-data catalog (`benchmarks[]`),
 * prices come from the market-data server. COLCAP and MSCI World use ETF proxies because Yahoo
 * does not publish those index histories.
 */
export const BENCHMARKS: Instrument[] = [
  {
    id: 'XBOG:ICOLCAP',
    symbol: 'ICOLCAP',
    name: 'COLCAP (ICOLCAP)',
    exchange: 'XBOG',
    currency: 'COP',
    country: 'CO',
    assetClass: 'etf',
    sector: 'Diversificado',
    providerSymbols: { yahoo: 'ICOLCAP.CL' },
  },
  {
    id: 'INDEX:^BVSP',
    symbol: 'IBOV',
    name: 'Ibovespa',
    exchange: 'INDEX',
    currency: 'BRL',
    country: 'BR',
    assetClass: 'other',
    providerSymbols: { yahoo: '^BVSP' },
  },
  {
    id: 'INDEX:^GSPC',
    symbol: 'SPX',
    name: 'S&P 500',
    exchange: 'INDEX',
    currency: 'USD',
    country: 'US',
    assetClass: 'other',
    providerSymbols: { yahoo: '^GSPC' },
  },
  {
    id: 'ARCX:URTH',
    symbol: 'URTH',
    name: 'MSCI World (URTH)',
    exchange: 'ARCX',
    currency: 'USD',
    country: 'US',
    assetClass: 'etf',
    sector: 'Diversificado',
    providerSymbols: { yahoo: 'URTH' },
  },
];

export const BENCHMARK_IDS = BENCHMARKS.map((b) => b.id);

export function benchmarkName(id: string): string {
  return BENCHMARKS.find((b) => b.id === id)?.name ?? indexName(id.replace(/^INDEX:\^?/, ''));
}

/** W32: the benchmark that matches the reporting currency comes first (BRL → Ibovespa, COP → COLCAP). */
export const HOME_BENCHMARK: Record<string, string> = { COP: 'XBOG:ICOLCAP', BRL: 'INDEX:^BVSP', USD: 'INDEX:^GSPC', EUR: 'ARCX:URTH' };

export function orderBenchmarks(list: string[], currency: string): string[] {
  const home = HOME_BENCHMARK[currency];
  return home && list.includes(home) ? [home, ...list.filter((b) => b !== home)] : list;
}

export function primaryBenchmark(list: string[], currency: string): string | undefined {
  return orderBenchmarks(list, currency)[0];
}
