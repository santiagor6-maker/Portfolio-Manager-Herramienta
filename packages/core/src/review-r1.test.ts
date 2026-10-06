/**
 * Regression tests from the round-1 external review (reviews/core-r1.md). Scenario ids
 * (S1a ... S7f) follow the reviewer's scripts; finding ids (C1 ... C19) follow the report.
 */
import { describe, expect, it } from 'vitest';
import {
  allocation,
  createMarketData,
  externalFlows,
  ledgerDiagnostics,
  monthlyPerformance,
  performanceSummary,
  realizedGains,
  riskMetrics,
  validateTransactions,
  valuePortfolio,
  valueSeries,
  xirr,
  xirrEx,
} from './api';
import { periodStart } from './engine';
import { daysBetween } from './dates';
import type { EngineInput } from './api';
import type { CostMethod, FxSeries, Instrument, PriceSeries, Transaction } from './types';

const pf = (base = 'COP', costMethod: CostMethod = 'FIFO') => ({ id: 'p', name: 'p', baseCurrency: base, costMethod, createdAt: '2020-01-01' });
let n = 0;
const tx = (t: Partial<Transaction> & Pick<Transaction, 'date' | 'type'>): Transaction => ({ id: `r${++n}`, portfolioId: 'p', currency: 'COP', ...t });
const inst = (id: string, currency: string, extra: Partial<Instrument> = {}): Instrument => ({ id, symbol: id, name: id, exchange: 'X', currency, country: 'US', assetClass: 'equity', ...extra });
const ps = (instrumentId: string, currency: string, pts: [string, number][]): PriceSeries => ({ instrumentId, currency, source: 'manual', points: pts.map(([date, close]) => ({ date, close })) });
const fxs = (base: string, quote: string, pts: [string, number][]): FxSeries => ({ base, quote, source: 'manual', points: pts.map(([date, rate]) => ({ date, rate })) });
const mkt = (prices: PriceSeries[], fx: FxSeries[] = [], extra: Record<string, unknown> = {}) => createMarketData({ prices, fx, ...extra });
const codes = (xs: { code: string }[]) => xs.map((x) => x.code);

