/**
 * Demo-data adapter over `createDemoData()` from @pm/core ("Portafolio de ejemplo").
 * Output is normalised to the local SeedData shape and enriched with one manually priced
 * fund (a Colombian FIC) so the month-end close flow has something to show: its manual
 * prices stop one month before the last demo month.
 */
import { createDemoData, type DemoData, type Instrument, type Transaction } from '@pm/core';
import type { SeedData } from '../db/repo';
import { addMonths, monthEnd } from '../lib/ids';

export const DEMO_FIC: Instrument = {
  id: 'MANUAL:FIC-RENTA-FIJA',
  symbol: 'FIC-RF',
  name: 'FIC Renta Fija Pesos (ejemplo)',
  exchange: 'MANUAL',
  currency: 'COP',
  country: 'CO',
  assetClass: 'fund',
  sector: 'Renta fija',
  pricing: 'manual',
};

type DemoLike = Pick<DemoData, 'portfolio' | 'instruments' | 'transactions' | 'prices' | 'fx'>;

export function normaliseDemo(d: DemoLike): SeedData {
  const lastDate = d.prices.reduce((m, s) => {
    const p = s.points[s.points.length - 1]?.date;
    return p && p > m ? p : m;
  }, '0000-00-00');
  const firstMonth = '2024-02';
  // Leave the latest month without a manual price (pending "cierre de mes").
  const lastPricedMonth = addMonths(lastDate.slice(0, 7), -1);
  const manualPrices: SeedData['manualPrices'] = [];
  let unit = 12_500;
  for (let m = firstMonth, i = 0; m <= lastPricedMonth && i < 240; m = addMonths(m, 1), i++) {
    // ~9% a year with a little noise; deterministic.
    unit *= 1 + 0.0072 + Math.sin(i * 1.7) * 0.0015;
    manualPrices.push({ instrumentId: DEMO_FIC.id, date: monthEnd(m), close: Math.round(unit * 100) / 100, currency: 'COP', note: 'Extracto (ejemplo)' });
  }
  const ficBuy: Transaction = {
    id: 'demo-fic-buy',
    portfolioId: d.portfolio.id,
    date: `${firstMonth}-05`,
    type: 'BUY',
    instrumentId: DEMO_FIC.id,
    quantity: 1_000,
    price: 12_500,
    amount: 12_500_000,
    currency: 'COP',
    account: 'Fiduciaria (FIC)',
    source: 'demo',
    note: 'Fondo de inversión colectiva',
  };
  const ficDeposit: Transaction = {
    id: 'demo-fic-deposit',
    portfolioId: d.portfolio.id,
    date: `${firstMonth}-05`,
    type: 'DEPOSIT',
    amount: 12_500_000,
    currency: 'COP',
    account: 'Fiduciaria (FIC)',
    source: 'demo',
    note: 'Aporte al FIC',
  };
  return {
    portfolios: [{ ...d.portfolio, name: d.portfolio.name || 'Portafolio de ejemplo' }],
    instruments: [...d.instruments, DEMO_FIC],
    transactions: [...d.transactions.map((t) => ({ ...t, source: t.source ?? 'demo' })), ficDeposit, ficBuy],
    prices: d.prices,
    fx: d.fx,
    manualPrices,
  };
}

export function loadDemoData(): SeedData {
  return normaliseDemo(createDemoData());
}
