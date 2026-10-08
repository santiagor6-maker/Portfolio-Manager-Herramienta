/**
 * Regression tests from the round-3 external review (reviews/core-r3.md), scripts r3-a/b/c.
 * Finding ids C36 ... C41.
 */
import { describe, expect, it } from 'vitest';
import {
  applyCorporateActions,
  createMarketData,
  ledgerDiagnostics,
  monthlyPerformance,
  performanceSummary,
  positionPerformance,
  realizedGains,
  valuePortfolio,
} from './api';
import type { EngineInput } from './api';
import { businessDaysIn } from './calendars';
import { addDays, isoToDay } from './dates';
import { inputHash } from './engine';
import type { CostMethod, FxSeries, Instrument, MarketData, PriceSeries, Transaction } from './types';

const pf = (base = 'COP', costMethod: CostMethod = 'FIFO') => ({ id: 'p', name: 'p', baseCurrency: base, costMethod, createdAt: '2020-01-01' });
let n = 0;
const tx = (t: Partial<Transaction> & Pick<Transaction, 'date' | 'type'>): Transaction => ({ id: `z${++n}`, portfolioId: 'p', currency: 'COP', ...t });
const inst = (id: string, currency: string, extra: Partial<Instrument> = {}): Instrument => ({ id, symbol: id, name: id, exchange: 'X', currency, country: currency === 'BRL' ? 'BR' : currency === 'COP' ? 'CO' : 'US', assetClass: 'equity', ...extra });
const ps = (instrumentId: string, currency: string, pts: [string, number][]): PriceSeries => ({ instrumentId, currency, source: 'manual', points: pts.map(([date, close]) => ({ date, close })) });
const fxs = (base: string, quote: string, pts: [string, number][]): FxSeries => ({ base, quote, source: 'manual', points: pts.map(([date, rate]) => ({ date, rate })) });
const mkt = (prices: PriceSeries[] = [], fx: FxSeries[] = []) => createMarketData({ prices, fx });
const codes = (xs: { code: string }[]) => xs.map((x) => x.code);

