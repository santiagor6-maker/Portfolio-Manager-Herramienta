/**
 * Import pipeline: read file → pick table + preset (header signatures) → parse rows → resolve
 * instruments → validate → hash → exact & semantic de-duplication → infer split ratios →
 * format confirmations → result with per-row preview and broker reconciliation.
 */
import type { Instrument, Transaction, TransactionType } from '@pm/core';
import { businessDaysBetween, calendarFor, dayNumber, type CalendarId } from './calendars';
import { makeIssue } from './i18n';
import { InstrumentResolver } from './instruments';
import { getBrokerProfile } from './profiles';
import { suggestMapping } from './mapping';
import { exchangeCurrency } from './markets';
import { extractPdf, PdfPasswordError, pdfToTable } from './pdf/extract';
import { PDF_PARSERS } from './pdf/parsers';
import { ParseContext, type PresetDefinition } from './presets/common';
import { extractoColombianoPreset } from './presets/extracto-co';
import { genericPreset, parseWithMapping } from './presets/generic';
import { getPreset, PRESETS } from './presets/registry';
import { readTables, type ReadResult } from './read';
import type {
  DetectionInfo,
  DraftTransaction,
  ImportInput,
  ImportIssue,
  ImportOptions,
  ImportResult,
  ImportRow,
  ImportStats,
  Locale,
  MappingSuggestion,
  ParsedRow,
  RawTable,
  Reconciliation,
} from './types';
import { hashString, isCurrencyCode, normalizeText, round } from './util';

export interface TableInspection {
  name: string;
  rowCount: number;
  presets: { id: string; label: string; score: number }[];
  suggestion: MappingSuggestion;
}

export interface FileInspection {
  kind: ReadResult['kind'];
  encoding?: string;
  delimiter?: string;
  tables: TableInspection[];
  /** Best preset over all tables (score ≥ 0.5), if any. */
  best?: { presetId: string; table: string; score: number };
  error?: ImportIssue;
}

const DETECT_THRESHOLD = 0.5;

function scoreTables(tables: RawTable[], presets: PresetDefinition[]): { preset: PresetDefinition; table: RawTable; score: number }[] {
  const out: { preset: PresetDefinition; table: RawTable; score: number }[] = [];
  for (const table of tables) {
    for (const preset of presets) {
      let score = 0;
      try {
        score = preset.detect(table);
      } catch {
        score = 0;
      }
      if (score > 0) out.push({ preset, table, score });
    }
  }
  return out.sort((a, b) => b.score - a.score);
}

function pickTable(tables: RawTable[], sheet: string | number | undefined): RawTable | undefined {
  if (sheet === undefined) return undefined;
  if (typeof sheet === 'number') return tables[sheet];
  return tables.find((t) => t.name === sheet);
}

/** Inspect a file without importing: tables, preset scores and mapping suggestions (for the UI wizard). */
export async function inspectFile(input: ImportInput, options: Pick<ImportOptions, 'encoding' | 'locale'> = {}): Promise<FileInspection> {
  const locale = options.locale ?? 'es';
  const read = await readTables(input.data, input.fileName, options.encoding);
  const res: FileInspection = { kind: read.kind, tables: [] };
  if (read.encoding) res.encoding = read.encoding;
  if (read.delimiter) res.delimiter = read.delimiter;
  if (read.error) res.error = makeIssue(locale, read.error.code, 'error', read.error.detail ? { detail: read.error.detail } : undefined);
  for (const t of read.tables) {
    const presets = scoreTables([t], PRESETS).map((s) => ({ id: s.preset.id, label: s.preset.label, score: s.score }));
    res.tables.push({ name: t.name, rowCount: t.rows.length, presets, suggestion: suggestMapping(t) });
  }
  const best = scoreTables(read.tables, PRESETS)[0];
  if (best && best.score >= DETECT_THRESHOLD) res.best = { presetId: best.preset.id, table: best.table.name, score: best.score };
  return res;
}

function emptyStats(): ImportStats {
  return {
    totalRows: 0, imported: 0, duplicates: 0, skipped: 0, errors: 0, warnings: 0, byType: {}, currencies: [],
    newInstruments: 0, matchedInstruments: 0, possibleDuplicates: 0, pending: 0,
  };
}

function failure(detection: DetectionInfo, issue: ImportIssue, extra: Partial<ImportResult> = {}): ImportResult {
  return {
    detection, transactions: [], instruments: [], rows: [], warnings: [], errors: [issue],
    stats: { ...emptyStats(), errors: 1 }, ...extra,
  };
}