describe('C1 — TWR on flow days uses trade prices and splits the day at the trades', () => {
  it('S3a: month-end prices 100 -> 125 and a mid-month buy at 120 give exactly +25 %', () => {
    const inp: EngineInput = {
      portfolio: pf(),
      instruments: [inst('X', 'COP')],
      market: mkt([ps('X', 'COP', [['2024-01-31', 100], ['2024-02-29', 125]])]),
      transactions: [
        tx({ date: '2024-01-31', type: 'BUY', instrumentId: 'X', quantity: 10, price: 100 }),
        tx({ date: '2024-02-15', type: 'BUY', instrumentId: 'X', quantity: 10, price: 120 }),
      ],
      options: { asOf: '2024-02-29' },
    };
    const r = monthlyPerformance(inp);
    expect(r[1]!.twr).toBeCloseTo(0.25, 12);
    expect(r[1]!.gainBase).toBeCloseTo(2500 - 1000 - 1200, 9);
    // The new shares are valued at the trade print on the trade date, not at the stale 100.
    const v = valuePortfolio(inp, '2024-02-15');
    expect(v.totalMarketValueBase).toBe(2400);
    expect(v.holdings[0]!.priceSource).toBe('trade');
  });

  it('S3b: mid-month sale at 120 and withdrawal, month-end 125 -> +25 %', () => {
    const inp: EngineInput = {
      portfolio: pf(),
      instruments: [inst('X', 'COP')],
      market: mkt([ps('X', 'COP', [['2024-01-31', 100], ['2024-02-29', 125]])]),
      transactions: [
        tx({ date: '2024-01-31', type: 'BUY', instrumentId: 'X', quantity: 10, price: 100 }),
        tx({ date: '2024-02-15', type: 'SELL', instrumentId: 'X', quantity: 5, price: 120 }),
        tx({ date: '2024-02-15', type: 'WITHDRAWAL', amount: 600 }),
      ],
      options: { asOf: '2024-02-29' },
    };
    expect(monthlyPerformance(inp)[1]!.twr).toBeCloseTo(0.25, 12);
  });

  it('S7b: daily prices 100 -> 105 (buy at close) -> 110 gives exactly +10 %; Modified Dietz unchanged', () => {
    const inp: EngineInput = {
      portfolio: pf(),
      instruments: [inst('X', 'COP')],
      market: mkt([ps('X', 'COP', [['2024-01-31', 100], ['2024-02-10', 105], ['2024-02-29', 110]])]),
      transactions: [
        tx({ date: '2024-01-31', type: 'DEPOSIT', amount: 1000 }),
        tx({ date: '2024-01-31', type: 'BUY', instrumentId: 'X', quantity: 10, price: 100 }),
        tx({ date: '2024-02-10', type: 'DEPOSIT', amount: 525 }),
        tx({ date: '2024-02-10', type: 'BUY', instrumentId: 'X', quantity: 5, price: 105 }),
      ],
      options: { asOf: '2024-02-29' },
    };
    expect(monthlyPerformance(inp)[1]!.twr).toBeCloseTo(0.1, 12);
    const md = monthlyPerformance(inp, { twrMethod: 'modifiedDietz' });
    expect(md[1]!.twr).toBeCloseTo((1650 - 1000 - 525) / (1000 + 525 * (20 / 29)), 12);
  });

  it('S2d: second buy at the new close 150 -> month TWR = +50 % (old shares 100 -> 150)', () => {
    const inp: EngineInput = {
      portfolio: pf(),
      instruments: [inst('X', 'COP')],
      market: mkt([ps('X', 'COP', [['2024-01-01', 100], ['2024-01-02', 150]])]),
      transactions: [
        tx({ date: '2024-01-01', type: 'BUY', instrumentId: 'X', quantity: 10, price: 100 }),
        tx({ date: '2024-01-02', type: 'BUY', instrumentId: 'X', quantity: 10, price: 150 }),
      ],
      options: { asOf: '2024-01-31' },
    };
    expect(monthlyPerformance(inp)[0]!.twr).toBeCloseTo(0.5, 12);
  });

  it('a trade away from the close: intraday split still yields the instrument return', () => {
    // Close 105 on 02-10 but the buy executed at 103: P = 10*103, then 15*105/(1030+515), then 110.
    const inp: EngineInput = {
      portfolio: pf(),
      instruments: [inst('X', 'COP')],
      market: mkt([ps('X', 'COP', [['2024-01-31', 100], ['2024-02-10', 105], ['2024-02-29', 110]])]),
      transactions: [
        tx({ date: '2024-01-31', type: 'BUY', instrumentId: 'X', quantity: 10, price: 100 }),
        tx({ date: '2024-02-10', type: 'BUY', instrumentId: 'X', quantity: 5, price: 103 }),
      ],
      options: { asOf: '2024-02-29' },
    };
    expect(monthlyPerformance(inp)[1]!.twr).toBeCloseTo(0.1, 12);
  });

  it('S2c: empty months and re-entry', () => {
    const inp: EngineInput = {
      portfolio: pf(),
      instruments: [inst('X', 'COP')],
      market: mkt([ps('X', 'COP', [['2024-01-01', 100], ['2024-01-31', 110], ['2024-02-15', 120], ['2024-04-15', 100], ['2024-04-30', 90]])]),
      transactions: [
        tx({ date: '2024-01-01', type: 'BUY', instrumentId: 'X', quantity: 10, price: 100 }),
        tx({ date: '2024-02-15', type: 'SELL', instrumentId: 'X', quantity: 10, price: 120 }),
        tx({ date: '2024-02-15', type: 'WITHDRAWAL', amount: 1200 }),
        tx({ date: '2024-04-15', type: 'BUY', instrumentId: 'X', quantity: 5, price: 100 }),
      ],
      options: { asOf: '2024-04-30' },
    };
    const r = monthlyPerformance(inp);
    expect(r.map((x) => x.twr)).toEqual([expect.closeTo(0.1, 12), expect.closeTo(120 / 110 - 1, 12), 0, expect.closeTo(-0.1, 12)]);
    expect(r[3]!.cumulativeTwr).toBeCloseTo(1.1 * (12 / 11) * 0.9 - 1, 12);
    expect(r.every((x) => !x.warnings)).toBe(true);
  });
});

