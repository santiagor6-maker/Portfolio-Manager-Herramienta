/**
 * Import already-built transactions through the normal pipeline (I2): the server inbox of the daily
 * IBKR Flex sync (`{ pending, instruments }` from GET /api/sync/ibkr-flex/inbox), or any other batch
 * of `Transaction[]` + `Instrument[]` (another app, a script).
 *
 * The server de-duplicates only against what IT synced before; the user's portfolio may already hold
 * the same trades from an Activity CSV, a manual entry or an earlier inbox. Running the batch through
 * `finalizeRows` gives the same preview, statuses and checks as a file import:
 *   - exact duplicates (same importHash, kept from the server) → `duplicate`;
 *   - the same trade from another source / account-compatible → `possible_duplicate`;
 *   - instruments matched to the user's (by id / ISIN / symbol) or proposed as new;
 *   - validation errors per row; reconciliation is not run (an inbox is not a statement).
 */
import type { Instrument, Transaction } from '@pm/core';
import { finalizeRows } from '../pipeline';
import { ParseContext } from '../presets/common';
import type { DetectionInfo, DraftTransaction, ImportOptions, ImportResult, InstrumentHint, ParsedRow, RawTable } from '../types';

export interface TransactionBatch {
  /** Transactions to import (`pending` is accepted as an alias: the server inbox shape). */
  transactions?: Transaction[];
  pending?: Transaction[];
  /** Instruments referenced by the transactions that the portfolio may not have yet. */
  instruments?: Instrument[];
  /** Default source when a transaction carries none (e.g. 'sync:ibkr-flex'). */
  source?: string;
}

/** Shape check for a parsed JSON value (server inbox or batch). */
export function isTransactionBatch(v: unknown): v is TransactionBatch {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  const list = o.pending ?? o.transactions;
  return Array.isArray(list) && list.every((t) => t && typeof t === 'object' && typeof (t as Transaction).date === 'string' && typeof (t as Transaction).type === 'string');
}

const KEEP_FIELDS = ['subtype', 'targetInstrumentId', 'costFraction', 'priceConfirmed', 'amountIsNet'] as const;

export function importTransactionBatch(batch: TransactionBatch, options: ImportOptions): ImportResult {
  const list = batch.transactions ?? batch.pending ?? [];
  const byId = new Map((batch.instruments ?? []).map((i) => [i.id, i]));
  const table: RawTable = { name: 'inbox', rows: list.map(() => []), lines: list.map((_, i) => i + 1) };
  const ctx = new ParseContext(table, options, 'inbox');
  const rows: ParsedRow[] = list.map((t, i) => {
    const row = ctx.newRow(i);
    row.raw = [t.date, t.type, t.instrumentId ?? '', String(t.quantity ?? t.amount ?? '')];
    const d: DraftTransaction = { date: t.date, type: t.type, currency: t.currency };
    if (t.instrumentId) {
      const inst = byId.get(t.instrumentId);
      // A full instrument is offered as-is when the portfolio lacks it; otherwise the id is matched.
      const hint: InstrumentHint = inst ? { create: inst } : { id: t.instrumentId };
      d.instrument = hint;
    }
    for (const k of ['quantity', 'price', 'amount', 'fees', 'taxes', 'ratio', 'toCurrency', 'toAmount', 'fxRateToBase', 'note', 'account'] as const) {
      if (t[k] !== undefined) (d as unknown as Record<string, unknown>)[k] = t[k];
    }
    const fields: Partial<Transaction> = {};
    for (const k of KEEP_FIELDS) if (t[k] !== undefined) (fields as Record<string, unknown>)[k] = t[k];
    d.keep = { fields };
    if (t.id) d.keep.id = t.id;
    if (t.importHash) d.keep.importHash = t.importHash;
    const src = t.source ?? batch.source;
    if (src) d.keep.source = src;
    row.draft = d;
    return row;
  });
  const detection: DetectionInfo = { fileKind: 'json', presetId: 'inbox', presetLabel: 'Bandeja de sincronización', presetConfidence: 'high', score: 1 };
  return finalizeRows(rows, ctx, batch.source ?? 'sync:inbox', detection);
}
