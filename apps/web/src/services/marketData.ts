/**
 * Market-data refresh: fetches histories (with corporate actions), FX, rate/inflation indices and
 * quotes for everything the user holds or watches from the market-data server, caches them in
 * IndexedDB and reports per-source freshness. When the server is unreachable the app keeps working
 * with cached (or sample) data. Sample-portfolio instruments are frozen (never refreshed) so the
 * demo stays internally consistent.
 */
import type { CurrencyCode, IndexId, Instrument } from '@pm/core';
import { db } from '../db/schema';
import { cacheCorporateActions, cacheQuotes, mergeFxSeries, mergeIndexSeries, mergePriceSeries } from '../db/repo';
import { useApp, type MarketStatus, type SourceStatus } from '../store/app';
import { addDays, todayIso } from '../lib/ids';
import { BENCHMARKS } from '../lib/benchmarks';
import { createHttpMarketClient, MarketDataApiError, type FxRequest, type HistoryRequest, type MarketClient, type SearchResult } from './marketClient';
import { evaluateAlerts } from './alerts';
import { canonicalInstrument, type RenamedInstrument } from '../lib/renames';

let inflight: Promise<void> | null = null;
let queuedForce: Promise<void> | null = null;
let lastAuto = 0;

/** Indices fetched for real returns and rate benchmarks. */
export const INDEX_IDS: IndexId[] = ['IPC_CO', 'IBR', 'UVR', 'IPCA', 'CDI', 'SELIC', 'CPI_US', 'HICP_EA'];

export function getMarketClient(): MarketClient {
  const { serverUrl, apiToken } = useApp.getState().settings;
  return createHttpMarketClient(serverUrl, undefined, apiToken);
}

/**
 * M37: prices are requested by instrument id (`XNYS:DTE`, `XBOG:ISA`, `INDEX:^BVSP`) so the server
 * resolves the right listing; a bare provider symbol could hit another market (DTE in NYSE vs Xetra).
 * Ids that are not exchange-qualified fall back to the provider symbol.
 */
export function requestSymbol(i: Instrument): string {
  return /^(?:[A-Z]{4}|INDEX):\S+$/.test(i.id) ? i.id : (i.providerSymbols?.yahoo ?? i.id);
}

/**
 * Rejects a response for another instrument or currency (US/EU symbol mix-ups): the instrument id or
 * symbol must match, and the currency must be the instrument's (case-insensitive: GBp/GBP is a unit
 * question handled by the engine, not a mismatch).
 */
export function responseMatches(inst: Instrument, got: { id?: string; symbol?: string; currency?: string }): boolean {
  const ccyOk = !got.currency || !inst.currency || got.currency.toUpperCase() === inst.currency.toUpperCase();
  const sym = (s?: string) => (s ?? '').split(':').pop()!.replace(/\.[A-Z]{1,3}$/, '').toUpperCase();
  const idOk = !got.id || got.id === inst.id || sym(got.id) === sym(inst.id) || (!!got.symbol && sym(got.symbol) === sym(inst.symbol));
  return ccyOk && idOk;
}

const providerSymbol = requestSymbol;

interface Plan {
  histories: HistoryRequest[];
  /** Instrument id of each history request. */
  ids: string[];
  fx: FxRequest[];
  quotes: string[];
  quoteIds: string[];
  indices: { id: IndexId; from: string }[];
}

