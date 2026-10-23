/**
 * Adapter over @pm/importers: runs detection/import with the local portfolio context
 * (existing transactions for de-duplication and known instruments for matching).
 */
import {
  listBrokerProfiles,
  canonicalTemplateCsv,
  exportTransactionsCsv,
  importEmail,
  importFile,
  normalizeBrokerName,
  sameBroker,
  inspectFile,
  type EmailImportResult,
  type ImportOptions,
  listPresets,
  type ColumnMapping,
  type CorporateActionSuggestion,
  type DateFormat,
  type NumberFormat,
  type FileInspection,
  type ImportResult,
  type Locale,
  type MappingField,
  type PresetInfo,
} from '@pm/importers';
import type { Instrument, Transaction } from '@pm/core';
import { db } from '../db/schema';
import { bulkAddTransactions, upsertInstruments } from '../db/repo';
import { newId } from '../lib/ids';
import { isNoteName } from '../lib/noteNames';
import { searchInstruments } from './marketData';

export type { ColumnMapping, CorporateActionSuggestion, DateFormat, FileInspection, ImportResult, MappingField, NumberFormat, PresetInfo };
export { canonicalTemplateCsv, exportTransactionsCsv, listBrokerProfiles, listPresets };
export type BrokerProfileInfo = ReturnType<typeof listBrokerProfiles>[number];

/** User answers collected by the review step and fed back into a re-run of the import. */
export interface ImportAnswers {
  dateFormat?: DateFormat;
  numberFormat?: NumberFormat;
  /** Line numbers of possible duplicates the user accepted. */
  acceptDuplicates?: number[];
  /** Unknown security spec / ticker → instrument id or MIC. */
  securityMap?: Record<string, string>;
  /** Importers R4: corporate-action proposals accepted with one click, and the answers they need. */
  acceptCorporateActions?: number[];
  corporateActionAnswers?: Record<number, { costFraction?: number; ratio?: number }>;
  /** Importers R5: broker notes released from review by the user (their pending rows import). */
  acceptNotes?: string[];
}

export interface ImportRequest {
  file: File;
  portfolioId: string;
  account?: string;
  presetId?: string;
  mapping?: ColumnMapping;
  locale: Locale;
  defaultCurrency?: string;
  brokerProfile?: string;
  answers?: ImportAnswers;
}

export async function inspect(file: File, locale: Locale): Promise<FileInspection> {
  return inspectFile({ data: file, fileName: file.name }, { locale });
}

export async function runImport(req: ImportRequest): Promise<ImportResult> {
  const [existingTransactions, existingInstruments] = await Promise.all([
    db.transactions.where('portfolioId').equals(req.portfolioId).toArray(),
    db.instruments.toArray(),
  ]);
  const options: ImportOptions = {
      portfolioId: req.portfolioId,
      account: req.account || undefined,
      presetId: req.presetId || undefined,
      mapping: req.mapping,
      existingTransactions,
      existingInstruments,
      locale: req.locale,
      defaultCurrency: req.defaultCurrency,
      brokerProfile: req.brokerProfile || undefined,
      dateFormat: req.answers?.dateFormat,
      numberFormat: req.answers?.numberFormat,
      acceptDuplicates: req.answers?.acceptDuplicates?.length ? req.answers.acceptDuplicates : 'none',
      acceptCorporateActions: req.answers?.acceptCorporateActions?.length ? req.answers.acceptCorporateActions : undefined,
      corporateActionAnswers: req.answers?.corporateActionAnswers,
      acceptNotes: req.answers?.acceptNotes?.length ? req.answers.acceptNotes : undefined,
      securityMap: req.answers?.securityMap && Object.keys(req.answers.securityMap).length ? req.answers.securityMap : undefined,
      catalog: (await import('../lib/catalog')).CATALOG,
      idFactory: () => newId('tx'),
  };
  // W30: register the pdf.js worker before reading a PDF (directly or inside an e-mail).
  if (/\.(pdf|eml)$/i.test(req.file.name) || /pdf|rfc822/.test(req.file.type)) {
    const { loadPdfJs } = await import('./pdfjs');
    const pdfjs = await loadPdfJs();
    if (pdfjs) options.pdfjs = pdfjs;
  }
  // Importers R4: a forwarded broker e-mail (.eml) imports every attachment (notas, extratos).
  if (/\.eml$/i.test(req.file.name) || req.file.type === 'message/rfc822') {
    const raw = new Uint8Array(await req.file.arrayBuffer());
    return emailToResult(await importEmail(raw, options), req.file.name);
  }
  return importFile({ data: req.file, fileName: req.file.name }, options);
}

