import type { Instrument } from '@pm/core';

/** Benchmarks offered for comparison. Prices come from the market-data server (Yahoo). */
export const BENCHMARKS: Instrument[] = [
  {
    id: 'INDEX:COLCAP',
    symbol: 'COLCAP',
    name: 'MSCI COLCAP',
    exchange: 'XBOG',
    currency: 'COP',
    country: 'CO',
    assetClass: 'etf',
    providerSymbols: { yahoo: 'ICOLCAP.CL' },
  },
  {
    id: 'INDEX:IBOV',
    symbol: 'IBOV',
    name: 'Ibovespa',
    exchange: 'BVMF',
    currency: 'BRL',
    country: 'BR',
    assetClass: 'etf',
    providerSymbols: { yahoo: '^BVSP' },
  },
  {
    id: 'INDEX:SPX',
    symbol: 'SPX',
    name: 'S&P 500',
    exchange: 'XNYS',
    currency: 'USD',
    country: 'US',
    assetClass: 'etf',
    providerSymbols: { yahoo: '^GSPC' },
  },
  {
    id: 'INDEX:MSCIW',
    symbol: 'URTH',
    name: 'MSCI World',
    exchange: 'ARCX',
    currency: 'USD',
    country: 'US',
    assetClass: 'etf',
    providerSymbols: { yahoo: 'URTH' },
  },
];

export const BENCHMARK_IDS = BENCHMARKS.map((b) => b.id);

export function benchmarkName(id: string): string {
  return BENCHMARKS.find((b) => b.id === id)?.name ?? id.replace(/^INDEX:/, '');
}
