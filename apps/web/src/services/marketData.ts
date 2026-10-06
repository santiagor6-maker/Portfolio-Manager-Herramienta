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
import { createHttpMarketClient, type FxRequest, type HistoryRequest, type MarketClient, type SearchResult } from './marketClient';
import { evaluateAlerts } from './alerts';

let inflight: Promise<void> | null = null;
let lastAuto = 0;

/** Indices fetched for real returns and rate benchmarks. */
export const INDEX_IDS: IndexId[] = ['IPC_CO', 'IBR', 'UVR', 'IPCA', 'CDI', 'SELIC', 'CPI_US', 'HICP_EA'];

export function getMarketClient(): MarketClient {
  return createHttpMarketClient(useApp.getState().settings.serverUrl);
}

function providerSymbol(i: Instrument): string {
  return i.providerSymbols?.yahoo ?? i.id;
}

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

export async function refreshMarketData(opts: { force?: boolean } = {}): Promise<void> {
  if (inflight) return inflight;
  // Auto refreshes are throttled across reloads using the persisted timestamp.
  const last = Math.max(lastAuto, useApp.getState().market.lastRefresh ?? 0);
  if (!opts.force && Date.now() - last < 5 * 60_000) return;
  lastAuto = Date.now();
  inflight = doRefresh().finally(() => {
    inflight = null;
  });
  return inflight;
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
        if (r.ok) {
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
          bump(r.data.series.source || 'fx', true);
        } else bump('fx', false, r.error.message);
      }
      for (const r of res.indices ?? []) {
        if (r.ok) {
          await mergeIndexSeries(r.data.series);
          bump(`index:${r.data.series.id}`, true);
        } else bump('indices', false, r.error.message);
      }
      const quotes = res.quotes.flatMap((q, k) =>
        q.ok
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
          : [],
      );
      await cacheQuotes(quotes);
      for (const q of quotes) await mergePriceSeries({ instrumentId: q.instrumentId, currency: q.currency, points: [{ date: q.date, close: q.price }], source: q.source });
    }
    await dropSupersededDemoFx();
    const now = Date.now();
    const status: MarketStatus = failed.length ? 'partial' : 'ok';
    await persistStatus(status, sources, now);
    setMarket({ status, lastRefresh: now, sources, failedSymbols: failed });
    void evaluateAlerts();
  } catch (e) {
    setMarket({ status: 'offline', sources: { server: { ok: false, message: String(e) } } });
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
    status: (status?.value as MarketStatus | undefined) ?? 'idle',
    sources: (sources?.value as Record<string, SourceStatus>) ?? {},
  });
}

/** Fetches daily history for one instrument (used by the transaction form to suggest a price). */
export async function fetchHistory(inst: Instrument, from: string): Promise<boolean> {
  if (inst.pricing === 'manual' || inst.accrual) return false;
  try {
    const res = await getMarketClient().batch({ histories: [{ symbol: providerSymbol(inst), from, interval: '1d' }] });
    const r = res.histories[0];
    if (r?.ok) {
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
  const all = new Map<string, Instrument>();
  for (const i of [...CATALOG, ...mine]) all.set(i.id, i);
  return [...all.values()]
    .filter(
      (i) =>
        i.symbol.toLowerCase().includes(needle) ||
        i.name.toLowerCase().includes(needle) ||
        (i.isin ?? '').toLowerCase() === needle,
    )
    .sort((a, b) => Number(b.symbol.toLowerCase() === needle) - Number(a.symbol.toLowerCase() === needle) || Number(b.symbol.toLowerCase().startsWith(needle)) - Number(a.symbol.toLowerCase().startsWith(needle)))
    .slice(0, 15)
    .map((i) => ({ ...i, origin: 'catalog' as const }));
}
