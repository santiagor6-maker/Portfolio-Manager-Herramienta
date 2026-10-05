/**
 * Demo-data adapter over `createDemoData()` from @pm/core ("Portafolio de ejemplo").
 * Output is normalised to the local SeedData shape.
 */
import { createDemoData, type DemoData } from '@pm/core';
import type { SeedData } from '../db/repo';

export function normaliseDemo(d: Pick<DemoData, 'portfolio' | 'instruments' | 'transactions' | 'prices' | 'fx'>): SeedData {
  return {
    portfolios: [{ ...d.portfolio, name: d.portfolio.name || 'Portafolio de ejemplo' }],
    instruments: d.instruments,
    transactions: d.transactions.map((t) => ({ ...t, source: t.source ?? 'demo' })),
    prices: d.prices,
    fx: d.fx,
    manualPrices: [],
  };
}

export function loadDemoData(): SeedData {
  return normaliseDemo(createDemoData());
}