async function importPdf(read: ReadResult, options: ImportOptions, detection: DetectionInfo, locale: Locale): Promise<ImportResult> {
  let doc;
  try {
    doc = await extractPdf(read.bytes!, options.pdfjs, options.pdfPassword);
  } catch (e) {
    if (e instanceof PdfPasswordError) {
      return failure(detection, makeIssue(locale, e.reason === 'required' ? 'PDF_PASSWORD_REQUIRED' : 'PDF_PASSWORD_INCORRECT', 'error'), { needsPassword: e.reason });
    }
    return failure(detection, makeIssue(locale, 'PDF_READ_ERROR', 'error', { detail: e instanceof Error ? e.message : String(e) }));
  }
  if (!doc.lines.length) return failure(detection, makeIssue(locale, 'PDF_NO_TEXT', 'error'));
  const table = pdfToTable(doc);
  const forced = options.presetId ? PDF_PARSERS.find((p) => p.id === options.presetId) : undefined;
  const scored = PDF_PARSERS.map((p) => ({ p, s: p.detect(doc) })).sort((a, b) => b.s - a.s)[0];
  const parser = forced ?? (scored && scored.s >= DETECT_THRESHOLD ? scored.p : undefined);
  const ctx = new ParseContext(table, options, parser?.id ?? 'pdf-table');
  if (parser) {
    detection.presetId = parser.id;
    detection.presetLabel = parser.label;
    detection.presetConfidence = parser.confidence;
    detection.score = forced ? 1 : scored!.s;
    const rows = parser.parse(doc, ctx);
    detection.numberFormat = ctx.numberFormat;
    detection.dateFormat = ctx.dateFormat;
    return finalizeRows(rows, ctx, `import:${parser.id}`, detection);
  }
  // Tabular statement: rebuild the table from the text columns and use the Colombian / generic mapper.
  const s = suggestMapping(table);
  if (extractoColombianoPreset.detect(table) > 0 || !s.missing.length) {
    const preset = extractoColombianoPreset.detect(table) > 0 ? extractoColombianoPreset : genericPreset;
    detection.presetId = `pdf-${preset.id}`;
    detection.presetLabel = `PDF (tabla) — ${preset.label}`;
    detection.presetConfidence = 'low';
    const rows = preset === genericPreset ? parseWithMapping(table, ctx, { ...s.mapping }) : preset.parse(table, ctx);
    ctx.fileIssues.push(ctx.issue('GENERIC_AUTO_MAPPING', 'warning'));
    detection.numberFormat = ctx.numberFormat;
    detection.dateFormat = ctx.dateFormat;
    const res = finalizeRows(rows, ctx, `import:pdf-${preset.id}`, detection);
    res.mappingSuggestion = s;
    return res;
  }
  return failure(detection, makeIssue(locale, 'FILE_PDF_UNSUPPORTED', 'error'));
}

/** Import a file (CSV/XLSX/XLS/HTML/PDF) into transactions + suggested instruments. */
export async function importFile(input: ImportInput, options: ImportOptions): Promise<ImportResult> {
  const locale: Locale = options.locale ?? 'es';
  const profile = getBrokerProfile(options.brokerProfile);
  if (profile) {
    options = {
      ...options,
      account: options.account ?? profile.defaults.account,
      defaultCurrency: options.defaultCurrency ?? profile.defaults.currency,
    };
  }
  const read = await readTables(input.data, input.fileName, options.encoding);
  const detection: DetectionInfo = {
    fileKind: read.kind, presetId: 'none', presetLabel: '', presetConfidence: 'low', score: 0,
  };
  if (read.encoding) detection.encoding = read.encoding;
  if (read.delimiter) detection.delimiter = read.delimiter;
  if (read.error) {
    return failure(detection, makeIssue(locale, read.error.code, 'error', read.error.detail ? { detail: read.error.detail } : undefined));
  }
  if (read.kind === 'pdf') return importPdf(read, options, detection, locale);
  if (read.kind === 'json') {
    const isBackup = /"format"\s*:\s*"portafolio-pro-backup"/.test(read.text ?? '');
    return failure(detection, makeIssue(locale, isBackup ? 'FILE_IS_BACKUP' : 'FILE_UNSUPPORTED', 'error'));
  }
  const tables = read.tables.filter((t) => t.rows.length > 0);
  if (!tables.length) return failure(detection, makeIssue(locale, 'FILE_EMPTY', 'error'));

  const forced = pickTable(tables, options.sheet);
  let preset: PresetDefinition | undefined;
  let table: RawTable | undefined;
  let score = 0;
  let autoGeneric = false;

  if (options.mapping) {
    preset = genericPreset;
    table = forced ?? tables[0];
    score = 1;
  } else if (options.presetId) {
    preset = getPreset(options.presetId);
    if (!preset) return failure(detection, makeIssue(locale, 'UNKNOWN_PRESET', 'error', { preset: options.presetId }));
    const scored = scoreTables(forced ? [forced] : tables, [preset])[0];
    table = forced ?? scored?.table ?? tables[0];
    score = scored?.score ?? 0;
  } else {
    const scored = scoreTables(forced ? [forced] : tables, PRESETS)[0];
    if (scored && scored.score >= DETECT_THRESHOLD) {
      preset = scored.preset;
      table = scored.table;
      score = scored.score;
    }
  }

  if (!preset || !table) {
    // Fallback: generic mapping guessed from headers on the most header-like table.
    const candidates = (forced ? [forced] : tables).map((t) => ({ t, s: suggestMapping(t) }));
    candidates.sort((a, b) => a.s.missing.length - b.s.missing.length || b.s.fields.length - a.s.fields.length);
    const best = candidates[0]!;
    detection.presetId = 'generic';
    detection.presetLabel = genericPreset.label;
    detection.presetConfidence = 'low';
    detection.sheet = best.t.name;
    if (best.s.missing.length) {
      return failure(detection, makeIssue(locale, 'NEEDS_MAPPING', 'error', { fields: best.s.missing.join(', ') }), {
        needsMapping: true,
        mappingSuggestion: best.s,
      });
    }
    preset = genericPreset;
    table = best.t;
    autoGeneric = true;
    const mapping = { ...best.s.mapping };
    if (profile?.defaults.exchange) mapping.defaultExchange = profile.defaults.exchange;
    if (profile?.defaults.currency) mapping.defaultCurrency = profile.defaults.currency;
    if (profile?.defaults.dateFormat && !options.dateFormat) mapping.dateFormat = profile.defaults.dateFormat;
    if (profile?.defaults.numberFormat && !options.numberFormat) mapping.numberFormat = profile.defaults.numberFormat;
    options = { ...options, mapping };
  }

  if (preset.multiSheet && !forced) {
    const all = tables.filter((t) => preset!.detect(t) > 0);
    if (all.length > 1) {
      table = { name: all.map((t) => t.name).join(' + '), rows: all.flatMap((t) => t.rows), lines: all.flatMap((t) => t.lines) };
    }
  }
  detection.presetId = preset.id;
  detection.presetLabel = preset.label;
  detection.presetConfidence = autoGeneric ? 'low' : preset.confidence;
  detection.score = score;
  detection.sheet = table.name;

  const ctx = new ParseContext(table, options, preset.id);
  if (read.delimiter) ctx.delimiter = read.delimiter;
  if (read.encoding === 'windows-1252') ctx.fileIssues.push(ctx.issue('ENCODING_LATIN1', 'info'));
  if (autoGeneric) ctx.fileIssues.push(ctx.issue('GENERIC_AUTO_MAPPING', 'warning'));
  const parsed = preset === genericPreset ? parseWithMapping(table, ctx, options.mapping!) : preset.parse(table, ctx);
  detection.numberFormat = ctx.numberFormat;
  detection.dateFormat = ctx.dateFormat;
  const result = finalizeRows(parsed, ctx, `import:${preset.id}`, detection);
  if (autoGeneric) result.mappingSuggestion = suggestMapping(table);
  return result;
}

