/**
 * Performance per position (C5): total return in money (capital + income, realized and
 * unrealized, with the currency part), time-weighted return and IRR, for any period.
 *
 * Position cash flows (base currency at the day's market FX):
 *   IN  = buys including fees, transfers in at market value (at the trade)
 *   OUT = net sale proceeds, transfers out, redemptions (at the trade)
 *   END = dividends / interest / return of capital, net of withholding (end of day)
 * Position TWR uses the same flow-day split as the portfolio:
 *   r_a = P(f) / V(f-1) - 1       P = units held before the trades x first trade price
 *   r_b = (V(f) + END) / (P + IN - OUT) - 1     (full exit: (V + END + OUT) / (P + IN) - 1)
 * IRR = XIRR of -V(start), -IN, +OUT, +END, +V(end) with ACT/ACT years.
 */
import type { ISODate, PositionPerformance } from './types';
import type { PeriodKey } from './api';
import { dayToIso, isoToDay, yearFraction } from './dates';
import type { Engine } from './engine';
import { periodStart } from './engine';
import { Ledger, type PositionFlow } from './ledger';
import { subReturn } from './performance';
import { valuePosition } from './pricing';
import { xirrDetailed } from './xirr';

interface Snap {
  value: Map<string, number>;
  unreal?: Map<string, { u: number; ufx: number; q: number }>;
}

