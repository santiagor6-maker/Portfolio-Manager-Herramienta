/**
 * Core R8: renamed tickers are one security under its current id (PFBCOLOM → PFCIBEST). The web uses
 * the same table as the engine (`@pm/core` tickerRenames): instruments are created under the current
 * id and remember the old symbol ("antes PFBCOLOM"); lookups of an old id resolve to the new one.
 */
import type { Instrument } from '@pm/core';
// W20: the rename table alone (pure data, no imports), not the engine behind the package index: this
// module is on the first-paint path (repo, useData). @pm/core exports only ".", hence the path.
import { renamedTickerId, tickerRenameMap } from '../../../../packages/core/src/tickerRenames';

export type RenamedInstrument<T extends Instrument = Instrument> = T & { renamedFrom?: string };

const symbolOf = (id: string) => id.split(':').slice(1).join(':') || id;

/** The instrument under its current id (unchanged when it was never renamed). */
export function canonicalInstrument<T extends Instrument>(i: T): RenamedInstrument<T> {
  const to = renamedTickerId(i.id);
  if (!to) return i;
  const { providerSymbols, ...rest } = i;
  return { ...(rest as T), id: to, symbol: symbolOf(to), renamedFrom: i.symbol || symbolOf(i.id) };
}

export function canonicalId(id: string | undefined): string | undefined {
  return id ? (renamedTickerId(id) ?? id) : id;
}

/**
 * Adds the current-id instrument for every renamed one the user has under its old id, so holdings
 * that the engine reports under the new id (INSTRUMENT_RENAMED) have a name, currency and country.
 */
export function withRenamedAliases<T extends Instrument>(list: T[]): RenamedInstrument<T>[] {
  const byId = new Map<string, RenamedInstrument<T>>(list.map((i) => [i.id, i]));
  for (const i of list) {
    const to = renamedTickerId(i.id);
    if (!to) continue;
    const cur = byId.get(to);
    if (!cur) byId.set(to, canonicalInstrument(i));
    else if (!cur.renamedFrom) byId.set(to, { ...cur, renamedFrom: i.symbol || symbolOf(i.id) });
  }
  // Instruments already created under the current id (importers / server canonicalize too) still
  // show their former ticker.
  for (const [id, inst] of byId) {
    if (inst.renamedFrom) continue;
    const from = previousSymbol(id);
    if (from && !inst.name.includes(from)) byId.set(id, { ...inst, renamedFrom: from });
  }
  return [...byId.values()];
}

let reverse: Map<string, string> | undefined;
/** The former ticker of a renamed security ("XBOG:PFCIBEST" → "PFBCOLOM"), if any. */
export function previousSymbol(id: string): string | undefined {
  if (!reverse) {
    reverse = new Map();
    for (const [from, to] of Object.entries(tickerRenameMap())) if (!reverse.has(to)) reverse.set(to, symbolOf(from));
  }
  return reverse.get(id);
}