describe('C2 — splits apply at the start of the ex-date', () => {
  const market = mkt([ps('A', 'COP', [['2024-01-02', 100], ['2024-03-01', 50], ['2024-03-29', 50]])]);
  it('S1a: buy on the ex-date in post-split units', () => {
    const txs = [
      tx({ date: '2024-01-02', type: 'BUY', instrumentId: 'A', quantity: 10, price: 100 }),
      tx({ date: '2024-03-01', type: 'SPLIT', instrumentId: 'A', ratio: 2 }),
      tx({ date: '2024-03-01', type: 'BUY', instrumentId: 'A', quantity: 10, price: 50 }),
    ];
    const h = valuePortfolio({ portfolio: pf(), transactions: txs, instruments: [inst('A', 'COP')], market }, '2024-03-29').holdings[0]!;
    expect(h.quantity).toBe(30);
    expect(h.costBasis).toBeCloseTo(1500, 9);
    expect(h.unrealizedGain).toBeCloseTo(0, 9);
  });

  it('S1b: sell everything on the ex-date', () => {
    const txs = [
      tx({ date: '2024-01-02', type: 'BUY', instrumentId: 'A', quantity: 10, price: 100 }),
      tx({ date: '2024-03-01', type: 'SPLIT', instrumentId: 'A', ratio: 2 }),
      tx({ date: '2024-03-01', type: 'SELL', instrumentId: 'A', quantity: 20, price: 50 }),
    ];
    const input = { portfolio: pf(), transactions: txs, instruments: [inst('A', 'COP')], market };
    expect(valuePortfolio(input, '2024-03-01').holdings).toHaveLength(0);
    expect(realizedGains(input).reduce((s, r) => s + r.gain, 0)).toBeCloseTo(0, 9);
  });

  it('S1e: no phantom shares; validator warns about same-day trades', () => {
    const txs = [
      tx({ date: '2024-01-02', type: 'BUY', instrumentId: 'A', quantity: 10, price: 100 }),
      tx({ date: '2024-03-01', type: 'BUY', instrumentId: 'A', quantity: 10, price: 50 }),
      tx({ date: '2024-03-01', type: 'SPLIT', instrumentId: 'A', ratio: 2 }),
      tx({ date: '2024-03-02', type: 'SELL', instrumentId: 'A', quantity: 30, price: 50 }),
    ];
    const r = validateTransactions(txs, [inst('A', 'COP')], { today: '2025-01-01' });
    expect(r.errors).toEqual([]);
    expect(codes(r.warnings)).toEqual(['SPLIT_SAME_DAY_TRADE']);
    const v = valuePortfolio({ portfolio: pf(), transactions: txs, instruments: [inst('A', 'COP')], market }, '2024-03-02');
    expect(v.holdings).toHaveLength(0);
  });

  it('S1c: sell all then re-buy (FIFO and AVERAGE)', () => {
    for (const m of ['FIFO', 'AVERAGE'] as const) {
      const txs = [
        tx({ date: '2024-01-02', type: 'BUY', instrumentId: 'A', quantity: 10, price: 100 }),
        tx({ date: '2024-02-01', type: 'BUY', instrumentId: 'A', quantity: 10, price: 120 }),
        tx({ date: '2024-03-01', type: 'SELL', instrumentId: 'A', quantity: 20, price: 110 }),
        tx({ date: '2024-04-01', type: 'BUY', instrumentId: 'A', quantity: 5, price: 90 }),
        tx({ date: '2024-05-01', type: 'BUY', instrumentId: 'A', quantity: 5, price: 110 }),
        tx({ date: '2024-05-15', type: 'SELL', instrumentId: 'A', quantity: 4, price: 120 }),
      ];
      const input = { portfolio: pf('COP', m), transactions: txs, instruments: [inst('A', 'COP')], market: mkt([ps('A', 'COP', [['2024-06-28', 130]])]) };
      const h = valuePortfolio(input, '2024-06-28').holdings[0]!;
      const total = realizedGains(input).reduce((s, r) => s + r.gain, 0);
      expect(h.quantity).toBe(6);
      expect(total).toBeCloseTo(m === 'FIFO' ? 120 : 80, 9);
      expect(h.costBasis).toBeCloseTo(m === 'FIFO' ? 640 : 600, 9);
    }
  });

  it('S1d: reverse split with cash in lieu sells the fraction', () => {
    const txs = [
      tx({ date: '2024-01-02', type: 'BUY', instrumentId: 'A', quantity: 10, price: 10 }),
      tx({ date: '2024-02-01', type: 'SPLIT', instrumentId: 'A', ratio: 1 / 3, amount: 9 }),
    ];
    const input = { portfolio: pf(), transactions: txs, instruments: [inst('A', 'COP')], market: mkt([ps('A', 'COP', [['2024-02-01', 30]])]) };
    const v = valuePortfolio(input, '2024-02-01');
    expect(v.holdings[0]!.quantity).toBe(3);
    expect(v.holdings[0]!.costBasis).toBeCloseTo(90, 6);
    const r = realizedGains(input);
    expect(r[0]!.proceeds).toBeCloseTo(9, 9);
    expect(r[0]!.cost).toBeCloseTo(10, 9);
    expect(v.cash.find((c) => c.currency === 'COP')!.amount).toBeCloseTo(9, 9);
  });
});

describe('C6 — overselling does not create phantom cash', () => {
  it('S5g: only the held part is credited', () => {
    const input = {
      portfolio: pf(),
      instruments: [inst('X', 'COP')],
      market: mkt([ps('X', 'COP', [['2024-01-01', 100]])]),
      transactions: [
        tx({ date: '2024-01-02', type: 'BUY', instrumentId: 'X', quantity: 10, price: 100 }),
        tx({ date: '2024-01-03', type: 'SELL', instrumentId: 'X', quantity: 15, price: 100 }),
      ],
    };
    const v = valuePortfolio(input, '2024-01-03');
    expect(v.cash.map((c) => c.amount)).toEqual([1000]);
    expect(v.totalMarketValueBase).toBe(1000);
    expect(codes(ledgerDiagnostics(input))).toContain('OVERSELL');
  });
});

