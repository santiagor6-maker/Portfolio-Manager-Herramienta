/**
 * Valuation of the ledger state at a date.
 *
 * Unrealized gain decomposition (base currency), per holding:
 *   MV    = market value in instrument currency          (q * P1 / multiplier)
 *   C     = cost basis in instrument currency            (sum of lots, fees included)
 *   CB    = cost basis in base currency at historical FX (sum of lots)
 *   X0    = CB / C   (cost-weighted historical FX, base per unit of instrument currency)
 *   X1    = FX at the valuation date
 *   priceGainBase = (MV - C) * X0         price move, measured at historical FX
 *   fxGainBase    = MV * (X1 - X0)        currency move on the current value
 *   priceGainBase + fxGainBase = MV*X1 - C*X0 = MV*X1 - CB = unrealizedGainBase   (exact)
 */
import type { CashBalance, CurrencyCode, Holding, Lot, Valuation } from './types';
import { dayToIso } from './dates';
import { roundQty } from './lots';
import type { Ledger } from './ledger';

function multiplier(m: number | undefined): number {
  return m && m > 0 ? m : 1;
}

/**
 * Fast total portfolio value in base currency with prices at `day` and FX at `fxDay`.
 * Used by the performance engine (thousands of calls). Holdings without price are valued
 * at cost. FX falls back to the nearest later rate when there is none on/before the date
 * (data starting after the first transaction), then to historical cost (holdings) or 0 (cash).
 */
export function totalValue(ledger: Ledger, day: number, fxDay: number = day): number {
  const { base, market } = ledger.ctx;
  let total = 0;
  for (const [id, book] of ledger.books) {
    const q = book.quantity;
    if (q === 0) continue;
    const inst = ledger.instrumentOf.get(id);
    if (!inst) continue;
    const p = ledger.marketPrice(inst, day);
    const rate = inst.currency === base ? 1 : (market.fxAt(inst.currency, base, fxDay) ?? market.fxNearest(inst.currency, base, fxDay));
    if (p !== undefined) {
      const mv = (q * p) / multiplier(inst.priceMultiplier);
      if (rate !== undefined) total += mv * rate;
      else total += book.costBasis !== 0 ? mv * (book.costBasisBase / book.costBasis) : 0;
    } else {
      total += rate !== undefined ? book.costBasis * rate : book.costBasisBase;
    }
  }
  for (const [ccy, amt] of ledger.cash) {
    if (amt === 0) continue;
    const rate = ccy === base ? 1 : (market.fxAt(ccy, base, fxDay) ?? market.fxNearest(ccy, base, fxDay));
    if (rate !== undefined) total += amt * rate;
  }
  return total;
}

/** Full valuation with holdings, lots, cash, weights and missing-data flags. */
export function buildValuation(ledger: Ledger, day: number): Valuation {
  const { base, market } = ledger.ctx;
  const holdings: Holding[] = [];
  const missingPrices: string[] = [];
  const missingFx = new Set<CurrencyCode>();
  for (const [id, book] of ledger.books) {
    const q = book.quantity;
    if (q === 0) continue;
    const inst = ledger.instrumentOf.get(id);
    if (!inst) continue;
    const mult = multiplier(inst.priceMultiplier);
    const point = market.pricePointAt(id, day);
    const price = ledger.marketPrice(inst, day);
    const exact = inst.currency === base ? 1 : market.fxAt(inst.currency, base, day);
    if (exact === undefined) missingFx.add(inst.currency);
    const X1 = exact ?? market.fxNearest(inst.currency, base, day);
    const C = book.costBasis;
    const CB = book.costBasisBase;
    const X0 = C !== 0 ? CB / C : (X1 ?? 0);
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
    if (price !== undefined) {
      const mv = (q * price) / mult;
      h.price = price;
      if (point) h.priceDate = dayToIso(point.day);
      h.marketValue = mv;
      h.unrealizedGain = mv - C;
      const mvBase = X1 !== undefined ? mv * X1 : mv * X0;
      h.marketValueBase = mvBase;
      h.unrealizedGainBase = mvBase - CB;
      h.priceGainBase = (mv - C) * X0;
      h.fxGainBase = h.unrealizedGainBase - h.priceGainBase;
    } else {
      missingPrices.push(id);
      // Valued at cost: no price effect, only the currency effect on the cost.
      h.marketValue = C;
      h.unrealizedGain = 0;
      const mvBase = X1 !== undefined ? C * X1 : CB;
      h.marketValueBase = mvBase;
      h.unrealizedGainBase = mvBase - CB;
      h.priceGainBase = 0;
      h.fxGainBase = h.unrealizedGainBase;
    }
    holdings.push(h);
  }

  const cash: CashBalance[] = [];
  for (const [ccy, amt] of ledger.cash) {
    if (amt === 0) continue;
    const exact = ccy === base ? 1 : market.fxAt(ccy, base, day);
    if (exact === undefined) missingFx.add(ccy);
    const rate = exact ?? market.fxNearest(ccy, base, day);
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

  return {
    date: dayToIso(day),
    baseCurrency: base,
    holdings,
    cash,
    totalMarketValueBase: total,
    totalCostBase: holdings.reduce((s, h) => s + h.costBasisBase, 0) + cashBase,
    missingPrices: missingPrices.sort(),
    missingFx: Array.from(missingFx).sort(),
  };
}
