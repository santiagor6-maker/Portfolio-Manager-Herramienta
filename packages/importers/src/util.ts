import type { Cell } from './types';

export function stripAccents(s: string): string {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Lowercase, accent-free, alphanumeric tokens separated by single spaces. "Preço / Unitário (R$)" → "preco unitario r". */
export function normalizeText(s: unknown): string {
  return stripAccents(String(s ?? ''))
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Convert any cell to a trimmed string. Dates become YYYY-MM-DD. */
export function cellToString(v: Cell | undefined): string {
  if (v === null || v === undefined) return '';
  if (v instanceof Date) return isNaN(v.getTime()) ? '' : toIsoDateUTC(v);
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  return String(v).replace(/ /g, ' ').trim();
}

export function toIsoDateUTC(d: Date): string {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function isBlankRow(row: Cell[] | undefined): boolean {
  if (!row) return true;
  return row.every((c) => cellToString(c) === '');
}

/** Round away floating noise from computed values (qty * price). */
export function round(x: number, decimals = 8): number {
  const f = 10 ** decimals;
  return Math.round(x * f) / f;
}

export function isCurrencyCode(s: string): boolean {
  return /^[A-Z]{3}$/.test(s);
}

/** Two independent 53-bit hashes (cyrb53) concatenated → 28 hex chars. Browser-safe, deterministic. */
export function hashString(str: string): string {
  return cyrb53(str, 0x9e3779b9).toString(16).padStart(14, '0') + cyrb53(str, 0x85ebca6b).toString(16).padStart(14, '0');
}

function cyrb53(str: string, seed: number): number {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** Format a number for machine-readable output without exponent notation or float noise. */
export function formatPlainNumber(n: number, decimal: '.' | ',' = '.'): string {
  if (!Number.isFinite(n)) return '';
  let s = String(round(n, 10));
  if (/e/i.test(s)) s = n.toFixed(12).replace(/\.?0+$/, '');
  return decimal === ',' ? s.replace('.', ',') : s;
}
