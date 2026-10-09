import type { AllocationDimension, CorporateAction, CostMethod, CurrencyCode, FxSeries, IndexSeries, PriceSeries } from '@pm/core';
import {
  db,
  SCHEMA_VERSION,
  type AlertRule,
  type CachedFxSeries,
  type CachedIndexSeries,
  type CachedPriceSeries,
  type Goal,
  type WatchItem,
  type CachedQuote,
  type ManualPrice,
  type StoredInstrument,
  type StoredPortfolio,
  type StoredTransaction,
} from './schema';
import { newId, todayIso } from '../lib/ids';
import { BENCHMARK_IDS } from '../lib/benchmarks';
import type { Lang } from '../lib/format';

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export type ThemePref = 'light' | 'dark' | 'system';

export interface AppSettings {
  reportingCurrency: CurrencyCode;
  language: Lang;
  theme: ThemePref;
  privacy: boolean;
  /** Portfolio id or 'all' for the consolidated view. */
  selectedPortfolioId: string;
  /** Market-data server base URL. Empty = same origin `/api` (Vite proxy). */
  serverUrl: string;
  /** Server API token (`API_TOKEN`), sent as a Bearer token. Needed for broker sync. */
  apiToken: string;
  defaultCostMethod: CostMethod;
  /** Benchmark instrument ids for comparisons. */
  benchmarks: string[];
  /** Annual risk-free rate (decimal) for Sharpe/Sortino. */
  riskFreeRate: number;
  autoRefresh: boolean;
  /** Monthly table: column preset or explicit column list, and row density. */
  monthlyColumns: string[] | 'essential' | 'complete';
  density: 'comfortable' | 'compact';
  /** Show real (inflation-adjusted) returns in the monthly table and heatmap. */
  realReturns: boolean;
  /** Rebalancing targets per dimension: key -> weight (0..1). */
  targets: Partial<Record<AllocationDimension, Record<string, number>>>;
  /** Onboarding wizard completed (or dismissed). */
  onboarded: boolean;
  /** Notification API permission was requested for alerts. */
  notifications: boolean;
}

export const DEFAULT_SETTINGS: AppSettings = {
  reportingCurrency: 'COP',
  language: 'es',
  theme: 'system',
  privacy: false,
  selectedPortfolioId: 'all',
  serverUrl: '',
  apiToken: '',
  defaultCostMethod: 'FIFO',
  benchmarks: BENCHMARK_IDS,
  riskFreeRate: 0.04,
  autoRefresh: true,
  monthlyColumns: 'essential',
  density: 'comfortable',
  realReturns: false,
  targets: {},
  onboarded: false,
  notifications: false,
};

export async function loadSettings(): Promise<AppSettings> {
  const rows = await db.settings.toArray();
  const out: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  for (const r of rows) if (r.key in DEFAULT_SETTINGS) out[r.key] = r.value;
  return out as unknown as AppSettings;
}

export async function saveSetting<K extends keyof AppSettings>(key: K, value: AppSettings[K]): Promise<void> {
  await db.settings.put({ key, value });
}

export async function getMeta<T>(key: string): Promise<T | undefined> {
  return (await db.meta.get(key))?.value as T | undefined;
}

export async function setMeta(key: string, value: unknown): Promise<void> {
  await db.meta.put({ key, value });
}

// ---------------------------------------------------------------------------
// Portfolios
// ---------------------------------------------------------------------------

export async function createPortfolio(
  input: Partial<StoredPortfolio> & Pick<StoredPortfolio, 'name' | 'baseCurrency'>,
): Promise<StoredPortfolio> {
  const p: StoredPortfolio = {
    id: input.id ?? newId('pf'),
    costMethod: input.costMethod ?? 'FIFO',
    createdAt: input.createdAt ?? todayIso(),
    ...input,
  };
  await db.portfolios.put(p);
  return p;
}

export async function updatePortfolio(id: string, patch: Partial<StoredPortfolio>): Promise<void> {
  await db.portfolios.update(id, patch);
}

/** Deletes a portfolio and all its transactions. */
export async function deletePortfolio(id: string): Promise<void> {
  await db.transaction('rw', db.portfolios, db.transactions, async () => {
    await db.transactions.where('portfolioId').equals(id).delete();
    await db.portfolios.delete(id);
  });
}

