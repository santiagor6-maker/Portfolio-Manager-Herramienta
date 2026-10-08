/**
 * Valuation of the ledger state at a date (prices resolved by pricing.ts).
 *
 * Unrealized gain decomposition (base currency), per holding:
 *   MV    = market value in instrument currency
 *   C     = cost basis in instrument currency            (sum of lots, fees included)
 *   CB    = cost basis in base currency at historical FX (sum of lots)
 *   X0    = CB / C   (cost-weighted historical FX, base per unit of instrument currency)
 *   X1    = FX at the valuation date
 *   priceGainBase = (MV - C) * X0         price move, measured at historical FX
 *   fxGainBase    = MV * (X1 - X0)        currency move on the current value
 *   priceGainBase + fxGainBase = MV*X1 - C*X0 = MV*X1 - CB = unrealizedGainBase   (exact)
 */
import type { CashBalance, CurrencyCode, Holding, Instrument, Lot, Valuation } from './types';
import { dayToIso } from './dates';
import type { Ledger } from './ledger';
import { roundQty } from './lots';
import { type PositionValue, quick, quickValue, valuePosition } from './pricing';
import { fixedIncomeTax, taxRegimeFor } from './fitax';

export interface ValueIssues {
  missingFx: Set<CurrencyCode>;
  missingPrices: Set<string>;
  missingIndex: Set<string>;
}

export const newIssues = (): ValueIssues => ({ missingFx: new Set(), missingPrices: new Set(), missingIndex: new Set() });

/** Is a price observation stale on `day`? */
export function isStale(ledger: Ledger, inst: Instrument, pv: PositionValue, day: number): boolean {
  if (pv.source === 'accrual' || pv.priceDay === undefined) return false;
  const o = ledger.ctx.options;
  const manual = inst.pricing === 'manual' || inst.assetClass === 'fund' || inst.assetClass === 'fixed_income' || inst.exchange === 'MANUAL';
  return day - pv.priceDay > (manual ? o.staleDaysManual : o.staleDaysListed);
}

function cashRate(ledger: Ledger, ccy: CurrencyCode, fxDay: number, issues?: ValueIssues): number | undefined {
  const { base, market } = ledger.ctx;
  if (ccy === base) return 1;
  const exact = market.fxAt(ccy, base, fxDay);
  if (exact === undefined) issues?.missingFx.add(ccy);
  return exact ?? market.fxNearest(ccy, base, fxDay);
}

/**
 * Fast total portfolio value in base currency with prices at `day` and FX at `fxDay`.
 * `overrides` = intra-day trade prices for the pre-flow valuation. Missing data is reported
 * in `issues` (never silently): holdings without price are valued at cost, FX falls back to
 * the nearest later rate, then to historical cost (holdings) or 0 (cash).
 */
export function totalValue(ledger: Ledger, day: number, fxDay: number = day, overrides?: Map<string, number>, issues?: ValueIssues): number {
  let total = 0;
  for (const [id, book] of ledger.books) {
    if (book.quantity === 0) continue;
    const inst = ledger.instrumentOf.get(id);
    if (!inst) continue;
    const ov = overrides?.get(id);
    if (ov === undefined && quickValue(ledger, book, inst, day, fxDay)) {
      if (issues) {
        if (quick.missingFx) issues.missingFx.add(inst.currency);
        if (quick.cost) issues.missingPrices.add(id);
      }
      total += quick.mvBase;
      continue;
    }
    const pv = valuePosition(ledger, book, inst, day, fxDay, ov);
    if (issues) {
      if (pv.missingFx) issues.missingFx.add(inst.currency);
      if (pv.source === 'cost') issues.missingPrices.add(id);
      if (pv.missingIndex && inst.accrual?.index) issues.missingIndex.add(inst.accrual.index);
    }
    total += pv.mvBase;
  }
  for (const [ccy, amt] of ledger.cash) {
    if (amt === 0) continue;
    const rate = cashRate(ledger, ccy, fxDay, issues);
    if (rate !== undefined) total += amt * rate;
  }
  return total;
}

