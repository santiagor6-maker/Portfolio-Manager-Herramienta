import { describe, expect, it } from 'vitest';
import { monthlyPerformance, performanceSummary, valueSeries } from './api';
import { periodStart } from './performance';
import { engine, fxs, inst, prices, tx } from './__fixtures__/helpers';

/**
 * Base USD, one stock. Daily closes where needed:
 *   01-31: 100 | 02-14: 110 | 02-15: 112 | 02-29: 105 | 03-09: 108 | 03-10: 115 | 03-31: 120
 * Flows:
 *   01-31 DEPOSIT 1000, BUY 10 @ 100
 *   02-15 DEPOSIT 1120, BUY 10 @ 112          (mid-month inflow, start-of-day convention)
 *   03-10 SELL 5 @ 115, WITHDRAWAL 575         (mid-month outflow, end-of-day convention)
 *
 * February (hand): V(01-31)=1000, V(02-14)=1100, V(02-15)=2240, V(02-29)=2100
 *   r = 1100/1000 * 2240/(1100+1120) * 2100/2240 - 1 = 1.1 * 2100/2220 - 1 = 0.0405405405...
 *   Modified Dietz: (2100 - 1000 - 1120) / (1000 + 1120 * 15/29) = -0.0126637...
 * March (hand): V(03-09)=2160, V(03-10)=1725 (+575 out), V(03-31)=1800
 *   r = 2160/2100 * (1725+575)/2160 * 1800/1725 - 1 = 120/105 - 1 = 0.142857...
 */
const X = inst('XNAS:XYZ', 'USD');
const px = prices(X.id, 'USD', {
  '2024-01-31': 100,
  '2024-02-14': 110,
  '2024-02-15': 112,
  '2024-02-29': 105,
  '2024-03-09': 108,
  '2024-03-10': 115,
  '2024-03-31': 120,
});
const txs = [
  tx({ date: '2024-01-31', type: 'DEPOSIT', amount: 1000, currency: 'USD' }),
  tx({ date: '2024-01-31', type: 'BUY', instrumentId: X.id, quantity: 10, price: 100, currency: 'USD' }),
  tx({ date: '2024-02-15', type: 'DEPOSIT', amount: 1120, currency: 'USD' }),
  tx({ date: '2024-02-15', type: 'BUY', instrumentId: X.id, quantity: 10, price: 112, currency: 'USD' }),
  tx({ date: '2024-03-10', type: 'SELL', instrumentId: X.id, quantity: 5, price: 115, currency: 'USD' }),
  tx({ date: '2024-03-10', type: 'WITHDRAWAL', amount: 575, currency: 'USD' }),
];
const input = engine({ base: 'USD', instruments: [X], prices: [px], transactions: txs, options: { asOf: '2024-03-31' } });

describe('time-weighted return (daily sub-periods)', () => {
  const rows = monthlyPerformance(input);

  it('one row per calendar month from the first transaction', () => {
    expect(rows.map((r) => r.month)).toEqual(['2024-01', '2024-02', '2024-03']);
  });

  it('February with a mid-month deposit matches the hand computation', () => {
    const feb = rows[1]!;
    expect(feb.startValueBase).toBe(1000);
    expect(feb.endValueBase).toBe(2100);
    expect(feb.netFlowsBase).toBe(1120);
    expect(feb.gainBase).toBe(-20);
    expect(feb.twr).toBeCloseTo(1.1 * (2100 / 2220) - 1, 12);
    expect(feb.twr).toBeCloseTo(0.0405405405405, 12);
    expect(feb.fxReturn).toBeCloseTo(0, 14);
  });

  it('March with a mid-month withdrawal equals the pure price return', () => {
    const mar = rows[2]!;
    expect(mar.netFlowsBase).toBe(-575);
    expect(mar.twr).toBeCloseTo(120 / 105 - 1, 12);
    expect(mar.cumulativeTwr).toBeCloseTo((1.1 * 2100) / 2220 * (120 / 105) - 1, 12);
  });

  it('Modified Dietz fallback', () => {
    const md = monthlyPerformance(input, { twrMethod: 'modifiedDietz' });
    expect(md[1]!.twr).toBeCloseTo(-20 / (1000 + (1120 * 15) / 29), 12);
    // March: out of 575 at end of day 03-10 -> weight (31-10)/31
    expect(md[2]!.twr).toBeCloseTo((1800 - 2100 + 575) / (2100 - (575 * 21) / 31), 12);
  });

  it('valueSeries cumulative TWR matches the monthly chain at month ends', () => {
    const s = valueSeries(input, { from: '2024-01-01', to: '2024-03-31', step: 'day' });
    expect(s).toHaveLength(91);
    const at = (d: string) => s.find((p) => p.date === d)!;
    expect(at('2024-02-29').cumulativeTwr).toBeCloseTo(rows[1]!.cumulativeTwr, 12);
    expect(at('2024-03-31').cumulativeTwr).toBeCloseTo(rows[2]!.cumulativeTwr, 12);
    expect(at('2024-03-31').valueBase).toBe(1800);
    expect(at('2024-03-31').netInvestedBase).toBe(1000 + 1120 - 575);
    expect(at('2024-02-15').netInvestedBase).toBe(2120);
    const monthly = valueSeries(input, { from: '2024-01-01', to: '2024-03-31', step: 'month' });
    expect(monthly.map((p) => p.date)).toEqual(['2024-01-01', '2024-01-31', '2024-02-29', '2024-03-31']);
    expect(monthly[3]!.cumulativeTwr).toBeCloseTo(rows[2]!.cumulativeTwr, 12);
    const weekly = valueSeries(input, { from: '2024-01-01', to: '2024-03-31', step: 'week' });
    expect(weekly[weekly.length - 1]!.date).toBe('2024-03-31');
    expect(weekly[weekly.length - 1]!.cumulativeTwr).toBeCloseTo(rows[2]!.cumulativeTwr, 12);
  });

  it('partial current month ends at asOf', () => {
    const r = monthlyPerformance(input, { asOf: '2024-03-10' });
    expect(r).toHaveLength(3);
    expect(r[2]!.endValueBase).toBe(1725);
    expect(r[2]!.twr).toBeCloseTo(2300 / 2100 - 1, 12);
  });

  it('from/to restrict the table without changing the returns', () => {
    const r = monthlyPerformance(input, { from: '2024-02', to: '2024-02' });
    expect(r).toHaveLength(1);
    expect(r[0]!.twr).toBeCloseTo(rows[1]!.twr, 14);
    expect(r[0]!.cumulativeTwr).toBeCloseTo(rows[1]!.twr, 14);
  });
});

