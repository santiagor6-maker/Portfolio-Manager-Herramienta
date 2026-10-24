/**
 * Web review R8 (W68): a consolidated input (rows of several portfolios) with isolatePortfolios
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
const all = (isolate: boolean): EngineInput => ({ portfolio: pf('all'), instruments: [S], market, transactions: [...A, ...B], options: { asOf: '2024-01-05', isolatePortfolios: isolate } });

describe('W68 — isolatePortfolios', () => {
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

describe('W68 — corporate events apply to their own portfolio\'s lots', () => {
  const split = (pid: string, ratio = 10) => tx({ portfolioId: pid, date: '2023-06-01', type: 'SPLIT', instrumentId: 'S', ratio });
  const input = (txs: Transaction[]): EngineInput => ({ portfolio: pf('all'), instruments: [S], market, transactions: txs, options: { asOf: '2024-01-05', isolatePortfolios: true } });
  const qty = (inp: EngineInput) => valuePortfolio(inp, '2024-01-05').holdings.find((h) => h.instrumentId === 'S')?.quantity;

  it('a split recorded in each portfolio is applied once to each portfolio\'s lots', () => {
    expect(qty(input([...A, ...B, split('A'), split('B')]))).toBe(1300);
  });

  it('a split recorded in one portfolio only scales that portfolio (the sum of the views)', () => {
    expect(qty(input([...A, ...B, split('A')]))).toBe(500 + 80);
  });

  it('a sale in one portfolio does not consume another portfolio\'s lots', () => {
    const sellB = tx({ portfolioId: 'B', date: '2023-02-01', type: 'SELL', instrumentId: 'S', quantity: 80, price: 120, amount: 9600, account: 'Clear' });
    const v = valuePortfolio(input([...A, ...B, sellB]), '2024-01-05');
    const h = v.holdings.find((x) => x.instrumentId === 'S')!;
    expect(h.quantity).toBe(50);
    expect(h.costBasis).toBeCloseTo(5000, 6); // A's 50 at 100, untouched by B's FIFO
  });

  it('bonificação (stock dividend) per portfolio', () => {
    const bonus = (pid: string) => tx({ portfolioId: pid, date: '2023-06-01', type: 'STOCK_DIVIDEND', instrumentId: 'S', ratio: 0.1 });
    expect(qty(input([...A, ...B, bonus('A'), bonus('B')]))).toBeCloseTo(143, 9);
  });
});


describe('W71 — each portfolio keeps its cost method in a consolidated input', () => {
  const pfM = (id: string, costMethod: 'FIFO' | 'AVERAGE') => ({ id, name: id, baseCurrency: 'USD', costMethod, createdAt: '2023-01-01' });
  const mk = (pid: string) => [
    tx({ portfolioId: pid, date: '2023-01-02', type: 'DEPOSIT', amount: 100_000 }),
    tx({ portfolioId: pid, date: '2023-01-05', type: 'BUY', instrumentId: 'S', quantity: 100, price: 100, amount: 10_000 }),
    tx({ portfolioId: pid, date: '2023-06-01', type: 'BUY', instrumentId: 'S', quantity: 100, price: 140, amount: 14_000 }),
    tx({ portfolioId: pid, date: '2023-09-01', type: 'SELL', instrumentId: 'S', quantity: 100, price: 150, amount: 15_000 }),
  ];
  const market2 = createMarketData({ prices: [ps([['2023-01-05', 100], ['2023-06-01', 140], ['2023-09-01', 150], ['2024-01-05', 150]])], fx: [fx] });
  const A2 = mk('A');
  const B2 = mk('B');
  const run = (inp: EngineInput) => performanceSummary(inp, 'SI', '2024-01-05');
  const single = (id: string, m: 'FIFO' | 'AVERAGE', txs: Transaction[]): EngineInput => ({ portfolio: pfM(id, m), instruments: [S], market: market2, transactions: txs, options: { asOf: '2024-01-05' } });
  const all: EngineInput = {
    portfolio: pfM('all', 'FIFO'),
    instruments: [S],
    market: market2,
    transactions: [...A2, ...B2],
    options: { asOf: '2024-01-05', isolatePortfolios: true, portfolioCostMethods: { A: 'FIFO', B: 'AVERAGE' } },
  };

  it('realized and unrealized gains equal A (FIFO) + B (AVERAGE)', () => {
    const a = run(single('A', 'FIFO', A2));
    const b = run(single('B', 'AVERAGE', B2));
    const s = run(all);
    expect(a.realizedGainBase).not.toBeCloseTo(b.realizedGainBase, 2); // the methods really differ
    expect(s.realizedGainBase).toBeCloseTo(a.realizedGainBase + b.realizedGainBase, 6);
    expect(s.unrealizedGainBase).toBeCloseTo(a.unrealizedGainBase + b.unrealizedGainBase, 6);
  });

  it('an explicit costMethod still overrides every portfolio', () => {
    const s = run({ ...all, options: { ...all.options, costMethod: 'FIFO' } });
    const a = run(single('A', 'FIFO', A2));
    expect(s.realizedGainBase).toBeCloseTo(2 * a.realizedGainBase, 6);
  });
});