describe('C36 — coupons and periodic interest of accrual instruments are not counted twice', () => {
  it('H1: CDT 12 % E.A. (ACT/ACT) paying quarterly interest with 4 % withholding', () => {
    const cdt = inst('CDTQ', 'COP', { assetClass: 'fixed_income', pricing: 'manual', accrual: { kind: 'fixed', annualRate: 0.12, maturity: '2025-01-02', dayCount: 'ACT/ACT' } });
    const q = 10_000_000 * (Math.pow(1.12, 0.25) - 1);
    const inp: EngineInput = {
      portfolio: pf(),
      instruments: [cdt],
      market: mkt(),
      transactions: [
        tx({ date: '2024-01-02', type: 'DEPOSIT', amount: 10_000_000 }),
        tx({ date: '2024-01-02', type: 'BUY', instrumentId: 'CDTQ', quantity: 1, price: 10_000_000 }),
        tx({ date: '2024-04-02', type: 'INTEREST', instrumentId: 'CDTQ', amount: q, taxes: q * 0.04 }),
        tx({ date: '2024-07-02', type: 'INTEREST', instrumentId: 'CDTQ', amount: q, taxes: q * 0.04 }),
        tx({ date: '2024-10-02', type: 'INTEREST', instrumentId: 'CDTQ', amount: q, taxes: q * 0.04 }),
      ],
      options: { asOf: '2024-12-31' },
    };
    // Hand chain: accrue (ACT/ACT: the year starting 2024-01-02 has 366 days, later ones 365) and
    // subtract each gross coupon on its payment day.
    const a1 = 10_000_000 * Math.pow(1.12, 91 / 366) - q;
    const a2 = a1 * Math.pow(1.12, 91 / 365) - q;
    const a3 = a2 * Math.pow(1.12, 92 / 365) - q;
    const value = a3 * Math.pow(1.12, 90 / 365);
    const v = valuePortfolio(inp, '2024-12-31');
    expect(v.holdings[0]!.marketValue).toBeCloseTo(value, 2);
    expect(v.holdings[0]!.marketValue!).toBeLessThan(10_300_000);
    expect(v.cash[0]!.amount).toBeCloseTo(3 * q * 0.96, 4);
    const twr = performanceSummary(inp, 'YTD', '2024-12-31').twr;
    expect(twr).toBeCloseTo((value + 3 * q * 0.96) / 10_000_000 - 1, 8);
    expect(twr).toBeGreaterThan(0.11);
    expect(twr).toBeLessThan(0.12); // was 20.2 % with the double count
    // Net value only taxes the interest accrued since the last coupon
    expect(v.holdings[0]!.accruedTaxBase).toBeCloseTo(0.04 * (value - a3), 4);
  });

  it('H2: bond coupon suggested by applyCorporateActions (COUPON -> INTEREST) is not counted twice', () => {
    const ntnf = inst('NTNF', 'BRL', { assetClass: 'bond', pricing: 'manual', accrual: { kind: 'fixed', annualRate: 0.1 } });
    const txs = [tx({ date: '2024-01-02', type: 'BUY', instrumentId: 'NTNF', quantity: 1, price: 1000, currency: 'BRL' })];
    const ca = applyCorporateActions(txs, [{ instrumentId: 'NTNF', date: '2024-07-01', type: 'DIVIDEND', subtype: 'COUPON', amountPerShare: 48.81, currency: 'BRL' }], [ntnf]);
    expect(ca.suggested.map((t) => t.type)).toEqual(['INTEREST']);
    const v = valuePortfolio({ portfolio: pf('BRL'), transactions: [...txs, ...ca.suggested], instruments: [ntnf], market: mkt() }, '2024-12-31');
    const du1 = businessDaysIn(isoToDay('2024-01-02'), isoToDay('2024-07-01'), 'BR');
    const du2 = businessDaysIn(isoToDay('2024-07-01'), isoToDay('2024-12-31'), 'BR');
    const expected = (1000 * Math.pow(1.1, du1 / 252) - 48.81) * Math.pow(1.1, du2 / 252);
    expect(v.holdings[0]!.marketValue).toBeCloseTo(expected, 6);
    expect(v.totalMarketValueBase).toBeCloseTo(expected + 48.81, 6);
    expect(v.totalMarketValueBase).toBeLessThan(1101); // ≈ 1,100, not 1,148.81
  });

  it('G3c: interest recorded at maturity + automatic redemption does not pay the interest twice', () => {
    const cdt = inst('C3', 'COP', { assetClass: 'fixed_income', pricing: 'manual', accrual: { kind: 'fixed', annualRate: 0.12, maturity: '2025-01-03' } });
    const inp: EngineInput = {
      portfolio: pf(),
      instruments: [cdt],
      market: mkt(),
      transactions: [
        tx({ date: '2024-01-03', type: 'BUY', instrumentId: 'C3', quantity: 1, price: 10_000_000 }),
        tx({ date: '2025-01-03', type: 'INTEREST', instrumentId: 'C3', amount: 1_200_000, taxes: 48_000 }),
      ],
    };
    const gross = 10_000_000 * Math.pow(1.12, 366 / 365);
    const cash = valuePortfolio(inp, '2025-01-31').cash[0]!.amount;
    // net interest + principal + the residual accrual the bank did not pay (day-count difference)
    expect(cash).toBeCloseTo(1_152_000 + (gross - 1_200_000), 4);
    expect(cash).toBeLessThan(11_160_000); // was 12,307,339
    expect(codes(ledgerDiagnostics(inp))).toContain('INTEREST_ALREADY_RECORDED');
  });

  it('a market price on a later date still re-anchors after a coupon reset', () => {
    const b = inst('B', 'COP', { assetClass: 'bond', pricing: 'manual', accrual: { kind: 'fixed', annualRate: 0.1 } });
    const inp: EngineInput = {
      portfolio: pf(),
      instruments: [b],
      market: createMarketData({ prices: [], fx: [], manualPrices: [ps('B', 'COP', [['2024-09-01', 1010]])] }),
      transactions: [
        tx({ date: '2024-01-02', type: 'BUY', instrumentId: 'B', quantity: 1, price: 1000 }),
        tx({ date: '2024-07-02', type: 'INTEREST', instrumentId: 'B', amount: 48 }),
      ],
    };
    expect(valuePortfolio(inp, '2024-12-31').holdings[0]!.marketValue).toBeCloseTo(1010 * Math.pow(1.1, (isoToDay('2024-12-31') - isoToDay('2024-09-01')) / 365), 8);
  });
});

