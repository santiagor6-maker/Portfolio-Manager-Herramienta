/**
 * Regression tests from the round-2 external review (reviews/core-r2.md). Scenario ids follow
 * the reviewer's scripts r2-a ... r2-f; finding ids C4, C22 ... C35 follow the report.
 */
import { describe, expect, it } from 'vitest';
import {
  applyCorporateActions,
  createEngine,
  createMarketData,
  goalProjection,
  goalProjectionForPortfolio,
  ledgerDiagnostics,
  monthlyPerformance,
  performanceSummary,
  positionPerformance,
  realizedGains,
  valuePortfolio,
  externalFlows,
} from './api';
import type { EngineInput } from './api';
import { businessDaysIn, easter, holidaysOfYear } from './calendars';
import { addDays, dayToIso, isoToDay, todayIso } from './dates';
import type { CorporateAction, CostMethod, FxSeries, IndexSeries, Instrument, PriceSeries, Transaction } from './types';

const pf = (base = 'COP', costMethod: CostMethod = 'FIFO') => ({ id: 'p', name: 'p', baseCurrency: base, costMethod, createdAt: '2020-01-01' });
let n = 0;
const tx = (t: Partial<Transaction> & Pick<Transaction, 'date' | 'type'>): Transaction => ({ id: `q${++n}`, portfolioId: 'p', currency: 'COP', ...t });
const inst = (id: string, currency: string, extra: Partial<Instrument> = {}): Instrument => ({ id, symbol: id, name: id, exchange: 'X', currency, country: currency === 'BRL' ? 'BR' : currency === 'COP' ? 'CO' : 'US', assetClass: 'equity', ...extra });
const ps = (instrumentId: string, currency: string, pts: [string, number][]): PriceSeries => ({ instrumentId, currency, source: 'manual', points: pts.map(([date, close]) => ({ date, close })) });
const fxs = (base: string, quote: string, pts: [string, number][]): FxSeries => ({ base, quote, source: 'manual', points: pts.map(([date, rate]) => ({ date, rate })) });
const mkt = (prices: PriceSeries[], fx: FxSeries[] = [], indexSeries: IndexSeries[] = []) => createMarketData({ prices, fx, indexSeries });
const codes = (xs: { code: string }[]) => xs.map((x) => x.code);
const weekdays = (from: string, to: string) => {
  const o: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const w = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (w !== 0 && w !== 6) o.push(d);
  }
  return o;
};

describe('C22 — corporate action on a flow day', () => {
  it('R1a: split + buy on the ex-date, flat post-split price: TWR 0 (table, summary, position)', () => {
    const inp: EngineInput = {
      portfolio: pf(),
      instruments: [inst('A', 'COP')],
      market: mkt([ps('A', 'COP', [['2024-01-31', 100], ['2024-02-15', 50], ['2024-02-29', 50]])]),
      transactions: [
        tx({ date: '2024-01-31', type: 'BUY', instrumentId: 'A', quantity: 10, price: 100 }),
        tx({ date: '2024-02-15', type: 'SPLIT', instrumentId: 'A', ratio: 2 }),
        tx({ date: '2024-02-15', type: 'BUY', instrumentId: 'A', quantity: 10, price: 50 }),
      ],
      options: { asOf: '2024-02-29' },
    };
    expect(monthlyPerformance(inp)[1]!.twr).toBeCloseTo(0, 12);
    expect(performanceSummary(inp, 'MTD', '2024-02-29').twr).toBeCloseTo(0, 12);
    expect(positionPerformance(inp, 'MTD', '2024-02-29')[0]!.twr).toBeCloseTo(0, 12);
  });

  it('R1b: split + deposit on the same day', () => {
    const inp: EngineInput = {
      portfolio: pf(),
      instruments: [inst('A', 'COP')],
      market: mkt([ps('A', 'COP', [['2024-01-31', 100], ['2024-02-15', 50], ['2024-02-29', 50]])]),
      transactions: [
        tx({ date: '2024-01-31', type: 'BUY', instrumentId: 'A', quantity: 10, price: 100 }),
        tx({ date: '2024-02-15', type: 'SPLIT', instrumentId: 'A', ratio: 2 }),
        tx({ date: '2024-02-15', type: 'DEPOSIT', amount: 500 }),
      ],
      options: { asOf: '2024-02-29' },
    };
    expect(monthlyPerformance(inp)[1]!.twr).toBeCloseTo(0, 12);
  });

  it('R1c: spin-off (100 -> 80 + 20) + deposit on the same day', () => {
    const inp: EngineInput = {
      portfolio: pf(),
      instruments: [inst('P', 'COP'), inst('S', 'COP')],
      market: mkt([ps('P', 'COP', [['2024-01-31', 100], ['2024-02-15', 80], ['2024-02-29', 80]]), ps('S', 'COP', [['2024-02-15', 20], ['2024-02-29', 20]])]),
      transactions: [
        tx({ date: '2024-01-31', type: 'BUY', instrumentId: 'P', quantity: 10, price: 100 }),
        tx({ date: '2024-02-15', type: 'SPLIT', subtype: 'SPINOFF', instrumentId: 'P', targetInstrumentId: 'S', ratio: 1, costFraction: 0.2 }),
        tx({ date: '2024-02-15', type: 'DEPOSIT', amount: 1000 }),
      ],
      options: { asOf: '2024-02-29' },
    };
    expect(monthlyPerformance(inp)[1]!.twr).toBeCloseTo(0, 12);
    expect(performanceSummary(inp, 'MTD', '2024-02-29').twr).toBeCloseTo(0, 12);
    const pos = positionPerformance(inp, 'SI', '2024-02-29');
    expect(pos.find((p) => p.instrumentId === 'P')!.twr).toBeCloseTo(0, 12);
    expect(pos.find((p) => p.instrumentId === 'S')!.twr).toBeCloseTo(0, 12);
  });
});

