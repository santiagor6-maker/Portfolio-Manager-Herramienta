/**
 * Shared machinery for presets: parse context (per-file number/date formats, issue factory),
 * header lookup by aliases, and the preset definition interface.
 */
import { dateFormatLabel, dateReadings, detectDateFormat, hasAmPm, isAmbiguousDate, parseDate } from '../dates';
import { makeIssue } from '../i18n';
import { detectNumberFormat, isAmbiguousNumber, parseNumber } from '../numbers';
import type {
  Cell,
  ConfirmationRequest,
  CorporateActionSuggestion,
  DateFormat,
  InstrumentHint,
  ReportedPosition,
  UnknownSecurity,
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
  /** Merge every matching sheet (e.g. B3 Posição: Ações, BDR, ETF, FII sheets) before parsing. */
  multiSheet?: boolean;
  parse(table: RawTable, ctx: ParseContext): ParsedRow[];
}

export class ParseContext {
  readonly locale: Locale;
  numberFormat: NumberFormat;
  dateFormat: DateFormat;
  readonly fileIssues: ImportIssue[] = [];
  /** Delimiter of the CSV source (hint for the decimal separator). */
  delimiter?: string;
  /** Pending format confirmations (block the import until answered). */
  readonly confirmations: ConfirmationRequest[] = [];
  /** Broker-reported positions/cash (reconciliation). */
  reported?: {
    source: string;
    asOf?: string;
    /** Broker account ids of the statement (IBKR U1234567...), to reconcile per account. */
    accountIds?: string[];
    positions: (ReportedPosition & { hint?: InstrumentHint })[];
    cash: { currency: string; amount: number }[];
  };
  readonly corporateActions: CorporateActionSuggestion[] = [];
  readonly unknownSecurities: UnknownSecurity[] = [];

  /** Record a security the user must identify (merged by key). */
  askSecurity(key: string, line: number, suggestions: string[] = []): void {
    const q = this.unknownSecurities.find((x) => x.key === key);
    if (q) q.lines.push(line);
    else this.unknownSecurities.push({ key, lines: [line], suggestions });
  }

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