/** Convenience wrapper for already-decoded CSV text. */
export function importText(text: string, options: ImportOptions, fileName?: string): Promise<ImportResult> {
  const input: ImportInput = { data: text };
  if (fileName) input.fileName = fileName;
  return importFile(input, options);
}

// ---------------------------------------------------------------------------
// Finalization
// ---------------------------------------------------------------------------

const POSITION_DELTA: Partial<Record<TransactionType, 1 | -1>> = {
  BUY: 1, TRANSFER_IN: 1, STOCK_DIVIDEND: 1, SELL: -1, TRANSFER_OUT: -1,
};

interface Work {
  row: ParsedRow;
  draft: DraftTransaction;
  instrumentId?: string;
  order: number;
  extra: boolean;
  invalid?: boolean;
  tx?: Transaction;
  status?: 'ok' | 'duplicate' | 'possible_duplicate';
  duplicateOf?: ImportRow['duplicateOf'];
}

/** Infer SPLIT / STOCK_DIVIDEND ratios from the running position (existing + imported transactions). */
function inferRatios(work: Work[], existing: Transaction[], ctx: ParseContext): void {
  if (!work.some((w) => w.draft.deltaShares !== undefined && w.draft.ratio === undefined)) return;
  type Ev = { date: string; order: number; kind: 'existing'; t: Transaction } | { date: string; order: number; kind: 'work'; w: Work };
  const events: Ev[] = [
    ...existing.map((t, i): Ev => ({ date: t.date, order: i - existing.length, kind: 'existing', t })),
    ...work.map((w): Ev => ({ date: w.draft.date, order: w.order, kind: 'work', w })),
  ];
  // Corporate actions apply after same-day trades.
  const rank = (e: Ev): number => {
    const type = e.kind === 'existing' ? e.t.type : e.w.draft.type;
    return type === 'SPLIT' || type === 'STOCK_DIVIDEND' ? 1 : 0;
  };
  events.sort((a, b) => a.date.localeCompare(b.date) || rank(a) - rank(b) || a.order - b.order);
  const pos = new Map<string, number>();
  for (const e of events) {
    const id = e.kind === 'existing' ? e.t.instrumentId : e.w.instrumentId;
    if (!id) continue;
    const p = pos.get(id) ?? 0;
    const type = e.kind === 'existing' ? e.t.type : e.w.draft.type;
    if (e.kind === 'work' && (type === 'SPLIT' || type === 'STOCK_DIVIDEND') && e.w.draft.ratio === undefined && e.w.draft.deltaShares !== undefined) {
      const d = e.w.draft;
      if (p > 0) {
        const after = p + d.deltaShares!;
        d.ratio = round(type === 'SPLIT' ? after / p : d.deltaShares! / p, 10);
        if (type === 'STOCK_DIVIDEND') d.quantity = Math.abs(d.deltaShares!);
        e.w.row.issues.push(ctx.issue('SPLIT_RATIO_INFERRED', 'info', { ratio: d.ratio, position: round(p, 6), after: round(after, 6) }, e.w.row.line));
        pos.set(id, after);
      } else {
        const sym = d.instrument?.symbol ?? id;
        if (type === 'STOCK_DIVIDEND' && d.deltaShares! > 0) {
          d.quantity = d.deltaShares!;
          pos.set(id, p + d.deltaShares!);
        } else {
          e.w.row.issues.push(ctx.issue('SPLIT_RATIO_UNKNOWN', 'error', { symbol: sym }, e.w.row.line));
          e.w.invalid = true;
        }
      }
      continue;
    }
    const t = e.kind === 'existing' ? e.t : undefined;
    const ratio = t ? t.ratio : e.kind === 'work' ? e.w.draft.ratio : undefined;
    const qty = t ? t.quantity : e.kind === 'work' ? e.w.draft.quantity : undefined;
    if (type === 'SPLIT' && ratio) pos.set(id, p * ratio);
    else if (type === 'STOCK_DIVIDEND' && !qty && ratio) pos.set(id, p * (1 + ratio));
    else if (POSITION_DELTA[type] && qty) pos.set(id, p + POSITION_DELTA[type]! * qty);
  }
}

