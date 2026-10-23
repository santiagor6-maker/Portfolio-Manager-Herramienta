/**
 * Small one-off engine calls on the main thread (e.g. holdings at a past month-end for the
 * month-close flow). Heavy, recurring work goes through the worker (engineClient.ts).
 */
import * as core from '@pm/core';
import type { Holding, ISODate, PerformanceSummary } from '@pm/core';
import { useApp } from '../store/app';
import { readRawData, toDataset } from '../hooks/useData';
import { buildEngineInput, createMarket, type Dataset } from './analysis';
import { missingFxCurrencies, scopeBases } from './fxCoverage';

export async function loadDataset(): Promise<Dataset> {
  return toDataset(await readRawData(), useApp.getState().settings);
}

export async function holdingsAt(date: ISODate): Promise<Holding[]> {
  const ds = await loadDataset();
  // Month-close covers every portfolio (prices are global).
  ds.selectedPortfolioId = 'all';
  const market = createMarket(ds);
  const input = buildEngineInput(ds, market);
  if (!input) return [];
  return core.computeHoldings(input, date).filter((h) => Math.abs(h.quantity) > 1e-9);
}

/** Performance over an arbitrary period for the selected portfolio (report). */
export async function customSummary(from: ISODate, to: ISODate): Promise<PerformanceSummary | undefined> {
  const ds = await loadDataset();
  const market = createMarket(ds);
  const input = buildEngineInput(ds, market);
  if (!input || !input.transactions.length) return undefined;
  // W40: no summary converted with a missing rate (the engine would report zeros).
  if (missingFxCurrencies(ds.reportingCurrency, input.transactions, ds.instruments, market, ds.asOf, scopeBases(ds)).length) return undefined;
  try {
    return core.performanceSummary(input, 'CUSTOM', to, { from, to });
  } catch {
    return undefined;
  }
}
