/**
 * In-memory market data with fill-forward lookups.
 *
 * - Prices: provider series merged with manual series; on the same date the manual
 *   price wins. Lookups return the last point on or before the requested date.
 * - FX: direct pair, inverse pair, triangulation via USD, then via EUR, then any path
 *   found by breadth-first search over the available pairs (max 3 legs). Candidate
 *   routes are tried in that order per date, so a direct series that starts later
 *   than the requested date falls back to a triangulated rate.
 * - Minor-unit quotes (GBp/GBX, ZAc, ILA) are normalized to the major currency.
 */
import type { CurrencyCode, FxSeries, ISODate, MarketData, PriceSeries } from './types';
import type { MarketDataInput } from './api';
import { dayToIso, firstIndexAtOrAfter, isoToDay, lastIndexAtOrBefore } from './dates';

/** Series stored as parallel typed arrays for fast binary search. */
interface DaySeries {
  days: Int32Array;
  values: Float64Array;
}

/**
 * Extended market interface used by the engine internally (day-number based).
 * `createMarketData` returns an object implementing it; any other `MarketData`
 * implementation is wrapped by `toEngineMarket`.
 */
export interface EngineMarket extends MarketData {
  readonly engineMarket: true;
  priceAt(instrumentId: string, day: number): number | undefined;
  /** Last price point on/before day (with its date). */
  pricePointAt(instrumentId: string, day: number): { day: number; close: number } | undefined;
  fxAt(from: CurrencyCode, to: CurrencyCode, day: number): number | undefined;
  /** Like fxAt, but if no rate exists on/before day, uses the first rate after it (for historical cost only). */
  fxNearest(from: CurrencyCode, to: CurrencyCode, day: number): number | undefined;
  /** Currency of the stored price series (after minor-unit normalization), if known. */
  priceCurrency(instrumentId: string): CurrencyCode | undefined;
}

/** Public extension of MarketData returned by createMarketData. */
export interface MarketDataEx extends EngineMarket {
  /** Price point (date + close) on or before date. */
  pricePoint(instrumentId: string, date: ISODate): { date: ISODate; close: number } | undefined;
  /** Instruments with at least one price point. */
  instrumentIds(): string[];
  /** Currency pairs available as `BASE/QUOTE`. */
  fxPairs(): string[];
}

const MINOR_UNITS: Record<string, { major: CurrencyCode; factor: number }> = {
  GBp: { major: 'GBP', factor: 100 },
  GBX: { major: 'GBP', factor: 100 },
  ZAc: { major: 'ZAR', factor: 100 },
  ZAC: { major: 'ZAR', factor: 100 },
  ILA: { major: 'ILS', factor: 100 },
};

export function normalizeCurrency(ccy: CurrencyCode): { currency: CurrencyCode; factor: number } {
  const m = MINOR_UNITS[ccy];
  return m ? { currency: m.major, factor: m.factor } : { currency: ccy, factor: 1 };
}

function buildSeries(points: Map<number, number>): DaySeries {
  const days = Array.from(points.keys()).sort((a, b) => a - b);
  const values = new Float64Array(days.length);
  days.forEach((d, i) => (values[i] = points.get(d) as number));
  return { days: Int32Array.from(days), values };
}

function lookup(s: DaySeries, day: number): number | undefined {
  const i = lastIndexAtOrBefore(s.days, day);
  return i < 0 ? undefined : s.values[i];
}

function lookupAfter(s: DaySeries, day: number): number | undefined {
  const i = firstIndexAtOrAfter(s.days, day);
  return i < 0 ? undefined : s.values[i];
}

interface Leg {
  series: DaySeries;
  invert: boolean;
}
type Route = Leg[];

