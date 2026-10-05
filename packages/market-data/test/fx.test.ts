import { describe, expect, it } from 'vitest';
import {
  chunkRange,
  combine,
  expandTrm,
  parseCsv,
  parseEcbCsv,
  parsePtaxRows,
  parseSgsRows,
  toMonthEnd,
  type TrmRecord,
} from '../src/index';
import { createTestService, fixture, fixtureJson } from './helpers';

const trm = fixtureJson<TrmRecord[]>('banrep/trm-2025-01-04.json');
const rateOn = (pts: { date: string; rate: number }[], d: string) => pts.find((p) => p.date === d)?.rate;

describe('Banrep TRM (datos.gov.co 32sa-8pi3)', () => {
  const pts = expandTrm(trm, '2025-01-01', '2025-04-30');

  it('has one point per calendar day, weekends and holidays included', () => {
    expect(pts.length).toBe(120);
    expect(pts[0]).toEqual({ date: '2025-01-01', rate: 4409.15 }); // holiday: TRM certified 31-Dec
    expect(rateOn(pts, '2025-01-02')).toBe(4409.15);
    expect(rateOn(pts, '2025-01-03')).toBe(4410.5);
  });

  it('applies the Friday TRM to Saturday, Sunday and the Monday holiday (Reyes, 6-Jan-2025)', () => {
    for (const d of ['2025-01-04', '2025-01-05', '2025-01-06', '2025-01-07']) expect(rateOn(pts, d)).toBe(4355.51);
    expect(rateOn(pts, '2025-01-08')).toBe(4342.31);
  });

  it('month-end TRM is the rate valid on the last CALENDAR day', () => {
    expect(toMonthEnd(pts).map((p) => [p.date, p.rate])).toEqual([
      ['2025-01-31', 4170.01],
      ['2025-02-28', 4120.11],
      ['2025-03-31', 4192.57], // Monday 31-Mar, certified for 29..31 Mar
      ['2025-04-30', 4198.83],
    ]);
  });

  it('clips to the requested window and skips invalid values', () => {
    const p = expandTrm([...trm, { valor: 'x', vigenciadesde: '2025-05-01T00:00:00.000', vigenciahasta: '2025-05-01T00:00:00.000' }], '2025-01-05', '2025-01-06');
    expect(p).toEqual([
      { date: '2025-01-05', rate: 4355.51 },
      { date: '2025-01-06', rate: 4355.51 },
    ]);
  });
});

describe('BCB PTAX / SGS parsing', () => {
  it('PTAX USD: selling rate (cotacaoVenda) per day', () => {
    const p = parsePtaxRows(fixtureJson('bcb/ptax-usd-2025-01.json').value);
    expect(p[0]).toEqual({ date: '2025-01-02', rate: 6.1916 });
    expect(p.at(-1)).toEqual({ date: '2025-02-03', rate: 5.8647 });
  });
  it('PTAX EUR: keeps only the closing bulletin (Fechamento)', () => {
    const p = parsePtaxRows(fixtureJson('bcb/ptax-eur-2025-01.json').value);
    expect(p).toEqual([
      { date: '2025-01-02', rate: 6.402 },
      { date: '2025-01-03', rate: 6.333 },
      { date: '2025-01-06', rate: 6.3668 },
      { date: '2025-01-31', rate: 6.059 },
    ]);
  });
  it('SGS: DD/MM/YYYY dates and string values', () => {
    expect(parseSgsRows(fixtureJson('bcb/sgs-1-2025-01.json')).slice(0, 2)).toEqual([
      { date: '2025-01-02', rate: 6.1916 },
      { date: '2025-01-03', rate: 6.1506 },
    ]);
    expect(parseSgsRows([{ data: '02/01/2025', valor: '6,1916' }])).toEqual([{ date: '2025-01-02', rate: 6.1916 }]);
  });
  it('chunks long ranges (SGS accepts at most 10 years per request)', () => {
    expect(chunkRange('2001-03-15', '2012-01-01', 5)).toEqual([
      ['2001-03-15', '2006-03-14'],
      ['2006-03-15', '2011-03-14'],
      ['2011-03-15', '2012-01-01'],
    ]);
  });
});

