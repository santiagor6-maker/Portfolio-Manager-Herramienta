import { describe, expect, it } from 'vitest';
import {
  buildHistory,
  dateInZone,
  dedupeByDate,
  endOfMonth,
  fillCalendarDays,
  isISODate,
  roundSig,
  toMonthEnd,
  type YahooChartResult,
} from '../src/index';
import { fixtureJson } from './helpers';

const chart = (f: string): YahooChartResult => fixtureJson(`yahoo/${f}`).chart.result[0];

describe('dates', () => {
  it('validates ISO dates', () => {
    expect(isISODate('2025-02-28')).toBe(true);
    expect(isISODate('2025-02-30')).toBe(false);
    expect(isISODate('2025-2-3')).toBe(false);
    expect(isISODate(undefined)).toBe(false);
  });
  it('end of month incl. leap years', () => {
    expect(endOfMonth('2024-02-10')).toBe('2024-02-29');
    expect(endOfMonth('2025-12-01')).toBe('2025-12-31');
  });
  it('converts epoch to exchange-local date', () => {
    // 2025-01-02 00:30 UTC is still Jan 1 in Bogotá / New York
    const t = Date.UTC(2025, 0, 2, 0, 30) / 1000;
    expect(dateInZone(t, 'America/Bogota')).toBe('2025-01-01');
    expect(dateInZone(t, 'Europe/Madrid')).toBe('2025-01-02');
    expect(dateInZone(t, 'Not/AZone', -5 * 3600)).toBe('2025-01-01');
  });
});

describe('series helpers', () => {
  it('toMonthEnd keeps the last point of each month with its real date', () => {
    const pts = [
      { date: '2025-01-30', close: 1 },
      { date: '2025-01-31', close: 2 },
      { date: '2025-02-27', close: 3 },
      { date: '2025-02-28', close: 4 },
      { date: '2025-03-03', close: 5 },
    ];
    expect(toMonthEnd(pts)).toEqual([
      { date: '2025-01-31', close: 2 },
      { date: '2025-02-28', close: 4 },
      { date: '2025-03-03', close: 5 },
    ]);
  });
  it('fillCalendarDays carries values forward and seeds from before `from`', () => {
    const pts = [
      { date: '2025-01-03', rate: 10 },
      { date: '2025-01-06', rate: 11 },
    ];
    expect(fillCalendarDays(pts, '2025-01-04', '2025-01-07').map((p) => [p.date, p.rate])).toEqual([
      ['2025-01-04', 10],
      ['2025-01-05', 10],
      ['2025-01-06', 11],
      ['2025-01-07', 11],
    ]);
  });
  it('dedupeByDate keeps the last occurrence and sorts', () => {
    expect(dedupeByDate([{ date: '2025-01-02', v: 1 }, { date: '2025-01-01', v: 0 }, { date: '2025-01-02', v: 2 }])).toEqual([
      { date: '2025-01-01', v: 0 },
      { date: '2025-01-02', v: 2 },
    ]);
  });
  it('roundSig removes float32 noise', () => {
    expect(roundSig(4284.100098)).toBe(4284.1);
    expect(roundSig(1.0351860523223877)).toBe(1.035186);
  });
});

describe('month-end closes from daily vs Yahoo 1mo bars (PETR4.SA fixture)', () => {
  const daily = buildHistory(chart('chart-PETR4.SA-1d.json'), 'PETR4.SA', '2024-11-01', '2025-03-14', []);
  const monthEnd = toMonthEnd(daily.points);

  it('uses the last trading day of each month', () => {
    expect(monthEnd).toEqual([
      { date: '2024-11-29', close: 38.9 },
      { date: '2024-12-30', close: 36.19 },
      { date: '2025-01-31', close: 37.69 },
      { date: '2025-02-28', close: 35.93 },
      { date: '2025-03-14', close: 35.5 }, // partial month: last available close
    ]);
  });

  it('documents why Yahoo 1mo bars are not used: labelled at month START and the last bar ignores period2', () => {
    const m = chart('chart-PETR4.SA-1mo.json');
    const off = m.meta.gmtoffset ?? 0;
    const bars = (m.timestamp ?? []).map((t, i) => ({ date: dateInZone(t, m.meta.exchangeTimezoneName, off), close: m.indicators!.quote![0]!.close![i] }));
    expect(bars[0]!.date).toBe('2024-11-01'); // holds the November close (38.90), dated Nov 1st
    expect(bars[0]!.close).toBeCloseTo(38.9, 2);
    // Requested until 2025-03-14 (close 35.50) but the March bar holds a later close.
    const march = bars.find((b) => b.date === '2025-03-01')!;
    expect(march.close).not.toBeCloseTo(35.5, 2);
    // Closed months agree in value, only the date label is shifted.
    for (const me of monthEnd.slice(0, 4)) {
      const bar = bars.find((b) => b.date === `${me.date.slice(0, 7)}-01`)!;
      expect(bar.close).toBeCloseTo(me.close, 2);
    }
  });

  it('extracts dividends in local dates', () => {
    expect(daily.dividends).toEqual([
      { date: '2024-12-12', amount: 1.551743 },
      { date: '2024-12-26', amount: 1.356891 },
    ]);
  });
});