describe('C37 — real large moves are not rejected as outliers', () => {
  it('G4: trade-only prices, genuine +40 % in 6 weeks: used, flagged unconfirmed', () => {
    const inp: EngineInput = {
      portfolio: pf(),
      instruments: [inst('PE', 'COP', { pricing: 'manual', assetClass: 'fund' })],
      market: mkt(),
      transactions: [
        tx({ date: '2024-01-02', type: 'BUY', instrumentId: 'PE', quantity: 100, price: 100 }),
        tx({ date: '2024-02-15', type: 'BUY', instrumentId: 'PE', quantity: 10, price: 140 }),
      ],
      options: { asOf: '2024-02-29' },
    };
    expect(valuePortfolio(inp, '2024-02-29').totalMarketValueBase).toBe(15_400);
    expect(monthlyPerformance(inp)[1]!.twr).toBeCloseTo(0.4, 12);
    expect(codes(ledgerDiagnostics(inp))).toEqual(['TRADE_PRICE_UNCONFIRMED']);
  });

  it('G4b: BTC +45 % with month-end closes and no later close yet', () => {
    const inp: EngineInput = {
      portfolio: pf(),
      instruments: [inst('BTC', 'USD', { assetClass: 'crypto' })],
      market: mkt([ps('BTC', 'USD', [['2024-01-31', 40000]])], [fxs('USD', 'COP', [['2024-01-01', 4000]])]),
      transactions: [
        tx({ date: '2024-01-31', type: 'BUY', instrumentId: 'BTC', quantity: 1, price: 40000, currency: 'USD' }),
        tx({ date: '2024-02-28', type: 'BUY', instrumentId: 'BTC', quantity: 0.1, price: 58000, currency: 'USD' }),
      ],
      options: { asOf: '2024-02-29' },
    };
    expect(monthlyPerformance(inp)[1]!.twr).toBeCloseTo(0.45, 12);
  });

  it('a typo contradicted by the next close is still rejected (R2)', () => {
    const inp: EngineInput = {
      portfolio: pf(),
      instruments: [inst('X', 'COP', { pricing: 'manual' })],
      market: mkt([ps('X', 'COP', [['2024-01-31', 100], ['2024-03-31', 101]])]),
      transactions: [
        tx({ date: '2024-01-31', type: 'BUY', instrumentId: 'X', quantity: 1000, price: 100 }),
        tx({ date: '2024-02-10', type: 'BUY', instrumentId: 'X', quantity: 1, price: 1000 }),
      ],
      options: { asOf: '2024-03-31' },
    };
    expect(codes(ledgerDiagnostics(inp))).toEqual(['TRADE_PRICE_OUTLIER']);
    expect(Math.abs(monthlyPerformance(inp)[1]!.twr)).toBeLessThan(0.01);
  });
});