/** Fill derived values and validate a draft; pushes errors to the row. Returns false when invalid. */
function validateDraft(w: Work, ctx: ParseContext): boolean {
  const d = w.draft;
  const row = w.row;
  const err = (code: string, params?: Record<string, string | number>): false => {
    row.issues.push(ctx.issue(code, 'error', params, row.line));
    return false;
  };
  if (!isCurrencyCode(d.currency)) return err('INVALID_CURRENCY', { value: d.currency || '∅' });
  const needsInstrument: TransactionType[] = ['BUY', 'SELL', 'SPLIT', 'STOCK_DIVIDEND', 'TRANSFER_IN', 'TRANSFER_OUT', 'RETURN_OF_CAPITAL'];
  if (needsInstrument.includes(d.type) && !w.instrumentId) return err('MISSING_INSTRUMENT');
  if (d.quantity !== undefined) d.quantity = Math.abs(d.quantity);
  if (d.price !== undefined) d.price = Math.abs(d.price);
  switch (d.type) {
    case 'BUY':
    case 'SELL': {
      if (!d.quantity) return err(d.quantity === 0 ? 'NON_POSITIVE' : 'MISSING_FIELD', { field: 'quantity' });
      if (d.price === undefined && d.amount !== undefined) d.price = round(Math.abs(d.amount) / d.quantity, 10);
      if (d.price === undefined) return err('MISSING_FIELD', { field: 'price' });
      if (d.amount === undefined) d.amount = round(d.quantity * d.price, 8);
      d.amount = Math.abs(d.amount);
      break;
    }
    case 'TRANSFER_IN':
    case 'TRANSFER_OUT':
      if (!d.quantity) return err('MISSING_FIELD', { field: 'quantity' });
      if (d.amount === undefined && d.price !== undefined) d.amount = round(d.quantity * d.price, 8);
      break;
    case 'DIVIDEND':
    case 'INTEREST':
      // Negative = reversal of a previous payment (kept signed on purpose).
      if (d.amount === undefined && d.quantity !== undefined && d.price !== undefined) d.amount = round(d.quantity * d.price, 8);
      if (d.amount === undefined) return err('MISSING_FIELD', { field: 'amount' });
      if (d.amount === 0) return err('NON_POSITIVE', { field: 'amount' });
      break;
    case 'RETURN_OF_CAPITAL':
    case 'DEPOSIT':
    case 'WITHDRAWAL':
      if (d.amount === undefined && d.quantity !== undefined && d.price !== undefined) d.amount = round(d.quantity * d.price, 8);
      if (d.amount === undefined) return err('MISSING_FIELD', { field: 'amount' });
      d.amount = Math.abs(d.amount);
      if (d.amount === 0) return err('NON_POSITIVE', { field: 'amount' });
      break;
    case 'FEE':
    case 'TAX':
      if (d.amount === undefined) return err('MISSING_FIELD', { field: 'amount' });
      break;
    case 'SPLIT':
      break; // ratio checked after inference
    case 'STOCK_DIVIDEND':
      if (!d.ratio && !d.quantity && d.deltaShares === undefined) return err('MISSING_FIELD', { field: 'quantity' });
      break;
    case 'FX_CONVERSION':
      if (d.amount === undefined) return err('MISSING_FIELD', { field: 'amount' });
      if (!d.toCurrency || !isCurrencyCode(d.toCurrency)) return err('MISSING_FIELD', { field: 'toCurrency' });
      if (d.toAmount === undefined) return err('MISSING_FIELD', { field: 'toAmount' });
      d.amount = Math.abs(d.amount);
      d.toAmount = Math.abs(d.toAmount);
      break;
  }
  return true;
}

function num(n: number | undefined, decimals: number): string {
  return n === undefined ? '' : String(round(n, decimals));
}

// --- semantic duplicate index (I7 / I14) ------------------------------------

interface DupEntry {
  day: number;
  tx: Transaction;
  inFile: boolean;
  line?: number;
  brokerRef?: string;
  /** Existing transaction already matched by an imported row. */
  used?: boolean;
}

const ACCOUNT_NOISE = /\b(cctvm|ctvm|dtvm|s a|sa|s a s|sas|ltda|corretora|corredores|comisionista|de|do|da|del|y|e|valores|investimentos|investimento|invest|banco|bank|llc|inc|plc|grupo|the)\b/g;

/** Same institution under different spellings (after noise removal, first word). */
const INSTITUTION_ALIASES: Record<string, string> = {
  interactive: 'ibkr', ib: 'ibkr', ibkr: 'ibkr',
  nubank: 'nu', nuinvest: 'nu', easynvest: 'nu',
  charles: 'schwab', schwab: 'schwab',
  t212: 'trading212', trading: 'trading212', trading212: 'trading212',
  modalmais: 'modal', btgpactual: 'btg', itau: 'itau', itaú: 'itau', ion: 'itau',
};

/** Broker account numbers that identify ONE account (IBKR U1234567 / DU1234567 paper / F-prefixed FA). */
const ACCOUNT_NUMBER_RE = /\b(D?U\d{5,10}|F\d{6,10})\b/i;

/** The broker account number inside an account label ("U1234567", "IBKR U1234567"), upper-cased. */
export function accountNumber(account: string | undefined): string | undefined {
  const m = account ? ACCOUNT_NUMBER_RE.exec(account) : null;
  return m ? m[1]!.toUpperCase() : undefined;
}

/** Normalized institution key: "XP INVESTIMENTOS CCTVM S/A" and "XP" → "xp"; "NU INVEST CORRETORA" → "nu"; "U1234567" → "ibkr". */
export function accountKey(account: string | undefined): string | undefined {
  if (!account) return undefined;
  if (accountNumber(account)) return 'ibkr';
  const n = normalizeText(account);
  const k = n.replace(ACCOUNT_NOISE, ' ').replace(/\s+/g, ' ').trim();
  const first = (k || n).split(' ')[0]!;
  return INSTITUTION_ALIASES[first] ?? first;
}

