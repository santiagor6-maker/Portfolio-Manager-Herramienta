import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db, resetDbInstance } from '../db/schema';
import { mergePriceSeries } from '../db/repo';
import { requestSymbol, responseMatches } from '../services/marketData';
import { splitSuggestion, unitFactor } from '../lib/diagnosticText';

let n = 0;
beforeEach(() => resetDbInstance(`r4-${++n}`));
afterEach(async () => {
  await db.delete();
});

describe('market-data M37', () => {
  it('stores series.seed on its own date and never over an existing close', async () => {
    await mergePriceSeries({ instrumentId: 'XBOG:ISA', currency: 'COP', source: 'yahoo', points: [{ date: '2026-09-28', close: 100 }] });
    await mergePriceSeries({
      instrumentId: 'XBOG:ISA',
      currency: 'COP',
      source: 'yahoo',
      points: [{ date: '2026-10-02', close: 110 }],
      seed: { date: '2026-09-28', close: 999 },
    } as never);
    await mergePriceSeries({ instrumentId: 'XBOG:ISA', currency: 'COP', source: 'yahoo', points: [], seed: { date: '2026-09-25', close: 95 } } as never);
    const s = await db.priceSeries.get('XBOG:ISA');
    expect(s!.points).toEqual([
      { date: '2026-09-25', close: 95 },
      { date: '2026-09-28', close: 100 },
      { date: '2026-10-02', close: 110 },
    ]);
  });

  it('requests by instrument id and rejects another listing or currency', () => {
    const dte = { id: 'XETR:DTE', symbol: 'DTE', name: 'Deutsche Telekom', exchange: 'XETR', currency: 'EUR', country: 'DE', assetClass: 'equity' as const, providerSymbols: { yahoo: 'DTE.DE' } };
    expect(requestSymbol(dte)).toBe('XETR:DTE');
    expect(requestSymbol({ ...dte, id: 'custom-1' })).toBe('DTE.DE');
    expect(responseMatches(dte, { id: 'XETR:DTE', currency: 'EUR' })).toBe(true);
    expect(responseMatches(dte, { id: 'XNYS:DTE', currency: 'USD' })).toBe(false); // US DTE Energy
    expect(responseMatches(dte, { id: 'XETR:DTE', currency: 'USD' })).toBe(false);
    expect(responseMatches({ ...dte, currency: 'GBP' }, { id: 'XETR:DTE', currency: 'GBp' })).toBe(true);
  });
});

describe('core R7 diagnostics', () => {
  it('reads the unit factor and the suggested split', () => {
    expect(unitFactor('Trade price 2450 of XBOG:ISA is 10.0x the previous reference 245.0000 (2026-01-02), close to a factor of 10: likely a unit')).toBe(10);
    expect(unitFactor('… close to a factor of 1/100: likely …')).toBeCloseTo(0.01);
    expect(splitSuggestion('The price of XNAS:NVDA went from 1200 (2024-06-07) to 121 (2024-06-10), close to a 10:1 split, and no split is recorded; if there was one, record it')).toEqual({ instrumentId: 'XNAS:NVDA', ratio: 10, date: '2024-06-10' });
    // Core R8 structured fields win over the message.
    expect(splitSuggestion('anything', { instrumentId: 'XNAS:NVDA', ratioFrom: 1, ratioTo: 10, splitRatio: 10, dateTo: '2024-06-10' })).toEqual({ instrumentId: 'XNAS:NVDA', ratio: 10, date: '2024-06-10' });
    expect(splitSuggestion('The price of BVMF:XYZ3 went from 1 (2024-01-02) to 10 (2024-01-03), close to a 1:10 reverse split, and no split is recorded')).toEqual({ instrumentId: 'BVMF:XYZ3', ratio: 0.1, date: '2024-01-03' });
  });
});