/** What needs fetching: auto-priced instruments of real portfolios, watchlist, FX, indices. */
export async function buildPlan(today = todayIso()): Promise<Plan> {
  const [allTxs, instruments, priceCache, fxCache, portfolios, watch, indexCache] = await Promise.all([
    db.transactions.toArray(),
    db.instruments.toArray(),
    db.priceSeries.toArray(),
    db.fxSeries.toArray(),
    db.portfolios.toArray(),
    db.watchlist.toArray(),
    db.indexSeries.toArray(),
  ]);
  const demoIds = new Set(portfolios.filter((p) => p.isDemo).map((p) => p.id));
  // Frozen demo: only real portfolios drive refreshes.
  const txs = allTxs.filter((t) => !demoIds.has(t.portfolioId));
  const { settings } = useApp.getState();
  const firstUse = new Map<string, string>();
  const currencies = new Set<CurrencyCode>([settings.reportingCurrency]);
  let earliest = today;
  for (const t of txs) {
    currencies.add(t.currency);
    if (t.toCurrency) currencies.add(t.toCurrency);
    if (t.date < earliest) earliest = t.date;
    if (t.instrumentId) {
      const prev = firstUse.get(t.instrumentId);
      if (!prev || t.date < prev) firstUse.set(t.instrumentId, t.date);
    }
  }
  for (const p of portfolios) if (!p.isDemo) currencies.add(p.baseCurrency);
  const byId = new Map(instruments.map((i) => [i.id, i]));
  const cacheById = new Map(priceCache.map((c) => [c.instrumentId, c]));
  const plan: Plan = { histories: [], ids: [], fx: [], quotes: [], quoteIds: [], indices: [] };
  const fromFor = (id: string, first: string) => {
    const c = cacheById.get(id);
    const last = c && !c.isDemo ? c.points[c.points.length - 1]?.date : undefined;
    return last ? addDays(last, -10) : addDays(first, -10);
  };
  for (const [id, first] of firstUse) {
    const inst = byId.get(id);
    if (!inst || inst.pricing === 'manual' || inst.accrual) continue;
    currencies.add(inst.currency);
    plan.histories.push({ symbol: providerSymbol(inst), from: fromFor(id, first), interval: '1d' });
    plan.ids.push(id);
    plan.quotes.push(providerSymbol(inst));
    plan.quoteIds.push(id);
  }
  for (const w of watch) {
    const inst = byId.get(w.instrumentId);
    if (!inst || plan.quoteIds.includes(inst.id)) continue;
    plan.histories.push({ symbol: providerSymbol(inst), from: fromFor(inst.id, addDays(today, -400)), interval: '1d' });
    plan.ids.push(inst.id);
    plan.quotes.push(providerSymbol(inst));
    plan.quoteIds.push(inst.id);
  }
  if (txs.length) {
    for (const b of BENCHMARKS) {
      plan.histories.push({ symbol: providerSymbol(b), from: fromFor(b.id, earliest), interval: '1d', adjust: 'none' });
      plan.ids.push(b.id);
    }
    const idxById = new Map(indexCache.map((s) => [s.id, s]));
    for (const id of INDEX_IDS) {
      const c = idxById.get(id);
      const last = c && !c.isDemo ? c.points[c.points.length - 1]?.date : undefined;
      plan.indices.push({ id, from: last ? addDays(last, -45) : addDays(earliest, -40) });
    }
  }
  const fxByPair = new Map(fxCache.map((f) => [f.pair, f]));
  if (txs.length || watch.length) {
    for (const c of currencies) {
      if (c === 'USD') continue;
      const cached = fxByPair.get(`USD/${c}`);
      const last = cached && !cached.isDemo ? cached.points[cached.points.length - 1]?.date : undefined;
      plan.fx.push({ base: 'USD', quote: c, from: last ? addDays(last, -7) : addDays(earliest, -10), interval: '1d', source: 'auto' });
    }
  }
  return plan;
}

/**
 * Refreshes market data. `fx` (W40): fetch only the USD/<currency> series of those currencies right
 * away (used when the reporting currency changes to one whose rate is not cached), without waiting
 * for — or being throttled by — the full refresh.
 */
