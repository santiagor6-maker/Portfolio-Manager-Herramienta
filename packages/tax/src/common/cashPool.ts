import type { CurrencyCode } from '@pm/core';

export interface PoolBalance {
  currency: CurrencyCode;
  units: number;
  /** Historical cost of the units in the tax currency (weighted average). */
  cost: number;
}

export interface PoolRemoval {
  /** Units actually available and removed from the pool. */
  covered: number;
  /** Units requested but missing in the pool (missing deposits in the user's records). */
  uncovered: number;
  /** Historical cost (tax currency) of the covered units. */
  costRemoved: number;
}

/**
 * Foreign-currency cash pool valued at weighted-average historical cost in a tax currency
 * (COP for Colombia, BRL for Brazil). Used for realized exchange differences and for the
 * year-end value of foreign cash at historical rates.
 */
export class CurrencyPool {
  private readonly balances = new Map<CurrencyCode, { units: number; cost: number }>();

  add(currency: CurrencyCode, units: number, cost: number): void {
    if (units <= 0) return;
    const b = this.balances.get(currency) ?? { units: 0, cost: 0 };
    b.units += units;
    b.cost += cost;
    this.balances.set(currency, b);
  }

  remove(currency: CurrencyCode, units: number): PoolRemoval {
    if (units <= 0) return { covered: 0, uncovered: 0, costRemoved: 0 };
    const b = this.balances.get(currency) ?? { units: 0, cost: 0 };
    const eps = 1e-9;
    const covered = Math.min(units, Math.max(0, b.units));
    const uncovered = units - covered > eps ? units - covered : 0;
    const costRemoved = b.units > eps ? (b.cost * covered) / b.units : 0;
    b.units -= covered;
    b.cost -= costRemoved;
    if (b.units < eps) {
      b.units = 0;
      b.cost = 0;
    }
    this.balances.set(currency, b);
    return { covered, uncovered, costRemoved };
  }

  snapshot(): PoolBalance[] {
    return [...this.balances.entries()]
      .filter(([, b]) => b.units > 1e-9)
      .map(([currency, b]) => ({ currency, units: b.units, cost: b.cost }))
      .sort((a, b) => a.currency.localeCompare(b.currency));
  }
}