describe('C38 — restructurings: per-position TWR consistent with money return', () => {
  it('G2: ticker change OLD (last close 100) -> NEW (110): the gain belongs to NEW', () => {
    const inp: EngineInput = {
      portfolio: pf(),
      instruments: [inst('OLD', 'COP'), inst('NEW', 'COP')],
      market: mkt([ps('OLD', 'COP', [['2024-01-31', 100], ['2024-02-08', 100]]), ps('NEW', 'COP', [['2024-02-15', 110], ['2024-02-29', 110]])]),
      transactions: [
        tx({ date: '2024-01-31', type: 'BUY', instrumentId: 'OLD', quantity: 10, price: 100 }),
        tx({ date: '2024-02-15', type: 'SPLIT', subtype: 'TICKER_CHANGE', instrumentId: 'OLD', targetInstrumentId: 'NEW', ratio: 1 }),
      ],
      options: { asOf: '2024-02-29' },
    };
    expect(monthlyPerformance(inp)[1]!.twr).toBeCloseTo(0.1, 12);
    const pp = Object.fromEntries(positionPerformance(inp, 'MTD', '2024-02-29').map((p) => [p.instrumentId, p]));
    expect(pp.OLD!.totalReturnBase).toBeCloseTo(0, 9);
    expect(pp.OLD!.twr).toBeCloseTo(0, 12);
    expect(pp.NEW!.totalReturnBase).toBeCloseTo(100, 9);
    expect(pp.NEW!.twr).toBeCloseTo(0.1, 12);
  });

  it('G1: corporate actions on flow days (reverse split + cash in lieu, USD split, bonificação)', () => {
    const a: EngineInput = {
      portfolio: pf(),
      instruments: [inst('A', 'COP')],
      market: mkt([ps('A', 'COP', [['2024-01-31', 10], ['2024-02-15', 30], ['2024-02-29', 30]])]),
      transactions: [
        tx({ date: '2024-01-31', type: 'BUY', instrumentId: 'A', quantity: 10, price: 10 }),
        tx({ date: '2024-02-15', type: 'SPLIT', instrumentId: 'A', ratio: 1 / 3, amount: 10 }),
        tx({ date: '2024-02-15', type: 'DEPOSIT', amount: 500 }),
      ],
      options: { asOf: '2024-02-29' },
    };
    expect(monthlyPerformance(a)[1]!.twr).toBeCloseTo(0, 9);
    const b: EngineInput = {
      portfolio: pf(),
      instruments: [inst('N', 'USD')],
      market: mkt([ps('N', 'USD', [['2024-01-31', 400], ['2024-02-15', 100], ['2024-02-29', 100]])], [fxs('USD', 'COP', [['2024-01-31', 4000], ['2024-02-15', 4100], ['2024-02-29', 4200]])]),
      transactions: [
        tx({ date: '2024-01-31', type: 'BUY', instrumentId: 'N', quantity: 1, price: 400, currency: 'USD' }),
        tx({ date: '2024-02-15', type: 'SPLIT', instrumentId: 'N', ratio: 4, currency: 'USD' }),
        tx({ date: '2024-02-15', type: 'BUY', instrumentId: 'N', quantity: 2, price: 100, currency: 'USD' }),
      ],
      options: { asOf: '2024-02-29' },
    };
    const rb = monthlyPerformance(b)[1]!;
    expect(rb.twr).toBeCloseTo(0.05, 9);
    expect(rb.localReturn).toBeCloseTo(0, 9);
    expect(positionPerformance(b, 'MTD', '2024-02-29')[0]!.twr).toBeCloseTo(0.05, 9);
    const c: EngineInput = {
      portfolio: pf('BRL'),
      instruments: [inst('B', 'BRL')],
      market: mkt([ps('B', 'BRL', [['2024-01-31', 11], ['2024-02-15', 10], ['2024-02-29', 10]])]),
      transactions: [
        tx({ date: '2024-01-31', type: 'BUY', instrumentId: 'B', quantity: 100, price: 11, currency: 'BRL' }),
        tx({ date: '2024-02-15', type: 'STOCK_DIVIDEND', instrumentId: 'B', ratio: 0.1, currency: 'BRL' }),
        tx({ date: '2024-02-15', type: 'SELL', instrumentId: 'B', quantity: 110, price: 10, currency: 'BRL' }),
        tx({ date: '2024-02-15', type: 'WITHDRAWAL', amount: 1100, currency: 'BRL' }),
      ],
      options: { asOf: '2024-02-29' },
    };
    expect(monthlyPerformance(c)[1]!.twr).toBeCloseTo(0, 9);
  });
});

