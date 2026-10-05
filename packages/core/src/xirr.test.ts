import { describe, expect, it } from 'vitest';
import { xirr } from './api';

describe('xirr', () => {
  it('matches the Excel documentation example (0.373362535)', () => {
    const r = xirr([
      { date: '2008-01-01', amount: -10000 },
      { date: '2008-03-01', amount: 2750 },
      { date: '2008-10-30', amount: 4250 },
      { date: '2009-02-15', amount: 3250 },
      { date: '2009-04-01', amount: 2750 },
    ]);
    expect(r).toBeCloseTo(0.373362535, 8);
  });

  it('one-year simple cases (Actual/365)', () => {
    expect(xirr([{ date: '2021-01-01', amount: -1000 }, { date: '2022-01-01', amount: 1100 }])).toBeCloseTo(0.1, 10);
    // 2020 is a leap year: 366 days
    expect(xirr([{ date: '2020-01-01', amount: -1000 }, { date: '2021-01-01', amount: 1100 }])).toBeCloseTo(Math.pow(1.1, 365 / 366) - 1, 10);
    expect(xirr([{ date: '2021-01-01', amount: -1000 }, { date: '2022-01-01', amount: 500 }])).toBeCloseTo(-0.5, 10);
  });

  it('order-independent and aggregates same-day flows', () => {
    const a = xirr([
      { date: '2022-01-01', amount: 600 },
      { date: '2021-01-01', amount: -500 },
      { date: '2022-01-01', amount: 500 },
      { date: '2021-01-01', amount: -500 },
    ]);
    expect(a).toBeCloseTo(0.1, 10);
  });

  it('very high and very negative returns', () => {
    expect(xirr([{ date: '2024-01-01', amount: -100 }, { date: '2024-01-31', amount: 200 }])).toBeCloseTo(Math.pow(2, 365 / 30) - 1, 4);
    expect(xirr([{ date: '2024-01-01', amount: -100 }, { date: '2025-01-01', amount: 0.01 }])).toBeCloseTo(Math.pow(0.0001, 365 / 366) - 1, 8);
  });

  it('multiple deposits with a terminal value', () => {
    const flows = [
      { date: '2023-01-15', amount: -5_000_000 },
      { date: '2023-06-15', amount: -2_000_000 },
      { date: '2023-12-20', amount: 1_000_000 },
      { date: '2024-06-30', amount: 7_400_000 },
    ];
    const r = xirr(flows)!;
    const t = (d: string) => (Date.parse(d) - Date.parse('2023-01-15')) / 86_400_000 / 365;
    const npv = flows.reduce((s, f) => s + f.amount * Math.pow(1 + r, -t(f.date)), 0);
    expect(Math.abs(npv)).toBeLessThan(1e-3);
  });

  it('returns undefined when there is no solution', () => {
    expect(xirr([])).toBeUndefined();
    expect(xirr([{ date: '2024-01-01', amount: -100 }])).toBeUndefined();
    expect(xirr([{ date: '2024-01-01', amount: -100 }, { date: '2024-02-01', amount: -100 }])).toBeUndefined();
    expect(xirr([{ date: '2024-01-01', amount: 100 }, { date: '2024-02-01', amount: 100 }])).toBeUndefined();
    expect(xirr([{ date: '2024-01-01', amount: -100 }, { date: '2024-01-01', amount: 110 }])).toBeUndefined();
    expect(xirr([{ date: '2024-01-01', amount: Number.NaN }, { date: '2024-02-01', amount: 100 }])).toBeUndefined();
  });
});
