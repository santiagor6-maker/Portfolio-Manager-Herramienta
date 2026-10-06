/**
 * XIRR: annualized internal rate of return for irregular cash flows.
 *   NPV(r) = sum_i a_i * (1 + r)^(-t_i) = 0
 * t_i in years: Actual/365 by default (Excel compatible) or ACT/ACT calendar years
 * (exactly 1 for 2023-12-31 -> 2024-12-31), which the engine uses for MWR so that
 * MWR = TWR over exactly one year without flows.
 * Newton-Raphson from several starting guesses, then a bracketing bisection fallback.
 * Returns undefined when there is no solution (no sign change) or the input is degenerate.
 * `multipleRoots` flags cash-flow patterns whose NPV crosses zero more than once.
 */
import type { ISODate } from './types';
import { isoToDay, yearFraction } from './dates';

export interface XirrResult {
  rate: number | undefined;
  /** The NPV equation has more than one root in (-99 %, 1000 %]: the MWR is ambiguous. */
  multipleRoots: boolean;
}

export type XirrDayCount = 'ACT/365' | 'ACT/ACT';

export function xirrImpl(flows: { date: ISODate; amount: number }[], guess = 0.1, dayCount: XirrDayCount = 'ACT/365'): number | undefined {
  return xirrDetailed(flows, guess, dayCount).rate;
}

export function xirrDetailed(flows: { date: ISODate; amount: number }[], guess = 0.1, dayCount: XirrDayCount = 'ACT/365'): XirrResult {
  const none: XirrResult = { rate: undefined, multipleRoots: false };
  // Aggregate by day and drop zeros.
  const byDay = new Map<number, number>();
  for (const f of flows ?? []) {
    if (!f || !Number.isFinite(f.amount) || f.amount === 0) continue;
    const d = isoToDay(f.date);
    if (!Number.isFinite(d)) continue;
    byDay.set(d, (byDay.get(d) ?? 0) + f.amount);
  }
  const entries = Array.from(byDay.entries())
    .filter(([, a]) => Math.abs(a) > 1e-12)
    .sort((a, b) => a[0] - b[0]);
  if (entries.length < 2) return none;
  if (!entries.some(([, a]) => a > 0) || !entries.some(([, a]) => a < 0)) return none;
  const d0 = entries[0]![0];
  const t = entries.map(([d]) => (dayCount === 'ACT/ACT' ? yearFraction(d0, d) : (d - d0) / 365));
  const a = entries.map(([, v]) => v);
  if (t[t.length - 1] === 0) return none;
  const scale = Math.max(...a.map(Math.abs));
  const amounts = a.map((v) => v / scale); // normalize for numerical stability

  const npv = (r: number): number => {
    let s = 0;
    const lr = Math.log1p(r);
    for (let i = 0; i < amounts.length; i++) s += (amounts[i] as number) * Math.exp(-(t[i] as number) * lr);
    return s;
  };
  const dnpv = (r: number): number => {
    let s = 0;
    const lr = Math.log1p(r);
    for (let i = 0; i < amounts.length; i++) {
      const ti = t[i] as number;
      s += -ti * (amounts[i] as number) * Math.exp(-(ti + 1) * lr);
    }
    return s;
  };

  // Sign changes of the cash-flow sequence: <= 1 guarantees a unique root (Descartes).
  let signChanges = 0;
  for (let i = 1; i < a.length; i++) if (Math.sign(a[i] as number) !== Math.sign(a[i - 1] as number)) signChanges++;
  const done = (rate: number): XirrResult => {
    let multipleRoots = false;
    if (signChanges > 1) {
      let roots = 0;
      let prev = npv(-0.99);
      for (let k = 1; k <= 600; k++) {
        const r = -0.99 + (k / 600) * 10.99;
        const v = npv(r);
        if (Number.isFinite(prev) && Number.isFinite(v) && v !== 0 && prev !== 0 && Math.sign(v) !== Math.sign(prev)) roots++;
        prev = v;
      }
      multipleRoots = roots > 1;
    }
    return { rate, multipleRoots };
  };

  const tol = 1e-10;
  const guesses = [guess, 0, 0.05, -0.05, 0.25, 0.5, -0.5, 1, 3, -0.9];
  for (const g of guesses) {
    let r = g;
    for (let k = 0; k < 100; k++) {
      const f = npv(r);
      const df = dnpv(r);
      if (!Number.isFinite(f) || !Number.isFinite(df) || df === 0) break;
      let next = r - f / df;
      if (next <= -1) next = (r - 1) / 2; // stay in domain
      if (!Number.isFinite(next)) break;
      if (Math.abs(next - r) < tol * Math.max(1, Math.abs(r))) {
        if (Math.abs(npv(next)) < 1e-7) return done(next);
        break;
      }
      r = next;
    }
  }

  // Bisection fallback: find a bracket on (-1, hi].
  const lo0 = -0.999999999;
  const grid = [lo0, -0.99, -0.9, -0.7, -0.5, -0.3, -0.1, 0, 0.1, 0.3, 0.6, 1, 2, 5, 10, 50, 100, 1000, 1e4, 1e6];
  let prevR = grid[0] as number;
  let prevF = npv(prevR);
  for (let i = 1; i < grid.length; i++) {
    const r = grid[i] as number;
    const f = npv(r);
    if (Number.isFinite(prevF) && Number.isFinite(f) && Math.sign(prevF) !== Math.sign(f)) {
      let lo = prevR;
      let hi = r;
      let flo = prevF;
      for (let k = 0; k < 300; k++) {
        const mid = (lo + hi) / 2;
        const fm = npv(mid);
        if (Math.abs(fm) < 1e-12 || hi - lo < 1e-13 * Math.max(1, Math.abs(mid))) return done(mid);
        if (Math.sign(fm) === Math.sign(flo)) {
          lo = mid;
          flo = fm;
        } else hi = mid;
      }
      return done((lo + hi) / 2);
    }
    prevR = r;
    prevF = f;
  }
  return none;
}
