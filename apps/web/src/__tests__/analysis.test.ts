import { describe, expect, it } from 'vitest';
import type { Transaction } from '@pm/core';
import { computeAnalysis, type Dataset } from '../services/analysis';
import { loadDemoData } from '../services/demo';
import { BENCHMARK_IDS, BENCHMARKS } from '../lib/benchmarks';
import { groupManualPrices } from '../hooks/useData';

function dataset(ccy: string, overrides: Partial<Dataset> = {}): Dataset {
  const d = loadDemoData();
  return {
    portfolios: d.portfolios,
    transactions: d.transactions,
    instruments: [...d.instruments, ...BENCHMARKS.filter((b) => !d.instruments.some((i) => i.id === b.id))],
    prices: d.prices,
    fx: d.fx,
    manualPrices: groupManualPrices((d.manualPrices ?? []).map((m) => ({ ...m, updatedAt: 0 }))),
    indexSeries: d.indexSeries ?? [],
    selectedPortfolioId: 'all',
    reportingCurrency: ccy,
    asOf: '2026-10-05',
    benchmarks: BENCHMARK_IDS,
    riskFreeRate: 0.04,
    defaultCostMethod: 'FIFO',
    ...overrides,
  };
}

describe('computeAnalysis (engine wiring)', () => {
  const cop = computeAnalysis(dataset('COP'));

  it('runs every engine step without errors on the sample portfolio', () => {
    expect(cop.engineErrors).toEqual({});
    expect(cop.hasTransactions).toBe(true);
    expect(cop.valuation!.totalMarketValueBase).toBeGreaterThan(0);
    expect(cop.monthly.length).toBeGreaterThan(24);
    expect(cop.series.length).toBeGreaterThan(10);
    expect(cop.allocations.country?.length).toBeGreaterThan(2);
    expect(cop.income.length).toBeGreaterThan(10);
  });

  it('re-expresses every figure in the reporting currency', () => {
    const usd = computeAnalysis(dataset('USD'));
    const brl = computeAnalysis(dataset('BRL'));
    expect(usd.baseCurrency).toBe('USD');
    const asOfFx = cop.valuation!.totalMarketValueBase / usd.valuation!.totalMarketValueBase;
    // Implied USD/COP rate must be in the demo's plausible range.
    expect(asOfFx).toBeGreaterThan(3500);
    expect(asOfFx).toBeLessThan(4500);
    expect(brl.valuation!.totalMarketValueBase).toBeLessThan(cop.valuation!.totalMarketValueBase);
    // TWR differs by currency (currency effect), weights do not.
    expect(usd.summaries.SI!.twr).not.toBeCloseTo(cop.summaries.SI!.twr, 4);
    const w = (a: typeof cop) => a.allocations.country!.find((s) => s.key === 'US')!.weight;
    expect(w(usd)).toBeCloseTo(w(cop), 6);
  });

  it('filters by portfolio and handles an empty portfolio', () => {
    const empty = computeAnalysis(
      dataset('COP', { portfolios: [{ id: 'p0', name: 'Vacío', baseCurrency: 'COP', costMethod: 'FIFO', createdAt: '2026-01-01' }], selectedPortfolioId: 'p0' }),
    );
    expect(empty.hasTransactions).toBe(false);
    expect(empty.engineErrors).toEqual({});
  });

  it('stays fast with 2,500+ transactions', () => {
    const base = dataset('COP');
    const extra: Transaction[] = [];
    const pid = base.portfolios[0]!.id;
    for (let i = 0; i < 2500; i++) {
      const month = String((i % 12) + 1).padStart(2, '0');
      const year = 2023 + (i % 3);
      extra.push({ id: `x${i}`, portfolioId: pid, date: `${year}-${month}-1${i % 9}`, type: 'BUY', instrumentId: 'XNAS:AAPL', quantity: 1, price: 150, currency: 'USD', fees: 0.5 });
      if (i % 5 === 0) extra.push({ id: `d${i}`, portfolioId: pid, date: `${year}-${month}-2${i % 8}`, type: 'DEPOSIT', currency: 'USD', amount: 400 });
    }
    const t0 = performance.now();
    const a = computeAnalysis({ ...base, transactions: [...base.transactions, ...extra] });
    const ms = performance.now() - t0;
    expect(a.engineErrors).toEqual({});
    expect(ms).toBeLessThan(8000);
  });

  it('wires the round-2 engine outputs (positions, real returns, % of index, diagnostics)', () => {
    expect(cop.inflationIndex).toBe('IPC_CO');
    expect(cop.rateIndices).toContain('IBR');
    expect(cop.summaries.SI!.realTwr).toBeDefined();
    expect(cop.summaries.SI!.realTwr!).toBeLessThan(cop.summaries.SI!.twr);
    expect(cop.summaries.SI!.percentOfIndex?.IBR).toBeDefined();
    expect(cop.monthly.some((m) => m.realTwr !== undefined)).toBe(true);
    expect(cop.positions.length).toBeGreaterThan(5);
    const p = cop.positions[0]!;
    expect(p.totalReturnBase).toBeCloseTo(p.endValueBase - p.startValueBase - p.investedBase + p.proceedsBase + p.incomeBase, 0);
    expect(Array.isArray(cop.diagnostics)).toBe(true);
    expect(cop.series.some((s) => s.investedRealBase !== undefined)).toBe(true);
    expect(Array.isArray(cop.upcomingDividends)).toBe(true);
    expect(cop.engineErrors).toEqual({});
  });
});
