/**
 * Interactive Brokers Flex Web Service sync through the market-data server
 * (`POST /api/sync/ibkr-flex`, `GET|DELETE /api/sync/ibkr-flex/inbox`, see apps/server/README.md).
 * The Flex token never stays in the browser: the server stores it encrypted with SYNC_SECRET.
 */
import type { Instrument, Transaction } from '@pm/core';
import type { ImportResult } from '@pm/importers';
import { db } from '../db/schema';
import { getMeta, setMeta } from '../db/repo';
import { useApp } from '../store/app';

export type SyncErrorKind = 'notConfigured' | 'unauthorized' | 'forbidden' | 'noCredential' | 'ibkr' | 'offline' | 'other';

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

/** Authenticated JSON call to the market-data server (shared by the IBKR and e-mail inboxes). */
export async function serverCall<T>(path: string, init: RequestInit = {}): Promise<T> {
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
  if (res.status === 401) throw new SyncError('unauthorized', message, res.status, code);
  // W38: 403 = the server allows sync only with API_TOKEN (or ALLOW_LOCAL_ADMIN=1 on loopback).
  if (res.status === 403) throw new SyncError(code === 'FORBIDDEN_ORIGIN' ? 'other' : 'forbidden', message, res.status, code);
  if (code === 'NO_CREDENTIAL') throw new SyncError('noCredential', message, res.status, code);
  if (code?.startsWith('FLEX_') || res.status === 502) throw new SyncError('ibkr', message, res.status, code);
  throw new SyncError('other', message, res.status, code);
}

const post = <T>(body: Record<string, unknown>) => serverCall<T>(PATH, { method: 'POST', body: JSON.stringify(body) });

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
  const r = await serverCall<IbkrInbox>(`${PATH}/inbox?portfolioId=${encodeURIComponent(portfolioId)}`);
  useApp.getState().setIbkrInbox(portfolioId, r?.pending?.length ?? 0);
  return { portfolioId, pending: r?.pending ?? [], instruments: r?.instruments ?? [], lastRun: r?.lastRun };
}

/**
 * Acknowledges the inbox. With `ids` only those transactions leave it (rows the daily job added
 * after the preview are kept); without ids the whole inbox is emptied.
 */
export async function clearIbkrInbox(portfolioId: string, ids?: string[]): Promise<void> {
  const r = await serverCall<{ cleared?: number }>(`${PATH}/inbox?portfolioId=${encodeURIComponent(portfolioId)}`, {
    method: 'DELETE',
    ...(ids ? { body: JSON.stringify({ ids }) } : {}),
  });
  const prev = useApp.getState().ibkrInbox[portfolioId] ?? 0;
  const left = ids ? Math.max(0, prev - (r?.cleared ?? ids.length)) : 0;
  useApp.getState().setIbkrInbox(portfolioId, left);
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

/**
 * Turns the inbox (already-built transactions) into an ImportResult through the importer pipeline
 * (`importTransactionBatch`, importers R4), so it gets the same preview, duplicate detection against
 * the user's existing trades (any source) and instrument matching as a file import.
 */
export async function inboxToImportResult(inbox: IbkrInbox, existing: Transaction[], knownInstruments: Instrument[]): Promise<ImportResult> {
  const [{ importTransactionBatch }, { CATALOG }, { newId }] = await Promise.all([import('@pm/importers'), import('../lib/catalog'), import('../lib/ids')]);
  return importTransactionBatch(
    { pending: inbox.pending, instruments: inbox.instruments, source: 'sync:ibkr-flex' },
    {
      portfolioId: inbox.portfolioId,
      existingTransactions: existing,
      existingInstruments: knownInstruments,
      catalog: CATALOG,
      acceptDuplicates: 'none',
      idFactory: () => newId('tx'),
    },
  );
}
