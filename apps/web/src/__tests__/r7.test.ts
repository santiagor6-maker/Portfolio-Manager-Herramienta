/** Round 7 (reviews/web-r6.md): W55–W60. */
import { describe, expect, it } from 'vitest';
import type { Instrument, Transaction } from '@pm/core';
import { computeAnalysis, type Dataset } from '../services/analysis';
import { pendingEvents } from '../lib/pendingEvents';

const NVDA: Instrument = { id: 'XNAS:NVDA', symbol: 'NVDA', name: 'NVIDIA', exchange: 'XNAS', currency: 'USD', country: 'US', assetClass: 'equity' };
const PETR: Instrument = { id: 'BVMF:PETR4', symbol: 'PETR4', name: 'Petrobras PN', exchange: 'BVMF', currency: 'BRL', country: 'BR', assetClass: 'equity' };
const tx = (t: Partial<Transaction>): Transaction => ({ id: `t${Math.random()}`, portfolioId: 'p', date: '2023-01-05', type: 'DEPOSIT', currency: 'USD', ...t }) as Transaction;

function ds(over: Partial<Dataset>): Dataset {
  return {
    portfolios: [{ id: 'p', name: 'P', baseCurrency: 'USD', costMethod: 'FIFO', createdAt: '2023-01-01' }],
    transactions: [],
    instruments: [NVDA, PETR],
    prices: [],
    fx: [{ base: 'USD', quote: 'BRL', source: 't', points: [{ date: '2022-12-01', rate: 5 }] }],
    manualPrices: [],
    indexSeries: [],
    selectedPortfolioId: 'p',
    reportingCurrency: 'USD',
    asOf: '2024-10-01',
    benchmarks: [],
    riskFreeRate: 0.04,
    defaultCostMethod: 'FIFO',
    ...over,
  };
}

describe('W55: pending corporate events reach the Resumen', () => {
  it('NVDA bought before the 10:1 split of 2024-06-10: the split is a pending event of a held position', () => {
    const a = computeAnalysis(
      ds({
        transactions: [tx({ amount: 1_500_000 }), tx({ type: 'BUY', instrumentId: NVDA.id, quantity: 10_000, price: 142.65, amount: 1_426_500 })],
        prices: [{ instrumentId: NVDA.id, currency: 'USD', source: 't', points: [{ date: '2023-01-05', close: 142.65 }, { date: '2024-06-07', close: 1208.88 }, { date: '2024-06-10', close: 121.79 }, { date: '2024-09-30', close: 121.44 }] }],
        corporateActions: [{ instrumentId: NVDA.id, type: 'SPLIT', date: '2024-06-10', ratio: 10, source: 'yahoo' } as never],
      }),
    );
    const p = pendingEvents(a);
    expect(p.splits).toHaveLength(1);
    expect(p.splits[0]).toMatchObject({ instrumentId: NVDA.id, date: '2024-06-10', ratio: 10 });
    expect(p.splits[0]!.suggestion).toBeDefined();
    expect(p.total).toBeGreaterThan(0);
  });

  it('an inferred split (price history only) is also pending when the position is held', () => {
    const a = computeAnalysis(
      ds({
        transactions: [tx({ amount: 1_500_000 }), tx({ type: 'BUY', instrumentId: NVDA.id, quantity: 10_000, price: 142.65, amount: 1_426_500 })],
        prices: [{ instrumentId: NVDA.id, currency: 'USD', source: 't', points: [{ date: '2023-01-05', close: 142.65 }, { date: '2024-06-07', close: 1208.88 }, { date: '2024-06-10', close: 121.79 }, { date: '2024-09-30', close: 121.44 }] }],
      }),
    );
    const p = pendingEvents(a);
    expect(p.splits.map((x) => [x.instrumentId, x.ratio])).toEqual([[NVDA.id, 10]]);
    expect(p.splits[0]!.suggestion).toBeUndefined();
  });

  it('announced Brazilian proventos are pending income, not "no hay proventos"', () => {
    const a = computeAnalysis(
      ds({
        portfolios: [{ id: 'p', name: 'P', baseCurrency: 'BRL', costMethod: 'FIFO', createdAt: '2023-01-01' }],
        reportingCurrency: 'BRL',
        transactions: [tx({ amount: 10_000, currency: 'BRL' }), tx({ type: 'BUY', instrumentId: PETR.id, quantity: 100, price: 25, amount: 2_500, currency: 'BRL' })],
        prices: [{ instrumentId: PETR.id, currency: 'BRL', source: 't', points: [{ date: '2023-01-05', close: 25 }, { date: '2024-09-30', close: 36 }] }],
        corporateActions: ['2024-03-01', '2024-06-03'].map((d) => ({ instrumentId: PETR.id, type: 'DIVIDEND', date: d, amountPerShare: 1.2, currency: 'BRL', source: 'yahoo' }) as never),
      }),
    );
    const p = pendingEvents(a);
    expect(p.income.length).toBe(2);
    expect(a.income).toHaveLength(0);
  });
});

describe('W56: redundant columns give way first', () => {
  it('flags all-zero and duplicate candidate columns, never the ones it is not allowed to hide', async () => {
    const { redundantColumns } = await import('../lib/columnStats');
    const rows = [
      { twr: 0.01, local: 0.01, fx: 0, flows: 0, income: 0 },
      { twr: -0.02, local: -0.02, fx: 0, flows: 100, income: 0 },
    ];
    const v = (id: string, r: Record<string, number>) => r[id];
    expect(redundantColumns(['twr', 'local', 'fx', 'flows', 'income'], rows, v as never, ['local', 'fx'])).toEqual(['local', 'fx']);
    // "income" is all zero but is not a candidate (dividends are never hidden).
    expect(redundantColumns(['twr', 'income'], rows, v as never, ['twr'])).toEqual([]);
  });
});

describe('W57: compact amounts', () => {
  it('Spanish uses millions and "mil", never MRD, with the full amount spacing', async () => {
    const { formatMoney } = await import('../lib/format');
    const c = (v: number, signed = false) => formatMoney(v, 'COP', 'es-CO', { compact: true, signed });
    expect(c(-8_568_345_718)).toMatch(/^-\$\s8\.568\sM$/);
    expect(c(62_804_000_000, true)).toMatch(/^\+\$\s62\.804\sM$/);
    expect(c(789_600_000, true)).toMatch(/^\+\$\s789,6\sM$/);
    expect(c(12_000)).toMatch(/^\$\s12\smil$/);
    expect(c(3_730.04)).toMatch(/^\$\s3,7\smil$/);
    expect(formatMoney(3_730.04, 'BRL', 'pt-BR', { compact: true })).toMatch(/R\$\s3,7\smil/);
  });
});