describe('C23 — cache safety', () => {
  const instruments = [inst('X', 'COP')];
  const market = mkt([ps('X', 'COP', [['2024-01-02', 100], ['2024-02-29', 120]])]);

  it('E1: in-place edits of transactions are reflected', () => {
    const txs = [tx({ date: '2024-01-02', type: 'BUY', instrumentId: 'X', quantity: 10, price: 100 })];
    const input = { portfolio: pf(), transactions: txs, instruments, market, options: { asOf: '2024-02-29' } };
    expect(valuePortfolio(input, '2024-02-29').holdings[0]!.quantity).toBe(10);
    txs[0]!.quantity = 20;
    expect(valuePortfolio(input, '2024-02-29').holdings[0]!.quantity).toBe(20);
    txs[0] = tx({ date: '2024-01-02', type: 'BUY', instrumentId: 'X', quantity: 30, price: 100 });
    expect(valuePortfolio(input, '2024-02-29').holdings[0]!.quantity).toBe(30);
  });

  it('E2/E4: options.asOf and portfolio.baseCurrency mutated in place', () => {
    const options: { asOf: string } = { asOf: '2024-01-31' };
    const input = { portfolio: pf(), transactions: [tx({ date: '2024-01-02', type: 'BUY', instrumentId: 'X', quantity: 10, price: 100 })], instruments, market, options };
    expect(monthlyPerformance(input)).toHaveLength(1);
    options.asOf = '2024-02-29';
    expect(monthlyPerformance(input)).toHaveLength(2);
    const portfolio = pf('COP');
    const usd = { portfolio, transactions: [tx({ date: '2024-01-02', type: 'DEPOSIT', amount: 1000, currency: 'USD' })], instruments: [], market: mkt([], [fxs('USD', 'COP', [['2024-01-01', 4000]])]) };
    expect(valuePortfolio(usd, '2024-01-31').totalMarketValueBase).toBe(4_000_000);
    portfolio.baseCurrency = 'USD';
    expect(valuePortfolio(usd, '2024-01-31').totalMarketValueBase).toBe(1000);
  });

  it('E3: mutating returned objects does not corrupt later results', () => {
    const input = { portfolio: pf(), transactions: [tx({ date: '2024-01-02', type: 'BUY', instrumentId: 'X', quantity: 10, price: 100 })], instruments, market, options: { asOf: '2024-02-29' } };
    monthlyPerformance(input).reverse();
    expect(monthlyPerformance(input)[0]!.month).toBe('2024-01');
    valuePortfolio(input, '2024-02-29').holdings[0]!.quantity = 999;
    expect(valuePortfolio(input, '2024-02-29').holdings[0]!.quantity).toBe(10);
    ledgerDiagnostics(input).push({ date: '', code: 'X', message: '' });
    expect(ledgerDiagnostics(input)).toHaveLength(0);
  });

  it('createEngine takes a snapshot: later edits do not leak into it', () => {
    const txs = [tx({ date: '2024-01-02', type: 'BUY', instrumentId: 'X', quantity: 10, price: 100 })];
    const eng = createEngine({ portfolio: pf(), transactions: txs, instruments, market });
    txs[0]!.quantity = 50;
    expect(eng.valuation('2024-02-29').holdings[0]!.quantity).toBe(10);
  });
});