/** Merges the per-attachment results of an e-mail into one preview (rows keep their lines). */
export function emailToResult(e: EmailImportResult, fileName: string): ImportResult {
  const parts = e.attachments.map((a) => a.result);
  const first = parts[0];
  const sum = (k: keyof ImportResult['stats']) => parts.reduce((n, p) => n + (Number(p.stats[k]) || 0), 0);
  const seen = new Set<string>();
  const instruments = parts.flatMap((p) => p.instruments).filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true)));
  // Importer messages are in Spanish (like the rest of @pm/importers issues).
  const issue = (code: string, message: string, params: Record<string, string | number>) => ({ code, severity: 'error' as const, message, params });
  const warnings = parts.flatMap((p) => p.warnings);
  const emailErrors = [
    ...e.needsPassword.map((f) => issue('EMAIL_PDF_PASSWORD', `El adjunto ${f} está protegido con contraseña: impórtalo por separado para escribirla.`, { file: f })),
    ...(parts.length ? [] : [issue('EMAIL_NO_ATTACHMENT', `El correo ${fileName} no tiene adjuntos importables (PDF, CSV, XLSX).`, { file: fileName })]),
  ];
  return {
    detection: {
      fileKind: first?.detection.fileKind ?? 'unknown',
      presetId: first?.detection.presetId ?? 'email',
      presetLabel: [e.subject, ...e.attachments.map((a) => `${a.fileName} · ${a.result.detection.presetLabel}`)].filter(Boolean).join(' — ') || fileName,
      presetConfidence: first?.detection.presetConfidence ?? 'low',
      score: first?.detection.score ?? 0,
    },
    transactions: e.transactions,
    instruments,
    rows: parts.flatMap((p) => p.rows),
    warnings,
    errors: [...emailErrors, ...parts.flatMap((p) => p.errors)],
    stats: {
      ...(first?.stats ?? { byType: {}, currencies: [] }),
      totalRows: sum('totalRows'),
      imported: e.transactions.length,
      duplicates: sum('duplicates'),
      skipped: sum('skipped'),
      errors: sum('errors'),
      warnings: warnings.length,
      newInstruments: instruments.length,
      matchedInstruments: sum('matchedInstruments'),
      possibleDuplicates: sum('possibleDuplicates'),
      pending: sum('pending'),
    } as ImportResult['stats'],
    corporateActions: parts.flatMap((p) => p.corporateActions ?? []),
    unknownSecurities: parts.flatMap((p) => p.unknownSecurities ?? []),
    instrumentUpdates: parts.flatMap((p) => p.instrumentUpdates ?? []),
    needsConfirmation: parts.flatMap((p) => p.needsConfirmation ?? []),
    noteChecks: parts.flatMap((p) => p.noteChecks ?? []),
  };
}

/**
 * Imported instruments often carry only the ticker as name ("ISA ISA"). Resolve names, sector,
 * ISIN and provider symbols from the offline catalog first, then the market-data server (W15).
 */
export async function enrichInstruments(list: Instrument[]): Promise<Instrument[]> {
  const { CATALOG } = await import('../lib/catalog');
  const byId = new Map(CATALOG.map((c) => [c.id, c]));
  const out: Instrument[] = [];
  for (const i of list) {
    const bare = isNoteName(i.name, i.symbol);
    let match: Instrument | undefined = byId.get(i.id) ?? CATALOG.find((c) => c.symbol === i.symbol && (c.exchange === i.exchange || !i.exchange));
    if (!match && bare) {
      try {
        const res = await Promise.race([searchInstruments(i.symbol), new Promise<undefined>((r) => setTimeout(() => r(undefined), 4000))]);
        match = res?.results.find((r) => r.symbol.toUpperCase() === i.symbol.toUpperCase() && (r.exchange === i.exchange || r.id === i.id));
      } catch {
        /* offline */
      }
    }
    out.push(
      match
        ? {
            ...i,
            name: bare ? match.name : i.name,
            sector: i.sector ?? match.sector,
            isin: i.isin ?? match.isin,
            country: i.country || match.country,
            providerSymbols: { ...(match.providerSymbols ?? {}), ...(i.providerSymbols ?? {}) },
          }
        : i,
    );
  }
  return out;
}

