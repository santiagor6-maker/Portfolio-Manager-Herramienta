import { describe, expect, it } from 'vitest';
import { parseDecimal, toInputNumber } from '../lib/parse';
import { buildXlsx, toCsv } from '../lib/export';

describe('parseDecimal', () => {
  it.each([
    ['1.234,56', 'es-CO', 1234.56],
    ['1.500.000', 'es-CO', 1500000],
    ['12,5', 'pt-BR', 12.5],
    ['1,234.56', 'en-US', 1234.56],
    ['1,500', 'en-US', 1500],
    ['0.25', 'es-CO', 0.25],
    ['$ 2.000', 'es-CO', 2000],
    ['abc', 'es-CO', undefined],
    ['', 'es-CO', undefined],
  ])('%s (%s) → %s', (input, locale, expected) => {
    expect(parseDecimal(input, locale)).toBe(expected);
  });
  it('round-trips through toInputNumber', () => {
    expect(parseDecimal(toInputNumber(1234.5678, 'es-CO'), 'es-CO')).toBe(1234.5678);
    expect(parseDecimal(toInputNumber(0.1, 'en-US'), 'en-US')).toBe(0.1);
  });
});

describe('exports', () => {
  it('escapes CSV cells and adds a BOM', () => {
    const csv = toCsv([
      ['a', 'b,c'],
      ['x "y"', 1.5],
    ]);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.slice(1)).toBe('a,"b,c"\r\n"x ""y""",1.5');
  });
  it('builds a valid zip-based XLSX', () => {
    const bytes = buildXlsx('Mensual', [
      ['Mes', 'TWR'],
      ['2026-01', 0.0123],
    ], [undefined, 'pct']);
    expect(bytes[0]).toBe(0x50); // P
    expect(bytes[1]).toBe(0x4b); // K
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain('xl/worksheets/sheet1.xml');
    expect(text).toContain('<v>0.0123</v>');
    expect(text).toContain('2026-01');
  });
});
