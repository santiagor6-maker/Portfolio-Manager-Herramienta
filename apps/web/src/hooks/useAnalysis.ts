import { useMemo } from 'react';
import type { Instrument } from '@pm/core';
import { useApp } from '../store/app';
import type { Analysis, SeriesPoint } from '../services/analysis';
import { useInstrumentMap } from './useData';
import { addDays } from '../lib/ids';

export function useAnalysis(): { analysis?: Analysis; loading: boolean; stale: boolean } {
  const analysis = useApp((s) => s.analysis);
  const computing = useApp((s) => s.computing);
  const ready = useApp((s) => s.ready);
  const ccy = useApp((s) => s.settings.reportingCurrency);
  const pid = useApp((s) => s.settings.selectedPortfolioId);
  const stale = !!analysis && (analysis.baseCurrency !== ccy || analysis.portfolioId !== pid);
  return { analysis, loading: !ready || !analysis, stale: stale || (computing && !analysis) };
}

export type ChartPeriod = 'MTD' | 'YTD' | '1Y' | '3Y' | 'ALL';

export function periodStart(period: ChartPeriod, asOf: string, first?: string): string {
  const y = asOf.slice(0, 4);
  let from: string;
  switch (period) {
    case 'MTD':
      from = addDays(`${asOf.slice(0, 7)}-01`, -1);
      break;
    case 'YTD':
      from = `${Number(y) - 1}-12-31`;
      break;
    case '1Y':
      from = addDays(asOf, -365);
      break;
    case '3Y':
      from = addDays(asOf, -365 * 3);
      break;
    default:
      from = first ?? '1900-01-01';
  }
  return first && from < first ? first : from;
}

export function seriesForPeriod(a: Analysis | undefined, period: ChartPeriod): SeriesPoint[] {
  if (!a) return [];
  const from = periodStart(period, a.asOf, a.firstDate);
  const daily = a.dailySeries.length && a.dailySeries[0]!.date <= from ? a.dailySeries : undefined;
  const src = period === 'MTD' || period === 'YTD' || period === '1Y' ? (daily ?? a.series) : a.series;
  return src.filter((p) => p.date >= from);
}

export function useInstrumentLabel(): (id: string | undefined) => { symbol: string; name: string; inst?: Instrument } {
  const map = useInstrumentMap();
  return useMemo(
    () => (id: string | undefined) => {
      if (!id) return { symbol: '—', name: '' };
      const inst = map.get(id);
      return { symbol: inst?.symbol ?? id.split(':').pop() ?? id, name: inst?.name ?? id, inst };
    },
    [map],
  );
}
