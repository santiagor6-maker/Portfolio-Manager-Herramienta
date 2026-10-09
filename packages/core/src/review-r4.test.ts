/**
 * Regression tests from the round-4 external review (reviews/core-r4.md), scripts r4-a/r4-b.
 * Finding ids C38, C42, C43, C44 (+ the K cache checks that already passed).
 */
import { describe, expect, it } from 'vitest';
import { createMarketData, ledgerDiagnostics, monthlyPerformance, performanceSummary, positionPerformance, valuePortfolio } from './api';
import type { EngineInput } from './api';
import type { FxSeries, Instrument, PriceSeries, Transaction } from './types';

const pf = (base = 'COP') => ({ id: 'p', name: 'p', baseCurrency: base, costMethod: 'FIFO' as const, createdAt: '2020-01-01' });
let n = 0;
const tx = (t: Partial<Transaction> & Pick<Transaction, 'date' | 'type'>): Transaction => ({ id: `r4-${++n}`, portfolioId: 'p', currency: 'COP', ...t });
const inst = (id: string, currency: string, extra: Partial<Instrument> = {}): Instrument => ({ id, symbol: id, name: id, exchange: 'X', currency, country: 'US', assetClass: 'equity', ...extra });
const ps = (instrumentId: string, currency: string, pts: [string, number][]): PriceSeries => ({ instrumentId, currency, source: 'manual', points: pts.map(([date, close]) => ({ date, close })) });
const fxs = (base: string, quote: string, pts: [string, number][]): FxSeries => ({ base, quote, source: 'manual', points: pts.map(([date, rate]) => ({ date, rate })) });
const mkt = (prices: PriceSeries[] = [], fx: FxSeries[] = []) => createMarketData({ prices, fx });
const tradeCodes = (inp: EngineInput) => ledgerDiagnostics(inp).map((d) => d.code).filter((c) => c.startsWith('TRADE'));
const bond = (id: string, accrual: Record<string, unknown>) =>
  inst(id, 'COP', { assetClass: 'bond', pricing: 'manual', country: 'CO', accrual: { taxRegime: 'NONE', ...accrual } as Instrument['accrual'] });

