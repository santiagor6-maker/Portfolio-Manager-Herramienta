/** Round 5 design gaps (reviews/web-design-r1.md). */
import { describe, expect, it } from 'vitest';
import { colorSlots, OTHER_SLOT } from '../lib/seriesColors';
import { niceTicks } from '../lib/chartMath';
import { monthWithoutPrices } from '../hooks/useAnalysis';
import { heatStyle, HEAT_CAP_YEAR } from '../pages/Monthly';

describe('D6: colour follows the entity', () => {
  it('keeps COP/USD/BRL colours whatever their rank', () => {
    const a = colorSlots('currency', ['COP', 'USD', 'BRL']);
    const b = colorSlots('currency', ['USD', 'BRL', 'COP']);
    expect(a.get('COP')).toBe(b.get('COP'));
    expect(a.get('USD')).toBe(b.get('USD'));
    expect(a.get('COP')).toBe(0);
    expect(a.get('USD')).toBe(1);
  });
  it('never repeats a colour inside one chart and keeps "Otros" grey', () => {
    const keys = ['CO', 'US', 'BR', 'X1', 'X2', 'X3', '__other'];
    const m = colorSlots('country', keys);
    const slots = keys.filter((k) => k !== '__other').map((k) => m.get(k));
    expect(new Set(slots).size).toBe(slots.length);
    expect(m.get('__other')).toBe(OTHER_SLOT);
  });
});

describe('D16: round axis ticks', () => {
  it('uses 1-2-5 steps covering the data', () => {
    const t = niceTicks(372.1e6, 404.7e6);
    expect(t[0]).toBeLessThanOrEqual(372.1e6);
    expect(t[t.length - 1]).toBeGreaterThanOrEqual(404.7e6);
    const step = t[1]! - t[0]!;
    expect([1, 2, 5, 10].some((m) => Math.abs(step / Math.pow(10, Math.floor(Math.log10(step))) - m) < 1e-9)).toBe(true);
    expect(t.every((v) => v % step === 0)).toBe(true);
  });
});

describe('D4: current month without prices', () => {
  it('is detected only when no price falls inside the month', () => {
    expect(monthWithoutPrices({ asOf: '2026-10-23', latestPriceDate: '2026-09-30' })).toBe('2026-10');
    expect(monthWithoutPrices({ asOf: '2026-10-23', latestPriceDate: '2026-10-22' })).toBeUndefined();
    expect(monthWithoutPrices({ asOf: '2026-10-23' })).toBeUndefined();
  });
});

describe('D10: heat map scale', () => {
  it('uses theme tokens and a separate cap for the year column', () => {
    expect(String(heatStyle(0.08)?.background)).toContain('var(--heat-pos)');
    expect(String(heatStyle(-0.08)?.background)).toContain('var(--heat-neg)');
    expect(String(heatStyle(0.08)?.background)).toContain('* 1.000');
    expect(String(heatStyle(0.08, HEAT_CAP_YEAR)?.background)).toContain('* 0.333');
    expect(heatStyle(NaN)).toBeUndefined();
  });
});
