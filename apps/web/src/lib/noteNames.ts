/**
 * W43: brokerage notes (SINACOR, XP, Nu) name securities with abbreviations and share-class codes
 * ("SID NACIONAL ON", "TRAN PAULIST PN N1", "ITAUUNIBANCO PN EJ N1"). Such a name is replaced by the
 * catalog's (or the market-data server's) name, exactly like a bare ticker from a CSV.
 */
import { db } from '../db/schema';

// B3 share-class / listing-segment codes as printed on notes (no English words such as INT or CI).
const CLASS_TOKENS = /\b(ON|PN|PNA|PNB|PNC|UNT|DRN|DR[123]|N[12]|NM|EJ|ED|EDJ|ATZ)\b/;

export function isNoteName(name: string | undefined, symbol: string): boolean {
  const n = (name ?? '').trim();
  if (!n || n.toUpperCase() === symbol.toUpperCase()) return true;
  // All caps (accents allowed), no lowercase, and at least one share-class token.
  return n === n.toUpperCase() && /[A-Z]/.test(n) && CLASS_TOKENS.test(n);
}

/**
 * W43: instruments saved before names were resolved keep the note's text ("SID NACIONAL ON"). Renames
 * them from the offline catalog once (first startup after the upgrade, no network).
 */
export async function repairNoteNames(): Promise<number> {
  // Once per database: a name the user types later (even "PETROBRAS PN") is never reverted.
  if ((await db.meta.get('noteNamesRepaired'))?.value) return 0;
  await db.meta.put({ key: 'noteNamesRepaired', value: true });
  const { CATALOG } = await import('../lib/catalog');
  const byId = new Map(CATALOG.map((c) => [c.id, c]));
  const fixed = (await db.instruments.toArray()).flatMap((i) => {
    const match = byId.get(i.id);
    return match && i.name !== match.name && isNoteName(i.name, i.symbol) ? [{ ...i, name: match.name, sector: i.sector ?? match.sector }] : [];
  });
  if (fixed.length) await db.instruments.bulkPut(fixed);
  return fixed.length;
}

