/**
 * E-mail inbox (apps/server: POST /api/inbox/email, GET/DELETE /api/inbox/email/drafts). The user
 * forwards broker notes and statements to `importar+<token>@<domain>`; the server imports the
 * attachments as drafts and the web reviews them through the normal preview before saving.
 */
import type { Instrument, Transaction } from '@pm/core';
import type { ImportResult } from '@pm/importers';
import { db } from '../db/schema';
import { getMeta, setMeta } from '../db/repo';
import { useApp } from '../store/app';
import { serverCall } from './ibkrSync';

export interface EmailDraft {
  id: string;
  receivedAt: string;
  from?: string;
  subject?: string;
  transactions: Transaction[];
  instruments: Instrument[];
  attachments?: { fileName: string; transactions?: number; preset?: string }[] | string[];
  needsPassword?: string[];
  ignored?: unknown[];
}

const PATH = '/api/inbox/email/drafts';
const META = 'emailInbox';

/** What the user told us about their forwarding address (only to display it; the server owns the token). */
export interface EmailInboxSettings {
  address?: string;
  /** Set after the first successful drafts call: the app then checks the inbox on load. */
  enabled?: boolean;
}

export const getEmailInboxSettings = async () => (await getMeta<EmailInboxSettings>(META)) ?? {};
export const saveEmailInboxSettings = async (patch: EmailInboxSettings) => setMeta(META, { ...(await getEmailInboxSettings()), ...patch });

export async function fetchEmailDrafts(portfolioId: string): Promise<EmailDraft[]> {
  const r = await serverCall<{ drafts?: EmailDraft[] }>(`${PATH}?portfolioId=${encodeURIComponent(portfolioId)}`);
  const drafts = r?.drafts ?? [];
  useApp.getState().setEmailDrafts(portfolioId, drafts.length);
  const cur = await getEmailInboxSettings();
  if (!cur.enabled) await saveEmailInboxSettings({ enabled: true });
  return drafts;
}

/** Acknowledges the drafts that were reviewed (by id: drafts that arrived meanwhile stay). */
export async function clearEmailDrafts(portfolioId: string, ids: string[]): Promise<void> {
  const r = await serverCall<{ cleared?: number }>(`${PATH}?portfolioId=${encodeURIComponent(portfolioId)}`, { method: 'DELETE', body: JSON.stringify({ ids }) });
  const prev = useApp.getState().emailDrafts[portfolioId] ?? 0;
  useApp.getState().setEmailDrafts(portfolioId, Math.max(0, prev - (r?.cleared ?? ids.length)));
}

/** On load, when the inbox was used before: drafts count per real portfolio (silent on errors). */
export async function checkEmailDrafts(): Promise<number> {
  if (!(await getEmailInboxSettings()).enabled) return 0;
  let total = 0;
  for (const p of (await db.portfolios.toArray()).filter((x) => !x.isDemo)) {
    try {
      total += (await fetchEmailDrafts(p.id)).length;
    } catch {
      /* server offline / not configured */
    }
  }
  return total;
}

/** Drafts → one preview through the importer pipeline (duplicates of existing trades filtered). */
export async function draftsToImportResult(portfolioId: string, drafts: EmailDraft[]): Promise<ImportResult> {
  const [{ importTransactionBatch }, { CATALOG }, { newId }] = await Promise.all([import('@pm/importers'), import('../lib/catalog'), import('../lib/ids')]);
  const [existing, known] = await Promise.all([db.transactions.where('portfolioId').equals(portfolioId).toArray(), db.instruments.toArray()]);
  const seen = new Set<string>();
  const instruments = drafts.flatMap((d) => d.instruments ?? []).filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true)));
  return importTransactionBatch(
    { transactions: drafts.flatMap((d) => d.transactions ?? []), instruments, source: 'email-inbox' },
    { portfolioId, existingTransactions: existing, existingInstruments: known, catalog: CATALOG, acceptDuplicates: 'none', idFactory: () => newId('tx') },
  );
}
