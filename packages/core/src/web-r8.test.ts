/**
 * Web review R8 (W68): a consolidated input (rows of several portfolios) with isolatePortfolioCash
 * gives the sum of the portfolios computed one by one — one portfolio's cash never funds another's
 * purchase, and each portfolio's implicit FX conversions use its own funding currency.
 */
import { describe, expect, it } from 'vitest';
import { createMarketData, performanceSummary, valuePortfolio } from './api';
import type { EngineInput } from './api';
import type { FxSeries, Instrument, PriceSeries, Transaction } from './types';

let n = 0;
const tx = (t: Partial<Transaction> & Pick<Transaction, 'date' | 'type' | 'portfolioId'>): Transaction => ({ id: `w8-${++n}`, currency: 'USD', ...t });
const S: Instrument = { id: 'S', symbol: 'S', name: 'S', exchange: 'X', currency: 'USD', country: 'US', assetClass: 'equity' };
const ps = (pts: [string, number][]): PriceSeries => ({ instrumentId: 'S', currency: 'USD', source: 'manual', points: pts.map(([date, close]) => ({ date, close })) });
const fx: FxSeries = { base: 'USD', quote: 'COP', source: 'manual', points: [{ date: '2023-01-01', rate: 4000 }] };
const market = createMarketData({ prices: [ps([['2023-01-05', 100], ['2024-01-05', 150]])], fx: [fx] });
const pf = (id: string, base = 'USD') => ({ id, name: id, baseCurrency: base, costMethod: 'FIFO' as const, createdAt: '2023-01-01' });

const A = [tx({ portfolioId: 'A', date: '2023-01-02', type: 'DEPOSIT', amount: 10_000 }), tx({ portfolioId: 'A', date: '2023-01-05', type: 'BUY', instrumentId: 'S', quantity: 50, price: 100, amount: 5000, account: 'XP' })];
const B = [tx({ portfolioId: 'B', date: '2023-01-05', type: 'BUY', instrumentId: 'S', quantity: 80, price: 100, amount: 8000, account: 'Clear' })];
const one = (id: string, txs: Transaction[]): EngineInput => ({ portfolio: pf(id), instruments: [S], market, transactions: txs, options: { asOf: '2024-01-05' } });
const all = (isolate: boolean): EngineInput => ({ portfolio: pf('all'), instruments: [S], market, transactions: [...A, ...B], options: { asOf: '2024-01-05', isolatePortfolioCash: isolate } });

describe('W68 — isolatePortfolioCash', () => {
  it('consolidated value = sum of the portfolios (B does not spend A\'s cash)', () => {
    const sum = valuePortfolio(one('A', A), '2024-01-05').totalMarketValueBase + valuePortfolio(one('B', B), '2024-01-05').totalMarketValueBase;
    expect(valuePortfolio(all(true), '2024-01-05').totalMarketValueBase).toBeCloseTo(sum, 6);
    // Without the option the pooled cash funds B's purchase (the old consolidated behaviour).
    expect(valuePortfolio(all(false), '2024-01-05').totalMarketValueBase).toBeLessThan(sum - 1);
  });

  it('contributions add up and the return stays the one of the security mix', () => {
    const s = performanceSummary(all(true), 'SI', '2024-01-05');
    const a = performanceSummary(one('A', A), 'SI', '2024-01-05');
    const b = performanceSummary(one('B', B), 'SI', '2024-01-05');
    expect(s.netFlowsBase).toBeCloseTo(a.netFlowsBase + b.netFlowsBase, 6);
    expect(s.twr).toBeGreaterThan(0);
    expect(s.twr).toBeLessThan(0.5);
  });

  it('cash by account keeps plain account labels', () => {
    const cash = valuePortfolio(all(true), '2024-01-05').cash.find((c) => c.currency === 'USD')!;
    expect(Object.keys(cash.accountAmounts ?? {}).every((k) => !k.includes('\\u0000'))).toBe(true);
  });
});