  /**
   * Evidence-based date-order detection over columns `cols` of rows `from..end`.
   * Order of evidence: forced option → fixed preset format → unambiguous samples (day > 12) →
   * AM/PM times → trade/settlement ordering → chronological monotony. If still ambiguous the
   * import is blocked with a `dateFormat` confirmation request (unless `allowAmbiguous`).
   */
  detectDates(cols: (number | undefined)[], from: number, hint: DateFormat, opts: { fixed?: boolean; settleCol?: number; headerRow?: number } = {}): DateFormat {
    if (this.options.dateFormat) return (this.dateFormat = this.options.dateFormat);
    if (opts.fixed) return (this.dateFormat = hint);
    const cs = cols.filter((c): c is number => c !== undefined);
    const cells: { v: Cell; line: number; r: number }[] = [];
    for (let r = from; r < this.table.rows.length; r++) {
      for (const c of cs) cells.push({ v: this.table.rows[r]![c] ?? null, line: this.table.lines[r] ?? r + 1, r });
    }
    const det = detectDateFormat(cells.map((x) => x.v), hint);
    if (det.inconsistent) {
      this.dateFormat = det.format;
      this.fileIssues.push(this.issue('AMBIGUOUS_DATE_FORMAT', 'warning', { format: dateFormatLabel(det.format) }));
      return det.format;
    }
    if (det.confident || det.ambiguous === 0) return (this.dateFormat = det.format === 'YMD' && det.ambiguous ? hint : det.format);
    // All a/b dates are ambiguous: look for more evidence.
    let dmy = 0;
    let mdy = 0;
    if (cells.some((x) => hasAmPm(x.v))) mdy += 10;
    if (opts.settleCol !== undefined && cs[0] !== undefined) {
      for (let r = from; r < this.table.rows.length; r++) {
        const t = dateReadings(this.table.rows[r]![cs[0]] ?? null);
        const st = dateReadings(this.table.rows[r]![opts.settleCol] ?? null);
        const ok = (a?: string, b?: string) => !!a && !!b && Date.parse(b) >= Date.parse(a) && Date.parse(b) - Date.parse(a) <= 10 * 86400000;
        const d = ok(t.DMY, st.DMY);
        const m = ok(t.MDY, st.MDY);
        if (d && !m) dmy += 3;
        if (m && !d) mdy += 3;
      }
    }
    // Language/currency hint: decides the suggestion, never the answer.
    const lang = opts.headerRow !== undefined ? headerLanguage(this.table.rows[opts.headerRow] ?? []) : undefined;
    const sample = this.table.rows.slice(from, from + 50).flat().map((c) => cellToString(c).toUpperCase());
    const latam = sample.some((c) => c === 'COP' || c === 'BRL' || c === 'R$');
    const usd = sample.some((c) => /^(USD|US\$)$/.test(c));
    const hinted: DateFormat | undefined = lang === 'es' || latam ? 'DMY' : lang === 'en' || usd ? 'MDY' : undefined;
    // Chronological monotony is weak evidence (statements grouped by security are not chronological):
    // it may only confirm the hinted order, and only with enough rows.
    const MIN_ROWS_FOR_MONOTONY = 8;
    if (cs[0] !== undefined) {
      const seq = (f: DateFormat) => cells.filter((x) => x.v !== null && cellToString(x.v) !== '').map((x) => parseDate(x.v, f)).filter((d): d is string => !!d);
      const inversions = (xs: string[]) => {
        let asc = 0;
        let desc = 0;
        for (let i = 1; i < xs.length; i++) {
          if (xs[i]! < xs[i - 1]!) asc++;
          if (xs[i]! > xs[i - 1]!) desc++;
        }
        return Math.min(asc, desc);
      };
      const dSeq = seq('DMY');
      const iD = inversions(dSeq);
      const iM = inversions(seq('MDY'));
      if (dSeq.length >= MIN_ROWS_FOR_MONOTONY) {
        if (iD === 0 && iM > 1 && hinted !== 'MDY') dmy += 2;
        if (iM === 0 && iD > 1 && hinted !== 'DMY') mdy += 2;
      }
    }
    if (dmy !== mdy) {
      this.dateFormat = dmy > mdy ? 'DMY' : 'MDY';
      this.fileIssues.push(this.issue('DATE_FORMAT_INFERRED', 'info', { format: dateFormatLabel(this.dateFormat) }));
      return this.dateFormat;
    }
    const suggested: DateFormat = hinted ?? (hint === 'YMD' ? 'DMY' : hint);
    this.dateFormat = suggested;
    const affected = cells.filter((x) => isAmbiguousDate(x.v));
    if (this.options.allowAmbiguous) {
      this.fileIssues.push(this.issue('AMBIGUOUS_DATE_FORMAT', 'warning', { format: dateFormatLabel(suggested) }));
      return suggested;
    }
    const other: DateFormat = suggested === 'DMY' ? 'MDY' : 'DMY';
    this.confirmations.push({
      kind: 'dateFormat',
      candidates: [suggested, other],
      suggested,
      reason: suggested === 'MDY' ? 'Encabezados en inglés / USD: se sugiere MM/DD/AAAA.' : 'Encabezados en español/portugués o COP/BRL: se sugiere DD/MM/AAAA.',
      samples: affected.slice(0, 5).map((x) => ({
        line: x.line,
        value: cellToString(x.v),
        readings: { DMY: parseDate(x.v, 'DMY') ?? '', MDY: parseDate(x.v, 'MDY') ?? '' },
      })),
      affectedLines: [...new Set(affected.map((x) => x.line))],
    });
    this.fileIssues.push(this.issue('CONFIRM_DATE_FORMAT', 'warning', { format: dateFormatLabel(suggested) }));
    return suggested;
  }

