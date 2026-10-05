import { describe, expect, it } from 'vitest';
import {
  classifyType,
  decodeBytes,
  detectDateFormat,
  detectNumberFormat,
  encodeWindows1252,
  parseCsvText,
  parseDate,
  parseNumber,
  sniffDelimiter,
} from '../src';

describe('parseNumber', () => {
  it('parses en and es/pt formats', () => {
    expect(parseNumber('1,234.56', 'dot')).toBe(1234.56);
    expect(parseNumber('1.234,56', 'comma')).toBe(1234.56);
    expect(parseNumber('1.234,56', 'dot')).toBe(1234.56); // both separators are unambiguous
    expect(parseNumber('1,234.56', 'comma')).toBe(1234.56);
    expect(parseNumber('5.000.000,00', 'comma')).toBe(5000000);
    expect(parseNumber('12,5', 'dot')).toBe(12.5);
  });
  it('resolves ambiguous thousands by file format', () => {
    expect(parseNumber('1.234', 'comma')).toBe(1234);
    expect(parseNumber('1.234', 'dot')).toBe(1.234);
    expect(parseNumber('1,234', 'dot')).toBe(1234);
    expect(parseNumber('1,234', 'comma')).toBe(1.234);
    expect(parseNumber('0.123', 'comma')).toBe(0.123);
  });
  it('handles currency symbols and negatives', () => {
    expect(parseNumber('-$1,250.70')).toBe(-1250.7);
    expect(parseNumber('($12.34)')).toBe(-12.34);
    expect(parseNumber('R$ 1.234,56', 'comma')).toBe(1234.56);
    expect(parseNumber('1.234,56-', 'comma')).toBe(-1234.56);
    expect(parseNumber('COP 2.450.000', 'comma')).toBe(2450000);
    expect(parseNumber('€ 10,50', 'comma')).toBe(10.5);
    expect(parseNumber("1'234.50", 'dot')).toBe(1234.5);
    expect(parseNumber('1e-7')).toBe(1e-7);
  });
  it('returns undefined for empty and NaN for garbage', () => {
    expect(parseNumber('')).toBeUndefined();
    expect(parseNumber('-')).toBeUndefined();
    expect(parseNumber(null)).toBeUndefined();
    expect(parseNumber('abc')).toBeNaN();
    expect(parseNumber(42)).toBe(42);
  });
  it('detects the decimal separator per file', () => {
    expect(detectNumberFormat(['1.234,56', '10,5', '3']).format).toBe('comma');
    expect(detectNumberFormat(['1,234.56', '10.5']).format).toBe('dot');
    const amb = detectNumberFormat(['1.234', '2.000'], 'comma');
    expect(amb).toMatchObject({ format: 'comma', confident: false, ambiguous: 2 });
    expect(detectNumberFormat(['02/01/2023', 'PETR4', '1.000.000']).format).toBe('comma');
  });
});

describe('parseDate', () => {
  it('parses common formats', () => {
    expect(parseDate('2023-01-31')).toBe('2023-01-31');
    expect(parseDate('31/01/2023', 'DMY')).toBe('2023-01-31');
    expect(parseDate('01/31/2023', 'MDY')).toBe('2023-01-31');
    expect(parseDate('05-01-2023', 'DMY')).toBe('2023-01-05');
    expect(parseDate('20230403;202000')).toBe('2023-04-03');
    expect(parseDate('2023-01-03, 10:30:00')).toBe('2023-01-03');
    expect(parseDate('2023-01-03 14:30:05.123')).toBe('2023-01-03');
    expect(parseDate('02/16/2023 as of 02/15/2023', 'MDY')).toBe('2023-02-15');
    expect(parseDate('3 de enero de 2024')).toBe('2024-01-03');
    expect(parseDate('15-mar-2023')).toBe('2023-03-15');
    expect(parseDate('Jan 5, 2023')).toBe('2023-01-05');
    expect(parseDate('05/01/23', 'DMY')).toBe('2023-01-05');
    expect(parseDate(new Date(Date.UTC(2023, 2, 10)))).toBe('2023-03-10');
    expect(parseDate(44935)).toBe('2023-01-09'); // Excel serial
    expect(parseDate(20230110)).toBe('2023-01-10');
  });
  it('rejects impossible dates', () => {
    expect(parseDate('2024-13-45')).toBeUndefined();
    expect(parseDate('31/02/2023', 'DMY')).toBeUndefined();
    expect(parseDate('hello')).toBeUndefined();
  });
  it('disambiguates DMY vs MDY per file', () => {
    expect(detectDateFormat(['01/02/2023', '25/02/2023']).format).toBe('DMY');
    expect(detectDateFormat(['01/02/2023', '02/25/2023']).format).toBe('MDY');
    expect(detectDateFormat(['01/02/2023', '03/04/2023'], 'MDY')).toMatchObject({ format: 'MDY', confident: false, ambiguous: 2 });
    expect(detectDateFormat(['2023-01-02']).format).toBe('YMD');
    expect(detectDateFormat(['13/01/2023', '01/13/2023']).inconsistent).toBe(true);
  });
});