// ---------------------------------------------------------------------------
// Instruments
// ---------------------------------------------------------------------------

export async function upsertInstruments(list: StoredInstrument[]): Promise<void> {
  if (list.length) await db.instruments.bulkPut(list);
}

// ---------------------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------------------

export async function saveTransaction(t: Omit<StoredTransaction, 'id'> & { id?: string }): Promise<StoredTransaction> {
  const now = Date.now();
  const row: StoredTransaction = {
    ...t,
    id: t.id ?? newId('tx'),
    source: t.source ?? 'manual',
    createdAt: t.createdAt ?? now,
    updatedAt: now,
  } as StoredTransaction;
  await db.transactions.put(row);
  return row;
}

export async function bulkAddTransactions(rows: StoredTransaction[]): Promise<number> {
  const now = Date.now();
  await db.transactions.bulkPut(rows.map((r) => ({ ...r, id: r.id || newId('tx'), createdAt: r.createdAt ?? now, updatedAt: now })));
  return rows.length;
}

export async function deleteTransactions(ids: string[]): Promise<void> {
  await db.transactions.bulkDelete(ids);
}

export async function existingImportHashes(portfolioId: string): Promise<Set<string>> {
  const rows = await db.transactions.where('portfolioId').equals(portfolioId).toArray();
  return new Set(rows.map((r) => r.importHash).filter((h): h is string => !!h));
}

// ---------------------------------------------------------------------------
// Prices
// ---------------------------------------------------------------------------

export async function setManualPrice(p: Omit<ManualPrice, 'updatedAt'>): Promise<void> {
  await db.manualPrices.put({ ...p, updatedAt: Date.now() });
}

export async function deleteManualPrice(instrumentId: string, date: string): Promise<void> {
  await db.manualPrices.delete([instrumentId, date]);
}

export async function cachePriceSeries(series: PriceSeries[], isDemo = false): Promise<void> {
  const now = Date.now();
  const rows: CachedPriceSeries[] = series.map((s) => ({ ...s, updatedAt: now, isDemo }));
  if (rows.length) await db.priceSeries.bulkPut(rows);
}

/** Merge new points into an existing cached series (new points win on the same date). */
export async function mergePriceSeries(series: PriceSeries): Promise<void> {
  const prev = await db.priceSeries.get(series.instrumentId);
  const map = new Map<string, number>();
  // Real data fully replaces synthetic sample series.
  if (prev && !prev.isDemo) for (const p of prev.points) map.set(p.date, p.close);
  for (const p of series.points) map.set(p.date, p.close);
  const points = [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, close]) => ({ date, close }));
  await db.priceSeries.put({ ...series, points, updatedAt: Date.now(), isDemo: false });
}

export async function cacheFxSeries(series: FxSeries[], isDemo = false): Promise<void> {
  const now = Date.now();
  const rows: CachedFxSeries[] = series.map((s) => ({ ...s, pair: `${s.base}/${s.quote}`, updatedAt: now, isDemo }));
  if (rows.length) await db.fxSeries.bulkPut(rows);
}

export async function mergeFxSeries(series: FxSeries): Promise<void> {
  const pair = `${series.base}/${series.quote}`;
  const prev = await db.fxSeries.get(pair);
  const map = new Map<string, number>();
  if (prev && !prev.isDemo) for (const p of prev.points) map.set(p.date, p.rate);
  for (const p of series.points) map.set(p.date, p.rate);
  const points = [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, rate]) => ({ date, rate }));
  await db.fxSeries.put({ ...series, pair, points, updatedAt: Date.now(), isDemo: false });
}

export async function mergeIndexSeries(series: IndexSeries): Promise<void> {
  const prev = await db.indexSeries.get(series.id);
  const map = new Map<string, number>();
  if (prev && !prev.isDemo && prev.kind === series.kind) for (const p of prev.points) map.set(p.date, p.value);
  for (const p of series.points) map.set(p.date, p.value);
  const points = [...map.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([date, value]) => ({ date, value }));
  await db.indexSeries.put({ ...series, points, updatedAt: Date.now(), isDemo: false });
}

