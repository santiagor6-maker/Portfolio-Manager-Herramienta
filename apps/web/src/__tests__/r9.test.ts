/** Round 9 (reviews/web-r8.md): W68 "Todos" applies each corporate event once; W69; W70. */
import { describe, expect, it } from 'vitest';
import type { Instrument, Transaction } from '@pm/core';
import { computeAnalysis, type Dataset } from '../services/analysis';
import { mergeCorporateEvents, scopeImportHashes } from '../lib/consolidate';

const inst = (id: string, currency: 'USD' | 'BRL'): Instrument => ({ id, symbol: id.split(':')[1]!, name: id, exchange: id.split(':')[0]!, currency, country: currency === 'BRL' ? 'BR' : 'US', assetClass: 'equity' });
const NVDA = inst('XNAS:NVDA', 'USD');
const ITUB = inst('BVMF:ITUB4', 'BRL');
const AMER = inst('BVMF:AMER3', 'BRL');
let n = 0;
const tx = (t: Partial<Transaction>): Transaction => ({ id: `t${++n}`, portfolioId: 'A', date: '2023-01-05', type: 'DEPOSIT', currency: 'USD', ...t }) as Transaction;

function ds(over: Partial<Dataset>): Dataset {
  return {
    portfolios: [
      { id: 'A', name: 'A', baseCurrency: 'USD', costMethod: 'FIFO', createdAt: '2023-01-01' },
      { id: 'B', name: 'B', baseCurrency: 'USD', costMethod: 'FIFO', createdAt: '2023-01-01' },
    ],
    transactions: [],
    instruments: [NVDA, ITUB, AMER],
    prices: [],
    fx: [{ base: 'USD', quote: 'BRL', source: 't', points: [{ date: '2022-01-01', rate: 5 }] }],
    manualPrices: [],
    indexSeries: [],
    selectedPortfolioId: 'all',
    reportingCurrency: 'USD',
    asOf: '2024-10-31',
    benchmarks: [],
    riskFreeRate: 0.04,
    defaultCostMethod: 'FIFO',
    ...over,
  };
}

/** Value and quantity of `id` in "Todos" and in each portfolio. */
function views(base: Dataset, id: string) {
  const pick = (pid: string) => {
    const a = computeAnalysis({ ...base, selectedPortfolioId: pid });
    return { value: a.valuation!.totalMarketValueBase, qty: a.valuation!.holdings.find((h) => h.instrumentId === id)?.quantity ?? 0, a };
  };
  return { all: pick('all'), A: pick('A'), B: pick('B') };
}

