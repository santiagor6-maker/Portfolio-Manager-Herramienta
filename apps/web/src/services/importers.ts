/**
 * Adapter over @pm/importers: runs detection/import with the local portfolio context
 * (existing transactions for de-duplication and known instruments for matching).
 */
import {
  canonicalTemplateCsv,
  exportTransactionsCsv,
  importFile,
  inspectFile,
  listPresets,
  type ColumnMapping,
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

export type { ColumnMapping, FileInspection, ImportResult, MappingField, PresetInfo };
export { canonicalTemplateCsv, exportTransactionsCsv, listPresets };

export interface ImportRequest {
  file: File;
  portfolioId: string;
  account?: string;
  presetId?: string;
  mapping?: ColumnMapping;
  locale: Locale;
  defaultCurrency?: string;
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
      idFactory: () => newId('tx'),
    },
  );
}

/** Persists the accepted transactions and the new instruments they reference. */
export async function commitImport(
  result: ImportResult,
  portfolioId: string,
  source: string,
): Promise<{ transactions: number; instruments: number }> {
  const known = new Set(await db.instruments.toCollection().primaryKeys());
  const newInstruments: Instrument[] = result.instruments.filter((i) => !known.has(i.id));
  await upsertInstruments(newInstruments);
  const rows: Transaction[] = result.transactions.map((t) => ({ ...t, portfolioId, source: t.source ?? source }));
  await bulkAddTransactions(rows);
  return { transactions: rows.length, instruments: newInstruments.length };
}
