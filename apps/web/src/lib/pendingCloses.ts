/**
 * Month-end closes still missing for manually priced instruments (funds, FIC, private assets).
 * For every month end since the first purchase (up to the last completed month) in which the
 * position was open, a manual price dated inside that month is expected.
 */
import type { Instrument, PriceSeries, Transaction } from '@pm/core';
import { addMonths, monthsBetween } from './ids';

export interface PendingClose {
  instrumentId: string;
  /** Months (YYYY-MM) with an open position and no price, oldest first. */
  months: string[];
}

function quantityDelta(t: Transaction, current: number): number {
  switch (t.type) {
    case 'BUY':
    case 'TRANSFER_IN':
      return t.quantity ?? 0;
    case 'SELL':
    case 'TRANSFER_OUT':
      return -(t.quantity ?? 0);
    case 'SPLIT':
      return !t.subtype || t.subtype === 'SPLIT' ? current * ((t.ratio ?? 1) - 1) : -current;
    case 'STOCK_DIVIDEND':
      return t.quantity && t.quantity > 0 ? t.quantity : current * (t.ratio ?? 0);
    default:
      return 0;
  }
}

export function pendingCloses(
  transactions: Transaction[],
  instruments: Instrument[],
  pricedSeries: PriceSeries[],
  asOf: string,
): PendingClose[] {
  const manual = instruments.filter((i) => i.pricing === 'manual' && !i.accrual);
  if (!manual.length) return [];
  const lastClosed = addMonths(asOf.slice(0, 7), -1);
  const priced = new Map<string, Set<string>>();
  for (const s of pricedSeries) {
    const set = priced.get(s.instrumentId) ?? new Set<string>();
    for (const p of s.points) set.add(p.date.slice(0, 7));
    priced.set(s.instrumentId, set);
  }
  const out: PendingClose[] = [];
  for (const inst of manual) {
    const txs = transactions.filter((t) => t.instrumentId === inst.id).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    if (!txs.length) continue;
    const months: string[] = [];
    const months0 = monthsBetween(txs[0]!.date, `${lastClosed}-28`);
    let qty = 0;
    let i = 0;
    for (const m of months0) {
      while (i < txs.length && txs[i]!.date.slice(0, 7) <= m) {
        qty += quantityDelta(txs[i]!, qty);
        i++;
      }
      if (qty > 1e-9 && !priced.get(inst.id)?.has(m)) months.push(m);
    }
    if (months.length) out.push({ instrumentId: inst.id, months });
  }
  return out;
}

/** Distinct pending months across instruments, oldest first. */
export function pendingMonths(p: PendingClose[]): string[] {
  return [...new Set(p.flatMap((x) => x.months))].sort();
}
