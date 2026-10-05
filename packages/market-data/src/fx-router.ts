/**
 * FX router: picks the official source for each pair and falls back down a chain.
 *
 * Preference (mode `auto`):
 *   1. Direct official providers, in this order: the local central bank of the emerging-market
 *      currency first (USD/COP -> Banrep TRM; X/BRL -> BCB PTAX, then BCB SGS), then the ECB for
 *      EUR pairs and crosses between ECB currencies (USD/GBP, USD/MXN, ...).
 *   2. Official triangulation through USD when both legs are official (EUR/COP = ECB EUR/USD x TRM,
 *      BRL/COP = PTAX x TRM). Source is reported as e.g. `ecb*banrep-trm`.
 *   3. Yahoo (`COP=X`, `EURUSD=X`, ...) as universal fallback.
 * Mode `official` stops after 2; mode `yahoo` uses only 3. Every failure is recorded in
 * `fallbacks` and the answering provider in `source`.
 */
import type { CurrencyCode, FxPoint, ISODate } from '@pm/core';
import { HOUR, historyTtlMs, type TieredCache } from './cache';
import { addDays, eachDay, todayISO } from './dates';
import { MarketDataError, errorMessage } from './errors';
import type { FxProvider } from './providers/types';
import { roundSig } from './series';
import type { FxSourceMode } from './types';

export interface FxResult {
  points: FxPoint[];
  source: string;
  fallbacks: { source: string; error: string }[];
}

export interface FxRouterOptions {
  /** Official providers in preference order + market fallback(s). */
  providers: FxProvider[];
  cache?: TieredCache;
  today?: () => ISODate;
}

type Route =
  | { kind: 'direct'; provider: FxProvider }
  | { kind: 'cross'; via: CurrencyCode };

export class FxRouter {
  private readonly official: FxProvider[];
  private readonly market: FxProvider[];
  private readonly today: () => ISODate;

  constructor(private readonly opts: FxRouterOptions) {
    this.official = opts.providers.filter((p) => p.official);
    this.market = opts.providers.filter((p) => !p.official);
    this.today = opts.today ?? (() => todayISO());
  }

  officialProviders(base: CurrencyCode, quote: CurrencyCode): FxProvider[] {
    return this.official.filter((p) => p.supports(base, quote));
  }

  /** Planned routes for a pair (exposed for diagnostics and tests). */
  routes(base: CurrencyCode, quote: CurrencyCode, mode: FxSourceMode): Route[] {
    const routes: Route[] = [];
    if (mode !== 'yahoo') {
      for (const p of this.officialProviders(base, quote)) routes.push({ kind: 'direct', provider: p });
      if (
        base !== 'USD' &&
        quote !== 'USD' &&
        this.officialProviders(base, 'USD').length > 0 &&
        this.officialProviders('USD', quote).length > 0
      ) {
        routes.push({ kind: 'cross', via: 'USD' });
      }
    }
    if (mode !== 'official') {
      for (const p of this.market.filter((m) => m.supports(base, quote))) routes.push({ kind: 'direct', provider: p });
    }
    return routes;
  }

  async daily(base: CurrencyCode, quote: CurrencyCode, from: ISODate, to: ISODate, mode: FxSourceMode = 'auto'): Promise<FxResult> {
    base = base.toUpperCase();
    quote = quote.toUpperCase();
    if (base === quote) {
      return { points: eachDay(from, to).map((date) => ({ date, rate: 1 })), source: 'identity', fallbacks: [] };
    }
    const load = () => this.resolve(base, quote, from, to, mode);
    if (!this.opts.cache) return load();
    const key = `fx:daily:${mode}:${base}${quote}:${from}:${to}`;
    const today = this.today();
    const r = await this.opts.cache.getOrLoad<FxResult>(
      key,
      // A result obtained after a failure of the preferred source is cached briefly so the
      // official source is retried soon.
      (v) => (v.fallbacks.length ? Math.min(HOUR, historyTtlMs(to, today)) : historyTtlMs(to, today)),
      load,
    );
    return r.value;
  }

  private async resolve(base: string, quote: string, from: ISODate, to: ISODate, mode: FxSourceMode): Promise<FxResult> {
    const routes = this.routes(base, quote, mode);
    if (!routes.length) {
      throw new MarketDataError(
        'UNSUPPORTED',
        mode === 'official'
          ? `No official source for ${base}/${quote}. Try source=auto or source=yahoo.`
          : `No FX source for ${base}/${quote}`,
      );
    }
    const fallbacks: FxResult['fallbacks'] = [];
    for (const route of routes) {
      const label = route.kind === 'direct' ? String(route.provider.id) : `cross:${route.via}`;
      try {
        if (route.kind === 'direct') {
          const points = await route.provider.daily(base, quote, from, to);
          if (!points.length) throw new MarketDataError('NOT_FOUND', 'empty series');
          return { points, source: String(route.provider.id), fallbacks };
        }
        const r = await this.cross(base, quote, route.via, from, to);
        return { ...r, fallbacks: [...fallbacks, ...r.fallbacks] };
      } catch (e) {
        fallbacks.push({ source: label, error: errorMessage(e) });
      }
    }
    const allNotFound = fallbacks.every((f) => /not found|no .* (published|data|reference)|empty/i.test(f.error));
    throw new MarketDataError(allNotFound ? 'NOT_FOUND' : 'UPSTREAM_ERROR', `All FX sources failed for ${base}/${quote}`, fallbacks);
  }

  /** base/quote = base/via x via/quote, official legs only, union of dates with fill-forward. */
  private async cross(base: string, quote: string, via: string, from: ISODate, to: ISODate): Promise<Omit<FxResult, 'fallbacks'> & { fallbacks: FxResult['fallbacks'] }> {
    const padded = addDays(from, -10);
    const [a, b] = await Promise.all([
      this.daily(base, via, padded, to, 'official'),
      this.daily(via, quote, padded, to, 'official'),
    ]);
    return {
      points: combine(a.points, b.points, from, to),
      source: `${a.source}*${b.source}`,
      fallbacks: [...a.fallbacks, ...b.fallbacks],
    };
  }
}

/** Multiply two series on the union of their dates (fill-forward), within [from, to]. */
export function combine(a: readonly FxPoint[], b: readonly FxPoint[], from: ISODate, to: ISODate): FxPoint[] {
  const dates = [...new Set([...a.map((p) => p.date), ...b.map((p) => p.date)])].sort();
  const out: FxPoint[] = [];
  let i = 0;
  let j = 0;
  let va: number | undefined;
  let vb: number | undefined;
  for (const d of dates) {
    while (i < a.length && a[i]!.date <= d) va = a[i++]!.rate;
    while (j < b.length && b[j]!.date <= d) vb = b[j++]!.rate;
    if (d < from || d > to || va === undefined || vb === undefined) continue;
    out.push({ date: d, rate: roundSig(va * vb, 10) });
  }
  return out;
}
