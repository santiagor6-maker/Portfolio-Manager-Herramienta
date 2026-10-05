import type { CurrencyCode, ISODate, MarketData } from '@pm/core';

export interface SimpleMarketDataInput {
  /** instrumentId -> [date, close][] in instrument currency. */
  prices?: Record<string, [ISODate, number][]>;
  /** 'BASE/QUOTE' (e.g. 'USD/COP') -> [date, units of QUOTE per 1 BASE][] */
  fx?: Record<string, [ISODate, number][]>;
}

function lookup(points: [ISODate, number][] | undefined, date: ISODate): number | undefined {
  if (!points) return undefined;
  let found: number | undefined;
  for (const [d, v] of points) {
    if (d <= date) found = v;
    else break;
  }
  return found;
}

/**
 * Minimal fill-forward MarketData for tests and for callers that only have a few rates at hand
 * (e.g. the official TRM/PTAX of specific dates). Supports inverse pairs and triangulation via USD.
 * Not a replacement for `createMarketData` in @pm/core.
 */
export function createSimpleMarketData(input: SimpleMarketDataInput): MarketData {
  const sortPts = (pts: [ISODate, number][]) => [...pts].sort((a, b) => a[0].localeCompare(b[0]));
  const prices = new Map(Object.entries(input.prices ?? {}).map(([k, v]) => [k, sortPts(v)]));
  const fx = new Map(Object.entries(input.fx ?? {}).map(([k, v]) => [k, sortPts(v)]));

  const direct = (from: CurrencyCode, to: CurrencyCode, date: ISODate): number | undefined => {
    if (from === to) return 1;
    const d = lookup(fx.get(`${from}/${to}`), date);
    if (d !== undefined) return d;
    const inv = lookup(fx.get(`${to}/${from}`), date);
    return inv ? 1 / inv : undefined;
  };

  return {
    price: (instrumentId, date) => lookup(prices.get(instrumentId), date),
    fx: (from, to, date) => {
      const d = direct(from, to, date);
      if (d !== undefined) return d;
      const a = direct(from, 'USD', date);
      const b = direct('USD', to, date);
      return a !== undefined && b !== undefined ? a * b : undefined;
    },
  };
}