describe('C7 — withdrawals above cash and degenerate sub-periods', () => {
  it('S2b: the shortfall is an implicit deposit (no negative values, no 110 % months)', () => {
    const inp: EngineInput = {
      portfolio: pf(),
      instruments: [inst('X', 'COP')],
      market: mkt([ps('X', 'COP', [['2024-01-01', 100], ['2024-01-20', 110], ['2024-02-10', 121], ['2024-03-31', 121]])]),
      transactions: [
        tx({ date: '2024-01-02', type: 'DEPOSIT', amount: 1000 }),
        tx({ date: '2024-01-02', type: 'BUY', instrumentId: 'X', quantity: 10, price: 100 }),
        tx({ date: '2024-01-25', type: 'WITHDRAWAL', amount: 5000 }),
        tx({ date: '2024-02-05', type: 'DEPOSIT', amount: 4000 }),
      ],
      options: { asOf: '2024-03-31' },
    };
    const r = monthlyPerformance(inp);
    expect(r[0]!.twr).toBeCloseTo(0.1, 12);
    expect(r.every((x) => x.endValueBase >= 0)).toBe(true);
    // February: the 4,000 deposit sits idle in cash from 02-05, so the TWR is diluted:
    // 1100 -> (1100 + 4000) -> 1210 + 4000 = 5210  =>  5210 / 5100 - 1
    expect(r[1]!.twr).toBeCloseTo(5210 / 5100 - 1, 12);
    expect(codes(ledgerDiagnostics(inp))).toContain('WITHDRAWAL_EXCEEDS_CASH');
    expect(externalFlows(inp).filter((f) => f.kind === 'IMPLICIT_DEPOSIT')[0]!.amount).toBe(5000);
  });

  it('a value appearing from nothing (no flow) is reported, not turned into a huge return', () => {
    const inp: EngineInput = {
      portfolio: pf(),
      instruments: [inst('X', 'COP')],
      market: mkt([]),
      transactions: [tx({ date: '2024-01-10', type: 'DIVIDEND', instrumentId: 'X', amount: 100 })],
      options: { asOf: '2024-01-31' },
    };
    const r = monthlyPerformance(inp);
    expect(r[0]!.twr).toBe(0);
    expect(r[0]!.warnings).toContain('DEGENERATE_SUBPERIOD');
    expect(codes(ledgerDiagnostics(inp))).toContain('INCOME_WITHOUT_POSITION');
  });
});

describe('C8 — missing FX is explicit; fresher FX routes win over stale direct pairs', () => {
  it('S4c: COP investor with only USD cash; EUR view without EUR data flags missing FX', () => {
    const inp: EngineInput = {
      portfolio: pf(),
      instruments: [],
      market: mkt([], [fxs('USD', 'COP', [['2024-01-31', 4000], ['2024-02-29', 4200]])]),
      transactions: [tx({ date: '2024-01-31', type: 'DEPOSIT', amount: 1000, currency: 'USD' })],
      options: { asOf: '2024-02-29' },
    };
    const r = monthlyPerformance(inp);
    expect(r[1]!.twr).toBeCloseTo(0.05, 12);
    expect(r[1]!.localReturn).toBeCloseTo(0, 12);
    expect(r[1]!.fxReturn).toBeCloseTo(0.05, 12);
    expect(r[1]!.fxGainBase).toBeCloseTo(200_000, 6);
    expect(monthlyPerformance({ ...inp, baseCurrency: 'USD' })[1]!.twr).toBeCloseTo(0, 12);
    const eur = { ...inp, baseCurrency: 'EUR' };
    const re = monthlyPerformance(eur);
    expect(re[1]!.missingFx).toEqual(['USD']);
    expect(performanceSummary(eur, 'SI', '2024-02-29').missingFx).toEqual(['USD']);
    expect(valuePortfolio(eur, '2024-02-29').missingFx).toEqual(['USD']);
    expect(codes(ledgerDiagnostics(eur))).toContain('MISSING_FX');
  });

  it('S5c: a stale direct BRL/COP pair loses to fresh USD triangulation', () => {
    const m = mkt([], [fxs('USD', 'COP', [['2024-01-01', 4000], ['2026-01-01', 3700]]), fxs('USD', 'BRL', [['2024-01-01', 5], ['2026-01-01', 5.5]]), fxs('BRL', 'COP', [['2024-01-01', 800]])]);
    expect(m.fx('BRL', 'COP', '2026-06-01')).toBeCloseTo(3700 / 5.5, 9);
    expect(m.fx('BRL', 'COP', '2024-01-03')).toBe(800); // direct is fresh enough here
    const m2 = mkt([], [fxs('USD', 'COP', [['2024-01-01', 4000]]), fxs('USD', 'BRL', [['2024-01-01', 5]]), fxs('BRL', 'COP', [['2024-06-01', 790]])]);
    expect(m2.fx('BRL', 'COP', '2024-03-01')).toBeCloseTo(800, 9);
    expect(m2.fx('BRL', 'COP', '2024-07-01')).toBe(790);
  });
});

