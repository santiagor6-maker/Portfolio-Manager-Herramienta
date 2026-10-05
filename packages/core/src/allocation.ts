/**
 * Allocation of a valuation by dimension. Holdings without a market value use their cost.
 * Cash is asset class 'cash', grouped by its own currency for 'currency', mapped to the
 * currency's country for 'country', and shown per currency for 'instrument'.
 * Labels are Spanish defaults; the UI may translate by `key`.
 */
import type { AllocationDimension, AllocationSlice, AssetClass, Instrument, Valuation } from './types';

export const ASSET_CLASS_LABELS: Record<AssetClass, string> = {
  equity: 'Acciones',
  etf: 'ETF',
  fund: 'Fondos',
  reit: 'Inmobiliario (REIT/FII)',
  bond: 'Bonos',
  fixed_income: 'Renta fija',
  cash: 'Efectivo',
  crypto: 'Cripto',
  commodity: 'Materias primas',
  other: 'Otros',
};

export const CURRENCY_COUNTRY: Record<string, string> = {
  COP: 'CO',
  BRL: 'BR',
  USD: 'US',
  EUR: 'EU',
  MXN: 'MX',
  CLP: 'CL',
  PEN: 'PE',
  GBP: 'GB',
  CHF: 'CH',
  CAD: 'CA',
  JPY: 'JP',
  ARS: 'AR',
  UYU: 'UY',
};

const UNKNOWN = 'unknown';
const UNKNOWN_LABEL = 'Sin clasificar';

export function allocationImpl(valuation: Valuation, instruments: Instrument[], by: AllocationDimension): AllocationSlice[] {
  const byId = new Map(instruments.map((i) => [i.id, i]));
  const acc = new Map<string, { label: string; value: number }>();
  const add = (key: string, label: string, value: number) => {
    if (!value) return;
    const e = acc.get(key);
    if (e) e.value += value;
    else acc.set(key, { label, value });
  };

  for (const h of valuation.holdings) {
    const value = h.marketValueBase ?? h.costBasisBase;
    const inst = byId.get(h.instrumentId);
    switch (by) {
      case 'assetClass': {
        const k = inst?.assetClass ?? 'other';
        add(k, ASSET_CLASS_LABELS[k] ?? k, value);
        break;
      }
      case 'country':
        add(inst?.country || UNKNOWN, inst?.country || UNKNOWN_LABEL, value);
        break;
      case 'currency':
        add(h.currency, h.currency, value);
        break;
      case 'sector':
        add(inst?.sector || UNKNOWN, inst?.sector || UNKNOWN_LABEL, value);
        break;
      case 'exchange':
        add(inst?.exchange || UNKNOWN, inst?.exchange || UNKNOWN_LABEL, value);
        break;
      case 'instrument':
        add(h.instrumentId, inst ? `${inst.symbol} · ${inst.name}` : h.instrumentId, value);
        break;
      case 'account': {
        const aq = h.accountQuantities;
        const total = aq ? Object.values(aq).reduce((s, v) => s + v, 0) : 0;
        if (aq && total > 0) {
          for (const [a, q] of Object.entries(aq)) add(a || UNKNOWN, a || 'Sin cuenta', (value * q) / total);
        } else add(UNKNOWN, 'Sin cuenta', value);
        break;
      }
    }
  }

  for (const c of valuation.cash) {
    const value = c.amountBase ?? 0;
    if (!value) continue;
    switch (by) {
      case 'assetClass':
        add('cash', ASSET_CLASS_LABELS.cash, value);
        break;
      case 'currency':
        add(c.currency, c.currency, value);
        break;
      case 'country': {
        const k = CURRENCY_COUNTRY[c.currency] ?? UNKNOWN;
        add(k, k === UNKNOWN ? UNKNOWN_LABEL : k, value);
        break;
      }
      case 'sector':
        add('cash', 'Efectivo', value);
        break;
      case 'exchange':
        add('cash', 'Efectivo', value);
        break;
      case 'instrument':
        add(`cash:${c.currency}`, `Efectivo ${c.currency}`, value);
        break;
      case 'account': {
        const aa = c.accountAmounts;
        const total = aa ? Object.values(aa).reduce((s, v) => s + v, 0) : 0;
        if (aa && Math.abs(total) > 1e-12) {
          for (const [a, amt] of Object.entries(aa)) add(a || UNKNOWN, a || 'Sin cuenta', (value * amt) / total);
        } else add(UNKNOWN, 'Sin cuenta', value);
        break;
      }
    }
  }

  const total = Array.from(acc.values()).reduce((s, e) => s + e.value, 0);
  return Array.from(acc.entries())
    .map(([key, e]) => ({ key, label: e.label, valueBase: e.value, weight: total !== 0 ? e.value / total : 0 }))
    .sort((a, b) => b.valueBase - a.valueBase);
}
