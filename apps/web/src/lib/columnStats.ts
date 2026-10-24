/**
 * W56: columns that add nothing for these rows: all zero/empty, or identical to another column.
 * `values` maps a column id to its numeric value per row (undefined = empty); only `candidates` (never
 * quantity, contributions or dividends) can be reported.
 */
export function redundantColumns<K extends string>(ids: K[], rows: unknown[], values: (id: K, row: never) => number | undefined, candidates: K[] = ids): K[] {
  const vec = new Map(ids.map((id) => [id, rows.map((r) => values(id, r as never))]));
  const zero = (v: (number | undefined)[]) => v.every((x) => x === undefined || !Number.isFinite(x) || Math.abs(x) < 1e-9);
  const same = (a: (number | undefined)[], b: (number | undefined)[]) =>
    a.length > 0 && a.every((x, i) => (x === undefined && b[i] === undefined) || (x !== undefined && b[i] !== undefined && Math.abs(x - b[i]!) <= 1e-9 * Math.max(1, Math.abs(x))));
  const out: K[] = [];
  ids.forEach((id, i) => {
    const v = vec.get(id)!;
    if (!rows.length || !candidates.includes(id)) return;
    // A copy is redundant only versus an earlier column that stays (the first of a pair is kept).
    if (zero(v) || ids.slice(0, i).some((o) => !out.includes(o) && same(v, vec.get(o)!))) out.push(id);
  });
  return out;
}