describe('ECB SDMX CSV', () => {
  it('parses quoted fields containing commas', () => {
    expect(parseCsv('a,"b, c","d ""q"""\r\n1,2,3\r\n')).toEqual([
      ['a', 'b, c', 'd "q"'],
      ['1', '2', '3'],
    ]);
  });
  it('extracts currency per EUR series', () => {
    const m = parseEcbCsv(fixture('ecb/exr-d-2025-01.csv'));
    expect([...m.keys()].sort()).toEqual(['BRL', 'GBP', 'USD']);
    expect(m.get('USD')![0]).toEqual({ date: '2025-01-02', rate: 1.0321 });
  });
});

describe('FX router', () => {
  it('USD/COP -> Banrep TRM (official)', async () => {
    const { service } = createTestService();
    const r = await service.fxSeries({ base: 'USD', quote: 'COP', from: '2025-01-01', to: '2025-03-31', interval: '1mo' });
    expect(r.series.source).toBe('banrep-trm');
    expect(r.series.points).toEqual([
      { date: '2025-01-31', rate: 4170.01 },
      { date: '2025-02-28', rate: 4120.11 },
      { date: '2025-03-31', rate: 4192.57 },
    ]);
    expect(r.fallbacks).toBeUndefined();
  });

  it('COP/USD is the inverse of the TRM', async () => {
    const { service } = createTestService();
    const r = await service.fxSeries({ base: 'COP', quote: 'USD', from: '2025-01-31', to: '2025-01-31' });
    expect(r.series.points[0]!.rate).toBeCloseTo(1 / 4170.01, 12);
  });

  it('USD/BRL -> BCB PTAX; BRL/USD inverted', async () => {
    const { service } = createTestService();
    const r = await service.fxSeries({ base: 'USD', quote: 'BRL', from: '2025-01-02', to: '2025-01-31', interval: '1mo' });
    expect(r.series).toMatchObject({ source: 'bcb-ptax', points: [{ date: '2025-01-31', rate: 5.8366 }] });
    const inv = await service.fxSeries({ base: 'BRL', quote: 'USD', from: '2025-01-02', to: '2025-01-02' });
    expect(inv.series.points[0]!.rate).toBeCloseTo(1 / 6.1916, 12);
  });

  it('EUR/BRL prefers PTAX (local central bank) over ECB', async () => {
    const { service } = createTestService();
    const r = await service.fxSeries({ base: 'EUR', quote: 'BRL', from: '2025-01-02', to: '2025-01-31', interval: '1mo' });
    expect(r.series.source).toBe('bcb-ptax');
    expect(r.series.points).toEqual([{ date: '2025-01-31', rate: 6.059 }]);
  });

  it('EUR/USD and USD/EUR -> ECB; USD/GBP as ECB cross', async () => {
    const { service } = createTestService();
    const r = await service.fxSeries({ base: 'EUR', quote: 'USD', from: '2025-01-02', to: '2025-01-03' });
    expect(r.series).toMatchObject({ source: 'ecb', points: [{ date: '2025-01-02', rate: 1.0321 }, { date: '2025-01-03', rate: 1.0299 }] });
    const inv = await service.fxSeries({ base: 'USD', quote: 'EUR', from: '2025-01-02', to: '2025-01-02' });
    expect(inv.series.points[0]!.rate).toBeCloseTo(1 / 1.0321, 10);
    const gbp = await service.fxSeries({ base: 'USD', quote: 'GBP', from: '2025-01-02', to: '2025-01-02' });
    expect(gbp.series.source).toBe('ecb');
    expect(gbp.series.points[0]!.rate).toBeCloseTo(0.8285 / 1.0321, 10);
  });

  it('EUR/COP is triangulated through USD with official legs (ECB x TRM), weekends filled by TRM', async () => {
    const { service } = createTestService();
    const r = await service.fxSeries({ base: 'EUR', quote: 'COP', from: '2025-01-03', to: '2025-01-06' });
    expect(r.series.source).toBe('ecb*banrep-trm');
    expect(r.series.points).toEqual([
      { date: '2025-01-03', rate: +(1.0299 * 4410.5).toPrecision(10) },
      { date: '2025-01-04', rate: +(1.0299 * 4355.51).toPrecision(10) }, // Saturday: ECB carried forward
      { date: '2025-01-05', rate: +(1.0299 * 4355.51).toPrecision(10) },
      { date: '2025-01-06', rate: +(1.0426 * 4355.51).toPrecision(10) },
    ]);
  });

  it('falls back PTAX -> SGS when olinda is down, recording the failure', async () => {
    const { service } = createTestService({ failingHosts: ['olinda.bcb.gov.br'] });
    const r = await service.fxSeries({ base: 'USD', quote: 'BRL', from: '2025-01-02', to: '2025-01-31', interval: '1mo' });
    expect(r.series).toMatchObject({ source: 'bcb-sgs', points: [{ date: '2025-01-31', rate: 5.8366 }] });
    expect(r.fallbacks?.map((f) => f.source)).toEqual(['bcb-ptax']);
  });

  it('falls back to Yahoo when every official source is blocked (as in this sandbox)', async () => {
    const { service } = createTestService({ blockedHosts: ['olinda.bcb.gov.br', 'api.bcb.gov.br', 'data-api.ecb.europa.eu'] });
    const r = await service.fxSeries({ base: 'USD', quote: 'BRL', from: '2025-01-02', to: '2025-01-03' });
    expect(r.series.source).toBe('yahoo');
    expect(r.series.points).toEqual([
      { date: '2025-01-02', rate: 6.3 },
      { date: '2025-01-03', rate: 6.151 },
    ]);
    expect(r.fallbacks?.map((f) => f.source)).toEqual(['bcb-ptax', 'bcb-sgs', 'ecb']);
    expect(r.fallbacks?.[0]?.error).toMatch(/403/);
  });

  it('source=yahoo forces Yahoo; source=official never uses Yahoo', async () => {
    const { service } = createTestService({ blockedHosts: ['www.datos.gov.co'] });
    const y = await service.fxSeries({ base: 'USD', quote: 'COP', from: '2025-01-02', to: '2025-01-02', source: 'yahoo' });
    expect(y.series).toMatchObject({ source: 'yahoo', points: [{ date: '2025-01-02', rate: 4403.17 }] });
    await expect(service.fxSeries({ base: 'USD', quote: 'COP', from: '2025-01-02', to: '2025-01-02', source: 'official' })).rejects.toMatchObject({
      code: 'UPSTREAM_ERROR',
    });
    await expect(service.fxSeries({ base: 'USD', quote: 'CLP', from: '2025-01-02', to: '2025-01-02', source: 'official' })).rejects.toMatchObject({
      code: 'UNSUPPORTED',
    });
  });

  it('EUR/USD via Yahoo uses EURUSD=X; identical currencies give rate 1', async () => {
    const { service } = createTestService();
    const r = await service.fxSeries({ base: 'EUR', quote: 'USD', from: '2025-01-02', to: '2025-01-02', source: 'yahoo' });
    expect(r.series.points[0]!.rate).toBe(1.035186);
    const same = await service.fxSeries({ base: 'COP', quote: 'COP', from: '2025-01-01', to: '2025-01-03' });
    expect(same.series.points.map((p) => p.rate)).toEqual([1, 1, 1]);
  });

  it('Yahoo crosses without USD are triangulated through USD legs (BRLCOP=X has no history)', async () => {
    const { service, fetch } = createTestService();
    const r = await service.fxSeries({ base: 'BRL', quote: 'COP', from: '2025-01-02', to: '2025-01-02', source: 'yahoo' });
    expect(r.series.source).toBe('yahoo');
    expect(r.series.points[0]!.rate).toBeCloseTo(4403.17 / 6.3, 2);
    expect(fetch.calls.some((u) => u.includes('BRLCOP'))).toBe(false);
  });

  it('combine() multiplies on the union of dates with fill-forward', () => {
    const a = [{ date: '2025-01-02', rate: 2 }, { date: '2025-01-06', rate: 3 }];
    const b = [{ date: '2025-01-01', rate: 10 }, { date: '2025-01-04', rate: 20 }];
    expect(combine(a, b, '2025-01-01', '2025-01-06')).toEqual([
      { date: '2025-01-02', rate: 20 },
      { date: '2025-01-04', rate: 40 },
      { date: '2025-01-06', rate: 60 },
    ]);
  });
});
