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

describe('core R8: renamed tickers', async () => {
  const { canonicalInstrument, canonicalId, withRenamedAliases } = await import('../lib/renames');
  const old = { id: 'XBOG:PFBCOLOM', symbol: 'PFBCOLOM', name: 'Bancolombia Preferencial', exchange: 'XBOG', currency: 'COP', country: 'CO', assetClass: 'equity' as const, providerSymbols: { yahoo: 'PFBCOLOM.CL' } };
  it('creates and looks up instruments under the current id, remembering the old symbol', () => {
    expect(canonicalId('XBOG:PFBCOLOM')).toBe('XBOG:PFCIBEST');
    expect(canonicalId('XNAS:AAPL')).toBe('XNAS:AAPL');
    const c = canonicalInstrument(old);
    expect(c).toMatchObject({ id: 'XBOG:PFCIBEST', symbol: 'PFCIBEST', renamedFrom: 'PFBCOLOM', currency: 'COP' });
    expect(c.providerSymbols).toBeUndefined();
    expect(withRenamedAliases([old]).map((i) => i.id)).toEqual(['XBOG:PFBCOLOM', 'XBOG:PFCIBEST']);
  });
  it('stores transactions of an old ticker under the new id (but not a ticker-change row)', async () => {
    const { saveTransaction } = await import('../db/repo');
    const a = await saveTransaction({ portfolioId: 'p', date: '2026-01-02', type: 'BUY', instrumentId: 'XBOG:PFBCOLOM', quantity: 1, price: 1, currency: 'COP' });
    expect(a.instrumentId).toBe('XBOG:PFCIBEST');
    const b = await saveTransaction({ portfolioId: 'p', date: '2026-01-02', type: 'SPLIT', subtype: 'TICKER_CHANGE', instrumentId: 'XBOG:PFBCOLOM', targetInstrumentId: 'XBOG:PFCIBEST', ratio: 1, currency: 'COP' });
    expect(b.instrumentId).toBe('XBOG:PFBCOLOM');
  });
  it('describes the new diagnostics from their structured data', async () => {
    const { describeDiagnostic } = await import('../lib/diagnosticText');
    const t = (k: string, o?: Record<string, unknown>) => `${k}|${JSON.stringify(o)}`;
    const out = describeDiagnostic(
      { code: 'COST_FRACTION_ESTIMATED', date: '2026-01-02', message: 'x', data: { instrumentId: 'BVMF:ABC3', targetInstrumentId: 'BVMF:XYZ3', costFraction: 0.125 } },
      { instruments: new Map(), locale: 'es-CO', t },
    );
    expect(out).toContain('"target":"XYZ3"');
    expect(out).toContain('12,5');
  });
});
