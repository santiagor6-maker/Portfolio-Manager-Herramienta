/**
 * Small one-off engine calls on the main thread (e.g. holdings at a past month-end for the
 * month-close flow). Heavy, recurring work goes through the worker (engineClient.ts).
 */
import * as core from '@pm/core';
import type { Holding, ISODate } from '@pm/core';
import { db } from '../db/schema';
import { useApp } from '../store/app';
import { BENCHMARKS } from '../lib/benchmarks';
import { groupManualPrices } from '../hooks/useData';
import { buildEngineInput, type Dataset } from './analysis';
import { todayIso } from '../lib/ids';

export async function loadDataset(): Promise<Dataset> {
  const [portfolios, transactions, instruments, prices, fx, manual] = await Promise.all([
    db.portfolios.toArray(),
    db.transactions.toArray(),
    db.instruments.toArray(),
    db.priceSeries.toArray(),
    db.fxSeries.toArray(),
    db.manualPrices.toArray(),
  ]);
  const s = useApp.getState().settings;
  const known = new Set(instruments.map((i) => i.id));
  return {
    portfolios,
    transactions,
    instruments: [...instruments, ...BENCHMARKS.filter((b) => !known.has(b.id))],
    prices,
    fx,
    manualPrices: groupManualPrices(manual),
    selectedPortfolioId: s.selectedPortfolioId,
    reportingCurrency: s.reportingCurrency,
    asOf: todayIso(),
    benchmarks: s.benchmarks,
    riskFreeRate: s.riskFreeRate,
    defaultCostMethod: s.defaultCostMethod,
  };
}

export async function holdingsAt(date: ISODate): Promise<Holding[]> {
  const ds = await loadDataset();
  // Month-close covers every portfolio (prices are global).
  ds.selectedPortfolioId = 'all';
  const market = core.createMarketData({ prices: ds.prices, fx: ds.fx, manualPrices: ds.manualPrices });
  const input = buildEngineInput(ds, market);
  if (!input) return [];
  return core.computeHoldings(input, date).filter((h) => Math.abs(h.quantity) > 1e-9);
}