export function corporateActionId(a: CorporateAction): string {
  return `${a.instrumentId}|${a.type}|${a.date}`;
}

export async function cacheCorporateActions(actions: CorporateAction[]): Promise<void> {
  const now = Date.now();
  if (actions.length) await db.corporateActions.bulkPut(actions.map((a) => ({ ...a, id: corporateActionId(a), updatedAt: now })));
}

export async function cacheQuotes(quotes: Omit<CachedQuote, 'updatedAt'>[]): Promise<void> {
  const now = Date.now();
  if (quotes.length) await db.quotes.bulkPut(quotes.map((q) => ({ ...q, updatedAt: now })));
}

// ---------------------------------------------------------------------------
// Demo data
// ---------------------------------------------------------------------------

export interface SeedData {
  portfolios: StoredPortfolio[];
  instruments: StoredInstrument[];
  transactions: StoredTransaction[];
  prices: PriceSeries[];
  fx: FxSeries[];
  manualPrices?: Omit<ManualPrice, 'updatedAt'>[];
  indexSeries?: IndexSeries[];
}

export async function seedData(data: SeedData, isDemo: boolean): Promise<void> {
  await db.transaction(
    'rw',
    [db.portfolios, db.instruments, db.transactions, db.priceSeries, db.fxSeries, db.manualPrices, db.indexSeries],
    async () => {
      await db.portfolios.bulkPut(data.portfolios.map((p) => ({ ...p, isDemo })));
      // Never overwrite a user's instrument with a demo copy.
      const existing = new Set(await db.instruments.toCollection().primaryKeys());
      await db.instruments.bulkPut(data.instruments.filter((i) => !isDemo || !existing.has(i.id)).map((i) => ({ ...i, isDemo })));
      await db.transactions.bulkPut(data.transactions.map((t) => ({ ...t, isDemo, source: t.source ?? (isDemo ? 'demo' : 'manual') })));
      const now = Date.now();
      // Demo series only fill gaps; never replace fresher real data.
      for (const s of data.prices) {
        const prev = await db.priceSeries.get(s.instrumentId);
        if (!prev || prev.isDemo || !isDemo) await db.priceSeries.put({ ...s, updatedAt: now, isDemo });
      }
      for (const s of data.fx) {
        const pair = `${s.base}/${s.quote}`;
        const prev = await db.fxSeries.get(pair);
        if (!prev || prev.isDemo || !isDemo) await db.fxSeries.put({ ...s, pair, updatedAt: now, isDemo });
      }
      for (const m of data.manualPrices ?? []) await db.manualPrices.put({ ...m, updatedAt: now });
      for (const s of data.indexSeries ?? []) {
        const prev = await db.indexSeries.get(s.id);
        if (!prev || prev.isDemo || !isDemo) await db.indexSeries.put({ ...s, updatedAt: now, isDemo });
      }
    },
  );
}

/** Removes the sample portfolio(s) and their transactions; keeps user data. */
export async function removeDemoData(): Promise<void> {
  await db.transaction('rw', [db.portfolios, db.transactions, db.instruments, db.manualPrices], async () => {
    const demos = await db.portfolios.filter((p) => !!p.isDemo).toArray();
    for (const p of demos) {
      await db.transactions.where('portfolioId').equals(p.id).delete();
      await db.portfolios.delete(p.id);
    }
    // Drop demo instruments no longer referenced by any transaction.
    const used = new Set((await db.transactions.toArray()).map((t) => t.instrumentId).filter(Boolean));
    const demoInstruments = await db.instruments.filter((i) => !!i.isDemo).toArray();
    const orphaned = demoInstruments.filter((i) => !used.has(i.id)).map((i) => i.id);
    await db.instruments.bulkDelete(orphaned);
    if (orphaned.length) await db.manualPrices.where('instrumentId').anyOf(orphaned).delete();
  });
}

// ---------------------------------------------------------------------------
// Backup / restore
// ---------------------------------------------------------------------------