describe('C39/C40 — late redemption; exempt net values', () => {
  it('G3a: a redemption recorded 8 business days after maturity replaces the estimate', () => {
    const cdt = inst('C1', 'COP', { assetClass: 'fixed_income', pricing: 'manual', accrual: { kind: 'fixed', annualRate: 0.12, maturity: '2025-01-03' } });
    const inp: EngineInput = {
      portfolio: pf(),
      instruments: [cdt],
      market: mkt(),
      transactions: [
        tx({ date: '2024-01-03', type: 'BUY', instrumentId: 'C1', quantity: 1, price: 10_000_000 }),
        tx({ date: '2025-01-16', type: 'SELL', instrumentId: 'C1', quantity: 1, price: 11_200_000, taxes: 48_000 }),
      ],
    };
    expect(valuePortfolio(inp, '2025-01-31').cash[0]!.amount).toBe(11_152_000);
    expect(codes(ledgerDiagnostics(inp))).toEqual(['LATE_REDEMPTION']);
    expect(realizedGains(inp).every((r) => !r.estimated)).toBe(true);
  });

  it('H3 / mixed: exempt instruments carry net = gross and tax 0; totals add up', () => {
    const cdb = inst('CDB', 'BRL', { assetClass: 'fixed_income', pricing: 'manual', accrual: { kind: 'fixed', annualRate: 0.12 } });
    const lci = inst('LCI', 'BRL', { assetClass: 'fixed_income', pricing: 'manual', accrual: { kind: 'fixed', annualRate: 0.1, taxRegime: 'EXEMPT' } });
    const txs = [
      tx({ date: '2024-01-02', type: 'BUY', instrumentId: 'CDB', quantity: 1, price: 10_000, currency: 'BRL' }),
      tx({ date: '2024-01-02', type: 'BUY', instrumentId: 'LCI', quantity: 1, price: 10_000, currency: 'BRL' }),
    ];
    const only = valuePortfolio({ portfolio: pf('BRL'), transactions: [txs[1]!], instruments: [lci], market: mkt() }, '2024-07-01');
    expect(only.holdings[0]!.accruedTaxBase).toBe(0);
    expect(only.totalNetMarketValueBase).toBe(only.totalMarketValueBase);
    const v = valuePortfolio({ portfolio: pf('BRL'), transactions: txs, instruments: [cdb, lci], market: mkt() }, '2024-07-20');
    const c = v.holdings.find((h) => h.instrumentId === 'CDB')!;
    const l = v.holdings.find((h) => h.instrumentId === 'LCI')!;
    expect(v.totalNetMarketValueBase).toBeCloseTo(c.netMarketValueBase! + l.netMarketValueBase!, 9);
  });
});

describe('C41 — mutable custom MarketData and hashing cost', () => {
  it('H5: a custom MarketData updated in place is never served from the cache', () => {
    const store = new Map<string, number>([['2024-01-02', 100]]);
    const custom: MarketData = {
      price: (_id, date) => {
        let best: number | undefined;
        for (const [d, p] of store) if (d <= date) best = p;
        return best;
      },
      fx: (a, b) => (a === b ? 1 : undefined),
    };
    const input: EngineInput = { portfolio: pf(), transactions: [tx({ date: '2024-01-02', type: 'BUY', instrumentId: 'X', quantity: 10, price: 100 })], instruments: [inst('X', 'COP')], market: custom };
    expect(valuePortfolio(input, '2024-02-29').totalMarketValueBase).toBe(1000);
    store.set('2024-02-29', 150);
    expect(valuePortfolio(input, '2024-02-29').totalMarketValueBase).toBe(1500);
    expect(inputHash(input)).toBeUndefined();
    // with a revision the cache is used and invalidated by bumping it
    const versioned: MarketData = { ...custom, revision: 1 };
    const vin = { ...input, market: versioned };
    expect(inputHash(vin)).toBeDefined();
    const h1 = inputHash(vin);
    versioned.revision = 2;
    expect(inputHash(vin)).not.toBe(h1);
  });

  it('repeated hashing of 30,000 unchanged rows is cheap; edits are still detected', () => {
    const txs = Array.from({ length: 30_000 }, (_, k) => tx({ date: addDays('2015-01-02', Math.floor(k / 11)), type: 'BUY', instrumentId: `I${k % 150}`, quantity: 1, price: 100 }));
    const input: EngineInput = { portfolio: pf(), transactions: txs, instruments: [], market: mkt() };
    const c0 = performance.now();
    const first = inputHash(input); // cold: fingerprints every row
    const cold = performance.now() - c0;
    const t0 = performance.now();
    for (let i = 0; i < 10; i++) inputHash(input);
    const warm = (performance.now() - t0) / 10;
    // machine-independent guard: warm calls only compare fields (no re-hashing)
    expect(warm).toBeLessThan(Math.max(cold, 5));
    expect(warm).toBeLessThan(100);
    expect(inputHash(input)).toBe(first);
    txs[12_345]!.price = 101;
    expect(inputHash(input)).not.toBe(first);
  });
});
