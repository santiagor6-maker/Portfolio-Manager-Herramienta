import { describe, expect, it } from 'vitest';
import { allocation, validateTransactions, valuePortfolio } from './api';
import { engine, fxs, inst, prices, tx } from './__fixtures__/helpers';

const A = inst('XNAS:AAPL', 'USD', { sector: 'Tecnología' });
const codes = (xs: { code: string }[]) => xs.map((x) => x.code).sort();

describe('validateTransactions', () => {
  it('accepts a clean history', () => {
    const r = validateTransactions(
      [
        tx({ date: '2024-01-02', type: 'BUY', instrumentId: A.id, quantity: 10, price: 100, currency: 'USD' }),
        tx({ date: '2024-06-02', type: 'SPLIT', instrumentId: A.id, ratio: 2, currency: 'USD' }),
        tx({ date: '2024-07-02', type: 'SELL', instrumentId: A.id, quantity: 20, price: 60, currency: 'USD' }),
      ],
      [A],
      { today: '2025-01-01' },
    );
    expect(r).toEqual({ errors: [], warnings: [] });
  });

  it('detects overselling (split-aware), unknown instruments, missing currency, bad quantities and ratios', () => {
    const r = validateTransactions(
      [
        tx({ id: 'b1', date: '2024-01-02', type: 'BUY', instrumentId: A.id, quantity: 10, price: 100, currency: 'USD' }),
        tx({ id: 's1', date: '2024-02-02', type: 'SELL', instrumentId: A.id, quantity: 11, price: 100, currency: 'USD' }),
        tx({ id: 'u1', date: '2024-02-02', type: 'BUY', instrumentId: 'XNAS:NOPE', quantity: 1, price: 1, currency: 'USD' }),
        tx({ id: 'c1', date: '2024-02-02', type: 'DEPOSIT', amount: 1, currency: '' }),
        tx({ id: 'n1', date: '2024-02-02', type: 'BUY', instrumentId: A.id, quantity: -1, price: 1, currency: 'USD' }),
        tx({ id: 'r1', date: '2024-02-03', type: 'SPLIT', instrumentId: A.id, ratio: 0, currency: 'USD' }),
        tx({ id: 'p1', date: '2024-02-03', type: 'BUY', instrumentId: A.id, quantity: 1, currency: 'USD' }),
        tx({ id: 'd1', date: '2024-02-30', type: 'DEPOSIT', amount: 1, currency: 'USD' }),
        tx({ id: 'x1', date: '2024-02-03', type: 'FX_CONVERSION', amount: 1, currency: 'USD' }),
      ],
      [A],
      { today: '2025-01-01' },
    );
    expect(codes(r.errors)).toEqual(
      ['INVALID_DATE', 'INVALID_RATIO', 'MISSING_CURRENCY', 'MISSING_PRICE', 'MISSING_QUANTITY', 'MISSING_TO_CURRENCY', 'NEGATIVE_QUANTITY', 'OVERSELL', 'UNKNOWN_INSTRUMENT'].sort(),
    );
    expect(r.errors.find((e) => e.code === 'OVERSELL')!.transactionId).toBe('s1');
  });

  it('warns about future dates, duplicate import hashes and currency mismatches; errors on duplicate ids', () => {
    const r = validateTransactions(
      [
        tx({ id: 'a', date: '2030-01-01', type: 'DEPOSIT', amount: 1, currency: 'USD' }),
        tx({ id: 'b', date: '2024-01-01', type: 'DEPOSIT', amount: 1, currency: 'USD', importHash: 'h1' }),
        tx({ id: 'c', date: '2024-01-01', type: 'DEPOSIT', amount: 1, currency: 'USD', importHash: 'h1' }),
        tx({ id: 'c', date: '2024-01-01', type: 'BUY', instrumentId: A.id, quantity: 1, price: 400_000, currency: 'COP' }),
      ],
      [A],
      { today: '2025-01-01' },
    );
    expect(codes(r.warnings)).toEqual(['CURRENCY_MISMATCH', 'DUPLICATE_IMPORT', 'FUTURE_DATE']);
    expect(codes(r.errors)).toEqual(['DUPLICATE_ID']);
  });
});

describe('allocation', () => {
  const PETR = inst('BVMF:PETR4', 'BRL', { country: 'BR', sector: 'Energía' });
  const VOO = inst('ARCX:VOO', 'USD', { assetClass: 'etf' });
  const input = engine({
    base: 'COP',
    instruments: [A, PETR, VOO],
    prices: [prices(A.id, 'USD', { '2024-01-01': 100 }), prices(PETR.id, 'BRL', { '2024-01-01': 40 }), prices(VOO.id, 'USD', { '2024-01-01': 400 })],
    fx: [fxs('USD', 'COP', { '2024-01-01': 4000 }), fxs('USD', 'BRL', { '2024-01-01': 5 })],
    // Keep the COP deposit as cash: foreign buys are funded by implicit deposits, not converted.
    options: { implicitFx: 'none' },
    transactions: [
      tx({ date: '2024-01-02', type: 'DEPOSIT', amount: 4_000_000, currency: 'COP', account: 'Trii' }),
      tx({ date: '2024-01-02', type: 'BUY', instrumentId: A.id, quantity: 10, price: 100, currency: 'USD', account: 'IBKR' }),
      tx({ date: '2024-01-02', type: 'BUY', instrumentId: VOO.id, quantity: 5, price: 400, currency: 'USD', account: 'IBKR' }),
      tx({ date: '2024-01-02', type: 'BUY', instrumentId: PETR.id, quantity: 250, price: 40, currency: 'BRL', account: 'XP' }),
    ],
  });
  const v = valuePortfolio(input, '2024-01-31');
  // AAPL 1000 USD = 4,000,000 ; VOO 2000 USD = 8,000,000 ; PETR4 10,000 BRL = 8,000,000 ; COP cash 4,000,000
  const map = (by: Parameters<typeof allocation>[2]) => Object.fromEntries(allocation(v, input.instruments, by).map((s) => [s.key, s.valueBase]));

  it('by asset class with cash as its own class', () => {
    expect(map('assetClass')).toEqual({ equity: 12_000_000, etf: 8_000_000, cash: 4_000_000 });
    const s = allocation(v, input.instruments, 'assetClass');
    expect(s.reduce((a, x) => a + x.weight, 0)).toBeCloseTo(1, 12);
    expect(s.find((x) => x.key === 'cash')!.label).toBe('Efectivo');
  });

  it('by currency of exposure (cash by its own currency)', () => {
    expect(map('currency')).toEqual({ USD: 12_000_000, BRL: 8_000_000, COP: 4_000_000 });
  });

  it('by country, sector, exchange, instrument and account', () => {
    expect(map('country')).toEqual({ US: 12_000_000, BR: 8_000_000, CO: 4_000_000 });
    expect(map('sector')).toEqual({ 'Tecnología': 4_000_000, 'Energía': 8_000_000, unknown: 8_000_000, cash: 4_000_000 });
    expect(map('exchange')).toEqual({ XNAS: 4_000_000, ARCX: 8_000_000, BVMF: 8_000_000, cash: 4_000_000 });
    expect(map('instrument')).toEqual({ [A.id]: 4_000_000, [VOO.id]: 8_000_000, [PETR.id]: 8_000_000, 'cash:COP': 4_000_000 });
    expect(map('account')).toEqual({ IBKR: 12_000_000, XP: 8_000_000, Trii: 4_000_000 });
  });
});