  /**
   * Evidence-based decimal-separator detection. Evidence: unambiguous samples ("1.234,56", "12,5"),
   * row cross-checks quantity × price ≈ amount under each reading, optional reference prices,
   * ';' delimiter. Language/currency only pick the suggestion; if values like "1.000" stay
   * ambiguous the import is blocked with a `numberFormat` confirmation (unless `allowAmbiguous`).
   */
  detectNumbers(
    cols: (number | undefined)[],
    from: number,
    hint: NumberFormat,
    opts: { fixed?: boolean; triple?: { q?: number; p?: number; a?: number }; headerRow?: number; symbolCol?: number; dateCol?: number } = {},
  ): NumberFormat {
    if (this.options.numberFormat) return (this.numberFormat = this.options.numberFormat);
    if (opts.fixed) return (this.numberFormat = hint);
    const cs = cols.filter((c): c is number => c !== undefined);
    const cells: { v: Cell; line: number }[] = [];
    for (let r = from; r < this.table.rows.length; r++) {
      for (const c of cs) cells.push({ v: this.table.rows[r]![c] ?? null, line: this.table.lines[r] ?? r + 1 });
    }
    const det = detectNumberFormat(cells.map((x) => x.v), hint);
    let dot = det.votes.dot;
    let comma = det.votes.comma;
    const t = opts.triple;
    if (t && t.q !== undefined && t.p !== undefined && t.a !== undefined) {
      for (let r = from; r < this.table.rows.length; r++) {
        const row = this.table.rows[r]!;
        const [q, p, a] = [row[t.q] ?? null, row[t.p] ?? null, row[t.a] ?? null];
        if (![q, p, a].some((x) => isAmbiguousNumber(x))) continue;
        const fits = (f: NumberFormat) => {
          const [nq, np, na] = [parseNumber(q, f), parseNumber(p, f), parseNumber(a, f)];
          if (nq === undefined || np === undefined || na === undefined || [nq, np, na].some(Number.isNaN)) return false;
          const exp = Math.abs(nq * np);
          return Math.abs(exp - Math.abs(na)) <= Math.max(0.011, 0.03 * Math.abs(na));
        };
        const fd = fits('dot');
        const fc = fits('comma');
        if (fd && !fc) dot += 5;
        if (fc && !fd) comma += 5;
      }
    }
    // Price plausibility against a reference price supplied by the app (market data), if any.
    const ref = this.options.referencePrice;
    if (ref && t?.p !== undefined && opts.symbolCol !== undefined && opts.dateCol !== undefined) {
      for (let r = from; r < this.table.rows.length; r++) {
        const row = this.table.rows[r]!;
        const pc = row[t.p] ?? null;
        if (!isAmbiguousNumber(pc)) continue;
        const date = parseDate(row[opts.dateCol] ?? null, this.dateFormat);
        const symbol = cellToString(row[opts.symbolCol] ?? null);
        if (!date || !symbol) continue;
        const rp = ref({ symbol }, date);
        if (!rp) continue;
        const close = (f: NumberFormat) => {
          const v = parseNumber(pc, f);
          return v !== undefined && !Number.isNaN(v) && Math.abs(v - rp) <= 0.5 * rp;
        };
        if (close('dot') && !close('comma')) dot += 5;
        if (close('comma') && !close('dot')) comma += 5;
      }
    }
    if (comma !== dot) {
      this.numberFormat = comma > dot ? 'comma' : 'dot';
      return this.numberFormat;
    }
    const affected = cells.filter((x) => isAmbiguousNumber(x.v));
    if (!affected.length) return (this.numberFormat = hint);
    if (this.delimiter === ';') {
      this.fileIssues.push(this.issue('NUMBER_FORMAT_INFERRED', 'info', { separator: ',' }));
      return (this.numberFormat = 'comma');
    }
    const lang = opts.headerRow !== undefined ? headerLanguage(this.table.rows[opts.headerRow] ?? []) : undefined;
    const ccy = this.table.rows.slice(from, from + 50).flat().map((c) => cellToString(c).toUpperCase());
    const suggested: NumberFormat = ccy.includes('BRL') || ccy.includes('EUR') ? 'comma' : ccy.includes('USD') ? 'dot' : lang === 'en' ? 'dot' : lang ? 'comma' : hint;
    this.numberFormat = suggested;
    if (this.options.allowAmbiguous) {
      this.fileIssues.push(this.issue('AMBIGUOUS_NUMBER_FORMAT', 'warning', { separator: suggested === 'comma' ? ',' : '.' }));
      return suggested;
    }
    this.confirmations.push({
      kind: 'numberFormat',
      candidates: [suggested, suggested === 'comma' ? 'dot' : 'comma'],
      suggested,
      reason: suggested === 'comma' ? 'Se sugiere coma decimal (1.234,56).' : 'Se sugiere punto decimal (1,234.56).',
      samples: affected.slice(0, 5).map((x) => ({
        line: x.line,
        value: cellToString(x.v),
        readings: { comma: String(parseNumber(x.v, 'comma')), dot: String(parseNumber(x.v, 'dot')) },
      })),
      affectedLines: [...new Set(affected.map((x) => x.line))],
    });
    this.fileIssues.push(this.issue('CONFIRM_NUMBER_FORMAT', 'warning', { separator: suggested === 'comma' ? ',' : '.' }));
    return suggested;
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

const EN_WORDS = /^(date|trade date|action|symbol|quantity|qty|price|amount|currency|description|fees|commission|side|type|shares|total)$/;
const ESPT_WORDS = /^(fecha|data|cantidad|quantidade|precio|preco|valor|moneda|moeda|operacion|operacao|especie|ativo|comision|corretagem|tipo|monto|descripcion|titulos|simbolo|nemotecnico)$/;

/** Language of a header row: 'en' or 'es' (es/pt) or undefined. */
export function headerLanguage(row: Cell[]): 'en' | 'es' | undefined {
  let en = 0;
  let es = 0;
  for (const c of row) {
    const h = normalizeText(cellToString(c));
    if (EN_WORDS.test(h)) en++;
    if (ESPT_WORDS.test(h)) es++;
  }
  return en > es ? 'en' : es > en ? 'es' : undefined;
}
