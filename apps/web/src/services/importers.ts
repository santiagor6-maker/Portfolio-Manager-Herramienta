/**
 * Adapter over @pm/importers: runs detection/import with the local portfolio context
 * (existing transactions for de-duplication and known instruments for matching).
 */
import {
  listBrokerProfiles,
  canonicalTemplateCsv,
  exportTransactionsCsv,
  importFile,
  inspectFile,
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
  return importFile(
    { data: req.file, fileName: req.file.name },
    {
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
      securityMap: req.answers?.securityMap && Object.keys(req.answers.securityMap).length ? req.answers.securityMap : undefined,
      catalog: (await import('../lib/catalog')).CATALOG,
      idFactory: () => newId('tx'),
    },
  );
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
    const bare = !i.name || i.name.trim().toUpperCase() === i.symbol.toUpperCase();
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
  const rows: Transaction[] = result.transactions.map((t) => ({ ...t, portfolioId, source: t.source ?? source }));
  await bulkAddTransactions(rows);
  return { transactions: rows.length, instruments: newInstruments.length };
}

/** Security names/tickers the importer could not resolve (answered with `securityMap`). */
export function unresolvedSecurities(r: ImportResult): { key: string; code: string }[] {
  const out = new Map<string, string>();
  for (const issue of [...r.errors, ...r.rows.flatMap((x) => x.issues)]) {
    if (issue.code === 'UNKNOWN_SECURITY' && issue.params?.spec) out.set(String(issue.params.spec), issue.code);
    if (issue.code === 'EXCHANGE_REQUIRED' && issue.params?.symbol) out.set(String(issue.params.symbol), issue.code);
  }
  return [...out.entries()].map(([key, code]) => ({ key, code }));
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
