import { useEffect, useMemo, useRef } from 'react';
import { useLiveQuery } from 'dexie-react-hooks';
import type { Instrument, PriceSeries } from '@pm/core';
import { db, type ManualPrice, type StoredInstrument, type StoredPortfolio, type StoredTransaction } from '../db/schema';
import { useApp } from '../store/app';
import { runAnalysis, latestRequestId } from '../services/engineClient';
import type { Dataset } from '../services/analysis';
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
  const timer = useRef<ReturnType<typeof setTimeout>>();

  const { selectedPortfolioId, reportingCurrency, benchmarks, riskFreeRate, defaultCostMethod } = settings;

  useEffect(() => {
    if (!ready || !portfolios || !transactions || !instruments || !prices || !fx || !manual) return;
    clearTimeout(timer.current);
    setComputing(true);
    timer.current = setTimeout(() => {
      const known = new Set(instruments.map((i) => i.id));
      const dataset: Dataset = {
        portfolios,
        transactions,
        instruments: [...instruments, ...BENCHMARKS.filter((b) => !known.has(b.id))],
        prices: prices.map(({ instrumentId, currency, points, source }) => ({ instrumentId, currency, points, source })),
        fx: fx.map(({ base, quote, points, source }) => ({ base, quote, points, source })),
        manualPrices: groupManualPrices(manual),
        selectedPortfolioId:
          selectedPortfolioId === 'all' || portfolios.some((p) => p.id === selectedPortfolioId) ? selectedPortfolioId : 'all',
        reportingCurrency,
        asOf: todayIso(),
        benchmarks,
        riskFreeRate,
        defaultCostMethod,
      };
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
    selectedPortfolioId,
    reportingCurrency,
    benchmarks,
    riskFreeRate,
    defaultCostMethod,
    setAnalysis,
    setComputing,
  ]);
}
