/**
 * W40: state of the conversion into the reporting currency.
 * - `pending`: the analysis is being recomputed for a new currency, or a missing rate is downloading
 *   → "Convirtiendo a BRL…" skeletons, never old figures or zeros.
 * - `missing`: currencies with no rate after that → "—" plus a warning everywhere.
 */
import { useEffect } from 'react';
import { useApp } from '../store/app';
import { ensureReportingFx, refreshMarketData } from '../services/marketData';

export interface Conversion {
  target: string;
  pending: boolean;
  missing: string[];
}

export function conversionState(
  analysis: { baseCurrency: string; fxMissing: string[] } | undefined,
  target: string,
  fxPending: string[],
  fxFetchedAt: Record<string, number> = {},
  analysisAt = 0,
): Conversion {
  const switching = !!analysis && analysis.baseCurrency !== target;
  const missing = analysis && !switching ? analysis.fxMissing : [];
  // A rate that arrived after this analysis was computed is still being applied (no "no rate" flash).
  const fetching = missing.some((c) => fxPending.includes(c) || (fxFetchedAt[c] ?? 0) > analysisAt) || fxPending.includes(target);
  return { target, pending: switching || (missing.length > 0 && fetching), missing: switching ? [] : missing };
}

export function useConversion(): Conversion {
  const analysis = useApp((s) => s.analysis);
  const analysisAt = useApp((s) => s.analysisAt);
  const target = useApp((s) => s.settings.reportingCurrency);
  const fxPending = useApp((s) => s.market.fxPending);
  const fxFetchedAt = useApp((s) => s.market.fxFetchedAt);
  return conversionState(analysis, target, fxPending, fxFetchedAt, analysisAt);
}

const attempted = new Set<string>();

/**
 * Mounted once (Layout): on a currency switch, download the reporting currency's rate at once; when
 * the analysis still reports currencies without a rate, download those (once per set per session —
 * the warning has a retry button).
 */
export function useFxAutoFetch(): void {
  const target = useApp((s) => s.settings.reportingCurrency);
  const ready = useApp((s) => s.ready);
  const analysis = useApp((s) => s.analysis);
  useEffect(() => {
    if (ready) void ensureReportingFx(target);
  }, [ready, target]);
  const missing = analysis && analysis.baseCurrency === target ? analysis.fxMissing : [];
  const key = missing.length ? `${target}:${missing.join(',')}` : '';
  useEffect(() => {
    if (!key || attempted.has(key)) return;
    attempted.add(key);
    void refreshMarketData({ force: true, fx: [...missing, target] });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}
