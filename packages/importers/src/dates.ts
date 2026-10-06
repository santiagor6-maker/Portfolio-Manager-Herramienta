/**
 * Date parsing for broker exports: ISO, DD/MM/YYYY, MM/DD/YYYY (disambiguated per file),
 * compact YYYYMMDD (IBKR Flex), month names (en/es/pt), Excel serials and Date cells.
 * Times and suffixes ("2023-01-03, 10:30:00", "20230103;103000", "02/16/2023 as of 02/15/2023") are ignored.
 */
import type { ISODate } from '@pm/core';
import type { Cell, DateFormat } from './types';
import { stripAccents, toIsoDateUTC } from './util';

const MONTHS: Record<string, number> = {
  jan: 1, ene: 1, janeiro: 1, enero: 1, january: 1,
  feb: 2, fev: 2, fevereiro: 2, febrero: 2, february: 2,
  mar: 3, marco: 3, marzo: 3, march: 3,
  apr: 4, abr: 4, abril: 4, april: 4,
  may: 5, mai: 5, maio: 5, mayo: 5,
  jun: 6, junho: 6, junio: 6, june: 6,
  jul: 7, julho: 7, julio: 7, july: 7,
  aug: 8, ago: 8, agosto: 8, august: 8,
  sep: 9, sept: 9, set: 9, setembro: 9, septiembre: 9, setiembre: 9, september: 9,
  oct: 10, out: 10, outubro: 10, octubre: 10, october: 10,
  nov: 11, novembro: 11, noviembre: 11, november: 11,
  dec: 12, dez: 12, dic: 12, dezembro: 12, diciembre: 12, december: 12,
};

function monthFromName(s: string): number | undefined {
  const k = stripAccents(s).toLowerCase().replace(/\.$/, '');
  return MONTHS[k] ?? MONTHS[k.slice(0, 3)];
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function makeIso(y: number, m: number, d: number): ISODate | undefined {
  if (y < 100) y += y < 70 ? 2000 : 1900;
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1900 || y > 2200) return undefined;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return undefined;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** Excel serial date (1900 system) → ISO. */
export function excelSerialToIso(serial: number): ISODate | undefined {
  if (!Number.isFinite(serial) || serial < 1 || serial > 120000) return undefined;
  const ms = Math.round((serial - 25569) * 86400000);
  return toIsoDateUTC(new Date(ms));
}

type Token =
  | { kind: 'iso'; y: number; m: number; d: number }
  | { kind: 'ab'; a: number; b: number; y: number }
  | { kind: 'named'; y: number; m: number; d: number };

function tokenize(raw: string): Token | undefined {
  let s = raw.trim().replace(/^(mon|tue|wed|thu|fri|sat|sun|lun|mar|mie|mié|jue|vie|sab|sáb|dom|seg|ter|qua|qui|sex)[a-záéíóú]*\.?,?\s+/i, '');
  // Schwab: "02/16/2023 as of 02/15/2023" → the effective ("as of") date.
  const asOf = /\bas of\s+(.+)$/i.exec(s);
  if (asOf) s = asOf[1]!.trim();
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:$|[\sT,;])/.exec(s);
  if (m) return { kind: 'iso', y: +m[1]!, m: +m[2]!, d: +m[3]! };
  m = /^(\d{4})(\d{2})(\d{2})(?:$|[\sT,;])/.exec(s);
  if (m) return { kind: 'iso', y: +m[1]!, m: +m[2]!, d: +m[3]! };
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4}|\d{2})(?:$|[\sT,;])/.exec(s);
  if (m) return { kind: 'ab', a: +m[1]!, b: +m[2]!, y: +m[3]! };
  // 03-Jan-2023, 3 Jan 2023, 3 de enero de 2023
  m = /^(\d{1,2})[-\s/.]+(?:de\s+)?([A-Za-zÀ-ÿ]{3,10})\.?[-\s/.,]+(?:de\s+)?(\d{4}|\d{2})\b/.exec(s);
  if (m) {
    const mo = monthFromName(m[2]!);
    if (mo) return { kind: 'named', y: +m[3]!, m: mo, d: +m[1]! };
  }
  // Jan 3, 2023
  m = /^([A-Za-zÀ-ÿ]{3,10})\.?\s+(\d{1,2}),?\s+(\d{4})\b/.exec(s);
  if (m) {
    const mo = monthFromName(m[1]!);
    if (mo) return { kind: 'named', y: +m[3]!, m: mo, d: +m[2]! };
  }
  return undefined;
}

