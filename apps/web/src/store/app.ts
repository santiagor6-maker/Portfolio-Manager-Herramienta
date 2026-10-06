import { create } from 'zustand';
import { DEFAULT_SETTINGS, saveSetting, type AppSettings } from '../db/repo';
import type { Analysis } from '../services/analysis';
import { LOCALE_BY_LANG } from '../lib/format';

export type MarketStatus = 'idle' | 'loading' | 'ok' | 'partial' | 'offline';

export interface SourceStatus {
  updatedAt?: number;
  ok: boolean;
  count?: number;
  message?: string;
}

export interface MarketState {
  status: MarketStatus;
  lastRefresh?: number;
  sources: Record<string, SourceStatus>;
  failedSymbols: string[];
}

interface AppState {
  ready: boolean;
  settings: AppSettings;
  analysis?: Analysis;
  computing: boolean;
  market: MarketState;
  onboardingOpen: boolean;
  setOnboardingOpen(v: boolean): void;
  setReady(settings: AppSettings): void;
  setSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]): void;
  setAnalysis(a: Analysis): void;
  setComputing(v: boolean): void;
  setMarket(patch: Partial<MarketState>): void;
}

export const useApp = create<AppState>((set) => ({
  ready: false,
  settings: DEFAULT_SETTINGS,
  computing: false,
  market: { status: 'idle', sources: {}, failedSymbols: [] },
  onboardingOpen: false,
  setOnboardingOpen: (onboardingOpen) => set({ onboardingOpen }),
  setReady: (settings) => set({ ready: true, settings }),
  setSetting: (key, value) => {
    set((s) => ({ settings: { ...s.settings, [key]: value } }));
    void saveSetting(key, value);
    if (key === 'theme') {
      try {
        localStorage.setItem('pp-theme', String(value));
      } catch {
        /* storage disabled */
      }
    }
  },
  setAnalysis: (analysis) => set({ analysis, computing: false }),
  setComputing: (computing) => set({ computing }),
  setMarket: (patch) => set((s) => ({ market: { ...s.market, ...patch } })),
}));

/** Convenience hook: everything a formatted figure needs. */
export function useFmt() {
  const language = useApp((s) => s.settings.language);
  // Figures come from the analysis: label them with the currency they were computed in, so a
  // switch never shows old numbers with the new currency symbol while the worker recomputes.
  const currency = useApp((s) => s.analysis?.baseCurrency ?? s.settings.reportingCurrency);
  const privacy = useApp((s) => s.settings.privacy);
  return { locale: LOCALE_BY_LANG[language], currency, privacy, language };
}