describe('C24 — maturity reconciles with the recorded payment', () => {
  it('F2: maturity on Saturday, payment recorded Monday net of 4 % withholding: no auto-redemption', () => {
    const cdt = inst('CDT2', 'COP', { assetClass: 'fixed_income', pricing: 'manual', accrual: { kind: 'fixed', annualRate: 0.12, maturity: '2025-01-04' } });
    const inp: EngineInput = {
      portfolio: pf(),
      instruments: [cdt],
      market: mkt([]),
      transactions: [
        tx({ date: '2024-01-04', type: 'BUY', instrumentId: 'CDT2', quantity: 1, price: 10_000_000 }),
        tx({ date: '2025-01-06', type: 'SELL', instrumentId: 'CDT2', quantity: 1, price: 11_200_000, taxes: 48_000 }),
      ],
      options: { asOf: '2025-01-31' },
    };
    expect(valuePortfolio(inp, '2025-01-31').cash[0]!.amount).toBe(11_152_000);
    expect(codes(ledgerDiagnostics(inp))).toEqual([]);
    const r = realizedGains(inp);
    expect(r).toHaveLength(1);
    expect(r[0]!.estimated).toBeUndefined();
    expect(r[0]!.gain).toBe(1_152_000);
    // between maturity and payment the value stays at the maturity value (accrual stopped)
    const maturityValue = 10_000_000 * Math.pow(1.12, 366 / 365);
    expect(valuePortfolio(inp, '2025-01-05').holdings[0]!.marketValue).toBeCloseTo(maturityValue, 4);
  });

  it('F1: without a recorded payment the redemption is automatic, estimated and net of withholding', () => {
    const cdt = inst('CDT1', 'COP', { assetClass: 'fixed_income', pricing: 'manual', accrual: { kind: 'fixed', annualRate: 0.12, maturity: '2025-01-02' } });
    const inp: EngineInput = { portfolio: pf(), instruments: [cdt], market: mkt([]), transactions: [tx({ date: '2024-01-02', type: 'BUY', instrumentId: 'CDT1', quantity: 1, price: 10_000_000 })] };
    const gross = 10_000_000 * Math.pow(1.12, 366 / 365); // ACT/365 over a leap year
    const net = gross - 0.04 * (gross - 10_000_000);
    expect(valuePortfolio(inp, '2025-01-10').cash[0]!.amount).toBeCloseTo(net, 4);
    const r = realizedGains(inp)[0]!;
    expect(r).toMatchObject({ sellDate: '2025-01-02', estimated: true });
    expect(r.gain).toBeCloseTo(net - 10_000_000, 4);
    // an ACT/ACT CDT pays exactly 12 % over one calendar year
    const actact = { ...inp, instruments: [{ ...cdt, accrual: { ...cdt.accrual!, dayCount: 'ACT/ACT' as const, taxRegime: 'NONE' as const } }] };
    expect(valuePortfolio(actact, '2025-01-10').cash[0]!.amount).toBeCloseTo(11_200_000, 4);
  });
});

describe('C25 — outlier trade prices', () => {
  it('R2: a typo (1 share at 1000 vs 100) is not used as a price and is reported', () => {
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
    const r = monthlyPerformance(inp);
    expect(r[1]!.endValueBase).toBe(100_100);
    expect(Math.abs(r[1]!.twr)).toBeLessThan(0.01); // the 900 overpaid is a small loss, not +900 %
    expect(r[2]!.twr).toBeCloseTo(0.01, 12);
    expect(codes(ledgerDiagnostics(inp))).toContain('TRADE_PRICE_OUTLIER');
  });

  it('a genuine large move confirmed by the next close is accepted', () => {
    const inp: EngineInput = {
      portfolio: pf(),
      instruments: [inst('X', 'COP')],
      market: mkt([ps('X', 'COP', [['2024-01-31', 100], ['2024-02-29', 190]])]),
      transactions: [
        tx({ date: '2024-01-31', type: 'BUY', instrumentId: 'X', quantity: 10, price: 100 }),
        tx({ date: '2024-02-20', type: 'BUY', instrumentId: 'X', quantity: 10, price: 185 }),
      ],
      options: { asOf: '2024-02-29' },
    };
    expect(codes(ledgerDiagnostics(inp))).not.toContain('TRADE_PRICE_OUTLIER');
    expect(monthlyPerformance(inp)[1]!.twr).toBeCloseTo(0.9, 12);
  });
});

