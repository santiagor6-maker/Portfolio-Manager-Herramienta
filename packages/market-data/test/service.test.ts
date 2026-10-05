import { describe, expect, it } from 'vitest';
import { CATALOG, InstrumentCatalog, MemoryStore, TieredCache, yahooSymbolFromId } from '../src/index';
import { createTestService, NOW } from './helpers';

function isinValid(isin: string): boolean {
  if (!/^[A-Z]{2}[A-Z0-9]{9}\d$/.test(isin)) return false;
  const digits = [...isin.slice(0, 11)].map((c) => parseInt(c, 36).toString()).join('');
  let sum = 0;
  [...digits].reverse().forEach((ch, i) => {
    let d = Number(ch);
    if (i % 2 === 0) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  });
  return (10 - (sum % 10)) % 10 === Number(isin[11]);
}

describe('curated catalog', () => {
  const cat = new InstrumentCatalog();

  it('has unique ids and the expected coverage', () => {
    const ids = CATALOG.instruments.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    const count = (ex: string) => CATALOG.instruments.filter((i) => i.exchange === ex).length;
    expect(count('XBOG')).toBeGreaterThanOrEqual(25);
    expect(count('BVMF')).toBeGreaterThanOrEqual(60);
    expect(CATALOG.instruments.filter((i) => i.assetClass === 'reit' && i.exchange === 'BVMF').length).toBeGreaterThanOrEqual(5);
  });

  it('ids map to their Yahoo symbol, ISINs have valid check digits', () => {
    for (const i of CATALOG.instruments) {
      expect(i.providerSymbols?.yahoo, i.id).toBeTruthy();
      expect(yahooSymbolFromId(i.id), i.id).toBe(i.providerSymbols!.yahoo);
      if (i.isin) expect(isinValid(i.isin), `${i.id} ${i.isin}`).toBe(true);
    }
  });

  it('benchmarks point at catalog instruments', () => {
    for (const b of CATALOG.benchmarks) expect(cat.get(b.instrumentId), b.id).toBeDefined();
    expect(cat.resolve('COLCAP')?.id).toBe('XBOG:ICOLCAP');
    expect(cat.resolve('IBOV')?.id).toBe('INDEX:^BVSP');
  });

  it('search is accent/case-insensitive and ranks symbol matches first', () => {
    expect(cat.search('petr4')[0]?.id).toBe('BVMF:PETR4');
    expect(cat.search('energia bogota').map((r) => r.id)).toContain('XBOG:GEB');
    expect(cat.search('Itaú').map((r) => r.id)).toContain('BVMF:ITUB4');
    expect(cat.search('bancolombia').map((r) => r.id)).toEqual(['XBOG:CIBEST', 'XBOG:PFCIBEST']);
    expect(cat.search('US0378331005')[0]?.id).toBe('XNAS:AAPL');
  });

  it('resolves ids, Yahoo symbols and ISINs', () => {
    expect(cat.resolve('bvmf:petr4')?.providerSymbols?.yahoo).toBe('PETR4.SA');
    expect(cat.resolve('ECOPETROL.CL')?.id).toBe('XBOG:ECOPETROL');
    expect(cat.resolve('IE00B5BMR087')).toBeDefined();
  });
});