export interface BackupFile {
  app: 'portafolio-pro';
  schemaVersion: number;
  exportedAt: string;
  portfolios: StoredPortfolio[];
  instruments: StoredInstrument[];
  transactions: StoredTransaction[];
  manualPrices: ManualPrice[];
  settings: { key: string; value: unknown }[];
  priceSeries?: CachedPriceSeries[];
  fxSeries?: CachedFxSeries[];
  indexSeries?: CachedIndexSeries[];
  watchlist?: WatchItem[];
  alerts?: AlertRule[];
  goals?: Goal[];
}

export async function exportBackup(includeMarketCache = true): Promise<BackupFile> {
  const [portfolios, instruments, transactions, manualPrices, settings, watchlist, alerts, goals] = await Promise.all([
    db.portfolios.toArray(),
    db.instruments.toArray(),
    db.transactions.toArray(),
    db.manualPrices.toArray(),
    db.settings.toArray(),
    db.watchlist.toArray(),
    db.alerts.toArray(),
    db.goals.toArray(),
  ]);
  const out: BackupFile = {
    app: 'portafolio-pro',
    schemaVersion: SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    portfolios,
    instruments,
    transactions,
    manualPrices,
    settings,
    watchlist,
    alerts,
    goals,
  };
  if (includeMarketCache) {
    out.priceSeries = await db.priceSeries.toArray();
    out.fxSeries = await db.fxSeries.toArray();
    out.indexSeries = await db.indexSeries.toArray();
  }
  return out;
}

export class BackupError extends Error {}

export function parseBackup(text: string): BackupFile {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    throw new BackupError('invalid_json');
  }
  const b = data as Partial<BackupFile>;
  if (!b || b.app !== 'portafolio-pro' || !Array.isArray(b.portfolios) || !Array.isArray(b.transactions)) {
    throw new BackupError('not_a_backup');
  }
  if ((b.schemaVersion ?? 0) > SCHEMA_VERSION) throw new BackupError('newer_version');
  return {
    app: 'portafolio-pro',
    schemaVersion: b.schemaVersion ?? 1,
    exportedAt: b.exportedAt ?? '',
    portfolios: b.portfolios,
    instruments: b.instruments ?? [],
    transactions: b.transactions.map((t) => ({ ...t, source: t.source ?? 'manual' })),
    manualPrices: b.manualPrices ?? [],
    settings: b.settings ?? [],
    priceSeries: b.priceSeries,
    fxSeries: b.fxSeries,
    indexSeries: b.indexSeries,
    watchlist: b.watchlist,
    alerts: b.alerts,
    goals: b.goals,
  };
}

/** Restores a backup. mode 'replace' wipes local data first; 'merge' upserts by id. */
export async function restoreBackup(b: BackupFile, mode: 'replace' | 'merge' = 'replace'): Promise<void> {
  await db.transaction(
    'rw',
    [db.portfolios, db.instruments, db.transactions, db.manualPrices, db.settings, db.priceSeries, db.fxSeries, db.indexSeries, db.watchlist, db.alerts, db.goals],
    async () => {
      if (mode === 'replace') {
        await Promise.all([
          db.portfolios.clear(),
          db.instruments.clear(),
          db.transactions.clear(),
          db.manualPrices.clear(),
          db.settings.clear(),
        ]);
      }
      await db.portfolios.bulkPut(b.portfolios);
      await db.instruments.bulkPut(b.instruments);
      await db.transactions.bulkPut(b.transactions);
      await db.manualPrices.bulkPut(b.manualPrices);
      await db.settings.bulkPut(b.settings);
      if (b.priceSeries?.length) await db.priceSeries.bulkPut(b.priceSeries);
      if (b.fxSeries?.length) await db.fxSeries.bulkPut(b.fxSeries);
      if (b.indexSeries?.length) await db.indexSeries.bulkPut(b.indexSeries);
      if (b.watchlist?.length) await db.watchlist.bulkPut(b.watchlist);
      if (b.alerts?.length) await db.alerts.bulkPut(b.alerts);
      if (b.goals?.length) await db.goals.bulkPut(b.goals);
    },
  );
}

/**
 * Deletes everything (user data + caches + settings). The sample portfolio is NOT seeded again
 * afterwards: the app opens empty with the onboarding wizard.
 */
export async function wipeAll(): Promise<void> {
  await Promise.all(db.tables.map((t) => t.clear()));
  await setMeta('demoSeeded', true);
}
