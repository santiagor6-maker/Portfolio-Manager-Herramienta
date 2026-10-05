import type { Instrument, TransactionType } from '@pm/core';

export interface TxDraft {
  portfolioId: string;
  type: TransactionType;
  date: string;
  instrument?: Instrument;
  quantity?: number;
  price?: number;
  amount?: number;
  fees?: number;
  taxes?: number;
  currency: string;
  toCurrency?: string;
  toAmount?: number;
  ratio?: number;
  fxRateToBase?: number;
  account?: string;
  note?: string;
}

export const NEEDS_INSTRUMENT: TransactionType[] = [
  'BUY',
  'SELL',
  'DIVIDEND',
  'SPLIT',
  'STOCK_DIVIDEND',
  'TRANSFER_IN',
  'TRANSFER_OUT',
  'RETURN_OF_CAPITAL',
];
export const NEEDS_QTY_PRICE: TransactionType[] = ['BUY', 'SELL', 'TRANSFER_IN', 'TRANSFER_OUT'];
export const NEEDS_AMOUNT: TransactionType[] = ['DIVIDEND', 'INTEREST', 'DEPOSIT', 'WITHDRAWAL', 'FEE', 'TAX', 'RETURN_OF_CAPITAL', 'FX_CONVERSION'];
export const NEEDS_RATIO: TransactionType[] = ['SPLIT', 'STOCK_DIVIDEND'];

export type TxErrors = Partial<Record<keyof TxDraft, string>>;

/**
 * Returns i18n keys of validation errors per field (empty object = valid).
 * `heldQuantity` enables the oversell check for SELL / TRANSFER_OUT.
 */
export function validateTxDraft(d: TxDraft, ctx: { today: string; heldQuantity?: number }): { errors: TxErrors; warnings: string[] } {
  const errors: TxErrors = {};
  const warnings: string[] = [];
  if (!d.portfolioId) errors.portfolioId = 'validation.required';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d.date)) errors.date = 'validation.date';
  else if (d.date > ctx.today) warnings.push('validation.futureDate');
  if (!d.currency || !/^[A-Z]{3}$/.test(d.currency)) errors.currency = 'validation.currency';
  if (NEEDS_INSTRUMENT.includes(d.type) && !d.instrument) errors.instrument = 'validation.instrument';
  if (NEEDS_QTY_PRICE.includes(d.type)) {
    if (!(d.quantity !== undefined && d.quantity > 0)) errors.quantity = 'validation.positive';
    if (d.price === undefined || d.price < 0) errors.price = 'validation.nonNegative';
  }
  if (NEEDS_AMOUNT.includes(d.type) && !(d.amount !== undefined && d.amount > 0)) errors.amount = 'validation.positive';
  if (NEEDS_RATIO.includes(d.type) && !(d.ratio !== undefined && d.ratio > 0)) errors.ratio = 'validation.positive';
  if (d.type === 'FX_CONVERSION') {
    if (!d.toCurrency || !/^[A-Z]{3}$/.test(d.toCurrency)) errors.toCurrency = 'validation.currency';
    else if (d.toCurrency === d.currency) errors.toCurrency = 'validation.sameCurrency';
    if (!(d.toAmount !== undefined && d.toAmount > 0)) errors.toAmount = 'validation.positive';
  }
  if (d.fees !== undefined && d.fees < 0) errors.fees = 'validation.nonNegative';
  if (d.taxes !== undefined && d.taxes < 0 && d.type !== 'TAX') errors.taxes = 'validation.nonNegative';
  if (d.type === 'DIVIDEND' && d.taxes !== undefined && d.amount !== undefined && d.taxes > d.amount) errors.taxes = 'validation.taxesExceed';
  if ((d.type === 'SELL' || d.type === 'TRANSFER_OUT') && ctx.heldQuantity !== undefined && d.quantity !== undefined) {
    if (d.quantity > ctx.heldQuantity + 1e-9) warnings.push('validation.oversell');
  }
  if (d.instrument && d.currency && d.instrument.currency !== d.currency && NEEDS_QTY_PRICE.includes(d.type)) {
    warnings.push('validation.currencyMismatch');
  }
  return { errors, warnings };
}