describe('C9 — money waterfall reconciles exactly; realized FX split', () => {
  const inp: EngineInput = {
    portfolio: pf(),
    instruments: [inst('AAPL', 'USD')],
    market: mkt([ps('AAPL', 'USD', [['2024-01-02', 100], ['2024-03-31', 110], ['2024-06-28', 130]])], [fxs('USD', 'COP', [['2024-01-02', 4000], ['2024-03-31', 3900], ['2024-06-28', 4100]])]),
    transactions: [
      tx({ date: '2024-01-02', type: 'DEPOSIT', amount: 2000, currency: 'USD' }),
      tx({ date: '2024-01-02', type: 'BUY', instrumentId: 'AAPL', quantity: 20, price: 100, currency: 'USD', fees: 2 }),
      tx({ date: '2024-04-10', type: 'SELL', instrumentId: 'AAPL', quantity: 5, price: 110, currency: 'USD', fees: 1 }),
      tx({ date: '2024-05-15', type: 'DIVIDEND', instrumentId: 'AAPL', amount: 4, taxes: 1.2, currency: 'USD' }),
      tx({ date: '2024-06-01', type: 'FEE', amount: 3, currency: 'USD' }),
    ],
    options: { asOf: '2024-06-28' },
  };
  const parts = (s: ReturnType<typeof performanceSummary>) =>
    s.realizedGainBase + s.unrealizedGainBase + s.incomeBase + s.fxCashGainBase! + s.fxConversionResultBase! + s.otherCostsBase! + s.transferAdjustmentBase! + s.corporateActionAdjustmentBase! + s.rateDifferenceBase!;

  it('S4d: SI and QTD gains equal the sum of named parts (no hidden residual)', () => {
    for (const p of ['SI', 'QTD', 'MTD', '3M'] as const) {
      const s = performanceSummary(inp, p, '2024-06-28');
      expect(parts(s)).toBeCloseTo(s.gainBase, 6);
      expect(s.rateDifferenceBase).toBeCloseTo(0, 6);
      expect(s.priceGainBase! + s.fxGainBase!).toBeCloseTo(s.realizedGainBase + s.unrealizedGainBase + s.fxCashGainBase!, 6);
    }
    const si = performanceSummary(inp, 'SI', '2024-06-28');
    // the standalone FEE of 3 USD at 4000 (June fill-forward from 03-31 is 3900)
    expect(si.otherCostsBase).toBeCloseTo(-3 * 3900, 6);
    // cash revaluation is named, not hidden
    expect(Math.abs(si.fxCashGainBase!)).toBeGreaterThan(0);
  });

  it('monthly rows carry realized/unrealized/FX money columns that reconcile with gainBase', () => {
    const rows = monthlyPerformance(inp);
    for (const r of rows) expect(Number.isFinite(r.fxGainBase!)).toBe(true);
    const sumGain = rows.reduce((s, r) => s + r.gainBase, 0);
    expect(sumGain).toBeCloseTo(performanceSummary(inp, 'SI', '2024-06-28').gainBase, 6);
  });

  it('S7f: sale at a constant price while USD/COP moves is 100 % currency gain', () => {
    const r = realizedGains({
      portfolio: pf(),
      instruments: [inst('AAPL', 'USD')],
      market: mkt([ps('AAPL', 'USD', [['2024-01-01', 100]])], [fxs('USD', 'COP', [['2024-01-01', 4000], ['2024-06-01', 4400]])]),
      transactions: [
        tx({ date: '2024-01-02', type: 'BUY', instrumentId: 'AAPL', quantity: 10, price: 100, currency: 'USD' }),
        tx({ date: '2024-06-03', type: 'SELL', instrumentId: 'AAPL', quantity: 10, price: 100, currency: 'USD' }),
      ],
    });
    expect(r[0]!.gainBase).toBeCloseTo(400_000, 6);
    expect(r[0]!.priceGainBase).toBeCloseTo(0, 6);
    expect(r[0]!.fxGainBase).toBeCloseTo(400_000, 6);
  });
});

describe('C10 — per-account views', () => {
  const txs = [
    tx({ date: '2024-01-02', type: 'BUY', instrumentId: 'X', quantity: 10, price: 100, account: 'A' }),
    tx({ date: '2024-01-03', type: 'SELL', instrumentId: 'X', quantity: 4, price: 100, account: 'B' }),
  ];
  const base = { portfolio: pf(), transactions: txs, instruments: [inst('X', 'COP')], market: mkt([ps('X', 'COP', [['2024-01-01', 100]])]) };
  it('S5i: selling from an account that never bought is diagnosed', () => {
    expect(codes(ledgerDiagnostics(base))).toContain('NEGATIVE_ACCOUNT_QTY');
    const v = valuePortfolio(base, '2024-01-03');
    expect(v.holdings[0]!.accountQuantities).toEqual({ A: 10, B: -4 });
    expect(allocation(v, base.instruments, 'account').reduce((s, x) => s + x.valueBase, 0)).toBeCloseTo(v.totalMarketValueBase, 9);
  });
  it('filter.accounts restricts the whole analysis to one account', () => {
    const a = { ...base, options: { filter: { accounts: ['A'] }, asOf: '2024-01-31' } };
    expect(valuePortfolio(a, '2024-01-31').holdings[0]!.quantity).toBe(10);
    expect(monthlyPerformance(a)).toHaveLength(1);
  });
});

