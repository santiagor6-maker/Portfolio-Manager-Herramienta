/**
 * The one "currency → jurisdiction" rule (W66 review): BRL is Brazil (average cost, B3 rules), every
 * other base currency defaults to Colombia (FIFO). Used for new portfolios and for the Impuestos tab.
 */
import type { CostMethod } from '@pm/core';

export type Jurisdiction = 'CO' | 'BR';

export function jurisdictionForCurrency(ccy: string | undefined): Jurisdiction {
  return ccy === 'BRL' ? 'BR' : 'CO';
}

export function defaultsForCurrency(ccy: string): { taxResidence: Jurisdiction; costMethod: CostMethod } {
  const taxResidence = jurisdictionForCurrency(ccy);
  return { taxResidence, costMethod: taxResidence === 'BR' ? 'AVERAGE' : 'FIFO' };
}

/** Explicit tax residence when set, else the base currency's. */
export function jurisdictionOf(p: { taxResidence?: string; baseCurrency?: string } | undefined): Jurisdiction {
  return p?.taxResidence === 'BR' || p?.taxResidence === 'CO' ? p.taxResidence : jurisdictionForCurrency(p?.baseCurrency);
}