describe('MarketDataService', () => {
  it('history by instrument id, month-end interval, with corporate actions', async () => {
    const { service } = createTestService();
    const h = await service.history({ symbol: 'XBOG:ECOPETROL', from: '2025-01-01', to: '2025-04-30', interval: '1mo' });
    expect(h.instrument).toMatchObject({ id: 'XBOG:ECOPETROL', currency: 'COP', isin: 'COC04PA00016' });
    expect(h.series).toEqual({
      instrumentId: 'XBOG:ECOPETROL',
      currency: 'COP',
      source: 'yahoo',
      points: [
        { date: '2025-01-31', close: 1960 },
        { date: '2025-02-28', close: 2060 },
        { date: '2025-03-31', close: 2075 },
        { date: '2025-04-30', close: 1725 },
      ],
    });
    expect(h.actions).toEqual([
      { instrumentId: 'XBOG:ECOPETROL', date: '2025-03-31', type: 'DIVIDEND', amountPerShare: 107 },
      { instrumentId: 'XBOG:ECOPETROL', date: '2025-04-23', type: 'DIVIDEND', amountPerShare: 107 },
    ]);
  });

  it('history by bare Yahoo symbol resolves to the catalog instrument id', async () => {
    const { service } = createTestService();
    const h = await service.history({ symbol: 'NVDA', from: '2024-06-07', to: '2024-06-10' });
    expect(h.instrument.id).toBe('XNAS:NVDA');
    expect(h.actions).toEqual([{ instrumentId: 'XNAS:NVDA', date: '2024-06-10', type: 'SPLIT', ratio: 10 }]);
  });

  it('builds the instrument from chart meta for symbols outside the catalog', async () => {
    const { service } = createTestService();
    const h = await service.history({ symbol: 'NVDA', from: '2024-06-07', to: '2024-06-10' }); // warm
    expect(h.instrument.name).toBeTruthy();
    const svc2 = createTestService({}, { catalog: new InstrumentCatalog({ version: 't', updated: '2026-10-05', instruments: [], benchmarks: [] }) }).service;
    const v = await svc2.history({ symbol: 'VOD.L', from: '2025-06-02', to: '2025-06-30' });
    expect(v.instrument).toMatchObject({ id: 'XLON:VOD', currency: 'GBP', country: 'GB', assetClass: 'equity', exchange: 'XLON' });
    expect(v.notes?.join(' ')).toMatch(/GBp/);
  });

  it('caches closed ranges (second call does not hit the network) and persists them', async () => {
    const store = new MemoryStore();
    const { service, fetch } = createTestService({}, { cache: new TieredCache({ store, now: () => NOW.getTime() }) });
    await service.history({ symbol: 'PETR4.SA', from: '2024-11-01', to: '2025-02-28', interval: '1mo' });
    const n = fetch.calls.length;
    await service.history({ symbol: 'BVMF:PETR4', from: '2024-11-01', to: '2025-02-28', interval: '1d' });
    expect(fetch.calls.length).toBe(n);
    const persisted = [...store.data.entries()].find(([k]) => k.startsWith('hist:yahoo:PETR4.SA'));
    expect(persisted?.[1].expiresAt).toBeNull();
  });

  it('quote with stale flag and catalog name', async () => {
    const { service } = createTestService();
    const q = await service.quote('XBOG:ECOPETROL');
    expect(q).toMatchObject({ instrumentId: 'XBOG:ECOPETROL', requested: 'XBOG:ECOPETROL', currency: 'COP', price: 2705, previousClose: 2700 });
    expect(q.stale).toBeUndefined();
  });

  it('search merges catalog and Yahoo results without duplicates', async () => {
    const { service } = createTestService();
    const { results } = await service.search('ecopetrol');
    const ys = results.map((r) => r.providerSymbols?.yahoo);
    expect(new Set(ys).size).toBe(ys.length);
    expect(results[0]).toMatchObject({ id: 'XBOG:ECOPETROL', origin: 'catalog' });
    expect(results.find((r) => r.id === 'XMUN:ECHA')?.origin).toBe('yahoo');
  });

  it('search degrades to catalog-only when Yahoo is down', async () => {
    const { service } = createTestService({ failingHosts: ['query2.finance.yahoo.com'] });
    const r = await service.search('petrobras');
    expect(r.results.length).toBeGreaterThan(0);
    expect(r.warnings?.[0]).toMatch(/unavailable/);
  });

  it('validates inputs with helpful errors', async () => {
    const { service } = createTestService();
    await expect(service.history({ symbol: 'PETR4.SA', from: '2025-13-01' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(service.history({ symbol: 'PETR4.SA', from: '2025-02-01', to: '2025-01-01' })).rejects.toThrow(/after/);
    await expect(service.history({ symbol: 'PETR4.SA', from: '2030-01-01' })).rejects.toThrow(/future/);
    await expect(service.history({ symbol: 'ZZZZ:FOO', from: '2025-01-01' })).rejects.toThrow(/Unknown exchange/);
    await expect(service.history({ symbol: 'PETR4.SA', from: '2025-01-01', interval: '1w' as never })).rejects.toThrow(/interval/);
    await expect(service.fxSeries({ base: 'US', quote: 'COP', from: '2025-01-01' })).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(service.history({ symbol: 'NOPE.SA', from: '2025-01-01', to: '2025-01-31' })).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('batch settles each item independently', async () => {
    const { service } = createTestService();
    const r = await service.batch({
      histories: [
        { symbol: 'BVMF:PETR4', from: '2024-11-01', to: '2025-02-28', interval: '1mo' },
        { symbol: 'NOPE.SA', from: '2025-01-01', to: '2025-01-31' },
      ],
      fx: [{ base: 'USD', quote: 'COP', from: '2025-01-01', to: '2025-02-28', interval: '1mo' }],
      quotes: ['AAPL'],
    });
    expect(r.histories[0]).toMatchObject({ ok: true });
    expect(r.histories[1]).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect(r.fx[0]).toMatchObject({ ok: true, data: { series: { source: 'banrep-trm' } } });
    expect(r.quotes[0]).toMatchObject({ ok: true, data: { price: 333.69 } });
  });
});
