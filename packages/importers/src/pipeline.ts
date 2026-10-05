/**
 * Import pipeline: read file → pick table + preset (header signatures) → parse rows → resolve
 * instruments → infer split ratios → validate → hash → de-duplicate → result with per-row preview.
 */
import type { Instrument, Transaction, TransactionType } from '@pm/core';
import { makeIssue } from './i18n';
import { InstrumentResolver } from './instruments';
import { suggestMapping } from './mapping';
import { exchangeCurrency } from './markets';
import { ParseContext, type PresetDefinition } from './presets/common';
import { PRESETS, getPreset } from './presets/registry';
import { genericPreset, parseWithMapping } from './presets/generic';
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
} from './types';
import { hashString, isCurrencyCode, round } from './util';

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
    newInstruments: 0, matchedInstruments: 0,
  };
}

function failure(detection: DetectionInfo, issue: ImportIssue, extra: Partial<ImportResult> = {}): ImportResult {
  return {
    detection, transactions: [], instruments: [], rows: [], warnings: [], errors: [issue],
    stats: { ...emptyStats(), errors: 1 }, ...extra,
  };
}

/** Import a file (CSV/XLSX/HTML table) into transactions + suggested instruments. */
export async function importFile(input: ImportInput, options: ImportOptions): Promise<ImportResult> {
  const locale: Locale = options.locale ?? 'es';
  const read = await readTables(input.data, input.fileName, options.encoding);
  const detection: DetectionInfo = {
    fileKind: read.kind, presetId: 'none', presetLabel: '', presetConfidence: 'low', score: 0,
  };
  if (read.encoding) detection.encoding = read.encoding;
  if (read.delimiter) detection.delimiter = read.delimiter;
  if (read.error) {
    return failure(detection, makeIssue(locale, read.error.code, 'error', read.error.detail ? { detail: read.error.detail } : undefined));
  }
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
    options = { ...options, mapping: best.s.mapping };
  }

  detection.presetId = preset.id;
  detection.presetLabel = preset.label;
  detection.presetConfidence = autoGeneric ? 'low' : preset.confidence;
  detection.score = score;
  detection.sheet = table.name;

  const ctx = new ParseContext(table, options, preset.id);
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
      if (!d.ratio) return row.issues.some((i) => i.code === 'SPLIT_RATIO_UNKNOWN') ? false : err('MISSING_FIELD', { field: 'ratio' });
      break;
    case 'STOCK_DIVIDEND':
      if (!d.ratio && !d.quantity) return err('MISSING_FIELD', { field: 'quantity' });
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

