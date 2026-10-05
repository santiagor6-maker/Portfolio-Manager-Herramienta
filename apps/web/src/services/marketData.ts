/**
 * Market-data refresh: fetches histories, FX and quotes for everything the user holds from the
 * market-data server, caches them in IndexedDB and reports per-source freshness.
 * When the server is unreachable the app keeps working with cached (or sample) data.
 */
import type { CurrencyCode, Instrument } from '@pm/core';
import { db } from '../db/schema';
import { cacheQuotes, mergeFxSeries, mergePriceSeries } from '../db/repo';
import { useApp, type SourceStatus } from '../store/app';
import { addDays, todayIso } from '../lib/ids';
import { BENCHMARKS } from '../lib/benchmarks';
import { createHttpMarketClient, type MarketClient } from './marketClient';
import type { FxRequest, HistoryRequest, SearchResult } from './marketClient';

let inflight: Promise<void> | null = null;
let lastAuto = 0;

export function getMarketClient(): MarketClient {
  return createHttpMarketClient(useApp.getState().settings.serverUrl);
}

function providerSymbol(i: Instrument): string {
  return i.providerSymbols?.yahoo ?? i.id;
}

/** What needs fetching: instruments with auto pricing, their earliest dates, and currencies. */
async function buildPlan(): Promise<{ histories: HistoryRequest[]; fx: FxRequest[]; quotes: string[]; ids: string[] }> {
  const [txs, instruments, priceCache, fxCache, portfolios] = await Promise.all([
    db.transactions.toArray(),
    db.instruments.toArray(),
    db.priceSeries.toArray(),
    db.fxSeries.toArray(),
    db.portfolios.toArray(),
  ]);
  const { settings } = useApp.getState();
  const today = todayIso();
  const firstUse = new Map<string, string>();
  const currencies = new Set<CurrencyCode>([settings.reportingCurrency, 'USD', 'COP', 'BRL', 'EUR']);
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
  for (const p of portfolios) currencies.add(p.baseCurrency);
  const byId = new Map(instruments.map((i) => [i.id, i]));
  const cacheById = new Map(priceCache.map((c) => [c.instrumentId, c]));

  const histories: HistoryRequest[] = [];
  const quotes: string[] = [];
  const ids: string[] = [];
  const fromFor = (id: string, first: string) => {
    const c = cacheById.get(id);
    const last = c && !c.isDemo ? c.points[c.points.length - 1]?.date : undefined;
    return last ? addDays(last, -7) : addDays(first, -10);
  };
  for (const [id, first] of firstUse) {
    const inst = byId.get(id);
    if (!inst || inst.pricing === 'manual') continue;
    currencies.add(inst.currency);
    histories.push({ symbol: providerSymbol(inst), from: fromFor(id, first), interval: '1d' });
    quotes.push(providerSymbol(inst));
    ids.push(id);
  }
  if (txs.length) {
    for (const b of BENCHMARKS) {
      histories.push({ symbol: providerSymbol(b), from: fromFor(b.id, earliest), interval: '1d' });
      ids.push(b.id);
    }
  }
  const fxByPair = new Map(fxCache.map((f) => [f.pair, f]));
  const fx: FxRequest[] = [];
  for (const c of currencies) {
    if (c === 'USD') continue;
    const cached = fxByPair.get(`USD/${c}`);
    const last = cached && !cached.isDemo ? cached.points[cached.points.length - 1]?.date : undefined;
    fx.push({ base: 'USD', quote: c, from: last ? addDays(last, -7) : addDays(earliest, -10), interval: '1d', source: 'auto' });
  }
  return { histories, fx, quotes, ids };
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

async function doRefresh(): Promise<void> {
  const { setMarket } = useApp.getState();
  setMarket({ status: 'loading' });
  const client = getMarketClient();
  try {
    await client.health();
  } catch {
    setMarket({ status: 'offline', lastRefresh: (await lastRefreshFromDb()) ?? undefined });
    return;
  }
  const plan = await buildPlan();
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
    // Chunk to keep each request reasonable.
    const chunk = 25;
    for (let i = 0; i < Math.max(plan.histories.length, plan.fx.length, 1); i += chunk) {
      const res = await client.batch({
        histories: plan.histories.slice(i, i + chunk),
        fx: plan.fx.slice(i, i + chunk),
        quotes: plan.quotes.slice(i, i + chunk),
      });
      for (let k = 0; k < res.histories.length; k++) {
        const r = res.histories[k]!;
        const id = plan.ids[i + k]!;
        if (r.ok) {
          await mergePriceSeries({ ...r.data.series, instrumentId: id });
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
      const quotes = res.quotes.flatMap((q, k) =>
        q.ok
          ? [
              {
                instrumentId: plan.ids[i + k] ?? q.data.instrumentId,
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
      // Today's quote extends the daily series so valuations are live.
      for (const q of quotes) await mergePriceSeries({ instrumentId: q.instrumentId, currency: q.currency, points: [{ date: q.date, close: q.price }], source: q.source });
    }
    await dropSupersededDemoFx();
    const now = Date.now();
    await db.meta.put({ key: 'lastRefresh', value: now });
    await db.meta.put({ key: 'sources', value: sources });
    setMarket({
      status: failed.length ? 'partial' : 'ok',
      lastRefresh: now,
      sources,
      failedSymbols: failed,
    });
  } catch (e) {
    setMarket({ status: 'offline', sources: { server: { ok: false, message: String(e) } } });
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

/** Restores last refresh info on startup (before any network call). */
export async function hydrateMarketState(): Promise<void> {
  const [last, sources] = await Promise.all([lastRefreshFromDb(), db.meta.get('sources')]);
  useApp.getState().setMarket({
    lastRefresh: last,
    sources: (sources?.value as Record<string, SourceStatus>) ?? {},
  });
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

async function localCatalogSearch(q: string): Promise<SearchResult[]> {
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
    .sort((a, b) => Number(b.symbol.toLowerCase().startsWith(needle)) - Number(a.symbol.toLowerCase().startsWith(needle)))
    .slice(0, 15)
    .map((i) => ({ ...i, origin: 'catalog' as const }));
}