describe('C12 — deposit in COP + buy in USD without a conversion row', () => {
  it('S7a: implicit conversion from base cash, no double-counted flows', () => {
    const inp: EngineInput = {
      portfolio: pf(),
      instruments: [inst('AAPL', 'USD')],
      market: mkt([ps('AAPL', 'USD', [['2024-01-01', 100], ['2024-01-31', 110]])], [fxs('USD', 'COP', [['2024-01-01', 4000]])]),
      transactions: [
        tx({ date: '2024-01-05', type: 'DEPOSIT', amount: 4_000_000 }),
        tx({ date: '2024-01-05', type: 'BUY', instrumentId: 'AAPL', quantity: 10, price: 100, currency: 'USD' }),
      ],
      options: { asOf: '2024-01-31' },
    };
    const r = monthlyPerformance(inp);
    expect(r[0]!.twr).toBeCloseTo(0.1, 12);
    expect(r[0]!.netFlowsBase).toBe(4_000_000);
    expect(externalFlows(inp).map((f) => f.kind)).toEqual(['DEPOSIT']);
    expect(codes(ledgerDiagnostics(inp))).toContain('IMPLICIT_FX_CONVERSION');
    const off = monthlyPerformance({ ...inp, options: { asOf: '2024-01-31', implicitFx: 'none' } });
    expect(off[0]!.netFlowsBase).toBe(8_000_000);
  });
});

describe('C13 — total-return benchmarks', () => {
  it('S7e: dividends from corporate actions are reinvested in the benchmark', () => {
    const market = createMarketData({
      prices: [ps('VOO', 'USD', [['2024-01-31', 100], ['2024-02-29', 100]])],
      fx: [fxs('USD', 'COP', [['2024-01-01', 4000]])],
      corporateActions: [{ instrumentId: 'VOO', date: '2024-02-15', type: 'DIVIDEND', amountPerShare: 1.5 }],
    });
    const inp: EngineInput = {
      portfolio: { ...pf(), benchmarks: ['VOO'] },
      instruments: [inst('VOO', 'USD')],
      market,
      transactions: [
        tx({ date: '2024-01-31', type: 'BUY', instrumentId: 'VOO', quantity: 10, price: 100, currency: 'USD' }),
        tx({ date: '2024-02-15', type: 'DIVIDEND', instrumentId: 'VOO', amount: 15, currency: 'USD' }),
      ],
      options: { asOf: '2024-02-29' },
    };
    const r = monthlyPerformance(inp)[1]!;
    expect(r.twr).toBeCloseTo(0.015, 12);
    expect(r.benchmarkReturns!.VOO).toBeCloseTo(0.015, 12);
    expect(r.benchmarkKinds!.VOO).toBe('total');
    const priceOnly = monthlyPerformance({ ...inp, options: { asOf: '2024-02-29', benchmarkKinds: { VOO: 'price' } } })[1]!;
    expect(priceOnly.benchmarkReturns!.VOO).toBeCloseTo(0, 12);
  });

  it('split-adjusts unadjusted benchmark prices', () => {
    const market = createMarketData({
      prices: [ps('SPY', 'USD', [['2024-01-31', 200], ['2024-02-29', 110]])],
      fx: [],
      corporateActions: [{ instrumentId: 'SPY', date: '2024-02-10', type: 'SPLIT', ratio: 2 }],
    });
    const inp: EngineInput = {
      portfolio: { ...pf('USD'), benchmarks: ['SPY'] },
      instruments: [],
      market,
      transactions: [tx({ date: '2024-01-31', type: 'DEPOSIT', amount: 1, currency: 'USD' })],
      options: { asOf: '2024-02-29' },
    };
    expect(monthlyPerformance(inp)[1]!.benchmarkReturns!.SPY).toBeCloseTo(0.1, 12);
  });
});

describe('C14 — dates must be exact YYYY-MM-DD', () => {
  it('S5a: a timestamp is rejected by both the validator and the ledger (never moved to another day)', () => {
    const t = tx({ date: '2024-04-01T01:00:00.000Z', type: 'BUY', instrumentId: 'X', quantity: 1, price: 100 });
    const input = { portfolio: pf(), transactions: [t], instruments: [inst('X', 'COP')], market: mkt([ps('X', 'COP', [['2024-03-01', 100]])]) };
    expect(codes(validateTransactions([t], input.instruments, { today: '2030-01-01' }).errors)).toContain('INVALID_DATE');
    expect(valuePortfolio(input, '2024-04-30').holdings).toHaveLength(0);
    expect(codes(ledgerDiagnostics(input))).toContain('INVALID_DATE');
  });
});