export interface DateFormatDetection {
  format: DateFormat;
  /** False when every sample was ambiguous (day and month ≤ 12) and the hint was used. */
  confident: boolean;
  /** True when some samples only fit DMY and others only MDY. */
  inconsistent: boolean;
  /** Number of `a/b/yyyy` samples where both a and b are ≤ 12. */
  ambiguous: number;
}

export function detectDateFormat(values: Iterable<Cell | undefined>, hint: DateFormat = 'DMY'): DateFormatDetection {
  let dmy = 0;
  let mdy = 0;
  let iso = 0;
  let ambiguous = 0;
  for (const v of values) {
    if (typeof v !== 'string') continue;
    const t = tokenize(v);
    if (!t) continue;
    if (t.kind === 'iso') iso++;
    else if (t.kind === 'ab') {
      if (t.a > 12 && t.b <= 12) dmy++;
      else if (t.b > 12 && t.a <= 12) mdy++;
      else if (t.a !== t.b) ambiguous++;
    }
  }
  if (dmy && mdy) return { format: dmy >= mdy ? 'DMY' : 'MDY', confident: false, inconsistent: true, ambiguous };
  if (dmy) return { format: 'DMY', confident: true, inconsistent: false, ambiguous };
  if (mdy) return { format: 'MDY', confident: true, inconsistent: false, ambiguous };
  if (iso) return { format: 'YMD', confident: true, inconsistent: false, ambiguous };
  return { format: hint, confident: false, inconsistent: false, ambiguous };
}

/** Parse a cell to ISO date using the per-file format for ambiguous `a/b/yyyy` dates. */
export function parseDate(v: Cell | undefined, format: DateFormat = 'DMY'): ISODate | undefined {
  if (v === null || v === undefined) return undefined;
  if (v instanceof Date) return isNaN(v.getTime()) ? undefined : toIsoDateUTC(v);
  if (typeof v === 'number') {
    if (v >= 19000101 && v <= 22001231 && Number.isInteger(v)) {
      return makeIso(Math.floor(v / 10000), Math.floor(v / 100) % 100, v % 100);
    }
    return excelSerialToIso(v);
  }
  if (typeof v !== 'string') return undefined;
  // Excel serial stored as text ("45292", "45292.5").
  if (/^\d{5}(\.\d+)?$/.test(v.trim())) {
    const n = Number(v.trim());
    if (n >= 20000 && n <= 80000) return excelSerialToIso(n);
  }
  const t = tokenize(v);
  if (!t) return undefined;
  if (t.kind === 'iso' || t.kind === 'named') return makeIso(t.y, t.m, t.d);
  if (format === 'MDY') return makeIso(t.y, t.a, t.b);
  return makeIso(t.y, t.b, t.a);
}

export function dateFormatLabel(f: DateFormat): string {
  return f === 'DMY' ? 'DD/MM/AAAA' : f === 'MDY' ? 'MM/DD/AAAA' : 'AAAA-MM-DD';
}

/** a/b/yyyy where both readings are valid and different (03/04/2024). */
export function isAmbiguousDate(v: Cell | undefined): boolean {
  if (typeof v !== 'string') return false;
  const t = tokenize(v);
  return !!t && t.kind === 'ab' && t.a <= 12 && t.b <= 12 && t.a !== t.b;
}

/** Both readings of a date cell (for confirmation dialogs and cross-checks). */
export function dateReadings(v: Cell | undefined): { DMY?: ISODate; MDY?: ISODate } {
  return { DMY: parseDate(v, 'DMY'), MDY: parseDate(v, 'MDY') };
}

/** Hour with AM/PM marker → strong US (MDY) hint. */
export function hasAmPm(v: Cell | undefined): boolean {
  return typeof v === 'string' && /\d{1,2}:\d{2}(:\d{2})?\s*[ap]\.?m\.?\b/i.test(v);
}
