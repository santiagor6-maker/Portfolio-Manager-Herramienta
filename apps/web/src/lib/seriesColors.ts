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

/**
 * W52: slot pairs that fail validate_palette.js --pairs all (light or dark: CVD ΔE < 8 or normal-vision
 * ΔE < 15). No three-plus-one palette avoids them all, so a chart never puts two of them together while
 * a conflict-free slot is free; the legend (label + %) is the secondary encoding for the rest.
 */
const CONFLICTS = new Set(['0-6', '1-3', '1-4', '1-5', '2-4', '2-5', '3-5']);
const clash = (a: number, b: number) => CONFLICTS.has(a < b ? `${a}-${b}` : `${b}-${a}`);

/** Palette index (0-based) per key for one chart: stable per entity, no two slices sharing a colour. */
export function colorSlots(
  dim: string | undefined,
  keys: string[],
  opts: { prefer?: (key: string) => number; reserved?: number[] } = {},
): Map<string, number> {
  const out = new Map<string, number>();
  const used: number[] = [...(opts.reserved ?? [])];
  const prefer = opts.prefer ?? ((k: string) => preferredSlot(dim, k));
  // Keys with a fixed slot first, so a hashed key never takes COP's colour.
  const ordered = [...keys].sort((a, b) => Number(ORDER[dim ?? '']?.includes(b) ?? false) - Number(ORDER[dim ?? '']?.includes(a) ?? false));
  const conflicts = (slot: number) => used.filter((u) => clash(u, slot)).length;
  for (const k of ordered) {
    if (k === '__other') {
      out.set(k, OTHER_SLOT);
      continue;
    }
    const free = Array.from({ length: SLOTS }, (_, i) => (prefer(k) + i) % SLOTS).filter((s) => !used.includes(s));
    if (!free.length) {
      out.set(k, OTHER_SLOT);
      continue;
    }
    // The preferred slot unless it clashes with one already drawn; then the free slot with fewest clashes.
    const slot = free.reduce((best, s) => (conflicts(s) < conflicts(best) ? s : best), free[0]!);
    used.push(slot);
    out.set(k, slot);
  }
  return out;
}

/**
 * W52: comparison lines keep one colour per index, whatever else is drawn (slot 0 is the portfolio).
 * The default combinations (portfolio + home index + home rate) have no CONFLICTS pair, i.e. they pass
 * validate_palette.js --pairs all in light and dark: COP blue/orange/teal, BRL blue/magenta/amber,
 * USD/EUR blue/green.
 */
export const BENCH_SLOT: Record<string, number> = {
  'XBOG:ICOLCAP': 1,
  IBR: 2,
  CDI: 3,
  SELIC: 3,
  'INDEX:^BVSP': 4,
  'INDEX:^GSPC': 5,
  'ARCX:URTH': 5,
};
