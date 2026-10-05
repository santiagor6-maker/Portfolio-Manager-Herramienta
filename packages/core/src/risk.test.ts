import { describe, expect, it } from 'vitest';
import { riskMetrics } from './api';
import type { MonthlyRow } from './types';

function rows(twrs: number[], bench?: number[]): MonthlyRow[] {
  let cum = 1;
  return twrs.map((twr, i) => {
    cum *= 1 + twr;
    const r: MonthlyRow = {
      month: `2024-${String(i + 1).padStart(2, '0')}`,
      startValueBase: 100,
      endValueBase: 100 * (1 + twr),
      netFlowsBase: 0,
      incomeBase: 0,
      feesBase: 0,
      taxesBase: 0,
      gainBase: 100 * twr,
      twr,
      cumulativeTwr: cum - 1,
    };
    if (bench) r.benchmarkReturns = { SPY: bench[i]! };
    return r;
  });
}

describe('riskMetrics', () => {
  const r = [0.02, -0.01, 0.03, -0.04, 0.01];

  it('volatility, Sharpe and Sortino (hand-computed)', () => {
    const m = riskMetrics(rows(r));
    // mean 0.002, sample variance 0.00308/4 = 0.00077
    const sd = Math.sqrt(0.00077);
    expect(m.volatility).toBeCloseTo(sd * Math.sqrt(12), 12);
    expect(m.volatility).toBeCloseTo(0.0961249, 6);
    expect(m.sharpe).toBeCloseTo((0.002 * 12) / (sd * Math.sqrt(12)), 12);
    // downside deviation: sqrt((0.01^2 + 0.04^2) / 5) * sqrt(12)
    expect(m.sortino).toBeCloseTo((0.002 * 12) / (Math.sqrt(0.0017 / 5) * Math.sqrt(12)), 12);
    expect(m.positiveMonthsRatio).toBeCloseTo(0.6, 12);
    expect(m.bestMonth).toEqual({ month: '2024-03', twr: 0.03 });
    expect(m.worstMonth).toEqual({ month: '2024-04', twr: -0.04 });
  });

  it('risk-free rate lowers Sharpe (monthly rf = (1+rf)^(1/12)-1)', () => {
    const m = riskMetrics(rows(r), { riskFreeAnnual: 0.12 });
    const rfm = Math.pow(1.12, 1 / 12) - 1;
    expect(m.sharpe).toBeCloseTo(((0.002 - rfm) * 12) / m.volatility, 12);
  });

  it('max drawdown with start (peak) and end (trough) months', () => {
    const m = riskMetrics(rows(r));
    expect(m.maxDrawdown).toBeCloseTo(-0.04, 12);
    expect(m.maxDrawdownStart).toBe('2024-03');
    expect(m.maxDrawdownEnd).toBe('2024-04');
    const m2 = riskMetrics(rows([-0.1, -0.1, 0.05]));
    expect(m2.maxDrawdown).toBeCloseTo(0.81 - 1, 12);
    expect(m2.maxDrawdownStart).toBe('2023-12'); // peak is the initial value, before the first month
    expect(m2.maxDrawdownEnd).toBe('2024-02');
  });

  it('beta and correlation vs benchmark (explicit series or row benchmarkReturns)', () => {
    const b = r.map((x) => x / 2);
    const m = riskMetrics(rows(r), { benchmarkMonthly: b });
    expect(m.beta).toBeCloseTo(2, 12);
    expect(m.correlation).toBeCloseTo(1, 12);
    const m2 = riskMetrics(rows(r, r.map((x) => -x)));
    expect(m2.beta).toBeCloseTo(-1, 12);
    expect(m2.correlation).toBeCloseTo(-1, 12);
  });

  it('degenerate inputs', () => {
    const m = riskMetrics([]);
    expect(m).toMatchObject({ volatility: 0, maxDrawdown: 0, positiveMonthsRatio: 0 });
    expect(m.sharpe).toBeUndefined();
    const one = riskMetrics(rows([0.05]));
    expect(one.volatility).toBe(0);
    expect(one.sharpe).toBeUndefined();
  });
});