describe('C44 — unconfirmed trade prices have a hard band and reach rows and summaries', () => {
  const t1 = (confirmed?: boolean): EngineInput => ({
    portfolio: pf(),
    instruments: [inst('X', 'COP')],
    market: mkt([ps('X', 'COP', [['2024-01-31', 100]])]),
    transactions: [
      tx({ date: '2024-01-31', type: 'BUY', instrumentId: 'X', quantity: 1000, price: 100 }),
      tx({ date: '2024-02-10', type: 'BUY', instrumentId: 'X', quantity: 10, price: 1000, ...(confirmed ? { priceConfirmed: true } : {}) }),
    ],
    options: { asOf: '2024-02-20' },
  });

  it('T1: a x10 typo in the current month (no later close) is not used as the price and is flagged in the summary', () => {
    const inp = t1();
    const s = performanceSummary(inp, 'MTD', '2024-02-20');
    expect(s.endValueBase).toBeCloseTo(101_000, 6);
    expect(s.twr).toBeGreaterThan(-0.1);
    expect(s.twr).toBeLessThan(0);
    expect(s.warnings).toContain('TRADE_PRICE_OUTLIER:X');
    expect(tradeCodes(inp)).toEqual(['TRADE_PRICE_OUTLIER']);
    const feb = monthlyPerformance(inp, { asOf: '2024-02-20' }).find((r) => r.month === '2024-02')!;
    expect(feb.warnings).toContain('TRADE_PRICE_OUTLIER:X');
  });

  it('T1b: priceConfirmed accepts the print without diagnostics', () => {
    const inp = t1(true);
    expect(tradeCodes(inp)).toEqual([]);
    expect(valuePortfolio(inp, '2024-02-20').totalMarketValueBase).toBeCloseTo(1_010_000, 6);
  });

  it('T2: a ÷10 typo with the next close 71 days later is rejected', () => {
    const inp: EngineInput = {
      portfolio: pf(),
      instruments: [inst('X', 'COP', { pricing: 'manual' })],
      market: mkt([ps('X', 'COP', [['2024-01-31', 100], ['2024-04-20', 102]])]),
      transactions: [tx({ date: '2024-01-31', type: 'BUY', instrumentId: 'X', quantity: 1000, price: 100 }), tx({ date: '2024-02-09', type: 'SELL', instrumentId: 'X', quantity: 1, price: 10 })],
      options: { asOf: '2024-03-31' },
    };
    const r = monthlyPerformance(inp, { asOf: '2024-03-31' });
    expect(r[1]!.twr).toBeGreaterThan(-0.01);
    expect(tradeCodes(inp)).toEqual(['TRADE_PRICE_OUTLIER']);
    expect(r[1]!.warnings).toContain('TRADE_PRICE_OUTLIER:X');
  });

  it('T3: a x10 typo after a 14-month gap (reference older than 400 days) is still checked', () => {
    const inp: EngineInput = {
      portfolio: pf(),
      instruments: [inst('PF', 'COP', { pricing: 'manual', assetClass: 'fund' })],
      market: mkt([ps('PF', 'COP', [['2022-12-31', 100]])]),
      transactions: [tx({ date: '2022-12-31', type: 'BUY', instrumentId: 'PF', quantity: 1000, price: 100 }), tx({ date: '2024-03-01', type: 'BUY', instrumentId: 'PF', quantity: 1, price: 1100 })],
      options: { asOf: '2024-03-31' },
    };
    expect(valuePortfolio(inp, '2024-03-31').totalMarketValueBase).toBeCloseTo(100_100, 6);
    expect(tradeCodes(inp)).toEqual(['TRADE_PRICE_OUTLIER']);
  });

  it('T4: a genuine -52 % gap confirmed by the next close is not flagged', () => {
    const inp: EngineInput = {
      portfolio: pf(),
      instruments: [inst('S', 'USD')],
      market: mkt([ps('S', 'USD', [['2024-03-01', 100], ['2024-03-04', 100], ['2024-03-05', 48], ['2024-03-06', 47]])], [fxs('USD', 'COP', [['2024-01-01', 4000]])]),
      transactions: [
        tx({ date: '2024-03-01', type: 'BUY', instrumentId: 'S', quantity: 10, price: 100, currency: 'USD' }),
        tx({ date: '2024-03-05', type: 'BUY', instrumentId: 'S', quantity: 10, price: 50, currency: 'USD' }),
      ],
      options: { asOf: '2024-03-06' },
    };
    expect(tradeCodes(inp)).toEqual([]);
    const s = performanceSummary(inp, 'MTD', '2024-03-06');
    expect(s.twr).toBeCloseTo(-0.53, 2);
    expect(s.warnings ?? []).not.toContain('TRADE_PRICE_UNCONFIRMED:S');
  });

  it('T5: a x3 crypto typo with a later close is rejected despite the double tolerance', () => {
    const inp: EngineInput = {
      portfolio: pf(),
      instruments: [inst('ETH', 'USD', { assetClass: 'crypto' })],
      market: mkt([ps('ETH', 'USD', [['2024-01-31', 2000], ['2024-02-29', 2100]])], [fxs('USD', 'COP', [['2024-01-01', 4000]])]),
      transactions: [
        tx({ date: '2024-01-31', type: 'BUY', instrumentId: 'ETH', quantity: 10, price: 2000, currency: 'USD' }),
        tx({ date: '2024-02-10', type: 'BUY', instrumentId: 'ETH', quantity: 0.01, price: 6000, currency: 'USD' }),
      ],
      options: { asOf: '2024-03-31' },
    };
    expect(tradeCodes(inp)).toEqual(['TRADE_PRICE_OUTLIER']);
    expect(monthlyPerformance(inp, { asOf: '2024-03-31' })[1]!.twr).toBeCloseTo(0.0479, 3);
  });

  it('a genuine +40 % move inside the band without a later close is used and flagged as unconfirmed until a close arrives', () => {
    const base = (pts: [string, number][]): EngineInput => ({
      portfolio: pf(),
      instruments: [inst('F', 'COP', { assetClass: 'fund', pricing: 'manual' })],
      market: mkt([ps('F', 'COP', pts)]),
      transactions: [tx({ date: '2024-01-31', type: 'BUY', instrumentId: 'F', quantity: 100, price: 100 }), tx({ date: '2024-02-15', type: 'BUY', instrumentId: 'F', quantity: 10, price: 140 })],
      options: { asOf: '2024-04-30' },
    });
    const inp = base([['2024-01-31', 100]]);
    expect(tradeCodes(inp)).toEqual(['TRADE_PRICE_UNCONFIRMED']);
    const rows = monthlyPerformance(inp, { asOf: '2024-04-30' });
    // still setting the price in March and April (no close since): the warning stays
    for (const r of rows.filter((x) => x.month >= '2024-02')) expect(r.warnings).toContain('TRADE_PRICE_UNCONFIRMED:F');
    expect(performanceSummary(inp, 'SI', '2024-04-30').warnings).toContain('TRADE_PRICE_UNCONFIRMED:F');
    expect(valuePortfolio(inp, '2024-04-30').totalMarketValueBase).toBeCloseTo(110 * 140, 6);
    // a later close confirms it: no diagnostic, no warning
    const ok = base([['2024-01-31', 100], ['2024-03-29', 141]]);
    expect(tradeCodes(ok)).toEqual([]);
    expect(monthlyPerformance(ok, { asOf: '2024-04-30' }).every((r) => !(r.warnings ?? []).some((w) => w.startsWith('TRADE')))).toBe(true);
  });
});