describe('performanceSummary', () => {
  it('SI summary: TWR, gains split, MWR via XIRR', () => {
    const s = performanceSummary(input, 'SI', '2024-03-31');
    expect(s.from).toBe('2024-01-31');
    expect(s.startValueBase).toBe(0);
    expect(s.endValueBase).toBe(1800);
    expect(s.netFlowsBase).toBe(1545);
    expect(s.gainBase).toBe(255);
    // realized: 5 sold @115 from the first lot @100 -> 75 ; unrealized: 5*(120-100) + 10*(120-112) = 180
    expect(s.realizedGainBase).toBeCloseTo(75, 9);
    expect(s.unrealizedGainBase).toBeCloseTo(180, 9);
    expect(s.realizedGainBase + s.unrealizedGainBase).toBeCloseTo(s.gainBase, 9);
    expect(s.twr).toBeCloseTo((1.1 * 2100) / 2220 * (120 / 105) - 1, 12);
    expect(s.twrAnnualized).toBeUndefined();
    expect(s.mwr).toBeDefined();
    // MWR solves -1000(01-31) -1120(02-15) +575(03-10) +1800(03-31) = 0 at mwr.
    const npv = (r: number) =>
      -1000 - 1120 * (1 + r) ** (-15 / 365) + 575 * (1 + r) ** (-39 / 365) + 1800 * (1 + r) ** (-60 / 365);
    expect(Math.abs(npv(s.mwr!))).toBeLessThan(1e-6);
  });

  it('MTD summary starts at the close of the previous month', () => {
    const s = performanceSummary(input, 'MTD', '2024-03-31');
    expect(s.from).toBe('2024-03-01');
    expect(s.startValueBase).toBe(2100);
    expect(s.twr).toBeCloseTo(120 / 105 - 1, 12);
    expect(s.netFlowsBase).toBe(-575);
  });

  it('CUSTOM range includes flows on its first day', () => {
    const s = performanceSummary(input, 'CUSTOM', '2024-03-31', { from: '2024-02-15', to: '2024-02-29' });
    expect(s.startValueBase).toBe(1100);
    expect(s.netFlowsBase).toBe(1120);
    expect(s.twr).toBeCloseTo(2240 / 2220 * (2100 / 2240) - 1, 12);
  });

  it('period start dates', () => {
    expect(periodStart('MTD', '2024-05-17', undefined)).toBe('2024-05-01');
    expect(periodStart('QTD', '2024-05-17', undefined)).toBe('2024-04-01');
    expect(periodStart('YTD', '2024-05-17', undefined)).toBe('2024-01-01');
    expect(periodStart('1M', '2024-03-31', undefined)).toBe('2024-03-01');
    expect(periodStart('1Y', '2024-02-29', undefined)).toBe('2023-03-01');
    expect(periodStart('3Y', '2024-05-17', undefined)).toBe('2021-05-18');
    expect(periodStart('SI', '2024-05-17', '2020-01-02')).toBe('2020-01-02');
  });

  it('annualizes only periods longer than a year', () => {
    const Y = inst('Y', 'USD');
    const long = engine({
      base: 'USD',
      instruments: [Y],
      prices: [prices('Y', 'USD', { '2020-01-01': 100, '2022-01-01': 121 })],
      transactions: [tx({ date: '2020-01-01', type: 'BUY', instrumentId: 'Y', quantity: 1, price: 100, currency: 'USD' })],
    });
    const s = performanceSummary(long, 'SI', '2022-01-01');
    expect(s.twr).toBeCloseTo(0.21, 12);
    expect(s.twrAnnualized).toBeCloseTo(Math.pow(1.21, 365.25 / 732) - 1, 12);
    expect(s.mwr).toBeCloseTo(Math.pow(1.21, 365 / 731) - 1, 8);
  });
});

describe('benchmarks', () => {
  it('benchmark monthly returns converted to base currency', () => {
    const SPY = inst('ARCX:SPY', 'USD');
    const b = engine({
      base: 'COP',
      instruments: [X, SPY],
      prices: [px, prices(SPY.id, 'USD', { '2024-01-31': 400, '2024-02-29': 420 })],
      fx: [fxs('USD', 'COP', { '2024-01-31': 4000, '2024-02-29': 3900 })],
      transactions: txs,
      benchmarks: [SPY.id, 'NOPE'],
    });
    const rows = monthlyPerformance(b, { asOf: '2024-02-29' });
    expect(rows[1]!.benchmarkReturns![SPY.id]).toBeCloseTo((420 * 3900) / (400 * 4000) - 1, 12);
    expect(rows[1]!.benchmarkReturns!.NOPE).toBeUndefined();
  });
});
