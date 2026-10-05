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
 * Quantities are rounded to 1e-9 after every operation to avoid floating drift; lots
 * whose quantity rounds to zero are closed.
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
}

export interface ClosedPiece {
  openDay: number;
  quantity: number;
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
  add(openDay: number, quantity: number, totalCost: number, totalCostBase: number): void {
    const q = roundQty(quantity);
    if (q <= 0) return;
    this.lots.push({ openDay, quantity: q, unitCost: totalCost / q, unitCostBase: totalCostBase / q });
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
    let left = roundQty(quantity);
    const pieces: ClosedPiece[] = [];
    const fromEnd = this.method === 'LIFO';
    while (left > 0 && this.lots.length > 0) {
      const idx = fromEnd ? this.lots.length - 1 : 0;
      const lot = this.lots[idx] as LotState;
      const take = Math.min(lot.quantity, left);
      pieces.push({
        openDay: lot.openDay,
        quantity: take,
        cost: take * lot.unitCost,
        costBase: take * lot.unitCostBase,
      });
      lot.quantity = roundQty(lot.quantity - take);
      left = roundQty(left - take);
      if (lot.quantity <= 0) this.lots.splice(idx, 1);
    }
    this.refresh();
    return { pieces, unmatched: left };
  }

  /** Split / reverse split / bonus: quantity * factor, total cost unchanged (+ optional added cost). */
  scale(factor: number, addedCost = 0, addedCostBase = 0): void {
    if (!(factor > 0)) return;
    const before = this.lots.reduce((s, l) => s + l.quantity, 0);
    for (const l of this.lots) {
      l.quantity = roundQty(l.quantity * factor);
      l.unitCost /= factor;
      l.unitCostBase /= factor;
    }
    this.lots = this.lots.filter((l) => l.quantity > 0);
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
    }
    this.refresh();
    return { excess: amount - applied, excessBase: amountBase - appliedBase };
  }
}
