export type CsvCell = string | number | boolean | undefined | null;

export interface CsvOptions {
  /** Field separator. Default ';' (what Excel expects in es-CO / pt-BR locales). */
  delimiter?: ',' | ';' | '\t';
  /** Decimal mark for numbers. Default ','. */
  decimal?: '.' | ',';
  /** Decimals for numbers. Default 2. */
  decimals?: number;
  /** Prepend a UTF-8 BOM so Excel detects accents correctly. Default true. */
  bom?: boolean;
}

export function toCsv(rows: CsvCell[][], opts: CsvOptions = {}): string {
  const delimiter = opts.delimiter ?? ';';
  const decimal = opts.decimal ?? ',';
  const decimals = opts.decimals ?? 2;
  if (delimiter === decimal) throw new Error('CSV delimiter and decimal mark must differ');
  const cell = (v: CsvCell): string => {
    if (v === undefined || v === null) return '';
    if (typeof v === 'boolean') return v ? 'SI' : 'NO';
    let s: string;
    if (typeof v === 'number') {
      s = Number.isFinite(v) ? v.toFixed(decimals) : '';
      if (decimal === ',') s = s.replace('.', ',');
    } else {
      s = v;
    }
    return /["\n\r]/.test(s) || s.includes(delimiter) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const body = rows.map((r) => r.map(cell).join(delimiter)).join('\r\n') + '\r\n';
  return (opts.bom ?? true ? '﻿' : '') + body;
}