/**
 * Accounts are compatible when either is unknown, or both are the same institution and they do not
 * carry two different account numbers ("U1111111" vs "U2222222" are two IBKR accounts; "IBKR" is
 * compatible with both).
 */
export function accountsCompatible(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return true;
  if (accountKey(a) !== accountKey(b)) return false;
  const na = accountNumber(a);
  const nb = accountNumber(b);
  return !na || !nb || na === nb;
}

const near = (a: number | undefined, b: number | undefined, rel: number, absTol: number) =>
  a === undefined || b === undefined ? a === b : Math.abs(a - b) <= Math.max(absTol, rel * Math.max(Math.abs(a), Math.abs(b)));

function sameEconomics(a: Transaction, b: Transaction): boolean {
  switch (a.type) {
    case 'BUY':
    case 'SELL':
    case 'TRANSFER_IN':
    case 'TRANSFER_OUT':
      return near(a.quantity, b.quantity, 1e-6, 1e-9) && (a.price === undefined || b.price === undefined || near(a.price, b.price, 0.005, 1e-9));
    case 'SPLIT':
      return near(a.ratio, b.ratio, 1e-6, 1e-9);
    case 'STOCK_DIVIDEND':
      return near(a.quantity, b.quantity, 1e-6, 1e-9);
    case 'FX_CONVERSION':
      return a.toCurrency === b.toCurrency && near(a.amount, b.amount, 0.005, 0.01) && near(a.toAmount, b.toAmount, 0.005, 0.01);
    default:
      return near(a.amount, b.amount, 0.005, 0.01);
  }
}

class DupIndex {
  private readonly map = new Map<string, Map<number, DupEntry[]>>();
  static key(t: Transaction): string {
    return `${t.type}|${t.instrumentId ?? ''}|${t.currency}`;
  }
  add(e: DupEntry): void {
    const k = DupIndex.key(e.tx);
    let byDay = this.map.get(k);
    if (!byDay) this.map.set(k, (byDay = new Map()));
    const list = byDay.get(e.day);
    if (list) list.push(e);
    else byDay.set(e.day, [e]);
  }
  find(tx: Transaction, day: number, cal: CalendarId, maxBusinessDays: number, accept: (e: DupEntry) => boolean): DupEntry | undefined {
    const byDay = this.map.get(DupIndex.key(tx));
    if (!byDay) return undefined;
    const span = maxBusinessDays === 0 ? 0 : maxBusinessDays + 4; // calendar-day window covering weekends/holidays
    for (let d = day - span; d <= day + span; d++) {
      const list = byDay.get(d);
      if (!list) continue;
      if (d !== day && Math.abs(businessDaysBetween(d, day, cal)) > maxBusinessDays) continue;
      for (const e of list) if (accept(e) && sameEconomics(e.tx, tx)) return e;
    }
    return undefined;
  }
}

function accepted(opts: ImportOptions, line: number, inFile: boolean): boolean {
  const a = opts.acceptDuplicates;
  if (!a || a === 'none') return false;
  if (a === 'all') return true;
  if (a === 'in-file') return inFile;
  return a.includes(line);
}

/** Positions (quantity) and cash per currency implied by transactions up to a date. */
export function computeBalances(transactions: Transaction[], asOf?: string): { positions: Map<string, number>; cash: Map<string, number> } {
  const positions = new Map<string, number>();
  const cash = new Map<string, number>();
  const add = (m: Map<string, number>, k: string, v: number) => m.set(k, (m.get(k) ?? 0) + v);
  const sorted = [...transactions].filter((t) => !asOf || t.date <= asOf).sort((a, b) => a.date.localeCompare(b.date));
  for (const t of sorted) {
    const amt = t.amount ?? (t.quantity ?? 0) * (t.price ?? 0);
    const fees = t.fees ?? 0;
    const taxes = t.taxes ?? 0;
    if (t.instrumentId) {
      const p = positions.get(t.instrumentId) ?? 0;
      if (t.type === 'SPLIT' && t.ratio) positions.set(t.instrumentId, p * t.ratio);
      else if (t.type === 'STOCK_DIVIDEND') positions.set(t.instrumentId, p + (t.quantity ?? p * (t.ratio ?? 0)));
      else if (POSITION_DELTA[t.type] && t.quantity) positions.set(t.instrumentId, p + POSITION_DELTA[t.type]! * t.quantity);
    }
    switch (t.type) {
      case 'BUY': add(cash, t.currency, -(amt + fees + taxes)); break;
      case 'SELL': add(cash, t.currency, amt - fees - taxes); break;
      case 'DIVIDEND': case 'INTEREST': case 'RETURN_OF_CAPITAL': add(cash, t.currency, amt - taxes - fees); break;
      case 'DEPOSIT': add(cash, t.currency, amt - fees); break;
      case 'WITHDRAWAL': add(cash, t.currency, -amt - fees); break;
      case 'FEE': case 'TAX': add(cash, t.currency, -amt); break;
      case 'FX_CONVERSION':
        add(cash, t.currency, -amt - fees);
        if (t.toCurrency) add(cash, t.toCurrency, t.toAmount ?? 0);
        break;
      default: break;
    }
  }
  return { positions, cash };
}

