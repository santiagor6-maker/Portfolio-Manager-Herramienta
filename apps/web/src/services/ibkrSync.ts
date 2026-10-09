/**
 * Interactive Brokers Flex Web Service sync through the market-data server
 * (`POST /api/sync/ibkr-flex`, `GET|DELETE /api/sync/ibkr-flex/inbox`, see apps/server/README.md).
 * The Flex token never stays in the browser: the server stores it encrypted with SYNC_SECRET.
 */
import type { Instrument, Transaction } from '@pm/core';
import type { ImportResult, ImportRow } from '@pm/importers';
import { db } from '../db/schema';
import { getMeta, setMeta } from '../db/repo';
import { useApp } from '../store/app';

export type SyncErrorKind = 'notConfigured' | 'unauthorized' | 'noCredential' | 'ibkr' | 'offline' | 'other';

export class SyncError extends Error {
  constructor(
    readonly kind: SyncErrorKind,
    message: string,
    readonly status?: number,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'SyncError';
  }
}

/** Saved connection (no secrets: the Flex token lives only on the server). */
export interface IbkrConnection {
  credentialId?: string;
  queryId: string;
  connectedAt: number;
  lastSync?: number;
}

export interface IbkrInbox {
  portfolioId: string;
  pending: Transaction[];
  instruments: Instrument[];
  lastRun?: { at?: string; ok?: boolean; error?: string; imported?: number; [k: string]: unknown };
}

const META_KEY = 'ibkrFlex';
const PATH = '/api/sync/ibkr-flex';

export const getIbkrConnection = () => getMeta<IbkrConnection>(META_KEY);

function base(): string {
  return useApp.getState().settings.serverUrl.trim().replace(/\/+$/, '');
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = useApp.getState().settings.apiToken.trim();
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (init.body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  let res: Response;
  try {
    res = await fetch(`${base()}${path}`, { ...init, headers });
  } catch (e) {
    throw new SyncError('offline', e instanceof Error ? e.message : String(e));
  }
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    body = undefined;
  }
  if (res.ok) return body as T;
  const err = (body as { error?: { code?: string; message?: string } } | undefined)?.error;
  const code = err?.code;
  const message = err?.message ?? `HTTP ${res.status}`;
  if (code === 'NOT_CONFIGURED' || (res.status === 503 && !code?.startsWith('FLEX_'))) throw new SyncError('notConfigured', message, res.status, code);
  if (res.status === 401 || res.status === 403) throw new SyncError('unauthorized', message, res.status, code);
  if (code === 'NO_CREDENTIAL') throw new SyncError('noCredential', message, res.status, code);
  if (code?.startsWith('FLEX_') || res.status === 502) throw new SyncError('ibkr', message, res.status, code);
  throw new SyncError('other', message, res.status, code);
}

const post = <T>(body: Record<string, unknown>) => call<T>(PATH, { method: 'POST', body: JSON.stringify(body) });

export async function connectIbkr(token: string, queryId: string): Promise<IbkrConnection> {
  const r = await post<{ credentialId?: string }>({ action: 'save', token: token.trim(), queryId: queryId.trim() });
  const conn: IbkrConnection = { credentialId: r?.credentialId, queryId: queryId.trim(), connectedAt: Date.now() };
  await setMeta(META_KEY, conn);
  return conn;
}

export async function disconnectIbkr(): Promise<void> {
  const conn = await getIbkrConnection();
  try {
    await post({ action: 'delete', ...(conn?.credentialId ? { credentialId: conn.credentialId } : {}) });
  } catch (e) {
    // Already gone on the server: forget it locally anyway.
    if (!(e instanceof SyncError && e.kind === 'noCredential')) throw e;
  }
  await db.meta.delete(META_KEY);
}

/** Downloads the Flex statement now; the server de-duplicates against the portfolio's transactions. */
export async function syncIbkrNow(portfolioId: string, account?: string): Promise<ImportResult> {
  const conn = await getIbkrConnection();
  const [existingTransactions, existingInstruments] = await Promise.all([
    db.transactions.where('portfolioId').equals(portfolioId).toArray(),
    db.instruments.toArray(),
  ]);
  const r = await post<ImportResult>({
    action: 'sync',
    portfolioId,
    ...(conn?.credentialId ? { credentialId: conn.credentialId } : {}),
    ...(account ? { account } : {}),
    existingTransactions,
    existingInstruments,
  });
  if (conn) await setMeta(META_KEY, { ...conn, lastSync: Date.now() });
  return r;
}

