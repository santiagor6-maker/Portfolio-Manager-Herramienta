import { describe, expect, it } from 'vitest';
import { validateTxDraft, type TxDraft } from '../components/txValidation';

const inst = { id: 'XNAS:AAPL', symbol: 'AAPL', name: 'Apple', exchange: 'XNAS', currency: 'USD', country: 'US', assetClass: 'equity' as const };
const base: TxDraft = { portfolioId: 'p1', type: 'BUY', date: '2026-01-10', currency: 'USD', instrument: inst, quantity: 10, price: 100 };
const ctx = { today: '2026-10-05' };

describe('validateTxDraft', () => {
  it('accepts a valid buy', () => {
    expect(validateTxDraft(base, ctx).errors).toEqual({});
  });
  it('requires an instrument, positive quantity and a price for trades', () => {
    const { errors } = validateTxDraft({ ...base, instrument: undefined, quantity: 0, price: undefined }, ctx);
    expect(errors.instrument).toBe('validation.instrument');
    expect(errors.quantity).toBe('validation.positive');
    expect(errors.price).toBe('validation.nonNegative');
  });
  it('warns when selling more than held and on future dates', () => {
    const { warnings } = validateTxDraft({ ...base, type: 'SELL', quantity: 20, date: '2027-01-01' }, { ...ctx, heldQuantity: 10 });
    expect(warnings).toContain('validation.oversell');
    expect(warnings).toContain('validation.futureDate');
  });
  it('validates FX conversions', () => {
    const fx: TxDraft = { portfolioId: 'p1', type: 'FX_CONVERSION', date: '2026-01-10', currency: 'COP', amount: 4_000_000, toCurrency: 'COP', toAmount: 0 };
    const { errors } = validateTxDraft(fx, ctx);
    expect(errors.toCurrency).toBe('validation.sameCurrency');
    expect(errors.toAmount).toBe('validation.positive');
  });
  it('rejects withholding above the gross dividend', () => {
    const div: TxDraft = { portfolioId: 'p1', type: 'DIVIDEND', date: '2026-01-10', currency: 'USD', instrument: inst, amount: 10, taxes: 11 };
    expect(validateTxDraft(div, ctx).errors.taxes).toBe('validation.taxesExceed');
  });
});