/** Resolve, validate, hash, de-duplicate and assemble the result. */
export function finalizeRows(parsed: ParsedRow[], ctx: ParseContext, source: string, detection: DetectionInfo): ImportResult {
  const opts = ctx.options;
  const existingTx = opts.existingTransactions ?? [];
  const resolver = new InstrumentResolver(opts.existingInstruments ?? [], {
    defaultUsExchange: opts.defaultUsExchange, catalog: opts.catalog, securityMap: opts.securityMap,
  });
  const instrumentsById = new Map<string, Instrument>((opts.existingInstruments ?? []).map((i) => [i.id, i]));
  const instrumentUpdates: NonNullable<ImportResult['instrumentUpdates']> = [];
  const work: Work[] = [];
  let order = 0;
  for (const row of parsed) {
    if (row.skipped || row.issues.some((i) => i.severity === 'error')) continue;
    const drafts = [row.draft, ...(row.extra ?? [])].filter((d): d is DraftTransaction => !!d);
    drafts.forEach((draft, k) => {
      const w: Work = { row, draft, order: order++, extra: k > 0 };
      if (draft.instrument) {
        const res = resolver.resolve(draft.instrument);
        if (res && 'error' in res) {
          row.issues.push(ctx.issue(res.error.code, 'error', res.error.params, row.line));
          if (res.error.code === 'EXCHANGE_REQUIRED') ctx.askSecurity(String(res.error.params.symbol), row.line, res.suggestions ?? []);
          w.invalid = true;
        } else if (res) {
          w.instrumentId = res.instrument.id;
          instrumentsById.set(res.instrument.id, res.instrument);
          for (const n of res.notes) row.issues.push(ctx.issue(n.code, n.code === 'SYMBOL_FROM_ISIN' ? 'warning' : 'info', n.params, row.line));
          if (res.update && !instrumentUpdates.some((u) => u.id === res.update!.id)) instrumentUpdates.push(res.update);
          const inst = res.instrument;
          if (!draft.currency) draft.currency = inst.currency;
          // Trade currency must match the instrument's (except deliberate foreign listings such as MGC).
          if (!res.foreignListing && draft.currency !== inst.currency && ['BUY', 'SELL', 'TRANSFER_IN', 'TRANSFER_OUT'].includes(draft.type)) {
            row.issues.push(ctx.issue('CURRENCY_MISMATCH', 'warning', { currency: draft.currency, instrumentCurrency: inst.currency }, row.line));
          }
        }
      }
      if (!draft.currency) draft.currency = opts.defaultCurrency ?? exchangeCurrency(draft.instrument?.exchange) ?? '';
      if (!w.invalid && !validateDraft(w, ctx)) w.invalid = true;
      work.push(w);
    });
  }

  // Hashes + exact duplicates.
  const existingHashes = new Set(existingTx.map((t) => t.importHash).filter((h): h is string => !!h));
  const occurrences = new Map<string, number>();
  let txIndex = 0;
  for (const w of work) {
    if (w.invalid) continue;
    const d = w.draft;
    const keyBase = d.brokerRef
      ? [source, 'ref', d.brokerRef, d.type, d.date, w.instrumentId ?? '', w.extra ? 'x' : ''].join('|')
      : [
          source, d.date, d.type, w.instrumentId ?? '', num(d.quantity, 6), num(d.price, 6), num(d.amount, 4),
          d.currency, d.toCurrency ?? '', num(d.toAmount, 4), num(d.ratio, 8),
        ].join('|');
    const occ = (occurrences.get(keyBase) ?? 0) + 1;
    occurrences.set(keyBase, occ);
    const importHash = hashString(`${keyBase}#${occ}`);
    const tx: Transaction = {
      id: opts.idFactory ? opts.idFactory(importHash, txIndex++) : `imp-${importHash}`,
      portfolioId: opts.portfolioId,
      date: d.date,
      type: d.type,
      currency: d.currency,
    };
    const account = d.account ?? opts.account;
    if (account) tx.account = account;
    if (w.instrumentId) tx.instrumentId = w.instrumentId;
    if (d.quantity !== undefined) tx.quantity = d.quantity;
    if (d.price !== undefined) tx.price = d.price;
    if (d.amount !== undefined) tx.amount = d.amount;
    if (d.fees) tx.fees = round(d.fees, 8);
    if (d.taxes) tx.taxes = round(d.taxes, 8);
    if (d.ratio !== undefined) tx.ratio = d.ratio;
    if (d.toCurrency) tx.toCurrency = d.toCurrency;
    if (d.toAmount !== undefined) tx.toAmount = d.toAmount;
    if (d.fxRateToBase !== undefined) tx.fxRateToBase = d.fxRateToBase;
    if (d.note) tx.note = d.note;
    tx.source = source;
    tx.importHash = importHash;
    w.tx = tx;
    if (existingHashes.has(importHash)) {
      w.status = 'duplicate';
      w.row.issues.push(ctx.issue('DUPLICATE', 'info', undefined, w.row.line));
    }
  }

  // Semantic duplicates (I7/I21). Against existing transactions of a compatible account/institution:
  // other sources ±3 business days, same source same day. Each existing transaction can absorb at most
  // one imported row (exact-hash duplicates consume theirs first), so legitimate repeats are kept.
  // Identical rows inside the same file are legitimate (partial fills, separate GMF charges): they are
  // only flagged, never blocked.
  const index = new DupIndex();
  const byHash = new Map<string, DupEntry[]>();
  for (const t of existingTx) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(t.date)) continue;
    const e: DupEntry = { day: dayNumber(t.date), tx: t, inFile: false };
    index.add(e);
    if (t.importHash) byHash.set(t.importHash, [...(byHash.get(t.importHash) ?? []), e]);
  }
  for (const w of work) {
    if (w.status === 'duplicate' && w.tx?.importHash) {
      const e = byHash.get(w.tx.importHash)?.find((x) => !x.used);
      if (e) e.used = true;
    }
  }
  const strictSources = /^import:(generic|portafolio-pro|extracto-co|pdf-)/;
  for (const w of work) {
    if (!w.tx || w.status === 'duplicate' || w.draft.noDuplicateCheck) continue;
    const tx = w.tx;
    const day = dayNumber(tx.date);
    const cal = calendarFor(tx.instrumentId, tx.currency);
    const ref = w.draft.brokerRef;
    const compatible = (e: DupEntry) => accountsCompatible(e.tx.account, tx.account);
    const hit =
      index.find(tx, day, cal, 3, (e) => !e.inFile && !e.used && compatible(e) && e.tx.source !== tx.source) ??
      index.find(tx, day, cal, 0, (e) => !e.inFile && !e.used && compatible(e) && e.tx.source === tx.source && !ref);
    if (hit) {
      hit.used = true;
      w.duplicateOf = { date: hit.tx.date, inFile: false, transactionId: hit.tx.id, ...(hit.tx.source ? { source: hit.tx.source } : {}) };
      const ok = accepted(opts, w.row.line, false);
      w.row.issues.push(ctx.issue('POSSIBLE_DUPLICATE', ok ? 'info' : 'warning', { date: hit.tx.date, source: hit.tx.source ?? 'manual' }, w.row.line));
      if (!ok) w.status = 'possible_duplicate';
    } else {
      const twin = index.find(tx, day, cal, 0, (e) => e.inFile && compatible(e) && !(ref && e.brokerRef && ref !== e.brokerRef));
      if (twin) {
        // Flag only: brokers list one execution per row; user files may contain real repeats.
        w.row.issues.push(ctx.issue('POSSIBLE_DUPLICATE_IN_FILE', strictSources.test(tx.source ?? '') ? 'warning' : 'info', { line: twin.line ?? 0 }, w.row.line));
      }
    }
    const entry: DupEntry = { day, tx, inFile: true, line: w.row.line };
    if (ref) entry.brokerRef = ref;
    index.add(entry);
  }

  // Ratio inference excludes rows that are (possibly) already in the portfolio.
  inferRatios(work.filter((w) => !w.invalid && !w.status), existingTx, ctx);
  for (const w of work) {
    if (w.invalid || !w.tx) continue;
    if (w.draft.type === 'SPLIT' && !w.draft.ratio) {
      if (!w.row.issues.some((i) => i.code === 'SPLIT_RATIO_UNKNOWN')) w.row.issues.push(ctx.issue('MISSING_FIELD', 'error', { field: 'ratio' }, w.row.line));
      w.invalid = true;
      continue;
    }
    if (w.draft.ratio !== undefined) w.tx.ratio = w.draft.ratio;
    if (w.draft.quantity !== undefined) w.tx.quantity = w.draft.quantity;
    if (!w.status) w.status = 'ok';
  }

  const pending = ctx.confirmations.some((c) => (c.scope ?? 'file') === 'file');
  const stats = emptyStats();
  const currencies = new Set<string>();
  const transactions: Transaction[] = [];
  const outRows: ImportRow[] = [];
  const byRow = new Map<ParsedRow, Work[]>();
  for (const w of work) byRow.set(w.row, [...(byRow.get(w.row) ?? []), w]);
  for (const row of parsed) {
    const ws = byRow.get(row) ?? [];
    const hasError = row.issues.some((i) => i.severity === 'error') || ws.some((w) => w.invalid);
    const main = ws.find((w) => !w.extra);
    let status: ImportRow['status'];
    if (hasError) status = 'error';
    else if (row.skipped || !ws.length) status = 'skipped';
    else if (main?.status === 'duplicate') status = 'duplicate';
    else if (main?.status === 'possible_duplicate') status = 'possible_duplicate';
    else status = pending || row.pending ? 'pending' : 'ok';
    if (status === 'ok' && pending) status = 'pending';
    const out: ImportRow = { line: row.line, status, issues: row.issues };
    if (row.sheet) out.sheet = row.sheet;
    if (row.raw) out.raw = row.raw;
    if (main?.tx && status !== 'error') out.transaction = main.tx;
    const extras = ws.filter((w) => w.extra && w.tx).map((w) => w.tx!);
    if (extras.length && status !== 'error') out.extraTransactions = extras;
    if (main?.duplicateOf) out.duplicateOf = main.duplicateOf;
    outRows.push(out);
    stats.totalRows++;
    if (status === 'ok') {
      for (const tx of [out.transaction, ...extras].filter((t): t is Transaction => !!t)) {
        transactions.push(tx);
        stats.byType[tx.type] = (stats.byType[tx.type] ?? 0) + 1;
        currencies.add(tx.currency);
        if (!stats.firstDate || tx.date < stats.firstDate) stats.firstDate = tx.date;
        if (!stats.lastDate || tx.date > stats.lastDate) stats.lastDate = tx.date;
      }
      stats.imported++;
    } else if (status === 'duplicate') stats.duplicates++;
    else if (status === 'possible_duplicate') stats.possibleDuplicates++;
    else if (status === 'pending') stats.pending++;
    else if (status === 'skipped') stats.skipped++;
    else stats.errors++;
  }
  stats.currencies = [...currencies].sort();

  const reconciliation = ctx.reported ? reconcileBestFit(ctx, resolver, existingTx, source, transactions) : undefined;
  const allIssues = [...ctx.fileIssues, ...parsed.flatMap((r) => r.issues)];
  const errors = allIssues.filter((i) => i.severity === 'error');
  const warnings = allIssues.filter((i) => i.severity !== 'error');
  stats.warnings = allIssues.filter((i) => i.severity === 'warning').length;

  const used = new Set(
    work.filter((w) => w.tx && (w.status === 'ok' || (pending && !w.invalid))).map((w) => w.tx!.instrumentId).filter(Boolean),
  );
  const instruments = resolver.newInstruments().filter((i) => used.has(i.id));
  stats.newInstruments = instruments.length;
  stats.matchedInstruments = resolver.matchedCount();

  const result: ImportResult = { detection, transactions: pending ? [] : transactions, instruments, rows: outRows, warnings, errors, stats };
  if (ctx.confirmations.length) {
    result.needsConfirmation = ctx.confirmations;
    const dc = ctx.confirmations.find((c) => c.kind === 'dateFormat');
    const nc = ctx.confirmations.find((c) => c.kind === 'numberFormat');
    if (dc) result.dateFormatCandidates = dc.candidates as ImportResult['dateFormatCandidates'];
    if (nc) result.numberFormatCandidates = nc.candidates as ImportResult['numberFormatCandidates'];
  }
  if (instrumentUpdates.length) result.instrumentUpdates = instrumentUpdates;
  if (ctx.corporateActions.length) result.corporateActions = ctx.corporateActions;
  if (ctx.unknownSecurities.length) result.unknownSecurities = ctx.unknownSecurities;
  if (reconciliation) result.reconciliation = reconciliation;
  return result;
}

