/**
 * Tax-lot bookkeeping for one instrument.
 *
 * Cost methods
 * - FIFO: sells consume the oldest lots first (Colombian default).
 * - LIFO: sells consume the newest lots first.
 * - AVERAGE: weighted average cost (Brazilian "preço médio"). Every buy re-averages the
 *   unit cost of all open lots; sells do not change the average. Lots are still kept in
 *   FIFO order so that holding periods (openDate) remain meaningful.
 *
 * Lot quantities keep full floating precision (so a 1-for-3 reverse split followed by a
 * 3-for-1 split returns exactly to the original position); a tolerance of 1e-9 is applied
 * when closing lots (a lot within 1e-9 of the remaining sell quantity is closed entirely)
 * and aggregate quantities are reported rounded to 1e-9.
 */
import type { CostMethod } from './types';

export const QTY_EPS = 1e-9;

export function roundQty(q: number): number {
  const r = Math.round(q * 1e9) / 1e9;
  return Math.abs(r) < QTY_EPS ? 0 : r;
}

export interface LotState {
  openDay: number;
  quantity: number;
  /** Per unit, instrument currency, fees included. */
  unitCost: number;
  /** Per unit, base currency at historical FX. */
  unitCostBase: number;
  /** Per unit value at purchase, instrument currency, BEFORE fees (anchor for accrual). */
  unitValue: number;
}

export interface ClosedPiece {
  openDay: number;
  /** Rounded to 1e-9 for display. */
  quantity: number;
  /** Exact quantity (use for proportional allocation of proceeds). */
  exact: number;
  cost: number;
  costBase: number;
}

export class LotBook {
  lots: LotState[] = [];
  /** Cached aggregates, refreshed after every mutation. */
  quantity = 0;
  costBasis = 0;
  costBasisBase = 0;
  constructor(readonly method: CostMethod) {}

  private refresh(): void {
    let q = 0;
    let c = 0;
    let cb = 0;
    for (const l of this.lots) {
      q += l.quantity;
      c += l.quantity * l.unitCost;
      cb += l.quantity * l.unitCostBase;
    }
    this.quantity = roundQty(q);
    this.costBasis = this.quantity === 0 ? 0 : c;
    this.costBasisBase = this.quantity === 0 ? 0 : cb;
  }

  /** Add a lot with total cost (instrument currency) and total cost in base currency. */
  add(openDay: number, quantity: number, totalCost: number, totalCostBase: number, unitValue?: number): void {
    const q = quantity;
    if (!(q > QTY_EPS)) return;
    this.lots.push({ openDay, quantity: q, unitCost: totalCost / q, unitCostBase: totalCostBase / q, unitValue: unitValue ?? totalCost / q });
    this.refresh();
    if (this.method === 'AVERAGE') this.reaverage();
  }

  private reaverage(): void {
    const q = this.lots.reduce((s, l) => s + l.quantity, 0);
    if (q <= 0) return;
    const uc = this.costBasis / q;
    const ucb = this.costBasisBase / q;
    for (const l of this.lots) {
      l.unitCost = uc;
      l.unitCostBase = ucb;
    }
    this.refresh();
  }

  /**
   * Remove `quantity` units according to the cost method. Returns the closed pieces and
   * the quantity that could not be matched (oversell).
   */
  remove(quantity: number): { pieces: ClosedPiece[]; unmatched: number } {
    let left = quantity;
    const pieces: ClosedPiece[] = [];
    const fromEnd = this.method === 'LIFO';
    while (left > QTY_EPS && this.lots.length > 0) {
      const idx = fromEnd ? this.lots.length - 1 : 0;
      const lot = this.lots[idx] as LotState;
      // Close the whole lot when it is within tolerance of what is left to sell.
      const closes = lot.quantity <= left + QTY_EPS;
      const take = closes ? lot.quantity : left;
      pieces.push({
        openDay: lot.openDay,
        quantity: roundQty(take),
        exact: take,
        cost: take * lot.unitCost,
        costBase: take * lot.unitCostBase,
      });
      left = closes ? Math.max(0, left - take) : 0;
      if (closes) this.lots.splice(idx, 1);
      else lot.quantity -= take;
    }
    this.refresh();
    return { pieces, unmatched: left > QTY_EPS ? roundQty(left) : 0 };
  }

  /** Split / reverse split / bonus: quantity * factor, total cost unchanged (+ optional added cost). */
  scale(factor: number, addedCost = 0, addedCostBase = 0): void {
    if (!(factor > 0)) return;
    const before = this.lots.reduce((s, l) => s + l.quantity, 0);
    for (const l of this.lots) {
      l.quantity *= factor;
      l.unitCost /= factor;
      l.unitCostBase /= factor;
      l.unitValue /= factor;
    }
    this.lots = this.lots.filter((l) => l.quantity > QTY_EPS);
    if ((addedCost !== 0 || addedCostBase !== 0) && before > 0) {
      // Distribute an attributed cost (e.g. Brazilian "bonificação" custo atribuído) pro rata.
      const q = this.lots.reduce((s, l) => s + l.quantity, 0);
      for (const l of this.lots) {
        l.unitCost += addedCost / q;
        l.unitCostBase += addedCostBase / q;
      }
    }
    this.refresh();
  }

  /** Remove and return every lot (merger / ticker change). */
  extractAll(): LotState[] {
    const out = this.lots;
    this.lots = [];
    this.refresh();
    return out;
  }

  /** Insert lots keeping open-date order (AVERAGE re-averages). */
  insert(lots: LotState[]): void {
    for (const l of lots) if (l.quantity > QTY_EPS) this.lots.push({ ...l });
    this.lots.sort((a, b) => a.openDay - b.openDay);
    this.refresh();
    if (this.method === 'AVERAGE') this.reaverage();
  }

  /** Keep (1 - fraction) of the cost of every lot; returns the lots' share that was removed (spin-off). */
  carveOutCost(fraction: number): LotState[] {
    const f = Math.min(1, Math.max(0, fraction));
    const carved = this.lots.map((l) => ({ ...l, unitCost: l.unitCost * f, unitCostBase: l.unitCostBase * f, unitValue: l.unitValue * f }));
    for (const l of this.lots) {
      l.unitCost *= 1 - f;
      l.unitCostBase *= 1 - f;
      l.unitValue *= 1 - f;
    }
    this.refresh();
    return carved;
  }

  /**
   * Return of capital: reduce total cost pro rata by quantity. Returns the excess (amount
   * above remaining basis) in instrument and base currency, which is a realized gain.
   */
  reduceCost(amount: number, amountBase: number): { excess: number; excessBase: number } {
    const q = this.lots.reduce((s, l) => s + l.quantity, 0);
    if (q <= 0) return { excess: amount, excessBase: amountBase };
    const basis = this.costBasis;
    const basisBase = this.costBasisBase;
    const applied = Math.min(amount, basis);
    const appliedBase = Math.min(amountBase, basisBase);
    const f = basis > 0 ? 1 - applied / basis : 1;
    const fb = basisBase > 0 ? 1 - appliedBase / basisBase : 1;
    for (const l of this.lots) {
      l.unitCost *= f;
      l.unitCostBase *= fb;
      l.unitValue *= f;
    }
    this.refresh();
    return { excess: amount - applied, excessBase: amountBase - appliedBase };
  }
}