describe('C26/C27/C28 — corporate actions', () => {
  it('K1: JCP and dividend with the same ex-date are both suggested; JCP with 15 % withholding', () => {
    const r = applyCorporateActions(
      [tx({ date: '2024-01-02', type: 'BUY', instrumentId: 'ITUB4', quantity: 100, price: 30, currency: 'BRL' })],
      [
        { instrumentId: 'ITUB4', date: '2024-03-01', payDate: '2024-04-01', type: 'DIVIDEND', subtype: 'JCP', amountPerShare: 0.2, currency: 'BRL' },
        { instrumentId: 'ITUB4', date: '2024-03-01', payDate: '2024-04-01', type: 'DIVIDEND', amountPerShare: 0.5, currency: 'BRL' },
      ],
      [inst('ITUB4', 'BRL')],
    );
    expect(r.suggested.map((t) => [t.subtype ?? 'DIV', t.amount, t.taxes ?? 0])).toEqual([
      ['JCP', 20, 3],
      ['DIV', 50, 0],
    ]);
  });

  it('K2/K3: monthly FII and dividend after a split', () => {
    const k2 = applyCorporateActions(
      [
        tx({ date: '2024-01-02', type: 'BUY', instrumentId: 'HGLG11', quantity: 10, price: 160, currency: 'BRL' }),
        tx({ date: '2024-02-14', type: 'DIVIDEND', instrumentId: 'HGLG11', amount: 11, currency: 'BRL' }),
      ],
      [
        { instrumentId: 'HGLG11', date: '2024-01-31', payDate: '2024-02-14', type: 'DIVIDEND', amountPerShare: 1.1 },
        { instrumentId: 'HGLG11', date: '2024-02-29', payDate: '2024-03-14', type: 'DIVIDEND', amountPerShare: 1.1 },
      ],
      [inst('HGLG11', 'BRL', { assetClass: 'reit' })],
    );
    expect(k2.suggested.map((t) => t.date)).toEqual(['2024-03-14']);
    const k3 = applyCorporateActions(
      [tx({ date: '2024-01-02', type: 'BUY', instrumentId: 'A', quantity: 10, price: 100, currency: 'USD' }), tx({ date: '2024-06-10', type: 'SPLIT', instrumentId: 'A', ratio: 10, currency: 'USD' })],
      [{ instrumentId: 'A', date: '2024-06-12', type: 'DIVIDEND', amountPerShare: 0.01, currency: 'USD' }],
      [inst('A', 'USD')],
    );
    expect(k3.suggested[0]!.quantity).toBe(100);
    expect(k3.suggested[0]!.taxes).toBeCloseTo(0.3, 9); // US-source dividend: 30 % suggested
  });

  it('K6: 30,000 transactions x 2,000 actions in well under a second', () => {
    const instruments = Array.from({ length: 100 }, (_, i) => inst(`I${i}`, 'USD'));
    const txs: Transaction[] = [];
    for (let k = 0; k < 30_000; k++) txs.push(tx({ date: addDays('2012-01-02', Math.floor(k / 6)), type: 'BUY', instrumentId: `I${k % 100}`, quantity: 1, price: 10, currency: 'USD' }));
    const actions: CorporateAction[] = [];
    for (let k = 0; k < 2000; k++) actions.push({ instrumentId: `I${k % 100}`, date: addDays('2012-03-01', k * 2), type: 'DIVIDEND', amountPerShare: 0.1, currency: 'USD' });
    const t0 = performance.now();
    const r = applyCorporateActions(txs, actions, instruments);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(r.suggested).toHaveLength(2000);
  });

  it('K5 / C28: merger cash is a partial disposal of the parent; per-position results are attributed correctly', () => {
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
    const rg = realizedGains(inp);
    expect(rg.reduce((s, r) => s + r.gain, 0)).toBeCloseTo(70, 9);
    // merger: cash 20 vs 5 B at 196 = 980 -> 2 % of the cost (20) is realized against the cash
    const mergerRow = rg.find((r) => r.instrumentId === 'A')!;
    expect(mergerRow.cost).toBeCloseTo(20, 9);
    expect(rg.every((r) => r.openDate === '2024-01-02')).toBe(true);
    const pos = Object.fromEntries(positionPerformance(inp, 'SI', '2024-04-30').map((p) => [p.instrumentId, p]));
    expect(pos.A!.totalReturnBase).toBeCloseTo(0, 9); // 1000 -> 980 in B + 20 cash
    expect(pos.A!.twr).toBeCloseTo(0, 12);
    expect(pos.B!.totalReturnBase).toBeCloseTo(20, 9); // 196 -> 200
    expect(pos.C!.totalReturnBase).toBeCloseTo(50, 9); // 200 -> 210
  });

  it('market-data conventions: COUPON -> INTEREST; MERGER + EXTRAORDINARY cash (CPLE6)', () => {
    const r = applyCorporateActions(
      [
        tx({ date: '2024-01-02', type: 'BUY', instrumentId: 'NTNB35', quantity: 2, price: 4200, currency: 'BRL' }),
        tx({ date: '2024-01-02', type: 'BUY', instrumentId: 'CPLE6', quantity: 1000, price: 10, currency: 'BRL' }),
      ],
      [
        { instrumentId: 'NTNB35', date: '2024-05-15', type: 'DIVIDEND', subtype: 'COUPON', amountPerShare: 120.5, currency: 'BRL' },
        { instrumentId: 'CPLE6', date: '2024-08-01', type: 'DIVIDEND', subtype: 'EXTRAORDINARY', amountPerShare: 0.7749, currency: 'BRL' },
        { instrumentId: 'CPLE6', date: '2024-08-01', type: 'SPLIT', subtype: 'MERGER', ratio: 1, targetInstrumentId: 'CPLE3' },
      ],
      [inst('NTNB35', 'BRL', { assetClass: 'bond' }), inst('CPLE6', 'BRL'), inst('CPLE3', 'BRL')],
    );
    const coupon = r.suggested.find((t) => t.instrumentId === 'NTNB35')!;
    expect(coupon).toMatchObject({ type: 'INTEREST', subtype: 'COUPON', amount: 241 });
    const merger = r.suggested.find((t) => t.instrumentId === 'CPLE6')!;
    expect(merger).toMatchObject({ type: 'SPLIT', subtype: 'MERGER', targetInstrumentId: 'CPLE3', amount: 774.9 });
    expect(r.suggested.filter((t) => t.instrumentId === 'CPLE6')).toHaveLength(1);
    expect(r.skipped.map((s) => s.reason)).toEqual(['ABSORBED_IN_MERGER']);
  });
});