/** Persists the accepted transactions and the new instruments they reference. */
export async function commitImport(
  result: ImportResult,
  portfolioId: string,
  source: string,
): Promise<{ transactions: number; instruments: number }> {
  const known = new Set(await db.instruments.toCollection().primaryKeys());
  const newInstruments: Instrument[] = await enrichInstruments(result.instruments.filter((i) => !known.has(i.id)));
  await upsertInstruments(newInstruments);
  // W33: the same institution under another spelling ("XP INVESTIMENTOS CCTVM S/A" vs the "XP" typed
  // at onboarding) is the same account: reuse the portfolio's existing label so cash is not split.
  const existingAccounts = [...new Set((await db.transactions.where('portfolioId').equals(portfolioId).toArray()).map((t) => t.account).filter((a): a is string => !!a))];
  const rows: Transaction[] = result.transactions.map((t) => ({ ...t, portfolioId, source: t.source ?? source, account: matchAccount(t.account, existingAccounts) }));
  await bulkAddTransactions(rows);
  return { transactions: rows.length, instruments: newInstruments.length };
}

/**
 * W33: maps an imported account label to the portfolio's existing account of the same institution
 * (and same account number for IBKR); unknown institutions keep their label, known ones get the
 * canonical name ("NU INVEST CORRETORA DE VALORES S.A." → "Nu Invest").
 */
export function matchAccount(label: string | undefined, existing: string[]): string | undefined {
  if (!label) return label;
  const same = existing.find((e) => e === label) ?? existing.find((e) => sameBroker(e, label));
  if (same) return same;
  const n = normalizeBrokerName(label);
  return n.known && !n.accountNumber ? n.displayName : label;
}

/**
 * Security names/tickers the importer could not resolve (answered with `securityMap`), with its
 * ranked suggestions (importers R4: broker-note names, BDR class letters such as GOGL34 vs GOGL35).
 */
export function unresolvedSecurities(r: ImportResult): { key: string; code: string; suggestions: string[] }[] {
  const out = new Map<string, { code: string; suggestions: string[] }>();
  for (const issue of [...r.errors, ...r.warnings, ...r.rows.flatMap((x) => x.issues)]) {
    const key = issue.params?.spec ?? issue.params?.symbol;
    if (['UNKNOWN_SECURITY', 'EXCHANGE_REQUIRED', 'BDR_CLASS_UNCERTAIN'].includes(issue.code) && key) out.set(String(key), { code: issue.code, suggestions: [] });
  }
  for (const u of r.unknownSecurities ?? []) {
    const prev = out.get(u.key);
    out.set(u.key, { code: prev?.code ?? 'UNKNOWN_SECURITY', suggestions: u.suggestions ?? [] });
  }
  return [...out.entries()].map(([key, v]) => ({ key, ...v }));
}

/**
 * Turns an importer corporate-action suggestion (incorporação, cisão, conversão...) into the
 * core SPLIT transaction with subtype MERGER / SPINOFF / TICKER_CHANGE. Returns undefined when a
 * leg cannot be resolved to a known instrument.
 */
export function corporateActionToTransaction(
  ca: CorporateActionSuggestion,
  resolve: (symbol: string | undefined) => Instrument | undefined,
  portfolioId: string,
  costFraction?: number,
): Transaction | undefined {
  const out = ca.legs.find((l) => l.direction === 'out');
  const inn = ca.legs.find((l) => l.direction === 'in');
  const from = resolve(out?.symbol);
  const to = resolve(inn?.symbol);
  if (!from || !to) return undefined;
  const ratio = out?.quantity && inn?.quantity ? inn.quantity / out.quantity : 1;
  const subtype = ca.kind === 'spinoff' ? 'SPINOFF' : ca.kind === 'symbol_change' ? 'TICKER_CHANGE' : 'MERGER';
  return {
    id: newId('tx'),
    portfolioId,
    date: ca.date,
    type: 'SPLIT',
    subtype,
    instrumentId: from.id,
    targetInstrumentId: to.id,
    ratio,
    currency: from.currency,
    costFraction: subtype === 'SPINOFF' ? (costFraction ?? 0) : undefined,
    note: ca.description,
    source: 'import:corporate-action',
  };
}