export interface ValueAggregates {
  total: number;
  cash: number;
  unrealized: number;
  unrealizedFx: number;
  unrealizedPrice: number;
}

/** Totals needed by the money waterfall, with the same pricing as totalValue. */
export function valueAggregates(ledger: Ledger, day: number, issues?: ValueIssues, stale?: Set<string>): ValueAggregates {
  let securities = 0;
  let unrealized = 0;
  let unrealizedFx = 0;
  for (const [id, book] of ledger.books) {
    if (book.quantity === 0) continue;
    const inst = ledger.instrumentOf.get(id);
    if (!inst) continue;
    if (!stale && quickValue(ledger, book, inst, day, day)) {
      if (issues) {
        if (quick.missingFx) issues.missingFx.add(inst.currency);
        if (quick.cost) issues.missingPrices.add(id);
      }
      const C = book.costBasis;
      const CB = book.costBasisBase;
      const X0 = C !== 0 ? CB / C : (quick.rate ?? 0);
      const u = quick.mvBase - CB;
      securities += quick.mvBase;
      unrealized += u;
      unrealizedFx += u - (quick.mv - C) * X0;
      continue;
    }
    const pv = valuePosition(ledger, book, inst, day, day);
    if (issues) {
      if (pv.missingFx) issues.missingFx.add(inst.currency);
      if (pv.source === 'cost') issues.missingPrices.add(id);
      if (pv.missingIndex && inst.accrual?.index) issues.missingIndex.add(inst.accrual.index);
    }
    if (stale && isStale(ledger, inst, pv, day)) stale.add(id);
    const C = book.costBasis;
    const CB = book.costBasisBase;
    const X0 = C !== 0 ? CB / C : (pv.rate ?? 0);
    const u = pv.mvBase - CB;
    const priceGain = (pv.mv - C) * X0;
    securities += pv.mvBase;
    unrealized += u;
    unrealizedFx += u - priceGain;
  }
  let cash = 0;
  for (const [ccy, amt] of ledger.cash) {
    if (amt === 0) continue;
    const rate = cashRate(ledger, ccy, day, issues);
    if (rate !== undefined) cash += amt * rate;
  }
  return { total: securities + cash, cash, unrealized, unrealizedFx, unrealizedPrice: unrealized - unrealizedFx };
}