describe('C29 — holiday calendars', () => {
  it('Easter, Brazilian (ANBIMA) and Colombian (Ley Emiliani) holidays', () => {
    expect(dayToIso(easter(2024))).toBe('2024-03-31');
    expect(dayToIso(easter(2025))).toBe('2025-04-20');
    expect(holidaysOfYear('CO', 2024).map(dayToIso)).toEqual([
      '2024-01-01', '2024-01-08', '2024-03-25', '2024-03-28', '2024-03-29', '2024-05-01', '2024-05-13', '2024-06-03', '2024-06-10',
      '2024-07-01', '2024-07-20', '2024-08-07', '2024-08-19', '2024-10-14', '2024-11-04', '2024-11-11', '2024-12-08', '2024-12-25',
    ]);
    expect(holidaysOfYear('BR', 2024).map(dayToIso)).toContain('2024-02-13'); // Carnival
    expect(holidaysOfYear('BR', 2024).map(dayToIso)).toContain('2024-05-30'); // Corpus Christi
    expect(holidaysOfYear('BR', 2024).map(dayToIso)).toContain('2024-11-20'); // Consciência Negra
    expect(businessDaysIn(isoToDay('2023-12-31'), isoToDay('2024-12-31'), 'BR')).toBe(253);
  });

  it('F5: prefixado 12 % a.a. BUS/252 uses ANBIMA business days', () => {
    const inp: EngineInput = {
      portfolio: pf('BRL'),
      instruments: [inst('PRE', 'BRL', { assetClass: 'fixed_income', pricing: 'manual', accrual: { kind: 'fixed', annualRate: 0.12 } })],
      market: mkt([]),
      transactions: [tx({ date: '2024-01-02', type: 'BUY', instrumentId: 'PRE', quantity: 1, price: 10_000, currency: 'BRL' })],
    };
    const du = businessDaysIn(isoToDay('2024-01-02'), isoToDay('2025-01-02'), 'BR');
    expect(du).toBe(253);
    expect(valuePortfolio(inp, '2025-01-02').totalMarketValueBase).toBeCloseTo(10_000 * Math.pow(1.12, du / 252), 8);
  });
});