/** Source family: statements of one broker reconcile against every import of that broker. */
function sourceFamily(source: string | undefined): string | undefined {
  if (!source) return undefined;
  if (source.startsWith('import:ibkr')) return 'ibkr';
  if (/^import:(b3-|nota-)/.test(source)) return 'b3';
  if (source.startsWith('import:degiro')) return 'degiro';
  return source;
}

/**
 * Existing transactions that belong to the statement's account (I20/I20b):
 *  - statements that report account numbers (IBKR U1234567) only take transactions of that account
 *    (or labelled with the bare institution);
 *  - otherwise the user's account option, then the statement's institution;
 *  - transactions without any account are "unassigned" when they come from the same broker family:
 *    the caller decides with them or without them (best fit) and says so.
 */
function sameAccount(existing: Transaction[], source: string, ctx: ParseContext): { assigned: Transaction[]; unassigned: Transaction[] } {
  const acct = ctx.options.account;
  const ids = ctx.reported?.accountIds ?? [];
  const numbered = ids.filter((a) => accountNumber(a));
  const fam = sourceFamily(source);
  const assigned: Transaction[] = [];
  const unassigned: Transaction[] = [];
  for (const t of existing) {
    if (t.account) {
      let ok: boolean;
      if (numbered.length) ok = numbered.some((a) => accountsCompatible(a, t.account));
      else if (acct) ok = accountsCompatible(t.account, acct);
      else if (ids.length) ok = ids.some((a) => accountsCompatible(a, t.account));
      else ok = sourceFamily(t.source) === fam;
      if (ok) assigned.push(t);
    } else if (sourceFamily(t.source) === fam) unassigned.push(t);
  }
  return { assigned, unassigned };
}