describe('W68: "Todos" is the sum of the portfolios when each recorded the corporate event', () => {
  const nvdaPrices = [{ instrumentId: NVDA.id, currency: 'USD', source: 't', points: [{ date: '2023-01-05', close: 142.65 }, { date: '2023-03-01', close: 230 }, { date: '2024-06-07', close: 1208.88 }, { date: '2024-06-10', close: 121.79 }, { date: '2024-10-31', close: 140 }] }];
  const nvda = (splits: Transaction[]) =>
    ds({
      prices: nvdaPrices,
      transactions: [
        tx({ portfolioId: 'A', amount: 1_500_000 }),
        tx({ portfolioId: 'A', type: 'BUY', instrumentId: NVDA.id, quantity: 10_000, price: 142.65, amount: 1_426_500 }),
        tx({ portfolioId: 'B', date: '2023-03-01', amount: 1_200_000 }),
        tx({ portfolioId: 'B', date: '2023-03-01', type: 'BUY', instrumentId: NVDA.id, quantity: 5_000, price: 230, amount: 1_150_000 }),
        ...splits,
      ],
    });

  it('NVDA 10:1 recorded in each portfolio (as "Todos" and the per-portfolio buttons do): 150.000 shares', () => {
    const split = (pid: string) => tx({ portfolioId: pid, date: '2024-06-10', type: 'SPLIT', instrumentId: NVDA.id, ratio: 10, importHash: 'same-hash' });
    const v = views(nvda([split('A'), split('B')]), NVDA.id);
    expect(v.A.qty).toBe(100_000);
    expect(v.B.qty).toBe(50_000);
    expect(v.all.qty).toBe(150_000);
    expect(v.all.value).toBeCloseTo(v.A.value + v.B.value, 2);
    expect(v.all.value).toBeCloseTo(150_000 * 140 + 73_500 + 50_000, 2);
    // TWR / MWR stay sane (not ×10), and no "already imported" warning across portfolios.
    const twr = v.all.a.summaries.SI!.twr;
    const twrA = v.A.a.summaries.SI!.twr;
    expect(twr).toBeCloseTo(twrA, 0); // same security, same path: no ×10 jump
    expect(twr).toBeGreaterThan(-0.5);
    expect(twr).toBeLessThan(20);
    expect([...v.all.a.issues.warnings, ...v.all.a.issues.errors].map((i) => i.code)).not.toContain('DUPLICATE_IMPORT');
  });

  it('the same event a few days apart in the two portfolios (inferred vs announced date) is applied once', () => {
    const v = views(nvda([tx({ portfolioId: 'A', date: '2024-06-10', type: 'SPLIT', instrumentId: NVDA.id, ratio: 10 }), tx({ portfolioId: 'B', date: '2024-06-07', type: 'SPLIT', instrumentId: NVDA.id, ratio: 10 })]), NVDA.id);
    expect(v.all.qty).toBe(150_000);
  });

  it('ITUB4 bonificação 10 % in two portfolios', () => {
    const base = ds({
      portfolios: [
        { id: 'A', name: 'XP', baseCurrency: 'BRL', costMethod: 'AVERAGE', createdAt: '2023-01-01' },
        { id: 'B', name: 'Clear', baseCurrency: 'BRL', costMethod: 'AVERAGE', createdAt: '2023-01-01' },
      ],
      reportingCurrency: 'BRL',
      prices: [{ instrumentId: ITUB.id, currency: 'BRL', source: 't', points: [{ date: '2023-01-05', close: 25 }, { date: '2024-10-31', close: 30 }] }],
      transactions: ['A', 'B'].flatMap((pid) => [
        tx({ portfolioId: pid, currency: 'BRL', amount: 10_000 }),
        tx({ portfolioId: pid, type: 'BUY', instrumentId: ITUB.id, quantity: 100, price: 25, amount: 2_500, currency: 'BRL' }),
        tx({ portfolioId: pid, date: '2024-03-18', type: 'STOCK_DIVIDEND', instrumentId: ITUB.id, ratio: 0.1, currency: 'BRL' }),
      ]),
    });
    const v = views(base, ITUB.id);
    expect([v.A.qty, v.B.qty, v.all.qty]).toEqual([110, 110, 220]);
    expect(v.all.value).toBeCloseTo(v.A.value + v.B.value, 2);
  });

  it('AMER3 grupamento 1:100 in two portfolios', () => {
    const base = ds({
      portfolios: [
        { id: 'A', name: 'XP', baseCurrency: 'BRL', costMethod: 'AVERAGE', createdAt: '2022-01-01' },
        { id: 'B', name: 'Clear', baseCurrency: 'BRL', costMethod: 'AVERAGE', createdAt: '2022-01-01' },
      ],
      reportingCurrency: 'BRL',
      prices: [{ instrumentId: AMER.id, currency: 'BRL', source: 't', points: [{ date: '2022-12-05', close: 11.5 }, { date: '2024-08-26', close: 0.05 }, { date: '2024-08-27', close: 7 }, { date: '2024-10-31', close: 6.63 }] }],
      transactions: [
        ...[['A', 2000], ['B', 1000]].flatMap(([pid, q]) => [
          tx({ portfolioId: pid as string, date: '2022-12-01', currency: 'BRL', amount: 50_000 }),
          tx({ portfolioId: pid as string, date: '2022-12-05', type: 'BUY', instrumentId: AMER.id, quantity: q as number, price: 11.5, amount: (q as number) * 11.5, currency: 'BRL' }),
          tx({ portfolioId: pid as string, date: '2024-08-27', type: 'SPLIT', instrumentId: AMER.id, ratio: 0.01, currency: 'BRL' }),
        ]),
      ],
    });
    const v = views(base, AMER.id);
    expect([v.A.qty, v.B.qty, v.all.qty]).toEqual([20, 10, 30]);
    expect(v.all.value).toBeCloseTo(v.A.value + v.B.value, 2);
  });
});

describe('mergeCorporateEvents', () => {
  const s = (pid: string, date: string, ratio: number, extra: Partial<Transaction> = {}) => tx({ portfolioId: pid, date, type: 'SPLIT', instrumentId: NVDA.id, ratio, ...extra });
  it('keeps different events: another ratio, or a trade between the two dates', () => {
    expect(mergeCorporateEvents([s('A', '2024-06-10', 10), s('B', '2024-06-14', 2)])).toHaveLength(2);
    const buy = tx({ portfolioId: 'B', date: '2024-06-08', type: 'BUY', instrumentId: NVDA.id, quantity: 1, price: 1, amount: 1 });
    expect(mergeCorporateEvents([s('A', '2024-06-05', 10), buy, s('B', '2024-06-10', 10)]).filter((t) => t.type === 'SPLIT')).toHaveLength(2);
  });
  it('adds up cash attached to the event (merger cash, cash in lieu)', () => {
    const out = mergeCorporateEvents([s('A', '2024-06-10', 0.1, { amount: 3 }), s('B', '2024-06-10', 0.1, { amount: 4 })]);
    expect(out).toHaveLength(1);
    expect(out[0]!.amount).toBe(7);
  });
  it('import hashes are scoped by portfolio', () => {
    expect(scopeImportHashes([tx({ portfolioId: 'B', importHash: 'h' })])[0]!.importHash).toBe('B:h');
  });
});
