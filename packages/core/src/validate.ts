/**
 * Transaction validation. Errors make results unreliable (the engine still runs, skipping
 * or capping the offending rows); warnings are informational.
 *
 * Error codes: INVALID_DATE, MISSING_CURRENCY, UNKNOWN_TYPE, MISSING_INSTRUMENT,
 *   UNKNOWN_INSTRUMENT, NEGATIVE_QUANTITY, MISSING_QUANTITY, MISSING_PRICE, NEGATIVE_AMOUNT,
 *   INVALID_RATIO, OVERSELL, MISSING_TO_CURRENCY, DUPLICATE_ID
 * Warning codes: FUTURE_DATE, DUPLICATE_IMPORT, CURRENCY_MISMATCH, ZERO_AMOUNT, SAME_CURRENCY_CONVERSION
 */
import type { Instrument, ISODate, Transaction, TransactionType } from './types';
import type { ValidationIssue } from './api';
import { isValidIsoDate, todayIso } from './dates';
import { sortTransactions } from './ledger';
import { roundQty } from './lots';

const NEEDS_INSTRUMENT: TransactionType[] = ['BUY', 'SELL', 'SPLIT', 'STOCK_DIVIDEND', 'RETURN_OF_CAPITAL'];
const KNOWN_TYPES = new Set<TransactionType>([
  'BUY', 'SELL', 'DIVIDEND', 'INTEREST', 'DEPOSIT', 'WITHDRAWAL', 'FEE', 'TAX', 'SPLIT',
  'STOCK_DIVIDEND', 'TRANSFER_IN', 'TRANSFER_OUT', 'FX_CONVERSION', 'RETURN_OF_CAPITAL',
]);