describe('C15 — one annualization convention (calendar years)', () => {
  it('S4b: exactly one (leap) year: annualized TWR = TWR = MWR without flows', () => {
    const inp: EngineInput = {
      portfolio: pf(),
      instruments: [inst('X', 'COP')],
      market: mkt([ps('X', 'COP', [['2023-01-01', 100], ['2023-12-31', 100], ['2024-12-31', 120]])]),
      transactions: [tx({ date: '2023-01-02', type: 'BUY', instrumentId: 'X', quantity: 10, price: 100 })],
    };
    const s = performanceSummary(inp, '1Y', '2024-12-31');
    expect(s.from).toBe('2024-01-01');
    expect(s.years).toBe(1);
    expect(s.twr).toBeCloseTo(0.2, 12);
    expect(s.twrAnnualized).toBeCloseTo(s.twr, 12);
    expect(s.mwr).toBeCloseTo(s.twr, 9);
    expect(s.mwrPeriod).toBeCloseTo(s.twr, 9);
  });

  it('S2e: XIRR vs bisection; multiple roots flagged; short periods expose a non-annualized MWR', () => {
    const flows = [
      { date: '2020-01-01', amount: -1000 },
      { date: '2020-07-01', amount: -500 },
      { date: '2021-03-15', amount: 200 },
      { date: '2022-02-28', amount: 1600 },
    ];
    const npv = (r: number) => flows.reduce((s, f) => s + f.amount / Math.pow(1 + r, daysBetween('2020-01-01', f.date) / 365), 0);
    expect(Math.abs(npv(xirr(flows)!))).toBeLessThan(1e-8);
    const ms = xirrEx([{ date: '2020-01-01', amount: -100 }, { date: '2021-01-01', amount: 230 }, { date: '2022-01-01', amount: -132 }]);
    expect(ms.multipleRoots).toBe(true);
    expect(xirrEx(flows).multipleRoots).toBe(false);
    const inp: EngineInput = {
      portfolio: pf(),
      instruments: [inst('X', 'COP')],
      market: mkt([ps('X', 'COP', [['2024-01-01', 100], ['2024-01-02', 101]])]),
      transactions: [tx({ date: '2024-01-01', type: 'BUY', instrumentId: 'X', quantity: 10, price: 100 })],
    };
    const s = performanceSummary(inp, 'CUSTOM', '2024-01-02', { from: '2024-01-01', to: '2024-01-02' });
    expect(s.mwr!).toBeGreaterThan(10); // annualized 1 % per day is enormous...
    expect(s.mwrPeriod).toBeCloseTo(0.01, 9); // ...the period MWR is what the UI should show
    expect(s.twrAnnualized).toBeUndefined();
  });
});

describe('C16 — risk ignores the partial current month; daily drawdown', () => {
  it('S4e: partial month excluded from volatility', () => {
    const inp: EngineInput = {
      portfolio: pf(),
      instruments: [inst('X', 'COP')],
      market: mkt([ps('X', 'COP', [['2024-01-01', 100], ['2024-01-31', 101], ['2024-02-29', 103], ['2024-03-02', 90]])]),
      transactions: [tx({ date: '2024-01-01', type: 'BUY', instrumentId: 'X', quantity: 10, price: 100 })],
      options: { asOf: '2024-03-02' },
    };
    const rows = monthlyPerformance(inp);
    expect(rows[2]!.partial).toBe(true);
    expect(rows[1]!.partial).toBeUndefined();
    const r = riskMetrics(rows);
    expect(r.monthsUsed).toBe(2);
    expect(riskMetrics(rows, { includePartial: true }).monthsUsed).toBe(3);
    const daily = valueSeries(inp, { from: '2024-01-01', to: '2024-03-02', step: 'day' });
    const d = riskMetrics(rows, { includePartial: true, dailySeries: daily });
    expect(d.maxDrawdown).toBeCloseTo(90 / 103 - 1, 12);
    expect(d.maxDrawdownStartDate).toBe('2024-02-29');
    expect(d.maxDrawdownEndDate).toBe('2024-03-02');
  });
});

describe('C17/C18/C19 — staleness, conversion spread, income without position', () => {
  it('S5d: a three-year-old price is flagged stale', () => {
    const input = {
      portfolio: pf(),
      instruments: [inst('X', 'COP')],
      market: mkt([ps('X', 'COP', [['2021-01-04', 100]])]),
      transactions: [tx({ date: '2021-01-04', type: 'BUY', instrumentId: 'X', quantity: 1, price: 100 })],
    };
    const v = valuePortfolio(input, '2024-06-30');
    expect(v.stalePrices).toEqual(['X']);
    expect(v.holdings[0]!.stale).toBe(true);
    expect(valuePortfolio(input, '2021-01-08').stalePrices).toBeUndefined();
    expect(valuePortfolio({ ...input, options: { staleDays: { listed: 2 } } }, '2021-01-08').stalePrices).toEqual(['X']);
  });

  it('S4g: an FX conversion 2 % below market shows as -2 % and as an explicit spread cost', () => {
    const inp: EngineInput = {
      portfolio: pf(),
      instruments: [],
      market: mkt([], [fxs('USD', 'COP', [['2024-01-01', 4000]])]),
      transactions: [
        tx({ date: '2024-01-10', type: 'DEPOSIT', amount: 4_000_000 }),
        tx({ date: '2024-01-10', type: 'FX_CONVERSION', amount: 4_000_000, toCurrency: 'USD', toAmount: 980 }),
      ],
      options: { asOf: '2024-01-31' },
    };
    const r = monthlyPerformance(inp)[0]!;
    expect(r.twr).toBeCloseTo(-0.02, 12);
    expect(r.fxSpreadBase).toBeCloseTo(80_000, 6);
    expect(performanceSummary(inp, 'SI', '2024-01-31').fxConversionResultBase).toBeCloseTo(-80_000, 6);
  });

  it('S5h: dividend without a position is warned by ledger and validator', () => {
    const txs = [tx({ date: '2024-01-02', type: 'DIVIDEND', instrumentId: 'X', amount: 100 })];
    expect(codes(ledgerDiagnostics({ portfolio: pf(), transactions: txs, instruments: [inst('X', 'COP')], market: mkt([]) }))).toContain('INCOME_WITHOUT_POSITION');
    expect(codes(validateTransactions(txs, [inst('X', 'COP')], { today: '2030-01-01' }).warnings)).toContain('INCOME_WITHOUT_POSITION');
  });
});

