/**
 * Parses a user-typed decimal in the UI locale. Accepts both "1.234,56" (es/pt) and
 * "1,234.56" (en); a single separator followed by 1–2 or 4+ digits is treated as decimal.
 */
export function parseDecimal(input: string, locale: string): number | undefined {
  const raw = input.trim().replace(/[\s $€£R]/g, '');
  if (!raw) return undefined;
  const commaDecimal = locale.startsWith('es') || locale.startsWith('pt');
  let norm: string;
  const hasDot = raw.includes('.');
  const hasComma = raw.includes(',');
  if (hasDot && hasComma) {
    // The right-most separator is the decimal one.
    norm = raw.lastIndexOf(',') > raw.lastIndexOf('.') ? raw.replace(/\./g, '').replace(',', '.') : raw.replace(/,/g, '');
  } else if (hasComma) {
    const parts = raw.split(',');
    const thousands = parts.length > 2 || (!commaDecimal && parts[1]?.length === 3);
    norm = thousands ? raw.replace(/,/g, '') : raw.replace(',', '.');
  } else if (hasDot) {
    const parts = raw.split('.');
    const thousands = parts.length > 2 || (commaDecimal && parts[1]?.length === 3);
    norm = thousands ? raw.replace(/\./g, '') : raw;
  } else norm = raw;
  if (!/^-?\d*\.?\d+$/.test(norm)) return undefined;
  const n = Number(norm);
  return Number.isFinite(n) ? n : undefined;
}

/** Formats a number for an editable input in the locale (no grouping). */
export function toInputNumber(v: number | undefined, locale: string): string {
  if (v === undefined || !Number.isFinite(v)) return '';
  const s = String(Math.round(v * 1e8) / 1e8);
  return locale.startsWith('en') ? s : s.replace('.', ',');
}
