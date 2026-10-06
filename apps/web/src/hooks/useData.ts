import { useEffect, useMemo, useRef } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { CorporateAction, IndexSeries, Instrument, PriceSeries } from '@pm/core';
import { db, type ManualPrice, type StoredInstrument, type StoredPortfolio, type StoredTransaction } from '../db/schema';
import { useApp } from '../store/app';
import { runAnalysis, latestRequestId } from '../services/engineClient';
import type { Dataset } from '../services/analysis';
import type { AppSettings } from '../db/repo';
import { BENCHMARKS } from '../lib/benchmarks';
import { todayIso } from '../lib/ids';

const EMPTY: never[] = [];

export function usePortfolios(): StoredPortfolio[] {
  return useLiveQuery(() => db.portfolios.toArray(), [], EMPTY as StoredPortfolio[]);
}

export function useInstruments(): StoredInstrument[] {
  return useLiveQuery(() => db.instruments.toArray(), [], EMPTY as StoredInstrument[]);
}

export function useInstrumentMap(): Map<string, Instrument> {
  const list = useInstruments();
  return useMemo(() => {
    const m = new Map<string, Instrument>();
    for (const b of BENCHMARKS) m.set(b.id, b);
    for (const i of list) m.set(i.id, i);
    return m;
  }, [list]);
}

export function useAllTransactions(): StoredTransaction[] | undefined {
  return useLiveQuery(() => db.transactions.toArray(), []);
}

/** Transactions of the selected portfolio (or all), newest first. */
export function useScopedTransactions(): StoredTransaction[] | undefined {
  const pid = useApp((s) => s.settings.selectedPortfolioId);
  const all = useAllTransactions();
  return useMemo(() => {
    if (!all) return undefined;
    const list = pid === 'all' ? all : all.filter((t) => t.portfolioId === pid);
    return [...list].sort((a, b) => (a.date === b.date ? (b.createdAt ?? 0) - (a.createdAt ?? 0) : a.date < b.date ? 1 : -1));
  }, [all, pid]);
}

export function useManualPrices(): ManualPrice[] {
  return useLiveQuery(() => db.manualPrices.toArray(), [], EMPTY as ManualPrice[]);
}

export function groupManualPrices(rows: ManualPrice[]): PriceSeries[] {
  const by = new Map<string, PriceSeries>();
  for (const r of rows) {
    let s = by.get(r.instrumentId);
    if (!s) {
      s = { instrumentId: r.instrumentId, currency: r.currency, points: [], source: 'manual' };
      by.set(r.instrumentId, s);
    }
    s.points.push({ date: r.date, close: r.close });
  }
  for (const s of by.values()) s.points.sort((a, b) => (a.date < b.date ? -1 : 1));
  return [...by.values()];
}

export interface RawData {
  portfolios: StoredPortfolio[];
  transactions: StoredTransaction[];
  instruments: StoredInstrument[];
  prices: { instrumentId: string; currency: string; points: { date: string; close: number }[]; source: string }[];
  fx: { base: string; quote: string; points: { date: string; rate: number }[]; source: string }[];
  manual: ManualPrice[];
  indexSeries: IndexSeries[];
  corporateActions: CorporateAction[];
  dismissed: string[];
}