describe('C33 — % of an annual-rate index scales the daily rate', () => {
  it('F4: 110 % of CDI 14.5 % a.a. (SGS 4389) = (1 + 1.1 x daily)^du', () => {
    const idx: IndexSeries = { id: 'CDI', kind: 'annualRate', unit: 'decimal', dayCount: 'BUS/252', source: 't', points: [{ date: '2024-01-01', value: 0.145 }] };
    const inp: EngineInput = {
      portfolio: pf('BRL'),
      instruments: [inst('CDB2', 'BRL', { assetClass: 'fixed_income', pricing: 'manual', accrual: { kind: 'indexed', index: 'CDI', percentOfIndex: 1.1, taxRegime: 'NONE' } })],
      market: mkt([], [], [idx]),
      transactions: [tx({ date: '2024-01-02', type: 'BUY', instrumentId: 'CDB2', quantity: 1, price: 10_000, currency: 'BRL' })],
      options: { asOf: '2024-12-31' },
    };
    const du = businessDaysIn(isoToDay('2024-01-02'), isoToDay('2024-12-31'), 'BR');
    const daily = Math.pow(1.145, 1 / 252) - 1;
    expect(valuePortfolio(inp, '2024-12-31').totalMarketValueBase).toBeCloseTo(10_000 * Math.pow(1 + 1.1 * daily, du), 6);
  });

  it('F3 / I1: a 110 % CDB shows ~110 % do CDI with a daily CDI series', () => {
    const days = weekdays('2023-06-01', '2024-12-31');
    const idx: IndexSeries = { id: 'CDI', kind: 'periodRate', period: 'day', unit: 'percent', source: 't', points: days.map((date) => ({ date, value: 0.04 })) };
    const inp: EngineInput = {
      portfolio: pf('BRL'),
      instruments: [inst('CDB1', 'BRL', { assetClass: 'fixed_income', pricing: 'manual', accrual: { kind: 'indexed', index: 'CDI', percentOfIndex: 110 } })],
      market: mkt([], [], [idx]),
      transactions: [tx({ date: '2024-01-02', type: 'BUY', instrumentId: 'CDB1', quantity: 1, price: 10_000, currency: 'BRL' })],
      options: { asOf: '2024-12-31' },
    };
    const s = performanceSummary(inp, 'YTD', '2024-12-31');
    expect(s.percentOfIndex!.CDI).toBeGreaterThan(1.09);
    expect(s.percentOfIndex!.CDI).toBeLessThan(1.11);
  });
});

describe('C31 — net-of-tax value of fixed income', () => {
  it('Brazilian CDB: IR regressive by holding period, IOF in the first 30 days', () => {
    const cdb = inst('CDB9', 'BRL', { assetClass: 'fixed_income', pricing: 'manual', accrual: { kind: 'fixed', annualRate: 0.12 } });
    const inp: EngineInput = { portfolio: pf('BRL'), instruments: [cdb], market: mkt([]), transactions: [tx({ date: '2024-01-02', type: 'BUY', instrumentId: 'CDB9', quantity: 1, price: 10_000, currency: 'BRL' })] };
    const h = valuePortfolio(inp, '2024-07-01').holdings[0]!; // 181 days -> 20 %
    const gain = h.marketValue! - 10_000;
    expect(h.accruedTaxBase).toBeCloseTo(0.2 * gain, 9);
    expect(h.netMarketValueBase).toBeCloseTo(h.marketValueBase! - 0.2 * gain, 9);
    const early = valuePortfolio(inp, '2024-01-12').holdings[0]!; // 10 days: IOF 66 %, then IR 22.5 %
    const g10 = early.marketValue! - 10_000;
    expect(early.accruedTaxBase).toBeCloseTo(g10 * 0.66 + g10 * (1 - 0.66) * 0.225, 9);
    const lci = { ...inp, instruments: [{ ...cdb, accrual: { ...cdb.accrual!, taxRegime: 'EXEMPT' as const } }] };
    expect(valuePortfolio(lci, '2024-07-01').holdings[0]!.accruedTaxBase).toBeUndefined();
  });

  it('Colombian CDT: 4 % retención on the accrued interest; valuation total net', () => {
    const cdt = inst('CDT', 'COP', { assetClass: 'fixed_income', pricing: 'manual', accrual: { kind: 'fixed', annualRate: 0.1 } });
    const v = valuePortfolio({ portfolio: pf(), instruments: [cdt], market: mkt([]), transactions: [tx({ date: '2024-01-02', type: 'BUY', instrumentId: 'CDT', quantity: 1, price: 1_000_000 })] }, '2024-12-31');
    const h = v.holdings[0]!;
    expect(h.accruedTaxBase).toBeCloseTo(0.04 * (h.marketValue! - 1_000_000), 9);
    expect(v.totalNetMarketValueBase).toBeCloseTo(v.totalMarketValueBase - h.accruedTaxBase!, 9);
  });
});