describe('C42 — coupons are apportioned by record-date units and never eat principal silently', () => {
  it('J2: one of two units sold ex-coupon; the coupon of both units leaves the remaining unit at par', () => {
    const b = bond('TES', { kind: 'fixed', annualRate: 0.1, dayCount: 'ACT/365' });
    const interest = 1000 * (Math.pow(1.1, 182 / 365) - 1);
    const inp: EngineInput = {
      portfolio: pf(),
      instruments: [b],
      market: mkt(),
      transactions: [
        tx({ date: '2024-01-01', type: 'BUY', instrumentId: 'TES', quantity: 2, price: 1000 }),
        tx({ date: '2024-06-28', type: 'SELL', instrumentId: 'TES', quantity: 1, price: 1000 }),
        tx({ date: '2024-07-01', type: 'INTEREST', instrumentId: 'TES', amount: 2 * interest }),
      ],
    };
    expect(valuePortfolio(inp, '2024-07-01').holdings[0]!.marketValueBase).toBeCloseTo(1000, 6);
    expect(ledgerDiagnostics(inp).map((d) => d.code)).toContain('COUPON_RECORD_DATE_UNITS');
    // explicit record-date quantity on the transaction
    const withQty = { ...inp, transactions: inp.transactions.map((t) => (t.type === 'INTEREST' ? { ...t, quantity: 2 } : t)) };
    expect(valuePortfolio(withQty, '2024-07-01').holdings[0]!.marketValueBase).toBeCloseTo(1000, 6);
  });

  it('a sale before payment with the coupon recorded for the remaining units only keeps the held-units split', () => {
    const b = bond('TES3', { kind: 'fixed', annualRate: 0.1, dayCount: 'ACT/365' });
    const interest = 1000 * (Math.pow(1.1, 182 / 365) - 1);
    const inp: EngineInput = {
      portfolio: pf(),
      instruments: [b],
      market: mkt(),
      transactions: [
        tx({ date: '2024-01-01', type: 'BUY', instrumentId: 'TES3', quantity: 2, price: 1000 }),
        tx({ date: '2024-06-28', type: 'SELL', instrumentId: 'TES3', quantity: 1, price: 1000 + interest }),
        tx({ date: '2024-07-01', type: 'INTEREST', instrumentId: 'TES3', amount: interest }),
      ],
    };
    expect(valuePortfolio(inp, '2024-07-01').holdings[0]!.marketValueBase).toBeCloseTo(1000, 6);
    expect(ledgerDiagnostics(inp).map((d) => d.code)).not.toContain('COUPON_RECORD_DATE_UNITS');
  });

  it('J4: interest before the accrual starts is income and leaves the principal intact', () => {
    const b = bond('NEW', { kind: 'fixed', annualRate: 0.1, dayCount: 'ACT/365', issueDate: '2024-03-01' });
    const inp: EngineInput = {
      portfolio: pf(),
      instruments: [b],
      market: mkt(),
      transactions: [tx({ date: '2024-02-20', type: 'BUY', instrumentId: 'NEW', quantity: 1, price: 1000 }), tx({ date: '2024-02-25', type: 'INTEREST', instrumentId: 'NEW', amount: 5 })],
    };
    expect(valuePortfolio(inp, '2024-03-01').holdings[0]!.marketValueBase).toBeCloseTo(1000, 6);
    expect(valuePortfolio(inp, '2025-03-01').holdings[0]!.marketValueBase).toBeCloseTo(1100, 6);
    expect(ledgerDiagnostics(inp).map((d) => d.code)).toContain('COUPON_EXCEEDS_ACCRUED_INTEREST');
  });

  it('a coupon on a lot bought with a dirty price (accrued interest bought) still resets to par', () => {
    const b = bond('DIRTY', { kind: 'fixed', annualRate: 0.1, dayCount: 'ACT/365', issueDate: '2024-01-01' });
    const inp: EngineInput = {
      portfolio: pf(),
      instruments: [b],
      market: mkt(),
      transactions: [
        tx({ date: '2024-04-01', type: 'BUY', instrumentId: 'DIRTY', quantity: 1, price: 1000 * Math.pow(1.1, 91 / 365) }),
        tx({ date: '2024-07-01', type: 'INTEREST', instrumentId: 'DIRTY', amount: 1000 * (Math.pow(1.1, 182 / 365) - 1) }),
      ],
    };
    expect(valuePortfolio(inp, '2024-07-01').holdings[0]!.marketValueBase).toBeCloseTo(1000, 6);
    expect(ledgerDiagnostics(inp).map((d) => d.code)).not.toContain('COUPON_EXCEEDS_ACCRUED_INTEREST');
  });
});