export function positionPerformanceImpl(eng: Engine, period: PeriodKey, asOf: ISODate, custom?: { from: ISODate; to: ISODate }): PositionPerformance[] {
  const ctx = eng.ctx;
  const full = eng.ledger;
  const incDay = eng.inceptionDay;
  if (incDay === undefined) return [];
  const inception = dayToIso(incDay);
  const to = period === 'CUSTOM' && custom ? custom.to : asOf;
  let from = periodStart(period, to, inception, custom);
  if (from < inception) from = inception;
  if (from > to) from = to;
  const baseDay = isoToDay(from) - 1;
  const toDay = isoToDay(to);
  const years = yearFraction(baseDay, toDay);

  // Merge position flows by (instrument, day).
  const byInst = new Map<string, Map<number, PositionFlow>>();
  for (const f of full.positionFlows) {
    if (f.day <= baseDay || f.day > toDay) continue;
    let m = byInst.get(f.instrumentId);
    if (!m) byInst.set(f.instrumentId, (m = new Map()));
    const e = m.get(f.day);
    if (!e) m.set(f.day, { ...f });
    else {
      e.inBase += f.inBase;
      e.outBase += f.outBase;
      e.endOutBase += f.endOutBase;
      e.incomeBase += f.incomeBase;
      e.feesBase += f.feesBase;
    }
  }
  const flowDays = new Set<number>();
  for (const m of byInst.values()) for (const d of m.keys()) flowDays.add(d);

  // Requests: close(base), close(to), and close(f-1), pre(f), close(f) for every flow day.
  type Req = { stateDay: number; priceDay: number; pre: boolean; full: boolean; key: string };
  const reqs: Req[] = [];
  const keyClose = (d: number) => `c${d}`;
  const keyPre = (d: number) => `p${d}`;
  const seen = new Set<string>();
  const add = (r: Req) => {
    if (seen.has(r.key)) {
      if (r.full) reqs.find((x) => x.key === r.key)!.full = true;
      return;
    }
    seen.add(r.key);
    reqs.push(r);
  };
  add({ stateDay: baseDay, priceDay: baseDay, pre: false, full: true, key: keyClose(baseDay) });
  for (const d of Array.from(flowDays).sort((a, b) => a - b)) {
    add({ stateDay: d - 1, priceDay: d - 1, pre: false, full: false, key: keyClose(d - 1) });
    add({ stateDay: d - 1, priceDay: d, pre: true, full: false, key: keyPre(d) });
    add({ stateDay: d, priceDay: d, pre: false, full: false, key: keyClose(d) });
  }
  add({ stateDay: toDay, priceDay: toDay, pre: false, full: true, key: keyClose(toDay) });
  reqs.sort((a, b) => a.stateDay - b.stateDay || (a.pre === b.pre ? a.priceDay - b.priceDay : a.pre ? 1 : -1));

  const snaps = new Map<string, Snap>();
  const runner = new Ledger(ctx);
  for (const r of reqs) {
    runner.applyUntil(r.stateDay);
    const ov = r.pre ? ctx.firstTradePrice.get(r.priceDay) : undefined;
    const snap: Snap = { value: new Map() };
    if (r.full) snap.unreal = new Map();
    for (const [id, book] of runner.books) {
      if (book.quantity === 0) continue;
      const inst = runner.instrumentOf.get(id);
      if (!inst) continue;
      const pv = valuePosition(runner, book, inst, r.priceDay, r.priceDay, ov?.get(id));
      snap.value.set(id, pv.mvBase);
      if (snap.unreal) {
        const C = book.costBasis;
        const CB = book.costBasisBase;
        const X0 = C !== 0 ? CB / C : (pv.rate ?? 0);
        const u = pv.mvBase - CB;
        snap.unreal.set(id, { u, ufx: u - (pv.mv - C) * X0, q: book.quantity });
      }
    }
    snaps.set(r.key, snap);
  }
  const val = (key: string, id: string) => snaps.get(key)?.value.get(id) ?? 0;
  const startSnap = snaps.get(keyClose(baseDay))!;
  const endSnap = snaps.get(keyClose(toDay))!;

  const ids = new Set<string>([...byInst.keys(), ...startSnap.value.keys(), ...endSnap.value.keys()]);
  const out: PositionPerformance[] = [];
  for (const id of ids) {
    const inst = full.instrumentOf.get(id) ?? ctx.instruments.get(id);
    const flows = Array.from(byInst.get(id)?.values() ?? []).sort((a, b) => a.day - b.day);
    const startV = val(keyClose(baseDay), id);
    const endV = val(keyClose(toDay), id);
    let scale = Math.max(Math.abs(startV), Math.abs(endV));
    for (const f of flows) scale = Math.max(scale, f.inBase, f.outBase, Math.abs(f.endOutBase));
    const eps = Math.max(1e-12, 1e-9 * scale);
    const ignore = () => undefined;

    let g = 1;
    let prev = startV;
    let last = baseDay;
    for (const f of flows) {
      const d = f.day;
      if (d - 1 > last) {
        const v = val(keyClose(d - 1), id);
        g *= 1 + subReturn(v, prev, eps, ignore);
        prev = v;
      }
      const pre = val(keyPre(d), id);
      const close = val(keyClose(d), id);
      const ra = subReturn(pre, prev, eps, ignore);
      const den = pre + f.inBase - f.outBase;
      let rb: number;
      if (den > eps) rb = (close + f.endOutBase) / den - 1;
      else if (pre + f.inBase > eps) rb = (close + f.endOutBase + f.outBase) / (pre + f.inBase) - 1;
      else rb = subReturn(close + f.endOutBase + f.outBase, pre + f.inBase, eps, ignore);
      g *= (1 + ra) * (1 + rb);
      prev = close;
      last = d;
    }
    if (toDay > last) g *= 1 + subReturn(endV, prev, eps, ignore);
    const twr = g - 1;

    const invested = flows.reduce((s, f) => s + f.inBase, 0);
    const income = flows.reduce((s, f) => s + f.incomeBase, 0);
    const proceeds = flows.reduce((s, f) => s + f.outBase + (f.endOutBase - f.incomeBase), 0);
    const fees = flows.reduce((s, f) => s + f.feesBase, 0);
    const realizedRows = full.realized.filter((r) => r.instrumentId === id && r.day > baseDay && r.day <= toDay);
    const realized = realizedRows.reduce((s, r) => s + r.gainBase, 0);
    const realizedFx = realizedRows.reduce((s, r) => s + (r.fxGainBase ?? 0), 0);
    const u0 = startSnap.unreal?.get(id);
    const u1 = endSnap.unreal?.get(id);
    const totalReturn = endV - startV - invested + proceeds + income;

    const cf: { date: ISODate; amount: number }[] = [];
    if (Math.abs(startV) > eps) cf.push({ date: dayToIso(baseDay), amount: -startV });
    for (const f of flows) cf.push({ date: dayToIso(f.day), amount: -f.inBase + f.outBase + f.endOutBase });
    if (Math.abs(endV) > eps) cf.push({ date: to, amount: endV });
    const x = xirrDetailed(cf, 0.1, 'ACT/ACT');

    const p: PositionPerformance = {
      instrumentId: id,
      currency: inst?.currency ?? ctx.base,
      from,
      to,
      quantityStart: u0?.q ?? 0,
      quantityEnd: u1?.q ?? 0,
      startValueBase: startV,
      endValueBase: endV,
      investedBase: invested,
      proceedsBase: proceeds,
      incomeBase: income,
      feesBase: fees,
      realizedGainBase: realized,
      unrealizedGainBase: (u1?.u ?? 0) - (u0?.u ?? 0),
      fxGainBase: realizedFx + (u1?.ufx ?? 0) - (u0?.ufx ?? 0),
      totalReturnBase: totalReturn,
      twr,
    };
    if (years >= 1 - 1e-12 && twr > -1) p.twrAnnualized = Math.pow(1 + twr, 1 / years) - 1;
    if (x.rate !== undefined) {
      p.irr = x.rate;
      p.irrPeriod = Math.pow(1 + x.rate, years) - 1;
    }
    const denom = startV + invested;
    if (denom > eps) p.simpleReturn = totalReturn / denom;
    out.push(p);
  }
  return out.sort((a, b) => b.endValueBase - a.endValueBase || b.totalReturnBase - a.totalReturnBase);
}