describe('C4/C32 — inflation "to date" and IPCA+ accrual in unpublished months', () => {
  const months: { date: string; value: number }[] = [];
  for (let m = 1; m <= 15; m++) months.push({ date: `${m <= 12 ? 2023 : 2024}-${String(((m - 1) % 12) + 1).padStart(2, '0')}-01`, value: 0.4 });
  const ipca: IndexSeries = { id: 'IPCA', kind: 'periodRate', period: 'month', unit: 'percent', source: 't', points: months }; // through 2024-03
  const ntnb = inst('IPCA6', 'BRL', { assetClass: 'fixed_income', pricing: 'manual', accrual: { kind: 'indexed', index: 'IPCA', spread: 0.06, dayCount: 'BUS/252' } });
  const inp: EngineInput = {
    portfolio: pf('BRL'),
    instruments: [ntnb],
    market: mkt([], [], [ipca]),
    transactions: [tx({ date: '2023-12-29', type: 'BUY', instrumentId: 'IPCA6', quantity: 1, price: 10_000, currency: 'BRL' })],
    options: { asOf: '2024-04-30' },
  };

  it('I2: real TWR since inception exists, marked estimated, with inflationThrough', () => {
    const s = performanceSummary(inp, 'SI', '2024-04-30');
    expect(s.realTwr).toBeDefined();
    expect(s.inflationEstimated).toBe(true);
    expect(s.inflationThrough).toBe('2024-03-31');
    const rows = monthlyPerformance(inp);
    expect(rows.at(-1)!.inflationEstimated).toBe(true);
    expect(rows.find((r) => r.month === '2024-03')!.inflationEstimated).toBeUndefined();
  });

  it('F6: IPCA+ keeps accruing inflation in April (projected) and is flagged estimated', () => {
    const v31 = valuePortfolio(inp, '2024-03-31');
    const v30 = valuePortfolio(inp, '2024-04-30');
    expect(v31.holdings[0]!.estimated).toBeUndefined();
    expect(v30.holdings[0]!.estimated).toBe(true);
    expect(v30.estimatedIndex).toEqual(['IPCA']);
    const du = businessDaysIn(isoToDay('2024-03-31'), isoToDay('2024-04-30'), 'BR');
    // April growth = projected IPCA (0.4 % per month, daily geometric) x 6 % real over du/252
    const expected = v31.holdings[0]!.marketValue! * Math.pow(1.004, 30 / 31) * Math.pow(1.06, du / 252);
    expect(v30.holdings[0]!.marketValue).toBeCloseTo(expected, 6);
  });

  it('I3: real return with the DANE IPC level', () => {
    const ipc: IndexSeries = { id: 'IPC_CO', kind: 'level', source: 't', points: [{ date: '2023-12-31', value: 137.72 }, { date: '2024-01-31', value: 138.98 }, { date: '2024-02-29', value: 140.49 }] };
    const rows = monthlyPerformance({
      portfolio: pf('COP'),
      instruments: [inst('EC', 'COP')],
      market: mkt([ps('EC', 'COP', [['2023-12-29', 2000], ['2024-01-31', 2100], ['2024-02-29', 2100]])], [], [ipc]),
      transactions: [tx({ date: '2023-12-29', type: 'BUY', instrumentId: 'EC', quantity: 100, price: 2000 })],
      options: { asOf: '2024-02-29' },
    });
    expect(rows.find((r) => r.month === '2024-01')!.realTwr).toBeCloseTo(1.05 / (138.98 / 137.72) - 1, 12);
  });
});

