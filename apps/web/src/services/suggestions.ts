/** Provider suggestions (corporate events, dividends): record or dismiss (W55: shared by Resumen, Proventos and Movimientos). */
import { addTransactionsOnce, getMeta, setMeta } from '../db/repo';
import { corporateNote } from '../lib/corporateText';
import type { Suggestion } from './analysis';

export async function dismiss(keys: string[]) {
  const prev = (await getMeta<string[]>('dismissedSuggestions')) ?? [];
  await setMeta('dismissedSuggestions', [...new Set([...prev, ...keys])]);
}

type T = (key: string, opts?: Record<string, unknown>) => string;

/** Records provider suggestions as transactions (localized note) and clears them from the inbox. */
export async function acceptSuggestions(items: Suggestion[], t: T, locale: string): Promise<void> {
  // W61: recorded events are skipped by addTransactionsOnce (one read-write transaction per call).
  // W53: the saved note is the localized description, not the provider's English text.
  // W64: fresh ids — core gives one event the same id in every portfolio, and each row must be written.
  await addTransactionsOnce(items.map((s) => ({ ...s.transaction, id: undefined, note: corporateNote(s.transaction, t, locale) })));
  await dismiss(items.map((s) => s.key));
}