export function refreshMarketData(opts: { force?: boolean; fx?: CurrencyCode[] } = {}): Promise<void> {
  if (opts.fx) return fetchFx(opts.fx).then(() => undefined);
  if (inflight) {
    if (!opts.force) return inflight;
    // W49: a forced refresh (e.g. after an import) runs again after the current one, whose plan may
    // not include the new assets — once, however many callers ask; the flag makes a reload retry it.
    void db.meta.put({ key: 'refreshPending', value: true });
    queuedForce ??= inflight
      .catch(() => undefined)
      .then(() => {
        queuedForce = null;
        return refreshMarketData(opts);
      });
    return queuedForce;
  }
  inflight = (async () => {
    // Auto refreshes are throttled across reloads using persisted timestamps. Failed attempts
    // count too and a 429 backs off longer: reloading must not hammer the server (W28).
    if (!opts.force) {
      const lastAttempt = ((await db.meta.get('lastAttempt'))?.value as number | undefined) ?? 0;
      const backoffUntil = ((await db.meta.get('refreshBackoffUntil'))?.value as number | undefined) ?? 0;
      // W49: a refresh interrupted by a reload (or a failed one) is retried at once, not after the throttle.
      const pending = !!(await db.meta.get('refreshPending'))?.value;
      const last = Math.max(lastAuto, useApp.getState().market.lastRefresh ?? 0);
      if (Date.now() < backoffUntil) return;
      if (!pending && (Date.now() - last < 5 * 60_000 || Date.now() - lastAttempt < 2 * 60_000)) return;
    }
    lastAuto = Date.now();
    await db.meta.bulkPut([
      { key: 'lastAttempt', value: lastAuto },
      { key: 'refreshPending', value: true },
    ]);
    await doRefresh();
    // Finished (ok, partial or failed): only a refresh cut short by a reload keeps the flag.
    await db.meta.delete('refreshPending');
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

const fxInflight = new Map<string, Promise<boolean>>();
/** Downloads in flight per currency: overlapping fetches never clear each other's pending state. */
const fxRunning = new Map<string, number>();

function trackFx(currencies: string[], delta: 1 | -1): void {
  for (const c of currencies) {
    const n = (fxRunning.get(c) ?? 0) + delta;
    if (n > 0) fxRunning.set(c, n);
    else fxRunning.delete(c);
  }
  useApp.getState().setMarket({ fxPending: [...fxRunning.keys()].sort() });
}

/** First transaction date of the real portfolios (all portfolios when only the sample exists). */
async function earliestTxDate(): Promise<string | undefined> {
  const [portfolios, txs] = await Promise.all([db.portfolios.toArray(), db.transactions.toArray()]);
  const demo = new Set(portfolios.filter((p) => p.isDemo).map((p) => p.id));
  const real = txs.filter((t) => !demo.has(t.portfolioId));
  let first: string | undefined;
  for (const t of real.length ? real : txs) if (!first || t.date < first) first = t.date;
  return first;
}

/**
 * W40: downloads USD/<c> for each currency (USD itself needs none) from the first transaction, or
 * from the last cached point when the cached real series already covers the history. The store's
 * `fxPending`/`fxFetchedAt` drive the "Convirtiendo a BRL…" state; `fxFailed` the "no rate" warning.
 */
export function fetchFx(currencies: CurrencyCode[]): Promise<boolean> {
  const wanted = [...new Set(currencies)].filter((c) => c && c !== 'USD').sort();
  if (!wanted.length) return Promise.resolve(true);
  const key = wanted.join(',');
  const running = fxInflight.get(key);
  if (running) return running;
  const { setMarket } = useApp.getState();
  setMarket({ fxFailed: useApp.getState().market.fxFailed.filter((c) => !wanted.includes(c)) });
  trackFx(wanted, 1);
  const job = (async () => {
    const today = todayIso();
    const first = (await earliestTxDate()) ?? addDays(today, -400);
    const fx: FxRequest[] = [];
    for (const c of wanted) {
      const cached = await db.fxSeries.get(`USD/${c}`);
      const pts = cached && !cached.isDemo ? cached.points : [];
      const covers = pts.length > 0 && pts[0]!.date <= first;
      fx.push({ base: 'USD', quote: c, from: covers ? addDays(pts[pts.length - 1]!.date, -7) : addDays(first, -10), interval: '1d', source: 'auto' });
    }
    const failed: CurrencyCode[] = [];
    try {
      const res = await getMarketClient().batch({ fx });
      for (const [k, r] of res.fx.entries()) {
        if (r.ok && r.data.series.points.length) await mergeFxSeries(r.data.series);
        else failed.push(fx[k]!.quote);
      }
    } catch {
      failed.push(...wanted);
    }
    const now = useApp.getState().market;
    const fetchedAt = { ...now.fxFetchedAt };
    for (const c of wanted) if (!failed.includes(c)) fetchedAt[c] = Date.now();
    setMarket({ fxFailed: [...new Set([...now.fxFailed, ...failed])], fxFetchedAt: fetchedAt });
    return failed.length === 0;
  })().finally(() => {
    fxInflight.delete(key);
    trackFx(wanted, -1);
  });
  fxInflight.set(key, job);
  return job;
}

/**
 * W40: called when the reporting currency changes. Fetches USD/<currency> at once when no real
 * series is cached for it (the sample's synthetic series never value a real portfolio).
 */
export async function ensureReportingFx(currency: CurrencyCode): Promise<void> {
  if (currency === 'USD') return;
  const real = (await db.portfolios.toArray()).filter((p) => !p.isDemo);
  if (!real.length) return;
  const cached = await db.fxSeries.get(`USD/${currency}`);
  if (cached && !cached.isDemo && cached.points.length) return;
  await fetchFx([currency]);
}

async function persistStatus(status: MarketStatus, sources?: Record<string, SourceStatus>, lastRefresh?: number) {
  await db.meta.put({ key: 'marketStatus', value: status });
  if (sources) await db.meta.put({ key: 'sources', value: sources });
  if (lastRefresh) await db.meta.put({ key: 'lastRefresh', value: lastRefresh });
}

async function doRefresh(): Promise<void> {
  const { setMarket } = useApp.getState();
  setMarket({ status: 'loading' });
  const client = getMarketClient();
  try {
    await client.health();
  } catch {
    setMarket({ status: 'offline', lastRefresh: (await lastRefreshFromDb()) ?? undefined });
    await persistStatus('offline');
    return;
  }
  const plan = await buildPlan();
  const byIdAll = new Map<string, Instrument>([...BENCHMARKS, ...(await db.instruments.toArray())].map((i) => [i.id, i]));
  if (!plan.histories.length && !plan.fx.length && !plan.indices.length) {
    // Only the frozen sample portfolio: nothing to refresh, server is fine.
    setMarket({ status: 'ok', failedSymbols: [] });
    await persistStatus('ok');
    return;
  }
  const sources: Record<string, SourceStatus> = {};
  const failed: string[] = [];
  const bump = (source: string, ok: boolean, message?: string) => {
    const s = (sources[source] ??= { ok: true, count: 0 });
    s.count = (s.count ?? 0) + (ok ? 1 : 0);
    if (ok) s.updatedAt = Date.now();
    if (!ok) {
      s.ok = false;
      s.message = message;
    }
  };
  try {
    const chunk = 25;
    const rounds = Math.max(plan.histories.length, plan.fx.length, plan.quotes.length, plan.indices.length, 1);
    for (let i = 0; i < rounds; i += chunk) {
      const res = await client.batch({
        histories: plan.histories.slice(i, i + chunk),
        fx: plan.fx.slice(i, i + chunk),
        quotes: plan.quotes.slice(i, i + chunk),
        indices: plan.indices.slice(i, i + chunk),
      });
      for (let k = 0; k < res.histories.length; k++) {
        const r = res.histories[k]!;
        const id = plan.ids[i + k]!;
        const inst = byIdAll.get(id);
        if (r.ok && inst && !responseMatches(inst, { id: r.data.instrument?.id, symbol: r.data.instrument?.symbol, currency: r.data.series.currency })) {
          failed.push(plan.histories[i + k]!.symbol);
          bump('yahoo', false, `${id}: ${r.data.instrument?.id ?? '?'} ${r.data.series.currency ?? ''} (mismatch)`);
        } else if (r.ok) {
          await mergePriceSeries({ ...r.data.series, instrumentId: id });
          if (r.data.actions?.length) await cacheCorporateActions(r.data.actions.map((a) => ({ ...a, instrumentId: id })));
          bump(r.data.series.source || 'yahoo', true);
        } else {
          failed.push(plan.histories[i + k]!.symbol);
          bump('yahoo', false, r.error.message);
        }
      }
      for (const r of res.fx) {
        if (r.ok) {
          await mergeFxSeries(r.data.series);
          const failedFx = useApp.getState().market.fxFailed;
          if (failedFx.includes(r.data.series.quote)) setMarket({ fxFailed: failedFx.filter((c) => c !== r.data.series.quote) });
          bump(r.data.series.source || 'fx', true);
        } else bump('fx', false, r.error.message);
      }
      for (const [k, r] of (res.indices ?? []).entries()) {
        if (r.ok) {
          await mergeIndexSeries(r.data.series);
          bump(`idx_${r.data.series.id}`, true);
        } else bump(`idx_${plan.indices[i + k]?.id ?? 'unknown'}`, false, r.error.message); // W27: name the index
      }
      const quotes = res.quotes.flatMap((q, k) => {
        const inst = byIdAll.get(plan.quoteIds[i + k] ?? '');
        return q.ok && (!inst || responseMatches(inst, { id: q.data.instrumentId, currency: q.data.currency }))
          ? [
              {
                instrumentId: plan.quoteIds[i + k] ?? q.data.instrumentId,
                price: q.data.price,
                previousClose: q.data.previousClose,
                currency: q.data.currency,
                date: q.data.date,
                source: q.data.source,
              },
            ]
          : [];
      });
      await cacheQuotes(quotes);
      for (const q of quotes) await mergePriceSeries({ instrumentId: q.instrumentId, currency: q.currency, points: [{ date: q.date, close: q.price }], source: q.source });
    }
    await dropSupersededDemoFx();
    const now = Date.now();
    const status: MarketStatus = failed.length ? 'partial' : 'ok';
    await persistStatus(status, sources, now);
    setMarket({ status, lastRefresh: now, sources, failedSymbols: failed, error: undefined });
    void evaluateAlerts();
  } catch (e) {
    const status = e instanceof MarketDataApiError ? e.status : undefined;
    const code = e instanceof MarketDataApiError ? e.code : undefined;
    const message = e instanceof Error ? e.message : String(e);
    if (status === 429) {
      const retry = Number((e as MarketDataApiError).details && ((e as MarketDataApiError).details as { retryAfter?: number }).retryAfter) || 300;
      await db.meta.put({ key: 'refreshBackoffUntil', value: Date.now() + retry * 1000 });
    }
    // Per-symbol failures come back inside the batch (ok: false); reaching here means the whole refresh failed.
    setMarket({ status: 'offline', error: { status, code, message }, sources: { server: { ok: false, message } } });
    await persistStatus('offline');
  }
}

/**
 * Sample FX series must not linger next to real ones (they would win triangulation for their
 * pair). Remove a demo pair once both of its currencies have a real USD rate.
 */
async function dropSupersededDemoFx(): Promise<void> {
  const all = await db.fxSeries.toArray();
  const realUsd = new Set<string>(['USD']);
  for (const s of all) {
    if (s.isDemo) continue;
    if (s.base === 'USD') realUsd.add(s.quote);
    if (s.quote === 'USD') realUsd.add(s.base);
  }
  const stale = all.filter((s) => s.isDemo && realUsd.has(s.base) && realUsd.has(s.quote)).map((s) => s.pair);
  if (stale.length) await db.fxSeries.bulkDelete(stale);
}

async function lastRefreshFromDb(): Promise<number | undefined> {
  return (await db.meta.get('lastRefresh'))?.value as number | undefined;
}

/** Restores last refresh info and status on startup (before any network call). */
export async function hydrateMarketState(): Promise<void> {
  const [last, sources, status] = await Promise.all([lastRefreshFromDb(), db.meta.get('sources'), db.meta.get('marketStatus')]);
  useApp.getState().setMarket({
    lastRefresh: last,
    // W60: an 'offline' / 'loading' from the previous session says nothing about now (the start-up refresh decides).
    status: status?.value === 'ok' || status?.value === 'partial' ? (status.value as MarketStatus) : 'idle',
    sources: (sources?.value as Record<string, SourceStatus>) ?? {},
  });
}

/** Fetches daily history for one instrument (used by the transaction form to suggest a price). */
export async function fetchHistory(inst: Instrument, from: string): Promise<boolean> {
  if (inst.pricing === 'manual' || inst.accrual) return false;
  try {
    const res = await getMarketClient().batch({ histories: [{ symbol: providerSymbol(inst), from, interval: '1d' }] });
    const r = res.histories[0];
    if (r?.ok && responseMatches(inst, { id: r.data.instrument?.id, symbol: r.data.instrument?.symbol, currency: r.data.series.currency })) {
      await mergePriceSeries({ ...r.data.series, instrumentId: inst.id });
      return true;
    }
  } catch {
    /* offline */
  }
  return false;
}

/** Ticker search: server first, local catalog fallback (instruments the user already has). */
export async function searchInstruments(q: string): Promise<{ results: SearchResult[]; offline: boolean }> {
  const query = q.trim();
  if (!query) return { results: [], offline: false };
  const local = await localCatalogSearch(query);
  try {
    const remote = await getMarketClient().search(query);
    const seen = new Set(remote.map((r) => r.id));
    return { results: [...remote, ...local.filter((l) => !seen.has(l.id))].slice(0, 15), offline: false };
  } catch {
    return { results: local, offline: true };
  }
}

export async function localCatalogSearch(q: string): Promise<SearchResult[]> {
  const needle = q.toLowerCase();
  const { CATALOG } = await import('../lib/catalog');
  const mine = await db.instruments.toArray();
  const all = new Map<string, RenamedInstrument>();
  // Core R8: an old ticker (PFBCOLOM) is offered as the current one (PFCIBEST, "antes PFBCOLOM").
  for (const raw of [...CATALOG, ...mine]) {
    const i = canonicalInstrument(raw);
    const prev = all.get(i.id);
    all.set(i.id, prev ? { ...prev, renamedFrom: prev.renamedFrom ?? i.renamedFrom } : i);
  }
  return [...all.values()]
    .filter(
      (i) =>
        i.symbol.toLowerCase().includes(needle) ||
        (i.renamedFrom ?? '').toLowerCase().includes(needle) ||
        i.name.toLowerCase().includes(needle) ||
        (i.isin ?? '').toLowerCase() === needle,
    )
    .sort((a, b) => Number(b.symbol.toLowerCase() === needle) - Number(a.symbol.toLowerCase() === needle) || Number(b.symbol.toLowerCase().startsWith(needle)) - Number(a.symbol.toLowerCase().startsWith(needle)))
    .slice(0, 15)
    .map(({ renamedFrom, ...i }) => ({
      ...i,
      origin: 'catalog' as const,
      ...(renamedFrom ? { renamedFrom: { kind: 'rename' as const, fromId: `${i.exchange}:${renamedFrom}`, toId: i.id, ratio: 1 } } : {}),
    }));
}