describe('Other reviewer scenarios kept as regressions', () => {
  it('S4a: period boundaries', () => {
    const cases: [Parameters<typeof periodStart>[0], string, string][] = [
      ['1M', '2024-03-31', '2024-03-01'],
      ['1M', '2024-03-30', '2024-03-01'],
      ['1M', '2024-02-29', '2024-01-30'],
      ['1Y', '2024-02-29', '2023-03-01'],
      ['1Y', '2025-02-28', '2024-02-29'],
      ['3M', '2024-05-31', '2024-03-01'],
      ['QTD', '2024-12-31', '2024-10-01'],
      ['YTD', '2024-01-01', '2024-01-01'],
    ];
    for (const [p, asOf, exp] of cases) expect(periodStart(p, asOf, '2000-01-01')).toBe(exp);
  });

  it('S4f: valueSeries cumulative TWR equals the CUSTOM summary', () => {
    const inp: EngineInput = {
      portfolio: pf(),
      instruments: [inst('X', 'COP')],
      market: mkt([ps('X', 'COP', [['2024-01-01', 100], ['2024-01-15', 105], ['2024-02-10', 98], ['2024-03-20', 120]])]),
      transactions: [
        tx({ date: '2024-01-01', type: 'DEPOSIT', amount: 5000 }),
        tx({ date: '2024-01-01', type: 'BUY', instrumentId: 'X', quantity: 10, price: 100 }),
        tx({ date: '2024-02-12', type: 'BUY', instrumentId: 'X', quantity: 10, price: 98 }),
        tx({ date: '2024-02-20', type: 'WITHDRAWAL', amount: 500 }),
      ],
    };
    const vs = valueSeries(inp, { from: '2024-01-10', to: '2024-03-25', step: 'month' });
    const c = performanceSummary(inp, 'CUSTOM', '2024-03-25', { from: '2024-01-11', to: '2024-03-25' });
    expect(vs.at(-1)!.cumulativeTwr).toBeCloseTo(c.twr, 12);
  });

  it('S5b: transfer in keeps the original cost; TWR unaffected', () => {
    const inp: EngineInput = {
      portfolio: pf(),
      instruments: [inst('X', 'COP')],
      market: mkt([ps('X', 'COP', [['2024-01-01', 100], ['2024-01-31', 100], ['2024-02-10', 110], ['2024-02-29', 121]])]),
      transactions: [tx({ date: '2024-02-10', type: 'TRANSFER_IN', instrumentId: 'X', quantity: 10, price: 80 })],
      options: { asOf: '2024-02-29' },
    };
    expect(monthlyPerformance(inp)[0]!.twr).toBeCloseTo(121 / 110 - 1, 12);
    expect(valuePortfolio(inp, '2024-02-29').holdings[0]!.costBasis).toBe(800);
    const s = performanceSummary(inp, 'SI', '2024-02-29');
    expect(s.transferAdjustmentBase).toBeCloseTo(800 - 1100, 9);
  });

  it('S7c: bonificação with attributed cost under preço médio', () => {
    const v = valuePortfolio(
      {
        portfolio: pf('BRL', 'AVERAGE'),
        instruments: [inst('ITSA4', 'BRL')],
        market: mkt([ps('ITSA4', 'BRL', [['2024-01-01', 10]])]),
        transactions: [
          tx({ date: '2024-01-02', type: 'BUY', instrumentId: 'ITSA4', quantity: 100, price: 10, currency: 'BRL' }),
          tx({ date: '2024-02-01', type: 'STOCK_DIVIDEND', instrumentId: 'ITSA4', quantity: 10, price: 5, currency: 'BRL' }),
        ],
      },
      '2024-02-01',
    );
    expect(v.holdings[0]!.quantity).toBe(110);
    expect(v.holdings[0]!.costBasis).toBeCloseTo(1050, 9);
  });

  it('S1f: dividend by price per share with withholding in USD', () => {
    const inp: EngineInput = {
      portfolio: pf(),
      instruments: [inst('AAPL', 'USD')],
      market: mkt([ps('AAPL', 'USD', [['2024-01-02', 100]])], [fxs('USD', 'COP', [['2024-01-02', 4000], ['2024-02-15', 3900]])]),
      transactions: [
        tx({ date: '2024-01-02', type: 'BUY', instrumentId: 'AAPL', quantity: 10, price: 100, currency: 'USD' }),
        tx({ date: '2024-02-15', type: 'DIVIDEND', instrumentId: 'AAPL', price: 0.25, taxes: 0.75, currency: 'USD' }),
      ],
      options: { asOf: '2024-02-29' },
    };
    expect(monthlyPerformance(inp)[1]!.incomeBase).toBeCloseTo(1.75 * 3900, 9);
  });
});