/** Resolve, validate, hash, de-duplicate and assemble the result. Exported for presets' unit tests. */
export function finalizeRows(parsed: ParsedRow[], ctx: ParseContext, source: string, detection: DetectionInfo): ImportResult {
  const opts = ctx.options;
  const resolver = new InstrumentResolver(opts.existingInstruments ?? [], { defaultUsExchange: opts.defaultUsExchange });
  const instrumentsById = new Map<string, Instrument>((opts.existingInstruments ?? []).map((i) => [i.id, i]));
  const work: Work[] = [];
  parsed.forEach((row, order) => {
    if (!row.draft || row.skipped || row.issues.some((i) => i.severity === 'error')) return;
    const w: Work = { row, draft: row.draft, order };
    if (row.draft.instrument) {
      const res = resolver.resolve(row.draft.instrument);
      if (res) {
        w.instrumentId = res.instrument.id;
        instrumentsById.set(res.instrument.id, res.instrument);
        for (const n of res.notes) {
          const sev = n.code === 'EXCHANGE_GUESSED' ? 'info' : 'warning';
          row.issues.push(ctx.issue(n.code, sev, n.params, row.line));
        }
      }
    }
    // Rows without currency take the instrument's (or the default) currency.
    if (!row.draft.currency) {
      const inst = w.instrumentId ? instrumentsById.get(w.instrumentId) : undefined;
      row.draft.currency = inst?.currency ?? opts.defaultCurrency ?? exchangeCurrency(row.draft.instrument?.exchange) ?? '';
    }
    work.push(w);
  });

  inferRatios(work, opts.existingTransactions ?? [], ctx);

  const existingHashes = new Set((opts.existingTransactions ?? []).map((t) => t.importHash).filter((h): h is string => !!h));
  const occurrences = new Map<string, number>();
  const outRows: ImportRow[] = [];
  const transactions: Transaction[] = [];
  const valid = new Map<ParsedRow, Transaction>();
  const duplicates = new Set<ParsedRow>();
  let txIndex = 0;

  for (const w of work) {
    if (!validateDraft(w, ctx)) continue;
    const d = w.draft;
    const keyBase = d.brokerRef
      ? [source, 'ref', d.brokerRef, d.type, d.date, w.instrumentId ?? ''].join('|')
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
    valid.set(w.row, tx);
    if (existingHashes.has(importHash)) {
      duplicates.add(w.row);
      w.row.issues.push(ctx.issue('DUPLICATE', 'info', undefined, w.row.line));
    }
  }

  // Possible duplicates: same instrument/type/quantity within ±3 days from a different source.
  const existing = (opts.existingTransactions ?? []).filter((t) => t.instrumentId && (t.type === 'BUY' || t.type === 'SELL' || t.type === 'DIVIDEND'));
  if (existing.length) {
    const byInst = new Map<string, Transaction[]>();
    for (const t of existing) byInst.set(t.instrumentId!, [...(byInst.get(t.instrumentId!) ?? []), t]);
    for (const [row, tx] of valid) {
      if (duplicates.has(row) || !tx.instrumentId) continue;
      const cands = byInst.get(tx.instrumentId) ?? [];
      const hit = cands.find((e) => {
        if (e.type !== tx.type || e.importHash === tx.importHash) return false;
        const days = Math.abs(Date.parse(e.date) - Date.parse(tx.date)) / 86400000;
        if (tx.type === 'DIVIDEND') return days <= 3 && Math.abs((e.amount ?? 0) - (tx.amount ?? 0)) <= 0.01 * Math.max(1, tx.amount ?? 0);
        return days <= 3 && Math.abs((e.quantity ?? 0) - (tx.quantity ?? 0)) < 1e-9 && (e.source !== tx.source || days === 0);
      });
      if (hit) row.issues.push(ctx.issue('POSSIBLE_DUPLICATE', 'warning', { date: hit.date, source: hit.source ?? 'manual' }, row.line));
    }
  }

  const stats = emptyStats();
  const currencies = new Set<string>();
  for (const row of parsed) {
    const tx = valid.get(row);
    const hasError = row.issues.some((i) => i.severity === 'error');
    let status: ImportRow['status'];
    if (hasError) status = 'error';
    else if (row.skipped || !row.draft) status = 'skipped';
    else if (!tx) status = 'error';
    else if (duplicates.has(row)) status = 'duplicate';
    else status = 'ok';
    const out: ImportRow = { line: row.line, status, issues: row.issues };
    if (row.sheet) out.sheet = row.sheet;
    if (row.raw) out.raw = row.raw;
    if (tx && status !== 'error') out.transaction = tx;
    outRows.push(out);
    stats.totalRows++;
    if (status === 'ok' && tx) {
      transactions.push(tx);
      stats.imported++;
      stats.byType[tx.type] = (stats.byType[tx.type] ?? 0) + 1;
      currencies.add(tx.currency);
      if (!stats.firstDate || tx.date < stats.firstDate) stats.firstDate = tx.date;
      if (!stats.lastDate || tx.date > stats.lastDate) stats.lastDate = tx.date;
    } else if (status === 'duplicate') stats.duplicates++;
    else if (status === 'skipped') stats.skipped++;
    else stats.errors++;
  }
  stats.currencies = [...currencies].sort();

  const allIssues = [...ctx.fileIssues, ...parsed.flatMap((r) => r.issues)];
  const errors = allIssues.filter((i) => i.severity === 'error');
  const warnings = allIssues.filter((i) => i.severity !== 'error');
  stats.warnings = allIssues.filter((i) => i.severity === 'warning').length;

  // Only suggest instruments actually used by importable transactions.
  const used = new Set(transactions.map((t) => t.instrumentId).filter(Boolean));
  const instruments = resolver.newInstruments().filter((i) => used.has(i.id));
  stats.newInstruments = instruments.length;
  stats.matchedInstruments = resolver.matchedCount();

  return { detection, transactions, instruments, rows: outRows, warnings, errors, stats };
}
