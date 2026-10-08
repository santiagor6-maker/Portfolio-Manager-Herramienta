import type { Instrument, Transaction, TransactionType } from '@pm/core';

export const round2 = (n: number): number => Math.round((n + Number.EPSILON) * 100) / 100;

export const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

/**
 * Processing order for transactions that share a date. Corporate actions first, then cash in,
 * then buys before sells (so a same-day buy+sell does not look like an oversell).
 */
const TYPE_ORDER: Record<TransactionType, number> = {
  SPLIT: 0,
  STOCK_DIVIDEND: 1,
  TRANSFER_IN: 2,
  DEPOSIT: 3,
  DIVIDEND: 4,
  INTEREST: 5,
  RETURN_OF_CAPITAL: 6,
  FX_CONVERSION: 7,
  BUY: 8,
  SELL: 9,
  FEE: 10,
  TAX: 11,
  TRANSFER_OUT: 12,
  WITHDRAWAL: 13,
};

/**
 * Stable sort by date, then by type order, then by original position. With `outBeforeIn`, same-day
 * TRANSFER_OUT is processed before TRANSFER_IN (custody moves: the cost leaves before it arrives).
 */
export function sortTransactions(txs: Transaction[], opts: { outBeforeIn?: boolean } = {}): Transaction[] {
  const order = (t: TransactionType) => (opts.outBeforeIn && t === 'TRANSFER_OUT' ? 1.5 : TYPE_ORDER[t]);
  return txs
    .map((tx, i) => ({ tx, i }))
    .sort((a, b) => a.tx.date.localeCompare(b.tx.date) || order(a.tx.type) - order(b.tx.type) || a.i - b.i)
    .map((x) => x.tx);
}

/** Gross cash amount of a row: `amount`, or quantity * price. */
export function grossAmount(tx: Transaction): number {
  if (tx.amount !== undefined) return tx.amount;
  return (tx.quantity ?? 0) * (tx.price ?? 0);
}

export function instrumentMap(instruments: Instrument[]): Map<string, Instrument> {
  return new Map(instruments.map((i) => [i.id, i]));
}

/** Symbol for display: instrument symbol, else the part after ':' of the id. */
export function displaySymbol(id: string, inst?: Instrument): string {
  return inst?.symbol ?? id.split(':').pop() ?? id;
}
