/** Provider suggestions (corporate events, dividends): record or dismiss (W55: shared by Resumen, Proventos and Movimientos). */
import { addTransactionsOnce, getMeta, setMeta } from '../db/repo';
import { once } from '../lib/writeGuard';
import { corporateNote } from '../lib/corporateText';
import type { Suggestion } from './analysis';

export async function dismiss(keys: string[]) {
  const prev = (await getMeta<string[]>('dismissedSuggestions')) ?? [];
  await setMeta('dismissedSuggestions', [...new Set([...prev, ...keys])]);
}

type T = (key: string, opts?: Record<string, unknown>) => string;

/** Records provider suggestions as transactions (localized note) and clears them from the inbox. */
export function acceptSuggestions(items: Suggestion[], t: T, locale: string): Promise<void> {
  // W61: never twice — same keys in flight share one write, and recorded events are skipped.
  return once(`accept|${items.map((s) => s.key).join(',')}`, async () => {
    // W53: the saved note is the localized description, not the provider's English text.
    // Fresh ids: core gives the same id to one event in every portfolio (W64: both must be written).
    await addTransactionsOnce(items.map((s) => ({ ...s.transaction, id: undefined, note: corporateNote(s.transaction, t, locale) })));
    await dismiss(items.map((s) => s.key));
  });
}