/** Full valuation with holdings, lots, cash, weights and missing-data flags. */
export function buildValuation(ledger: Ledger, day: number): Valuation {
  const { base } = ledger.ctx;
  const holdings: Holding[] = [];
  const missingPrices: string[] = [];
  const stalePrices: string[] = [];
  const missingIndex = new Set<string>();
  const estimatedIndex = new Set<string>();
  let accruedTaxTotal = 0;
  let hasFixedIncome = false;
  const missingFx = new Set<CurrencyCode>();
  for (const [id, book] of ledger.books) {
    const q = book.quantity;
    if (q === 0) continue;
    const inst = ledger.instrumentOf.get(id);
    if (!inst) continue;
    const pv = valuePosition(ledger, book, inst, day, day);
    if (pv.missingFx) missingFx.add(inst.currency);
    if (pv.missingIndex && inst.accrual?.index) missingIndex.add(inst.accrual.index);
    const C = book.costBasis;
    const CB = book.costBasisBase;
    const X0 = C !== 0 ? CB / C : (pv.rate ?? 0);
    const lots: Lot[] = book.lots.map((l) => ({
      instrumentId: id,
      openDate: dayToIso(l.openDay),
      quantity: l.quantity,
      unitCost: l.unitCost,
      unitCostBase: l.unitCostBase,
    }));
    const h: Holding = {
      instrumentId: id,
      quantity: q,
      currency: inst.currency,
      costBasis: C,
      costBasisBase: CB,
      lots,
      priceSource: pv.source,
    };
    const accounts = ledger.accountQty.get(id);
    if (accounts) {
      const aq: Record<string, number> = {};
      for (const [k, v] of accounts) {
        const r = roundQty(v);
        if (r !== 0) aq[k] = r;
      }
      if (Object.keys(aq).length) h.accountQuantities = aq;
    }
    if (pv.source === 'cost') missingPrices.push(id);
    else {
      h.price = pv.price;
      if (pv.priceDay !== undefined) h.priceDate = dayToIso(pv.priceDay);
    }
    if (isStale(ledger, inst, pv, day)) {
      h.stale = true;
      stalePrices.push(id);
    }
    h.marketValue = pv.mv;
    h.unrealizedGain = pv.mv - C;
    h.marketValueBase = pv.mvBase;
    h.unrealizedGainBase = pv.mvBase - CB;
    h.priceGainBase = (pv.mv - C) * X0;
    h.fxGainBase = h.unrealizedGainBase - h.priceGainBase;
    if (pv.estimated) {
      h.estimated = true;
      if (inst.accrual?.index) estimatedIndex.add(inst.accrual.index);
    }
    // C31: estimated tax on the accrued yield (IR regressivo + IOF in Brazil, 4 % retención in Colombia)
    const regime = inst.accrual ? taxRegimeFor(inst) : 'NONE';
    if (inst.accrual && (regime === 'NONE' || regime === 'EXEMPT')) {
      // C40: exempt / untaxed fixed income: net = gross, tax 0 (fields always present)
      h.accruedTaxBase = 0;
      h.netMarketValueBase = pv.mvBase;
      hasFixedIncome = true;
    } else if (regime !== 'NONE' && regime !== 'EXEMPT') {
      hasFixedIncome = true;
      let tax = 0;
      book.lots.forEach((l, i) => {
        const v = pv.lotValues?.[i] ?? (q !== 0 ? (pv.mv * l.quantity) / q : 0);
        tax += fixedIncomeTax(regime, day - l.openDay, v - l.quantity * l.unitValue, inst.accrual).total;
      });
      const taxBase = tax * (pv.rate ?? X0);
      h.accruedTaxBase = taxBase;
      h.netMarketValueBase = pv.mvBase - taxBase;
      accruedTaxTotal += taxBase;
    }
    holdings.push(h);
  }

  const cash: CashBalance[] = [];
  for (const [ccy, amt] of ledger.cash) {
    if (amt === 0) continue;
    const exact = ccy === base ? 1 : ledger.ctx.market.fxAt(ccy, base, day);
    if (exact === undefined) missingFx.add(ccy);
    const rate = exact ?? ledger.ctx.market.fxNearest(ccy, base, day);
    const cb: CashBalance = { currency: ccy, amount: amt };
    if (rate !== undefined) cb.amountBase = amt * rate;
    const byAcct = ledger.cashByAccount.get(ccy);
    if (byAcct) {
      const aa: Record<string, number> = {};
      for (const [k, v] of byAcct) if (v !== 0) aa[k] = v;
      if (Object.keys(aa).length) cb.accountAmounts = aa;
    }
    cash.push(cb);
  }
  cash.sort((a, b) => (b.amountBase ?? 0) - (a.amountBase ?? 0));

  const securities = holdings.reduce((s, h) => s + (h.marketValueBase ?? 0), 0);
  const cashBase = cash.reduce((s, c) => s + (c.amountBase ?? 0), 0);
  const total = securities + cashBase;
  for (const h of holdings) h.weight = total !== 0 ? (h.marketValueBase ?? 0) / total : 0;
  holdings.sort((a, b) => (b.marketValueBase ?? 0) - (a.marketValueBase ?? 0));

  const v: Valuation = {
    date: dayToIso(day),
    baseCurrency: base,
    holdings,
    cash,
    totalMarketValueBase: total,
    totalCostBase: holdings.reduce((s, h) => s + h.costBasisBase, 0) + cashBase,
    missingPrices: missingPrices.sort(),
    missingFx: Array.from(missingFx).sort(),
  };
  if (stalePrices.length) v.stalePrices = stalePrices.sort();
  if (estimatedIndex.size) v.estimatedIndex = Array.from(estimatedIndex).sort();
  if (hasFixedIncome || accruedTaxTotal !== 0) v.totalNetMarketValueBase = total - accruedTaxTotal;
  if (missingIndex.size) v.missingIndex = Array.from(missingIndex).sort();
  return v;
}
