import { describe, expect, it } from 'vitest';
import { formatMoney, formatMonth, formatPct, formatQuantity, MASK, trend } from '../lib/format';

const nb = (s: string) => s.replace(/ /g, ' ');

describe('formatMoney', () => {
  it('formats COP for es-CO without decimals', () => {
    expect(nb(formatMoney(1234567, 'COP', 'es-CO'))).toBe('$ 1.234.567');
  });
  it('formats BRL for pt-BR', () => {
    expect(nb(formatMoney(1234.56, 'BRL', 'pt-BR'))).toBe('R$ 1.234,56');
  });
  it('formats USD for en-US', () => {
    expect(formatMoney(1234.56, 'USD', 'en-US')).toBe('$1,234.56');
  });
  it('disambiguates foreign dollar currencies with the ISO code', () => {
    expect(nb(formatMoney(1234.5, 'USD', 'es-CO'))).toBe('USD 1.234,50');
    expect(nb(formatMoney(1000, 'COP', 'en-US'))).toBe('COP 1,000');
  });
  it('signs and compacts', () => {
    expect(nb(formatMoney(1500, 'COP', 'es-CO', { signed: true }))).toBe('+$ 1.500');
    expect(nb(formatMoney(-1500, 'COP', 'es-CO', { signed: true }))).toBe('-$ 1.500');
    expect(nb(formatMoney(123_456_789, 'COP', 'es-CO', { compact: true }))).toMatch(/123,5\sM/);
  });
  it('masks amounts in privacy mode and handles missing values', () => {
    expect(formatMoney(1, 'COP', 'es-CO', { privacy: true })).toBe(MASK);
    expect(formatMoney(undefined, 'COP', 'es-CO')).toBe('—');
    expect(formatMoney(Number.NaN, 'COP', 'es-CO')).toBe('—');
  });
});

describe('other formatters', () => {
  it('percent with sign per locale', () => {
    expect(nb(formatPct(0.0123, 'es-CO', { signed: true }))).toBe('+1,23 %'.replace(' %', '%'));
    expect(formatPct(-0.05, 'en-US', { signed: true })).toBe('-5.00%');
  });
  it('capitalised month labels', () => {
    expect(formatMonth('2026-09', 'es-CO')).toBe('Sept de 2026');
    expect(formatMonth('2026-09', 'en-US')).toBe('Sep 2026');
  });
  it('quantities keep fractional units', () => {
    expect(formatQuantity(1234, 'es-CO')).toBe('1.234');
    expect(formatQuantity(0.5, 'es-CO')).toBe('0,5');
  });
  it('trend gives colourblind-safe direction', () => {
    expect(trend(1)).toBe('up');
    expect(trend(-1)).toBe('down');
    expect(trend(0)).toBe('flat');
    expect(trend(undefined)).toBe('flat');
  });
});
