/**
 * Performance budget: 10-year portfolio, 2,000 transactions, 40 instruments with daily
 * (business-day) prices, daily valueSeries in < 1.5 s in Node.
 */
import { describe, expect, it } from 'vitest';
import { createEngine, monthlyPerformance, performanceSummary, positionPerformance, valuePortfolio, valueSeries } from './api';
import { dayToIso, isoToDay } from './dates';
import { engine, inst } from './__fixtures__/helpers';
import type { FxSeries, Instrument, PriceSeries, Transaction } from './types';

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), a | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function bigPortfolio() {
  const rand = rng(42);
  const ccys = ['COP', 'BRL', 'USD', 'EUR'];
  const start = isoToDay('2015-01-01');
  const end = isoToDay('2024-12-31');
  const businessDays: number[] = [];
  for (let d = start; d <= end; d++) {
    const wd = new Date(d * 86_400_000).getUTCDay();
    if (wd !== 0 && wd !== 6) businessDays.push(d);
  }
  const instruments: Instrument[] = [];
  const prices: PriceSeries[] = [];
  for (let i = 0; i < 40; i++) {
    const ccy = ccys[i % 4]!;
    const id = `X:I${i}`;
    instruments.push(inst(id, ccy));
    let p = 10 + 90 * rand();
    prices.push({
      instrumentId: id,
      currency: ccy,
      source: 't',
      points: businessDays.map((d) => {
        p *= 1 + (rand() - 0.495) * 0.03;
        return { date: dayToIso(d), close: p };
      }),
    });
  }
  const fx: FxSeries[] = [
    ['USD', 'COP', 3000],
    ['USD', 'BRL', 4],
    ['EUR', 'USD', 1.1],
  ].map(([b, q, r0]) => {
    let r = r0 as number;
    return {
      base: b as string,
      quote: q as string,
      source: 't',
      points: businessDays.map((d) => {
        r *= 1 + (rand() - 0.5) * 0.01;
        return { date: dayToIso(d), rate: r };
      }),
    };
  });
  const transactions: Transaction[] = [];
  const held = new Map<string, number>();
  for (let k = 0; k < 2000; k++) {
    const day = businessDays[Math.floor((k / 2000) * businessDays.length)]!;
    const i = Math.floor(rand() * 40);
    const id = `X:I${i}`;
    const ccy = ccys[i % 4]!;
    const price = 50;
    const q = held.get(id) ?? 0;
    const r = rand();
    const base = { id: `t${k}`, portfolioId: 'p1', date: dayToIso(day), currency: ccy };
    if (r < 0.1) transactions.push({ ...base, type: 'DEPOSIT', amount: 10_000 });
    else if (r < 0.2 && q > 0) transactions.push({ ...base, type: 'DIVIDEND', instrumentId: id, amount: q * 0.5, taxes: q * 0.05 });
    else if (r < 0.35 && q > 2) {
      const s = Math.floor(q / 2);
      held.set(id, q - s);
      transactions.push({ ...base, type: 'SELL', instrumentId: id, quantity: s, price, fees: 1 });
    } else if (r < 0.37) transactions.push({ ...base, type: 'WITHDRAWAL', amount: 500 });
    else {
      const b = 1 + Math.floor(rand() * 20);
      held.set(id, q + b);
      transactions.push({ ...base, type: 'BUY', instrumentId: id, quantity: b, price, fees: 1 });
    }
  }
  return engine({ base: 'COP', instruments, prices, fx, transactions, options: { asOf: '2024-12-31' } });
}

describe('performance', () => {
  const input = bigPortfolio();

  it('daily valueSeries over 10 years with 2,000 transactions and 40 instruments runs < 1.5 s', () => {
    valueSeries(input, { from: '2015-01-01', to: '2015-02-01', step: 'day' }); // warm-up (JIT)
    const t0 = performance.now();
    const s = valueSeries(input, { from: '2015-01-01', to: '2024-12-31', step: 'day' });
    const ms = performance.now() - t0;
    expect(s).toHaveLength(isoToDay('2024-12-31') - isoToDay('2015-01-01') + 1);
    expect(s.every((p) => Number.isFinite(p.valueBase) && Number.isFinite(p.cumulativeTwr))).toBe(true);
    expect(ms).toBeLessThan(1500);
  });

  it('monthly table, summary and valuation are fast and consistent', () => {
    const t0 = performance.now();
    const rows = monthlyPerformance(input);
    const si = performanceSummary(input, 'SI', '2024-12-31');
    const v = valuePortfolio(input, '2024-12-31');
    const ms = performance.now() - t0;
    expect(rows).toHaveLength(120);
    expect(si.twr).toBeCloseTo(rows[119]!.cumulativeTwr, 8);
    expect(v.totalMarketValueBase).toBeCloseTo(rows[119]!.endValueBase, 4);
    for (const r of rows) expect(r.localReturn! + r.fxReturn!).toBeCloseTo(r.twr, 12);
    expect(ms).toBeLessThan(1500);
  });

  it('dashboard: 10 period summaries + position performance on a fresh engine < 1.5 s', () => {
    const t0 = performance.now();
    const eng = createEngine(input);
    const out = (['MTD', 'QTD', 'YTD', '1M', '3M', '6M', '1Y', '3Y', '5Y', 'SI'] as const).map((p) => eng.summary(p, '2024-12-31'));
    const pos = eng.positions('SI', '2024-12-31');
    const ms = performance.now() - t0;
    expect(out.every((s) => Number.isFinite(s.twr))).toBe(true);
    expect(pos.length).toBe(40);
    expect(ms).toBeLessThan(1500);
    // stateless API agrees with the engine
    expect(performanceSummary(input, '1Y', '2024-12-31').twr).toBeCloseTo(out[6]!.twr, 12);
    expect(positionPerformance(input, 'SI', '2024-12-31').length).toBe(40);
  });
});