/** Reconcile with or without the family's unassigned transactions, whichever explains the statement better. */
function reconcileBestFit(ctx: ParseContext, resolver: InstrumentResolver, existing: Transaction[], source: string, imported: Transaction[]): Reconciliation {
  const { assigned, unassigned } = sameAccount(existing, source, ctx);
  const withU = reconcile(ctx, resolver, [...assigned, ...unassigned, ...imported]);
  let rec = withU;
  if (unassigned.length) {
    const without = reconcile(ctx, resolver, [...assigned, ...imported]);
    const n = (r: Reconciliation) => r.positionDifferences.length + r.cashDifferences.length;
    if (n(without) < n(withU)) {
      rec = without;
      ctx.fileIssues.push(ctx.issue('RECONCILIATION_UNASSIGNED', 'info', { count: unassigned.length }));
    }
  }
  if (rec.positionDifferences.length || rec.cashDifferences.length) {
    ctx.fileIssues.push(ctx.issue('RECONCILIATION_DIFF', 'warning', { count: rec.positionDifferences.length + rec.cashDifferences.length }));
  }
  return rec;
}

function reconcile(ctx: ParseContext, resolver: InstrumentResolver, all: Transaction[]): Reconciliation {
  const rep = ctx.reported!;
  const { positions, cash } = computeBalances(all, rep.asOf);
  const rec: Reconciliation = { source: rep.source, positions: [], cash: rep.cash, positionDifferences: [], cashDifferences: [] };
  if (rep.asOf) rec.asOf = rep.asOf;
  for (const p of rep.positions) {
    const { hint, ...pos } = p;
    let id = pos.instrumentId;
    if (!id && hint) {
      const r = resolver.resolve(hint);
      if (r && !('error' in r)) id = r.instrument.id;
    }
    if (id) pos.instrumentId = id;
    rec.positions.push(pos);
    if (!id) continue;
    const computed = positions.get(id) ?? 0;
    if (Math.abs(computed - pos.quantity) > 1e-6) {
      rec.positionDifferences.push({ instrumentId: id, symbol: pos.symbol, reported: pos.quantity, computed: round(computed, 8), difference: round(pos.quantity - computed, 8) });
    }
  }
  for (const [id, q] of positions) {
    if (Math.abs(q) > 1e-6 && !rec.positions.some((p) => p.instrumentId === id) && rep.positions.length) {
      rec.positionDifferences.push({ instrumentId: id, symbol: id.split(':').pop() ?? id, reported: 0, computed: round(q, 8), difference: round(-q, 8) });
    }
  }
  for (const c of rep.cash) {
    const computed = round(cash.get(c.currency) ?? 0, 6);
    if (Math.abs(computed - c.amount) > 0.01) rec.cashDifferences.push({ currency: c.currency, reported: c.amount, computed, difference: round(c.amount - computed, 6) });
  }
  return rec;
}