describe('C38 — merger followed by a ticker change', () => {
  it('P1: the intermediate company keeps its own +2.04 % and the positions add up to the portfolio', () => {
    const inp: EngineInput = {
      portfolio: pf(),
      instruments: [inst('A', 'COP'), inst('B', 'COP'), inst('C', 'COP')],
      market: mkt([ps('A', 'COP', [['2024-01-02', 100], ['2024-02-29', 100]]), ps('B', 'COP', [['2024-03-01', 196], ['2024-04-01', 200]]), ps('C', 'COP', [['2024-04-01', 200], ['2024-04-30', 210]])]),
      transactions: [
        tx({ date: '2024-01-02', type: 'BUY', instrumentId: 'A', quantity: 10, price: 100 }),
        tx({ date: '2024-03-01', type: 'SPLIT', subtype: 'MERGER', instrumentId: 'A', targetInstrumentId: 'B', ratio: 0.5, amount: 20 }),
        tx({ date: '2024-04-01', type: 'SPLIT', subtype: 'TICKER_CHANGE', instrumentId: 'B', targetInstrumentId: 'C', ratio: 1 }),
        tx({ date: '2024-04-30', type: 'SELL', instrumentId: 'C', quantity: 5, price: 210 }),
      ],
      options: { asOf: '2024-04-30' },
    };
    const pp = positionPerformance(inp, 'SI', '2024-04-30');
    const by = new Map(pp.map((p) => [p.instrumentId, p]));
    expect(by.get('B')!.totalReturnBase).toBeCloseTo(20, 9);
    expect(by.get('B')!.twr).toBeCloseTo(1000 / 980 - 1, 9);
    expect(by.get('C')!.twr).toBeCloseTo(0.05, 9);
    expect(by.get('A')!.twr).toBeCloseTo(0, 9);
    for (const p of pp) if (Math.abs(p.totalReturnBase) > 1e-9) expect(Math.sign(p.twr)).toBe(Math.sign(p.totalReturnBase));
    const s = performanceSummary(inp, 'SI', '2024-04-30');
    expect(pp.reduce((a, p) => a + p.totalReturnBase, 0)).toBeCloseTo(s.gainBase, 9);
  });
});

describe('C43 — interest recorded net of withholding without `taxes`', () => {
  const cdt = () => inst('CDTM', 'COP', { assetClass: 'bond', pricing: 'manual', country: 'CO', accrual: { kind: 'fixed', annualRate: 0.12, dayCount: 'ACT/365' } });
  const m = 10_000_000 * (Math.pow(1.12, 31 / 365) - 1);
  const run = (amount: number) => {
    const inp: EngineInput = {
      portfolio: pf(),
      instruments: [cdt()],
      market: mkt(),
      transactions: [tx({ date: '2024-01-01', type: 'BUY', instrumentId: 'CDTM', quantity: 1, price: 10_000_000 }), tx({ date: '2024-02-01', type: 'INTEREST', instrumentId: 'CDTM', amount })],
    };
    return { inp, v: valuePortfolio(inp, '2024-02-01').holdings[0]!.marketValueBase!, codes: ledgerDiagnostics(inp).map((d) => d.code) };
  };

  it('J6: net amount (96 %) infers the 4 % withholding: no phantom accrued interest', () => {
    const { v, codes } = run(m * 0.96);
    expect(v).toBeCloseTo(10_000_000, 4);
    expect(codes).toContain('INTEREST_NET_ASSUMED');
  });

  it('a gross amount is kept as recorded', () => {
    const { v, codes } = run(m);
    expect(v).toBeCloseTo(10_000_000, 4);
    expect(codes).not.toContain('INTEREST_NET_ASSUMED');
  });
});

describe('K — cache sees in-place edits (already passing, kept as regression)', () => {
  it('K1/K2: accrual rate edited in place and filter.accounts mutated in place', () => {
    const cdt = inst('CDT', 'COP', { assetClass: 'fixed_income', pricing: 'manual', accrual: { kind: 'fixed', annualRate: 0.1, taxRegime: 'NONE' } });
    const inp: EngineInput = {
      portfolio: pf(),
      instruments: [cdt],
      market: mkt(),
      transactions: [tx({ date: '2024-01-01', type: 'BUY', instrumentId: 'CDT', quantity: 1, price: 1000, account: 'A' })],
      options: { filter: { accounts: ['A'] } },
    };
    valuePortfolio(inp, '2024-12-31');
    cdt.accrual!.annualRate = 0.2;
    expect(valuePortfolio(inp, '2024-12-31').totalMarketValueBase).toBeCloseTo(1200, 6);
    inp.options!.filter!.accounts!.length = 0;
    inp.options!.filter!.accounts!.push('B');
    expect(valuePortfolio(inp, '2024-12-31').totalMarketValueBase).toBe(0);
  });
});
