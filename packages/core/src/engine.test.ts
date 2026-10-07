/** C20 — memoized engine; C21 — goal projection. */
import { describe, expect, it } from 'vitest';
import { createEngine, goalProjection, monthlyPerformance, performanceSummary, valueSeries } from './api';
import { createDemoData } from './demo';

describe('createEngine', () => {
  const d = createDemoData();
  const eng = createEngine(d.input);

  it('serves summaries, series and the monthly table from one pass, consistently', () => {
    const rows = eng.monthly({});
    const si = eng.summary('SI', d.asOf);
    expect(si.twr).toBeCloseTo(rows.at(-1)!.cumulativeTwr, 10);
    const ytd = eng.summary('YTD', d.asOf);
    const ytdRows = rows.filter((r) => r.month.startsWith('2026'));
    expect(ytd.twr).toBeCloseTo(ytdRows.reduce((g, r) => g * (1 + r.twr), 1) - 1, 10);
    const s = eng.series({ from: '2023-01-01', to: d.asOf, step: 'month' });
    expect(s.at(-1)!.cumulativeTwr).toBeCloseTo(si.twr, 10);
    expect(s.at(-1)!.valueBase).toBeCloseTo(si.endValueBase, 6);
  });

  it('matches the stateless API and caches by input object', () => {
    expect(performanceSummary(d.input, '1Y', d.asOf).twr).toBeCloseTo(eng.summary('1Y', d.asOf).twr, 12);
    const a = monthlyPerformance(d.input);
    const b = monthlyPerformance(d.input);
    expect(b).toEqual(a); // same content (cached engine)...
    expect(b).not.toBe(a); // ...but every call returns a fresh copy (C23)
    expect(valueSeries(d.input, { from: '2026-01-01', to: d.asOf, step: 'week' }).length).toBeGreaterThan(30);
  });

  it('every period reconciles its money waterfall', () => {
    for (const p of ['MTD', 'QTD', 'YTD', '1M', '3M', '6M', '1Y', '3Y', 'SI'] as const) {
      const s = eng.summary(p, d.asOf);
      const parts =
        s.realizedGainBase + s.unrealizedGainBase + s.incomeBase + s.fxCashGainBase! + s.fxConversionResultBase! + s.otherCostsBase! + s.transferAdjustmentBase! + s.corporateActionAdjustmentBase! + s.rateDifferenceBase!;
      expect(parts).toBeCloseTo(s.gainBase, 4);
    }
  });
});

describe('goalProjection', () => {
  it('expected path, required contribution and probability', () => {
    const r = goalProjection({ startValue: 100_000_000, startDate: '2026-10-01', monthlyContribution: 2_000_000, expectedReturn: 0.1, volatility: 0.15, target: 1_000_000_000, targetDate: '2036-10-01' });
    expect(r.points).toHaveLength(121);
    const i = Math.pow(1.1, 1 / 12) - 1;
    const g = Math.pow(1 + i, 120);
    const fv = 100_000_000 * g + (2_000_000 * (g - 1)) / i;
    expect(r.expectedFinalValue).toBeCloseTo(fv, 0);
    expect(r.points[0]).toMatchObject({ expected: 100_000_000, pessimistic: 100_000_000, optimistic: 100_000_000 });
    const last = r.points.at(-1)!;
    expect(last.pessimistic).toBeLessThan(last.expected);
    expect(last.optimistic).toBeGreaterThan(last.expected);
    // required contribution reproduces the target in the expected scenario
    const req = r.requiredMonthlyContribution!;
    expect(100_000_000 * g + (req * (g - 1)) / i).toBeCloseTo(1_000_000_000, 0);
    expect(r.probabilityOfSuccess!).toBeGreaterThan(0);
    expect(r.probabilityOfSuccess!).toBeLessThan(1);
    expect(r.monthsToTarget).toBeGreaterThan(120);
  });
});