export async function fetchIbkrInbox(portfolioId: string): Promise<IbkrInbox> {
  const r = await call<IbkrInbox>(`${PATH}/inbox?portfolioId=${encodeURIComponent(portfolioId)}`);
  useApp.getState().setIbkrInbox(portfolioId, r?.pending?.length ?? 0);
  return { portfolioId, pending: r?.pending ?? [], instruments: r?.instruments ?? [], lastRun: r?.lastRun };
}

export async function clearIbkrInbox(portfolioId: string): Promise<void> {
  await call(`${PATH}/inbox?portfolioId=${encodeURIComponent(portfolioId)}`, { method: 'DELETE' });
  useApp.getState().setIbkrInbox(portfolioId, 0);
}

/** Checks the daily-sync inbox of every user portfolio (app load). Silent when not connected/offline. */
export async function checkIbkrInboxes(): Promise<number> {
  if (!(await getIbkrConnection())) return 0;
  const portfolios = (await db.portfolios.toArray()).filter((p) => !p.isDemo);
  let total = 0;
  for (const p of portfolios) {
    try {
      total += (await fetchIbkrInbox(p.id)).pending.length;
    } catch {
      /* server offline or not configured: the Import page shows the reason on demand */
    }
  }
  return total;
}

function dedupKey(t: Transaction): string {
  return [t.date, t.type, t.instrumentId ?? '', t.quantity ?? '', t.amount ?? '', t.currency].join('|');
}

/**
 * Turns the inbox (already-built transactions) into an ImportResult so it goes through the same
 * preview / confirm flow as a file. De-duplicates by import hash, then by date+type+asset+amounts.
 */
export function inboxToImportResult(inbox: IbkrInbox, existing: Transaction[], knownInstruments: Instrument[]): ImportResult {
  const hashes = new Set(existing.map((t) => t.importHash).filter(Boolean));
  const keys = new Map(existing.map((t) => [dedupKey(t), t]));
  const known = new Set(knownInstruments.map((i) => i.id));
  const rows: ImportRow[] = [];
  const transactions: Transaction[] = [];
  const byType: ImportResult['stats']['byType'] = {};
  const currencies = new Set<string>();
  inbox.pending.forEach((tx, i) => {
    const t = { ...tx, portfolioId: inbox.portfolioId };
    const dup = (t.importHash && hashes.has(t.importHash)) || keys.get(dedupKey(t));
    if (dup) {
      const other = typeof dup === 'object' ? dup : existing.find((e) => e.importHash === t.importHash);
      rows.push({ line: i + 1, status: 'duplicate', transaction: t, issues: [], duplicateOf: { transactionId: other?.id, source: other?.source, date: t.date, inFile: false } });
      return;
    }
    rows.push({ line: i + 1, status: 'ok', transaction: t, issues: [] });
    transactions.push(t);
    byType[t.type] = (byType[t.type] ?? 0) + 1;
    currencies.add(t.currency);
  });
  const used = new Set(transactions.map((t) => t.instrumentId).filter(Boolean));
  const instruments = inbox.instruments.filter((i) => used.has(i.id) && !known.has(i.id));
  const dates = transactions.map((t) => t.date).sort();
  return {
    detection: { fileKind: 'json', presetId: 'ibkr-flex-inbox', presetLabel: 'Interactive Brokers (Flex)', presetConfidence: 'high', score: 1 },
    transactions,
    instruments,
    rows,
    warnings: [],
    errors: [],
    stats: {
      totalRows: rows.length,
      imported: transactions.length,
      duplicates: rows.length - transactions.length,
      skipped: 0,
      errors: 0,
      warnings: 0,
      byType,
      firstDate: dates[0],
      lastDate: dates[dates.length - 1],
      currencies: [...currencies],
      newInstruments: instruments.length,
      matchedInstruments: used.size - instruments.length,
      possibleDuplicates: 0,
      pending: 0,
    },
  };
}
