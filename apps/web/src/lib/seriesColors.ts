/**
 * D6: colour follows the entity, never its rank. Each allocation key has a preferred slot of the
 * categorical palette (COP → 1, USD → 2, BRL → 3, EUR → 4…; Colombia, United States, Brazil…; equity,
 * ETF, fixed income…); other keys get a slot from a hash. Inside one chart a taken slot moves to the next
 * free one, so a month where USD outgrows COP repaints nothing. Slot 8 (index 7) is reserved for "Otros".
 */
const ORDER: Record<string, string[]> = {
  currency: ['COP', 'USD', 'BRL', 'EUR', 'GBP', 'CHF', 'MXN'],
  country: ['CO', 'US', 'BR', 'EU', 'ES', 'DE', 'GB'],
  assetClass: ['equity', 'etf', 'fixed_income', 'fund', 'reit', 'crypto', 'cash'],
};
const SLOTS = 7;
export const OTHER_SLOT = 7;

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function preferredSlot(dim: string | undefined, key: string): number {
  const i = dim ? (ORDER[dim]?.indexOf(key) ?? -1) : -1;
  return i >= 0 ? i : hash(`${dim ?? ''}:${key}`) % SLOTS;
}

/** Palette index (0-based) per key for one chart: stable per entity, no two slices sharing a colour. */
export function colorSlots(dim: string | undefined, keys: string[]): Map<string, number> {
  const out = new Map<string, number>();
  const used = new Set<number>();
  // Keys with a fixed slot first, so a hashed key never takes COP's colour.
  const ordered = [...keys].sort((a, b) => Number(ORDER[dim ?? '']?.includes(b) ?? false) - Number(ORDER[dim ?? '']?.includes(a) ?? false));
  for (const k of ordered) {
    if (k === '__other') {
      out.set(k, OTHER_SLOT);
      continue;
    }
    let slot = preferredSlot(dim, k);
    for (let n = 0; used.has(slot) && n < SLOTS; n++) slot = (slot + 1) % SLOTS;
    used.add(slot);
    out.set(k, slot);
  }
  return out;
}