export function validateTransactionsImpl(
  transactions: Transaction[],
  instruments: Instrument[],
  opts: { today?: ISODate } = {},
): { errors: ValidationIssue[]; warnings: ValidationIssue[] } {
  const errors: ValidationIssue[] = [];
  const warnings: ValidationIssue[] = [];
  const err = (tx: Transaction | undefined, code: string, message: string) => errors.push({ transactionId: tx?.id, code, message });
  const warn = (tx: Transaction | undefined, code: string, message: string) => warnings.push({ transactionId: tx?.id, code, message });
  const byId = new Map(instruments.map((i) => [i.id, i]));
  const today = opts.today ?? todayIso();
  const seenIds = new Set<string>();
  const seenHashes = new Map<string, string>();
  const valid: Transaction[] = [];

  for (const tx of transactions) {
    let ok = true;
    if (tx.id) {
      if (seenIds.has(tx.id)) err(tx, 'DUPLICATE_ID', `Duplicate transaction id ${tx.id}`);
      seenIds.add(tx.id);
    }
    if (tx.importHash) {
      const prev = seenHashes.get(tx.importHash);
      if (prev !== undefined) warn(tx, 'DUPLICATE_IMPORT', `Same import hash as transaction ${prev} (possible duplicate)`);
      else seenHashes.set(tx.importHash, tx.id);
    }
    if (!KNOWN_TYPES.has(tx.type)) {
      err(tx, 'UNKNOWN_TYPE', `Unknown transaction type ${String(tx.type)}`);
      continue;
    }
    if (!isValidIsoDate(tx.date)) {
      err(tx, 'INVALID_DATE', `Invalid date ${String(tx.date)} (expected YYYY-MM-DD)`);
      ok = false;
    } else if (tx.date > today) warn(tx, 'FUTURE_DATE', `Date ${tx.date} is in the future`);
    if (!tx.currency || typeof tx.currency !== 'string') {
      err(tx, 'MISSING_CURRENCY', 'Missing currency');
      ok = false;
    }
    const needsInst = NEEDS_INSTRUMENT.includes(tx.type) || ((tx.type === 'TRANSFER_IN' || tx.type === 'TRANSFER_OUT') && tx.quantity !== undefined);
    if (needsInst && !tx.instrumentId) {
      err(tx, 'MISSING_INSTRUMENT', `${tx.type} requires an instrument`);
      ok = false;
    }
    if (tx.instrumentId && !byId.has(tx.instrumentId)) {
      err(tx, 'UNKNOWN_INSTRUMENT', `Unknown instrument ${tx.instrumentId}`);
    }
    for (const [field, v] of [['quantity', tx.quantity], ['price', tx.price], ['fees', tx.fees], ['toAmount', tx.toAmount]] as const) {
      if (v !== undefined && v !== null && (!Number.isFinite(v) || v < 0)) {
        err(tx, field === 'quantity' ? 'NEGATIVE_QUANTITY' : 'NEGATIVE_AMOUNT', `${field} must be a non-negative number`);
        ok = false;
      }
    }
    if (tx.amount !== undefined && tx.amount !== null && (!Number.isFinite(tx.amount) || (tx.amount < 0 && tx.type !== 'TAX'))) {
      err(tx, 'NEGATIVE_AMOUNT', 'amount must be a non-negative number');
      ok = false;
    }
    if (tx.taxes !== undefined && (!Number.isFinite(tx.taxes) || tx.taxes < 0)) {
      err(tx, 'NEGATIVE_AMOUNT', 'taxes must be a non-negative number');
      ok = false;
    }
    switch (tx.type) {
      case 'BUY':
      case 'SELL':
        if (!(tx.quantity && tx.quantity > 0)) {
          err(tx, 'MISSING_QUANTITY', `${tx.type} requires a quantity > 0`);
          ok = false;
        }
        if (tx.price === undefined && tx.amount === undefined) {
          err(tx, 'MISSING_PRICE', `${tx.type} requires price or amount`);
          ok = false;
        }
        break;
      case 'SPLIT':
        if (!(typeof tx.ratio === 'number' && tx.ratio > 0 && Number.isFinite(tx.ratio))) {
          err(tx, 'INVALID_RATIO', 'Split ratio must be > 0');
          ok = false;
        }
        break;
      case 'STOCK_DIVIDEND':
        if (!(tx.quantity && tx.quantity > 0) && !(typeof tx.ratio === 'number' && tx.ratio > 0)) {
          err(tx, 'INVALID_RATIO', 'Stock dividend requires a quantity or a ratio > 0');
          ok = false;
        }
        break;
      case 'FX_CONVERSION':
        if (!tx.toCurrency) {
          err(tx, 'MISSING_TO_CURRENCY', 'FX conversion requires toCurrency');
          ok = false;
        } else if (tx.toCurrency === tx.currency) warn(tx, 'SAME_CURRENCY_CONVERSION', 'FX conversion between the same currency');
        if (!tx.amount) warn(tx, 'ZERO_AMOUNT', 'FX conversion without amount');
        break;
      case 'DEPOSIT':
      case 'WITHDRAWAL':
      case 'FEE':
        if (!tx.amount && !(tx.type === 'FEE' && tx.fees)) warn(tx, 'ZERO_AMOUNT', `${tx.type} without amount`);
        break;
      case 'DIVIDEND':
      case 'INTEREST':
        if (tx.amount === undefined && !tx.price) warn(tx, 'ZERO_AMOUNT', `${tx.type} without amount`);
        break;
      default:
        break;
    }
    if ((tx.type === 'BUY' || tx.type === 'SELL') && tx.instrumentId) {
      const inst = byId.get(tx.instrumentId);
      if (inst && tx.currency && inst.currency !== tx.currency) {
        warn(tx, 'CURRENCY_MISMATCH', `Transaction currency ${tx.currency} differs from instrument currency ${inst.currency}; converted at market FX`);
      }
    }
    if (ok) valid.push(tx);
  }

  // Oversell check: replay quantities in engine order (splits and stock dividends included).
  const held = new Map<string, number>();
  for (const { tx } of sortTransactions(valid)) {
    const id = tx.instrumentId;
    if (!id) continue;
    const q = held.get(id) ?? 0;
    switch (tx.type) {
      case 'BUY':
      case 'TRANSFER_IN':
        held.set(id, roundQty(q + (tx.quantity ?? 0)));
        break;
      case 'SELL':
      case 'TRANSFER_OUT': {
        const sell = tx.quantity ?? 0;
        if (roundQty(sell - q) > 0) {
          err(tx, 'OVERSELL', `${tx.type} of ${sell} ${id} on ${tx.date} exceeds holding of ${q}`);
          held.set(id, 0);
        } else held.set(id, roundQty(q - sell));
        break;
      }
      case 'SPLIT':
        held.set(id, roundQty(q * (tx.ratio ?? 1)));
        break;
      case 'STOCK_DIVIDEND':
        held.set(id, roundQty(tx.quantity && tx.quantity > 0 ? q + tx.quantity : q * (1 + (tx.ratio ?? 0))));
        break;
      default:
        break;
    }
  }
  return { errors, warnings };
}