export function createMarketDataImpl(input: MarketDataInput): MarketDataEx {
  // ---- prices -------------------------------------------------------------
  const priceMaps = new Map<string, Map<number, number>>();
  const priceCcy = new Map<string, CurrencyCode>();
  const addPrices = (series: PriceSeries[] | undefined) => {
    for (const s of series ?? []) {
      if (!s || !s.instrumentId) continue;
      const { currency, factor } = normalizeCurrency(s.currency);
      if (currency) priceCcy.set(s.instrumentId, currency);
      let m = priceMaps.get(s.instrumentId);
      if (!m) priceMaps.set(s.instrumentId, (m = new Map()));
      for (const p of s.points ?? []) {
        if (!p || !Number.isFinite(p.close) || p.close < 0 || typeof p.date !== 'string') continue;
        const day = isoToDay(p.date);
        if (!Number.isFinite(day)) continue;
        m.set(day, p.close / factor); // later series (manual) override earlier ones on the same date
      }
    }
  };
  addPrices(input.prices);
  addPrices(input.manualPrices);
  const prices = new Map<string, DaySeries>();
  for (const [id, m] of priceMaps) prices.set(id, buildSeries(m));

  // ---- fx -----------------------------------------------------------------
  const fxMaps = new Map<string, Map<number, number>>();
  const addFx = (s: FxSeries) => {
    if (!s || !s.base || !s.quote || s.base === s.quote) return;
    const b = normalizeCurrency(s.base);
    const q = normalizeCurrency(s.quote);
    // rate quote-per-base; base minor => fewer quote per minor unit; quote minor => fewer majors.
    const adj = b.factor / q.factor;
    const key = `${b.currency}/${q.currency}`;
    let m = fxMaps.get(key);
    if (!m) fxMaps.set(key, (m = new Map()));
    for (const p of s.points ?? []) {
      if (!p || !Number.isFinite(p.rate) || p.rate <= 0 || typeof p.date !== 'string') continue;
      const day = isoToDay(p.date);
      if (!Number.isFinite(day)) continue;
      m.set(day, p.rate * adj);
    }
  };
  for (const s of input.fx ?? []) addFx(s);
  const fxSeries = new Map<string, DaySeries>();
  const graph = new Map<CurrencyCode, Set<CurrencyCode>>();
  const link = (a: CurrencyCode, b: CurrencyCode) => {
    let s = graph.get(a);
    if (!s) graph.set(a, (s = new Set()));
    s.add(b);
  };
  for (const [key, m] of fxMaps) {
    if (m.size === 0) continue;
    fxSeries.set(key, buildSeries(m));
    const [a, b] = key.split('/') as [string, string];
    link(a, b);
    link(b, a);
  }

  const directLeg = (from: CurrencyCode, to: CurrencyCode): Leg | undefined => {
    const d = fxSeries.get(`${from}/${to}`);
    if (d) return { series: d, invert: false };
    const i = fxSeries.get(`${to}/${from}`);
    if (i) return { series: i, invert: true };
    return undefined;
  };

  /** Two directions may both exist (USD/COP and COP/USD); collect both legs for robustness. */
  const legsBetween = (from: CurrencyCode, to: CurrencyCode): Leg[] => {
    const out: Leg[] = [];
    const d = fxSeries.get(`${from}/${to}`);
    if (d) out.push({ series: d, invert: false });
    const i = fxSeries.get(`${to}/${from}`);
    if (i) out.push({ series: i, invert: true });
    return out;
  };

  const routeCache = new Map<string, Route[]>();
  const routesFor = (from: CurrencyCode, to: CurrencyCode): Route[] => {
    const key = `${from}>${to}`;
    let routes = routeCache.get(key);
    if (routes) return routes;
    routes = [];
    for (const leg of legsBetween(from, to)) routes.push([leg]);
    for (const via of ['USD', 'EUR']) {
      if (via === from || via === to) continue;
      const a = directLeg(from, via);
      const b = directLeg(via, to);
      if (a && b) routes.push([a, b]);
    }
    // Generic BFS for anything else (up to 3 legs).
    if (routes.length === 0) {
      const prev = new Map<CurrencyCode, CurrencyCode>();
      const queue: CurrencyCode[] = [from];
      const seen = new Set([from]);
      while (queue.length) {
        const c = queue.shift() as CurrencyCode;
        if (c === to) break;
        for (const n of graph.get(c) ?? []) {
          if (seen.has(n)) continue;
          seen.add(n);
          prev.set(n, c);
          queue.push(n);
        }
      }
      if (prev.has(to)) {
        const path: CurrencyCode[] = [to];
        while (path[0] !== from) path.unshift(prev.get(path[0] as string) as string);
        if (path.length <= 4) {
          const r: Route = [];
          for (let k = 0; k + 1 < path.length; k++) r.push(directLeg(path[k] as string, path[k + 1] as string) as Leg);
          routes.push(r);
        }
      }
    }
    routeCache.set(key, routes);
    return routes;
  };

  const evalRoute = (route: Route, day: number, nearest: boolean): number | undefined => {
    let rate = 1;
    for (const leg of route) {
      let v = lookup(leg.series, day);
      if (v === undefined && nearest) v = lookupAfter(leg.series, day);
      if (v === undefined) return undefined;
      rate *= leg.invert ? 1 / v : v;
    }
    return rate;
  };

  const fxImpl = (from: CurrencyCode, to: CurrencyCode, day: number, nearest: boolean): number | undefined => {
    if (from === to) return 1;
    const f = normalizeCurrency(from);
    const t = normalizeCurrency(to);
    const adj = t.factor / f.factor;
    if (f.currency === t.currency) return adj;
    for (const r of routesFor(f.currency, t.currency)) {
      const v = evalRoute(r, day, false);
      if (v !== undefined) return v * adj;
    }
    if (nearest) {
      for (const r of routesFor(f.currency, t.currency)) {
        const v = evalRoute(r, day, true);
        if (v !== undefined) return v * adj;
      }
    }
    return undefined;
  };

  const market: MarketDataEx = {
    engineMarket: true,
    price(instrumentId, date) {
      const s = prices.get(instrumentId);
      return s ? lookup(s, isoToDay(date)) : undefined;
    },
    fx(from, to, date) {
      return fxImpl(from, to, isoToDay(date), false);
    },
    priceAt(instrumentId, day) {
      const s = prices.get(instrumentId);
      return s ? lookup(s, day) : undefined;
    },
    pricePointAt(instrumentId, day) {
      const s = prices.get(instrumentId);
      if (!s) return undefined;
      const i = lastIndexAtOrBefore(s.days, day);
      return i < 0 ? undefined : { day: s.days[i] as number, close: s.values[i] as number };
    },
    pricePoint(instrumentId, date) {
      const p = market.pricePointAt(instrumentId, isoToDay(date));
      return p ? { date: dayToIso(p.day), close: p.close } : undefined;
    },
    fxAt: (from, to, day) => fxImpl(from, to, day, false),
    fxNearest: (from, to, day) => fxImpl(from, to, day, true),
    priceCurrency: (id) => priceCcy.get(id),
    instrumentIds: () => Array.from(prices.keys()),
    fxPairs: () => Array.from(fxSeries.keys()),
  };
  return market;
}

/** Wrap any MarketData implementation into the day-number interface used by the engine. */
export function toEngineMarket(m: MarketData): EngineMarket {
  if ((m as Partial<EngineMarket>).engineMarket === true) return m as EngineMarket;
  return {
    engineMarket: true,
    price: (id, date) => m.price(id, date),
    fx: (a, b, date) => m.fx(a, b, date),
    priceAt: (id, day) => m.price(id, dayToIso(day)),
    pricePointAt: (id, day) => {
      const close = m.price(id, dayToIso(day));
      return close === undefined ? undefined : { day, close };
    },
    fxAt: (a, b, day) => (a === b ? 1 : m.fx(a, b, dayToIso(day))),
    fxNearest: (a, b, day) => (a === b ? 1 : m.fx(a, b, dayToIso(day))),
    priceCurrency: () => undefined,
  };
}