/** Turns raw IndexedDB rows + settings into the engine dataset (shared by worker and one-off calls). */
export function toDataset(raw: RawData, settings: AppSettings, asOf = todayIso()): Dataset {
  const known = new Set(raw.instruments.map((i) => i.id));
  return {
    portfolios: raw.portfolios,
    transactions: raw.transactions,
    instruments: [...raw.instruments, ...BENCHMARKS.filter((b) => !known.has(b.id))],
    prices: raw.prices.map(({ instrumentId, currency, points, source }) => ({ instrumentId, currency, points, source })),
    fx: raw.fx.map(({ base, quote, points, source }) => ({ base, quote, points, source })),
    manualPrices: groupManualPrices(raw.manual),
    indexSeries: raw.indexSeries.map(({ id, kind, period, unit, dayCount, currency, points, source }) => ({ id, kind, period, unit, dayCount, currency, points, source })),
    corporateActions: raw.corporateActions.map(({ id: _id, updatedAt: _u, ...a }: CorporateAction & { id?: string; updatedAt?: number }) => a),
    dismissedSuggestions: raw.dismissed,
    selectedPortfolioId:
      settings.selectedPortfolioId === 'all' || raw.portfolios.some((p) => p.id === settings.selectedPortfolioId) ? settings.selectedPortfolioId : 'all',
    reportingCurrency: settings.reportingCurrency,
    asOf,
    benchmarks: settings.benchmarks,
    riskFreeRate: settings.riskFreeRate,
    defaultCostMethod: settings.defaultCostMethod,
  };
}

export async function readRawData(): Promise<RawData> {
  const [portfolios, transactions, instruments, prices, fx, manual, indexSeries, corporateActions, dismissed] = await Promise.all([
    db.portfolios.toArray(),
    db.transactions.toArray(),
    db.instruments.toArray(),
    db.priceSeries.toArray(),
    db.fxSeries.toArray(),
    db.manualPrices.toArray(),
    db.indexSeries.toArray(),
    db.corporateActions.toArray(),
    db.meta.get('dismissedSuggestions'),
  ]);
  return { portfolios, transactions, instruments, prices, fx, manual, indexSeries, corporateActions, dismissed: (dismissed?.value as string[]) ?? [] };
}

/**
 * Watches IndexedDB + settings and recomputes the analysis in the engine worker.
 * Mounted once at the app root.
 */
export function useAnalysisDriver(): void {
  const ready = useApp((s) => s.ready);
  const settings = useApp((s) => s.settings);
  const setAnalysis = useApp((s) => s.setAnalysis);
  const setComputing = useApp((s) => s.setComputing);

  const portfolios = useLiveQuery(() => db.portfolios.toArray(), []);
  const transactions = useLiveQuery(() => db.transactions.toArray(), []);
  const instruments = useLiveQuery(() => db.instruments.toArray(), []);
  const prices = useLiveQuery(() => db.priceSeries.toArray(), []);
  const fx = useLiveQuery(() => db.fxSeries.toArray(), []);
  const manual = useLiveQuery(() => db.manualPrices.toArray(), []);
  const indexSeries = useLiveQuery(() => db.indexSeries.toArray(), []);
  const corporateActions = useLiveQuery(() => db.corporateActions.toArray(), []);
  const dismissed = useLiveQuery(async () => ((await db.meta.get('dismissedSuggestions'))?.value as string[]) ?? [], []);
  const timer = useRef<ReturnType<typeof setTimeout>>();

  const { selectedPortfolioId, reportingCurrency, benchmarks, riskFreeRate, defaultCostMethod } = settings;

  useEffect(() => {
    if (!ready || !portfolios || !transactions || !instruments || !prices || !fx || !manual || !indexSeries || !corporateActions || !dismissed) return;
    clearTimeout(timer.current);
    setComputing(true);
    timer.current = setTimeout(() => {
      const dataset = toDataset(
        { portfolios, transactions, instruments, prices, fx, manual, indexSeries, corporateActions, dismissed },
        useApp.getState().settings,
      );
      void runAnalysis(dataset).then(({ id, analysis }) => {
        if (id === latestRequestId()) setAnalysis(analysis);
      });
    }, 60);
    return () => clearTimeout(timer.current);
  }, [
    ready,
    portfolios,
    transactions,
    instruments,
    prices,
    fx,
    manual,
    indexSeries,
    corporateActions,
    dismissed,
    selectedPortfolioId,
    reportingCurrency,
    benchmarks,
    riskFreeRate,
    defaultCostMethod,
    setAnalysis,
    setComputing,
  ]);
}
