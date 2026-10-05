import { describe, expect, it } from 'vitest';
import { ALL_INSTRUMENTS, I, tx } from './testing/fixtures';
import { checkUsDividendWithholding, expectedUsDividendWithholding } from './us/withholding';
import { addYears, easterSunday, lastBrazilBusinessDayOfMonth } from './common/dates';
import { toCsv } from './common/csv';
import { createSimpleMarketData } from './testing/marketData';
import { TAX_DISCLAIMER } from './common/disclaimer';

describe('US nonresident dividend withholding', () => {
  const txs = [
    tx({ date: '2025-02-13', type: 'DIVIDEND', instrumentId: I.AAPL.id, amount: 100, taxes: 30, currency: 'USD' }),
    tx({ date: '2025-05-13', type: 'DIVIDEND', instrumentId: I.AAPL.id, amount: 100, taxes: 15, currency: 'USD' }),
    tx({ date: '2025-08-13', type: 'DIVIDEND', instrumentId: I.AAPL.id, amount: 100, currency: 'USD' }),
    tx({ date: '2025-08-13', type: 'DIVIDEND', instrumentId: I.SAN.id, amount: 100, taxes: 19, currency: 'EUR' }),
  ];
  const input = { transactions: txs, instruments: ALL_INSTRUMENTS };

  it('treaty table: no treaty for BR/CO (30%), 15% for Spain, 10% for Mexico', () => {
    expect(expectedUsDividendWithholding('BR').rate).toBe(0.3);
    expect(expectedUsDividendWithholding('CO').rate).toBe(0.3);
    expect(expectedUsDividendWithholding('ES').rate).toBe(0.15);
    expect(expectedUsDividendWithholding('MX').rate).toBe(0.1);
    expect(expectedUsDividendWithholding('ZZ').rate).toBe(0.3);
  });

  it('Colombian resident: 30% is ok, 15% is under-withheld, none is flagged; non-US source ignored', () => {
    const rows = checkUsDividendWithholding(input, 'CO');
    expect(rows.map((r) => r.status)).toEqual(['ok', 'under_withheld', 'missing_withholding']);
  });

  it('Spanish resident: 30% is over-withheld (W-8BEN missing)', () => {
    const rows = checkUsDividendWithholding(input, 'ES');
    expect(rows[0]!.status).toBe('over_withheld');
    expect(rows[1]!.status).toBe('ok');
  });
});

describe('dates', () => {
  it('Easter and Brazilian last business day (Good Friday, weekends)', () => {
    expect(easterSunday(2024)).toBe('2024-03-31');
    expect(easterSunday(2025)).toBe('2025-04-20');
    expect(lastBrazilBusinessDayOfMonth('2024-03')).toBe('2024-03-28');
    expect(lastBrazilBusinessDayOfMonth('2025-11')).toBe('2025-11-28');
    expect(lastBrazilBusinessDayOfMonth('2025-04')).toBe('2025-04-30');
  });
  it('addYears handles leap days', () => {
    expect(addYears('2024-02-29', 1)).toBe('2025-02-28');
    expect(addYears('2022-01-03', 2)).toBe('2024-01-03');
  });
});

describe('csv and market helper', () => {
  it('quotes cells containing the delimiter and formats decimals', () => {
    expect(toCsv([['a;b', 1.5, true, undefined]], { bom: false })).toBe('"a;b";1,50;SI;\r\n');
    expect(toCsv([['x', 1.5]], { delimiter: ',', decimal: '.', bom: false })).toBe('x,1.50\r\n');
  });
  it('simple market data fills forward, inverts and triangulates via USD', () => {
    const m = createSimpleMarketData({
      fx: { 'USD/COP': [['2024-01-01', 4000]], 'USD/BRL': [['2024-01-01', 5]] },
      prices: { X: [['2024-01-01', 10], ['2024-02-01', 12]] },
    });
    expect(m.fx('COP', 'USD', '2024-03-01')).toBeCloseTo(1 / 4000, 12);
    expect(m.fx('BRL', 'COP', '2024-03-01')).toBeCloseTo(800, 8);
    expect(m.price('X', '2024-01-15')).toBe(10);
    expect(m.price('X', '2023-12-31')).toBeUndefined();
  });
  it('disclaimer exists in es/pt/en', () => {
    expect(TAX_DISCLAIMER.es).toMatch(/no constituye asesoría/);
    expect(TAX_DISCLAIMER.pt).toMatch(/não constitui/);
    expect(TAX_DISCLAIMER.en).toMatch(/not tax/);
  });
});
