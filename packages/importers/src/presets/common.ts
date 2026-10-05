/**
 * Shared machinery for presets: parse context (per-file number/date formats, issue factory),
 * header lookup by aliases, and the preset definition interface.
 */
import { dateFormatLabel, detectDateFormat, parseDate } from '../dates';
import { makeIssue } from '../i18n';
import { detectNumberFormat, parseNumber } from '../numbers';
import type {
  Cell,
  DateFormat,
  ImportIssue,
  ImportOptions,
  Locale,
  NumberFormat,
  ParsedRow,
  PresetInfo,
  RawTable,
  Severity,
} from '../types';
import { cellToString, normalizeText } from '../util';

export interface PresetDefinition extends PresetInfo {
  /** 0..1 header-signature score for a table. */
  detect(table: RawTable): number;
  parse(table: RawTable, ctx: ParseContext): ParsedRow[];
}

export class ParseContext {
  readonly locale: Locale;
  numberFormat: NumberFormat;
  dateFormat: DateFormat;
  readonly fileIssues: ImportIssue[] = [];

  constructor(
    readonly table: RawTable,
    readonly options: ImportOptions,
    readonly presetId: string,
  ) {
    this.locale = options.locale ?? 'es';
    this.numberFormat = options.numberFormat ?? 'dot';
    this.dateFormat = options.dateFormat ?? 'DMY';
  }

  issue(code: string, severity: Severity, params?: Record<string, string | number>, line?: number, column?: string): ImportIssue {
    return makeIssue(this.locale, code, severity, params, { line, sheet: this.table.name, column });
  }

  /** Detect the decimal separator over the given cells (default: whole table) unless forced by options. */
  initNumbers(hint: NumberFormat, cells?: Iterable<Cell>): NumberFormat {
    if (this.options.numberFormat) return (this.numberFormat = this.options.numberFormat);
    const det = detectNumberFormat(cells ?? this.table.rows.flat(), hint);
    this.numberFormat = det.format;
    if (!det.confident && det.ambiguous > 0) {
      this.fileIssues.push(this.issue('AMBIGUOUS_NUMBER_FORMAT', 'warning', { separator: det.format === 'comma' ? ',' : '.' }));
    }
    return det.format;
  }

  /** Detect the date order over the given cells unless forced by options. */
  initDates(values: Iterable<Cell>, hint: DateFormat): DateFormat {
    if (this.options.dateFormat) return (this.dateFormat = this.options.dateFormat);
    const det = detectDateFormat(values, hint);
    this.dateFormat = det.format;
    if ((!det.confident && det.ambiguous > 0) || det.inconsistent) {
      this.fileIssues.push(this.issue('AMBIGUOUS_DATE_FORMAT', 'warning', { format: dateFormatLabel(det.format) }));
    }
    return det.format;
  }

  /** Parse a number; on garbage adds an INVALID_NUMBER error to the row and returns undefined. */
  num(v: Cell | undefined, row: ParsedRow, field: string): number | undefined {
    const n = parseNumber(v, this.numberFormat);
    if (n !== undefined && Number.isNaN(n)) {
      row.issues.push(this.issue('INVALID_NUMBER', 'error', { field, value: cellToString(v ?? null) }, row.line, field));
      return undefined;
    }
    return n;
  }

  date(v: Cell | undefined, row: ParsedRow, field = 'date'): string | undefined {
    const d = parseDate(v ?? null, this.dateFormat);
    if (!d) row.issues.push(this.issue('INVALID_DATE', 'error', { value: cellToString(v ?? null) }, row.line, field));
    return d;
  }

  newRow(index: number, raw?: Cell[]): ParsedRow {
    const row: ParsedRow = { line: this.table.lines[index] ?? index + 1, sheet: this.table.name, issues: [] };
    if (raw) row.raw = raw.map((c) => cellToString(c));
    return row;
  }

  skip(row: ParsedRow, code: string, params?: Record<string, string | number>, severity: Severity = 'info'): ParsedRow {
    row.skipped = true;
    row.issues.push(this.issue(code, severity, params, row.line));
    return row;
  }
}

/** Column lookup by aliases: exact normalized match first, then prefix match. */
export class HeaderIndex {
  readonly norm: string[];
  constructor(readonly cells: Cell[]) {
    this.norm = cells.map((c) => normalizeText(cellToString(c)));
  }
  find(...aliases: string[]): number | undefined {
    for (const a of aliases) {
      const i = this.norm.indexOf(normalizeText(a));
      if (i >= 0) return i;
    }
    for (const a of aliases) {
      const na = normalizeText(a);
      const i = this.norm.findIndex((h) => h !== '' && h.startsWith(na));
      if (i >= 0) return i;
    }
    return undefined;
  }
  has(...aliases: string[]): boolean {
    return this.find(...aliases) !== undefined;
  }
  /** Fraction of the given alias groups present (each group = alternatives). */
  coverage(groups: string[][]): number {
    if (!groups.length) return 0;
    return groups.filter((g) => this.norm.some((h) => g.some((a) => h === normalizeText(a)))).length / groups.length;
  }
}

/** Find the first row (within maxScan) whose header coverage of `groups` is ≥ minCoverage. */
export function locateHeader(table: RawTable, groups: string[][], minCoverage = 0.7, maxScan = 40): { index: number; header: HeaderIndex; coverage: number } | undefined {
  let best: { index: number; header: HeaderIndex; coverage: number } | undefined;
  const n = Math.min(table.rows.length, maxScan);
  for (let i = 0; i < n; i++) {
    const h = new HeaderIndex(table.rows[i]!);
    const cov = h.coverage(groups);
    if (cov >= minCoverage && (!best || cov > best.coverage)) best = { index: i, header: h, coverage: cov };
    if (cov === 1) break;
  }
  return best;
}

export function cell(row: Cell[], i: number | undefined): Cell {
  return i === undefined ? null : row[i] ?? null;
}

export function str(row: Cell[], i: number | undefined): string {
  return cellToString(cell(row, i));
}

/** Values of one column below the header (for date / number detection). */
export function columnValues(table: RawTable, from: number, ...cols: (number | undefined)[]): Cell[] {
  const out: Cell[] = [];
  for (let r = from; r < table.rows.length; r++) {
    for (const c of cols) if (c !== undefined) out.push(table.rows[r]![c] ?? null);
  }
  return out;
}

export function abs(n: number | undefined): number | undefined {
  return n === undefined ? undefined : Math.abs(n);
}

export function sum(...ns: (number | undefined)[]): number | undefined {
  const xs = ns.filter((n): n is number => n !== undefined);
  return xs.length ? xs.reduce((a, b) => a + b, 0) : undefined;
}

export const TOTAL_ROW_RE = /^(total|totais|totales|subtotal|sub total|saldo|grand total|transactions total)\b/i;