describe('decoding and CSV reading', () => {
  it('decodes UTF-8, UTF-8 BOM, Windows-1252 and UTF-16LE', () => {
    const text = 'Operación;Preço;€';
    expect(decodeBytes(new TextEncoder().encode(text))).toMatchObject({ text, encoding: 'utf-8' });
    const bom = new Uint8Array([0xef, 0xbb, 0xbf, ...new TextEncoder().encode(text)]);
    expect(decodeBytes(bom)).toMatchObject({ text, encoding: 'utf-8', hadBom: true });
    expect(decodeBytes(encodeWindows1252(text))).toMatchObject({ text, encoding: 'windows-1252' });
    const u16 = new Uint8Array(text.length * 2);
    for (let i = 0; i < text.length; i++) {
      u16[i * 2] = text.charCodeAt(i) & 0xff;
      u16[i * 2 + 1] = text.charCodeAt(i) >> 8;
    }
    expect(decodeBytes(u16)).toMatchObject({ text, encoding: 'utf-16le' });
    expect(decodeBytes(new Uint8Array([0xff, 0xfe, ...u16]))).toMatchObject({ text, encoding: 'utf-16le', hadBom: true });
  });
  it('sniffs delimiters even with comma decimals', () => {
    expect(sniffDelimiter('Data;Valor\n01/02/2023;1,5\n02/02/2023;2,5\n')).toBe(';');
    expect(sniffDelimiter('a,b,c\n1,2,3\n')).toBe(',');
    expect(sniffDelimiter('a\tb\tc\n1\t2,5\t3\n')).toBe('\t');
    expect(sniffDelimiter('"x, y";b\n"1,0";2\n')).toBe(';');
  });
  it('keeps source line numbers with multi-line quoted fields and blank lines', () => {
    const { table } = parseCsvText('h1,h2\n"a\nb",1\n\nc,2\n');
    expect(table.rows).toEqual([['h1', 'h2'], ['a\nb', '1'], ['c', '2']]);
    expect(table.lines).toEqual([1, 2, 5]);
  });
  it('honours the Excel sep= hint line', () => {
    const { table, delimiter } = parseCsvText('sep=;\na;b\n1,5;2\n');
    expect(delimiter).toBe(';');
    expect(table.rows[1]).toEqual(['1,5', '2']);
    expect(table.lines[1]).toBe(3);
  });
});

describe('classifyType', () => {
  it.each([
    ['C', 'BUY'], ['V', 'SELL'], ['Compra', 'BUY'], ['Venda', 'SELL'], ['Market buy', 'BUY'], ['SELL', 'SELL'],
    ['Juros Sobre Capital Próprio', 'DIVIDEND'], ['Rendimento', 'DIVIDEND'], ['Pago de dividendos', 'DIVIDEND'],
    ['Retención en la fuente dividendos', 'TAX'], ['GMF 4x1000', 'TAX'], ['Consignación', 'DEPOSIT'], ['Retiro', 'WITHDRAWAL'],
    ['Desdobro', 'SPLIT'], ['Bonificación', 'STOCK_DIVIDEND'], ['Comisión de custodia', 'FEE'], ['Intereses', 'INTEREST'],
    ['Abono dividendos ECOPETROL', 'DIVIDEND'], ['Monetización', 'FX_CONVERSION'], ['RETURN_OF_CAPITAL', 'RETURN_OF_CAPITAL'],
    ['Amortização', 'RETURN_OF_CAPITAL'], ['Compra de acciones', 'BUY'],
  ])('%s → %s', (input, expected) => {
    expect(classifyType(input)).toBe(expected);
  });
  it('supports user overrides and unknowns', () => {
    expect(classifyType('X', { x: 'BUY' })).toBe('BUY');
    expect(classifyType('Ajuste raro')).toBeUndefined();
  });
});
