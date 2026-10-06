/** C4 — index series, real (inflation-adjusted) returns and rate benchmarks. */
import { describe, expect, it } from 'vitest';
import { createMarketData, monthlyPerformance, performanceSummary } from './api';
import type { EngineInput } from './api';
import { isoToDay } from './dates';
import { buildIndex } from './indices';
import { inst, prices, tx } from './__fixtures__/helpers';
import type { IndexSeries } from './types';

const d = isoToDay;

describe('index construction', () => {
  it('level series with geometric interpolation; no extrapolation for benchmarks', () => {
    const ipc = buildIndex({ id: 'IPC_CO', kind: 'level', source: 't', points: [{ date: '2024-01-31', value: 100 }, { date: '2024-02-29', value: 101 }] })!;
    expect(ipc.factor(d('2024-01-31'), d('2024-02-29'))).toBeCloseTo(1.01, 14);
    expect(ipc.factor(d('2024-01-31'), d('2024-02-14'))).toBeCloseTo(Math.pow(1.01, 14 / 29), 14);
    expect(ipc.factor(d('2024-01-31'), d('2024-03-31'))).toBeUndefined();
    expect(ipc.factor(d('2024-01-31'), d('2024-03-31'), { extrapolate: true })).toBeCloseTo(1.01, 14);
  });

  it('monthly variations (IPCA SGS 433) chain into month-end levels', () => {
    const s: IndexSeries = { id: 'IPCA', kind: 'periodRate', period: 'month', source: 't', points: [{ date: '2024-01-01', value: 0.42 }, { date: '2024-02-01', value: 0.83 }, { date: '2024-03-01', value: 0.16 }] };
    const i = buildIndex(s)!;
    expect(i.factor(d('2023-12-31'), d('2024-03-31'))).toBeCloseTo(1.0042 * 1.0083 * 1.0016, 14);
    expect(i.factor(d('2024-01-31'), d('2024-02-29'))).toBeCloseTo(1.0083, 14);
  });

  it('daily rates (CDI SGS 12): the rate of day j is earned from j to j+1; 110 % scales each day', () => {
    const s: IndexSeries = { id: 'CDI', kind: 'periodRate', period: 'day', source: 't', points: [{ date: '2024-01-02', value: 0.04 }, { date: '2024-01-03', value: 0.05 }, { date: '2024-01-04', value: 0.06 }] };
    const i = buildIndex(s)!;
    expect(i.factor(d('2024-01-02'), d('2024-01-04'))).toBeCloseTo(1.0004 * 1.0005, 15);
    expect(i.factor(d('2024-01-02'), d('2024-01-04'), { percent: 1.1 })).toBeCloseTo(1.00044 * 1.00055, 15);
  });

  it('annual rates: IBR nominal ACT/360 and CDI annualized BUS/252', () => {
    const ibr = buildIndex({ id: 'IBR', kind: 'annualRate', dayCount: 'ACT/360', source: 't', points: [{ date: '2024-01-01', value: 12 }, { date: '2024-02-01', value: 9 }] })!;
    expect(ibr.factor(d('2024-01-01'), d('2024-02-11'))).toBeCloseTo(Math.pow(1 + 0.12 / 360, 31) * Math.pow(1 + 0.09 / 360, 10), 14);
    const cdi = buildIndex({ id: 'CDI', kind: 'annualRate', dayCount: 'BUS/252', source: 't', points: [{ date: '2024-01-01', value: 11.65 }] })!;
    expect(cdi.factor(d('2024-01-05'), d('2024-01-12'))).toBeCloseTo(Math.pow(1.1165, 5 / 252), 14);
  });
});

describe('real returns and % of index', () => {
  const ipc: IndexSeries = { id: 'IPC_CO', kind: 'level', source: 't', points: [{ date: '2023-12-31', value: 100 }, { date: '2024-01-31', value: 100.9 }, { date: '2024-02-29', value: 101.91 }] };
  const ibr: IndexSeries = { id: 'IBR', kind: 'annualRate', dayCount: 'ACT/360', source: 't', points: [{ date: '2023-12-01', value: 12 }] };
  const input: EngineInput = {
    portfolio: { id: 'p', name: 'p', baseCurrency: 'COP', costMethod: 'FIFO', createdAt: '2024-01-01' },
    instruments: [inst('X', 'COP')],
    market: createMarketData({ prices: [prices('X', 'COP', { '2024-01-31': 100, '2024-02-29': 125 })], fx: [], indexSeries: [ipc, ibr] }),
    transactions: [tx({ date: '2024-01-31', type: 'BUY', instrumentId: 'X', quantity: 10, price: 100, currency: 'COP' })],
    options: { asOf: '2024-03-15' },
  };

  it('monthly: realTwr = (1 + twr) / (1 + inflation) - 1, IBR return and % of IBR', () => {
    const rows = monthlyPerformance(input);
    const feb = rows[1]!;
    expect(feb.twr).toBeCloseTo(0.25, 12);
    expect(feb.inflation).toBeCloseTo(0.01, 12);
    expect(feb.realTwr).toBeCloseTo(1.25 / 1.01 - 1, 12);
    const ibrFeb = Math.pow(1 + 0.12 / 360, 29) - 1;
    expect(feb.indexReturns!.IBR).toBeCloseTo(ibrFeb, 12);
    expect(feb.percentOfIndex!.IBR).toBeCloseTo(0.25 / ibrFeb, 9);
    // March is partial and CPI for March is not published: no inflation (never extrapolated)
    expect(rows[2]!.partial).toBe(true);
    expect(rows[2]!.inflation).toBeUndefined();
    expect(rows[2]!.cumulativeRealTwr).toBeUndefined();
    expect(rows[1]!.cumulativeRealTwr).toBeCloseTo((1 + rows[0]!.realTwr!) * (1 + feb.realTwr!) - 1, 12);
  });

  it('summary: real TWR and % of index over the period', () => {
    const s = performanceSummary(input, 'CUSTOM', '2024-02-29', { from: '2024-02-01', to: '2024-02-29' });
    expect(s.inflation).toBeCloseTo(0.01, 12);
    expect(s.realTwr).toBeCloseTo(1.25 / 1.01 - 1, 12);
    expect(s.indexReturns!.IBR).toBeCloseTo(Math.pow(1 + 0.12 / 360, 29) - 1, 12);
    // inflation index can be disabled or overridden
    expect(performanceSummary({ ...input, options: { ...input.options, inflationIndex: null } }, 'SI', '2024-02-29').realTwr).toBeUndefined();
  });

  it('rate indices can be used as benchmarks', () => {
    const rows = monthlyPerformance({ ...input, portfolio: { ...input.portfolio, benchmarks: ['IBR'] } });
    expect(rows[1]!.benchmarkReturns!.IBR).toBeCloseTo(Math.pow(1 + 0.12 / 360, 29) - 1, 12);
    expect(rows[1]!.benchmarkKinds!.IBR).toBe('rate');
  });

  it('MarketData.indexLevel exposes the accumulated level', () => {
    expect(input.market.indexLevel!('IPC_CO', '2024-02-29')).toBeCloseTo(1.0191, 12);
  });
});
