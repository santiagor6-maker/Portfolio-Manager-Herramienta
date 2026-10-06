/**
 * Locale-aware number parsing: `1.234,56` (es/pt) and `1,234.56` (en), currency symbols,
 * parentheses / trailing-minus negatives, and per-file auto-detection of the decimal separator.
 */
import type { Cell, NumberFormat } from './types';

const CURRENCY_TOKENS = /(R\$|US\$|COL\$|COP\$|CA\$|A\$|MX\$|\$|€|£|¥|\b(?:COP|BRL|USD|EUR|GBP|GBX|MXN|CLP|PEN|CHF|CAD)\b)/gi;
const EMPTY_TOKENS = new Set(['', '-', '--', '—', '–', 'n/a', 'na', 'n.a.', 'nan', 'null', '#n/a']);

/** Strip currency symbols, spaces and sign markers. Returns sign separately. */
function clean(raw: string): { body: string; negative: boolean } | undefined {
  let s = raw.replace(/[   ]/g, ' ').trim();
  if (EMPTY_TOKENS.has(s.toLowerCase())) return undefined;
  let negative = false;
  // Debit / credit suffixes: "1,234.56 DR", "1.234,56 D", "2.345,00 C" (SINACOR, bank statements).
  const dc = /^(.*\d)\s*(DR|DB|D|CR|C)$/i.exec(s);
  if (dc) {
    s = dc[1]!.trim();
    if (/^d/i.test(dc[2]!)) negative = true;
  }
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(CURRENCY_TOKENS, '').replace(/\s+/g, '').replace(/%$/, '');
  s = s.replace(/[−‒–]/g, '-'); // unicode minus / dashes
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  } else if (s.endsWith('-')) {
    negative = !negative;
    s = s.slice(0, -1);
  } else if (s.startsWith('+')) s = s.slice(1);
  // "-$1,250.70" → after removing $ we may still have a leading sign
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  }
  if (s === '') return undefined;
  return { body: s, negative };
}

/**
 * Parse a cell into a number. Returns `undefined` for empty cells and `NaN` for garbage
 * (callers report NaN as an INVALID_NUMBER issue).
 */
export function parseNumber(v: Cell | undefined, format: NumberFormat = 'dot'): number | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  if (typeof v === 'boolean' || v instanceof Date) return NaN;
  const c = clean(String(v));
  if (!c) return undefined;
  let s = c.body;
  if (/^\d+(\.\d+)?e[+-]?\d+$/i.test(s)) return (c.negative ? -1 : 1) * Number(s);
  if (!/^[\d.,']+$/.test(s)) return NaN;
  s = s.replace(/'/g, ''); // Swiss thousands 1'234.50
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  let decimalSep: '.' | ',' | undefined;
  if (lastDot >= 0 && lastComma >= 0) decimalSep = lastDot > lastComma ? '.' : ',';
  else if (lastComma >= 0) {
    const n = (s.match(/,/g) ?? []).length;
    if (n > 1) decimalSep = undefined; // "1,234,567": only thousands separators
    else if (format === 'comma') decimalSep = ',';
    else decimalSep = /^[1-9]\d{0,2},\d{3}$/.test(s) ? undefined : ','; // "1,234" thousands; "12,5" decimal
  } else if (lastDot >= 0) {
    const n = (s.match(/\./g) ?? []).length;
    if (n > 1) decimalSep = undefined; // "1.234.567"
    else if (format === 'comma' && /^[1-9]\d{0,2}\.\d{3}$/.test(s)) decimalSep = undefined; // "1.234" = thousands
    else decimalSep = '.';
  }
  let normalized: string;
  if (decimalSep === ',') normalized = s.replace(/\./g, '').replace(',', '.');
  else if (decimalSep === '.') normalized = s.replace(/,/g, '');
  else normalized = s.replace(/[.,]/g, '');
  if (!/^\d*\.?\d+$|^\d+\.?$/.test(normalized)) return NaN;
  const num = Number(normalized);
  if (!Number.isFinite(num)) return NaN;
  return c.negative ? -num : num;
}

export interface NumberFormatDetection {
  format: NumberFormat;
  /** False when no unambiguous sample was found and the hint/default was used. */
  confident: boolean;
  votes: { dot: number; comma: number };
  /** Samples such as "1.234" or "1,234" that fit both conventions. */
  ambiguous: number;
}

const NUMERIC_LIKE = /^[-+(]?\s*(?:R\$|US\$|\$|€|£)?\s*-?[\d.,']+\s*\)?-?$/;

/** Vote over all numeric-looking strings of a file to decide the decimal separator. */
export function detectNumberFormat(values: Iterable<Cell | undefined>, hint?: NumberFormat): NumberFormatDetection {
  let dot = 0;
  let comma = 0;
  let ambiguous = 0;
  for (const v of values) {
    if (typeof v !== 'string') continue;
    const s = v.trim();
    if (!s || s.length > 30 || !NUMERIC_LIKE.test(s) || !/\d/.test(s)) continue;
    if (/^\d{1,4}[./-]\d{1,2}[./-]\d{2,4}$/.test(s)) continue; // date-like
    const body = s.replace(/[^\d.,]/g, '');
    const dots = (body.match(/\./g) ?? []).length;
    const commas = (body.match(/,/g) ?? []).length;
    if (dots && commas) {
      if (body.lastIndexOf('.') > body.lastIndexOf(',')) dot++;
      else comma++;
    } else if (commas) {
      if (commas > 1) dot++;
      else if (!/^[1-9]\d{0,2},\d{3}$/.test(body)) comma++;
      else ambiguous++;
    } else if (dots) {
      if (dots > 1) comma++;
      else if (!/^[1-9]\d{0,2}\.\d{3}$/.test(body)) dot++;
      else ambiguous++;
    }
  }
  if (comma > dot) return { format: 'comma', confident: true, votes: { dot, comma }, ambiguous };
  if (dot > comma) return { format: 'dot', confident: true, votes: { dot, comma }, ambiguous };
  return { format: hint ?? 'dot', confident: false, votes: { dot, comma }, ambiguous };
}

/**
 * Split / bonus ratio: "2", "2:1", "1x10", "1×10", "1/10", "10%" (bonus) → new shares per old share.
 * "a:b" / "axb" / "a/b" are read as a / b.
 */
export function parseRatio(v: Cell | undefined, format: NumberFormat = 'dot'): number | undefined {
  if (v === null || v === undefined) return undefined;
  if (typeof v === 'number') return v;
  const s = String(v).trim();
  if (!s) return undefined;
  const m = /^([\d.,]+)\s*(?::|x|×|\/|for|por|para)\s*([\d.,]+)$/i.exec(s);
  if (m) {
    const a = parseNumber(m[1]!, format);
    const b = parseNumber(m[2]!, format);
    if (a === undefined || b === undefined || !b || Number.isNaN(a) || Number.isNaN(b)) return NaN;
    return a / b;
  }
  const pct = /^([\d.,]+)\s*%$/.exec(s);
  if (pct) {
    const n = parseNumber(pct[1]!, format);
    return n === undefined ? undefined : n / 100;
  }
  return parseNumber(s, format);
}

/** True for strings that read differently under the two conventions ("1.000", "2,450"). */
export function isAmbiguousNumber(v: Cell | undefined): boolean {
  if (typeof v !== 'string') return false;
  const body = v.replace(/[^\d.,]/g, '');
  return /^[1-9]\d{0,2}[.,]\d{3}$/.test(body);
}