describe('C30/C34 — accounts and dates', () => {
  it('E5: implicit FX never takes cash from another account; per-account views add up', () => {
    const input: EngineInput = {
      portfolio: pf(),
      instruments: [inst('AAPL', 'USD')],
      market: mkt([ps('AAPL', 'USD', [['2024-01-01', 100]])], [fxs('USD', 'COP', [['2024-01-01', 4000]])]),
      transactions: [
        tx({ date: '2024-01-05', type: 'DEPOSIT', amount: 4_000_000, account: 'Trii' }),
        tx({ date: '2024-01-06', type: 'BUY', instrumentId: 'AAPL', quantity: 10, price: 100, currency: 'USD', account: 'IBKR' }),
      ],
    };
    const all = valuePortfolio(input, '2024-01-31').totalMarketValueBase;
    const ib = valuePortfolio({ ...input, options: { filter: { accounts: ['IBKR'] } } }, '2024-01-31').totalMarketValueBase;
    const tr = valuePortfolio({ ...input, options: { filter: { accounts: ['Trii'] } } }, '2024-01-31').totalMarketValueBase;
    expect(ib + tr).toBeCloseTo(all, 6);
    expect(externalFlows(input).map((f) => f.kind)).toEqual(['DEPOSIT', 'IMPLICIT_DEPOSIT']);
    expect(codes(ledgerDiagnostics(input))).toContain('IMPLICIT_FX_OTHER_ACCOUNT');
  });

  it('unassigned cash (rows without account) can fund an account', () => {
    const input: EngineInput = {
      portfolio: pf(),
      instruments: [inst('AAPL', 'USD')],
      market: mkt([ps('AAPL', 'USD', [['2024-01-01', 100]])], [fxs('USD', 'COP', [['2024-01-01', 4000]])]),
      transactions: [
        tx({ date: '2024-01-05', type: 'DEPOSIT', amount: 4_000_000 }),
        tx({ date: '2024-01-06', type: 'BUY', instrumentId: 'AAPL', quantity: 10, price: 100, currency: 'USD', account: 'IBKR' }),
      ],
    };
    expect(externalFlows(input).map((f) => f.kind)).toEqual(['DEPOSIT']);
  });

  it('E7: Engine.asOf is the local date', () => {
    const eng = createEngine({ portfolio: pf(), transactions: [tx({ date: '2024-01-02', type: 'DEPOSIT', amount: 1 })], instruments: [], market: mkt([]) });
    expect(eng.asOf).toBe(todayIso());
  });
});

describe('C35 — goal projection with inflation and from the portfolio', () => {
  it('indexed contributions and real terms', () => {
    const nominal = goalProjection({ startValue: 0, startDate: '2026-01-31', monthlyContribution: 100, expectedReturn: 0, years: 1 });
    expect(nominal.expectedFinalValue).toBeCloseTo(1200, 9);
    const indexed = goalProjection({ startValue: 0, startDate: '2026-01-31', monthlyContribution: 100, expectedReturn: 0, years: 1, inflation: 0.12, indexContributions: true });
    const g = Math.pow(1.12, 1 / 12) - 1;
    expect(indexed.expectedFinalValue).toBeCloseTo((100 * (Math.pow(1 + g, 12) - 1)) / g, 9);
    const real = goalProjection({ startValue: 1000, startDate: '2026-01-31', monthlyContribution: 0, expectedReturn: 0.12, years: 1, inflation: 0.12, realTerms: true });
    expect(real.expectedFinalValue).toBeCloseTo(1000, 9); // 12 % nominal = 0 % real
  });

  it('seeded from a portfolio: current value, historical return and volatility', () => {
    const inp: EngineInput = {
      portfolio: pf(),
      instruments: [inst('X', 'COP')],
      market: mkt([ps('X', 'COP', [['2023-01-01', 100], ['2023-06-30', 103], ['2023-12-31', 110], ['2024-06-30', 115], ['2024-12-31', 121]])]),
      transactions: [tx({ date: '2023-01-02', type: 'BUY', instrumentId: 'X', quantity: 100, price: 100 })],
    };
    const g = goalProjectionForPortfolio(inp, '2024-12-31', { years: 5, target: 20_000 });
    expect(g.points[0]!.expected).toBeCloseTo(12_100, 9);
    expect(g.expectedFinalValue).toBeGreaterThan(12_100);
    expect(g.monthsToTarget).toBeGreaterThan(0);
  });
});
