import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { TTL } from '@pm/market-data';
import { MarketDataApiError, MarketDataClient } from '@pm/market-data/client';
import { createTestService } from '../../../packages/market-data/test/helpers';
import { createApp } from './app';
import { FileStore } from './fileStore';

function setup(fetchOpts: Parameters<typeof createTestService>[0] = {}) {
  const { service, fetch } = createTestService(fetchOpts);
  const app = createApp({ service, log: null });
  return { app, fetch };
}

const getJson = async (app: ReturnType<typeof createApp>, path: string) => {
  const res = await app.request(path);
  return { status: res.status, headers: res.headers, body: (await res.json()) as any };
};

describe('server routes', () => {
  const { app } = setup();

  it('GET /api/health', async () => {
    const r = await getJson(app, '/api/health');
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ ok: true, service: 'portafolio-pro-market-data' });
    expect(r.headers.get('server-timing')).toMatch(/total;dur=/);
  });

  it('CORS preflight and headers', async () => {
    const pre = await app.request('/api/history', { method: 'OPTIONS', headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'GET' } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('*');
    const r = await app.request('/api/health', { headers: { Origin: 'http://localhost:5173' } });
    expect(r.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('GET /api/search', async () => {
    const r = await getJson(app, '/api/search?q=iberdrola&limit=5');
    expect(r.status).toBe(200);
    expect(r.body.results[0]).toMatchObject({ id: 'XMAD:IBE', currency: 'EUR', origin: 'catalog' });
    expect(r.body.results.length).toBeLessThanOrEqual(5);
    expect((await getJson(app, '/api/search')).status).toBe(400);
    expect((await getJson(app, '/api/search?q=x&limit=999')).body.error.message).toMatch(/limit/);
  });

  it('GET /api/quote with ids and symbols, per-item errors', async () => {
    const r = await getJson(app, '/api/quote?ids=XBOG:ECOPETROL,AAPL,VOD.L,NOPE.SA');
    expect(r.status).toBe(200);
    const [eco, aapl, vod, nope] = r.body.quotes;
    expect(eco).toMatchObject({ ok: true, data: { instrumentId: 'XBOG:ECOPETROL', price: 2705, currency: 'COP' } });
    expect(aapl).toMatchObject({ ok: true, data: { instrumentId: 'XNAS:AAPL', price: 333.69 } });
    expect(vod).toMatchObject({ ok: true, data: { currency: 'GBP', price: 1.2765 } });
    expect(nope).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    expect((await getJson(app, '/api/quote')).status).toBe(400);
  });

  it('GET /api/history monthly with actions and immutable Cache-Control for closed ranges', async () => {
    const r = await getJson(app, '/api/history?symbol=PETR4.SA&from=2024-11-01&to=2025-02-28&interval=1mo');
    expect(r.status).toBe(200);
    expect(r.body.instrument.id).toBe('BVMF:PETR4');
    expect(r.body.series.points).toEqual([
      { date: '2024-11-29', close: 38.9 },
      { date: '2024-12-30', close: 36.19 },
      { date: '2025-01-31', close: 37.69 },
      { date: '2025-02-28', close: 35.93 },
    ]);
    expect(r.body.actions).toHaveLength(2);
    expect(r.headers.get('cache-control')).toMatch(/max-age=86400/);
  });

  it('GET /api/history validation errors', async () => {
    const missing = await getJson(app, '/api/history?from=2025-01-01');
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatchObject({ code: 'BAD_REQUEST' });
    expect(missing.body.error.message).toMatch(/symbol/);
    expect((await getJson(app, '/api/history?symbol=PETR4.SA&from=01-01-2025')).body.error.message).toMatch(/YYYY-MM-DD/);
    expect((await getJson(app, '/api/history?symbol=PETR4.SA&from=2025-01-01&interval=1w')).body.error.message).toMatch(/1d, 1mo/);
    const nf = await getJson(app, '/api/history?symbol=NOPE.SA&from=2025-01-01&to=2025-01-31');
    expect(nf.status).toBe(404);
  });

  it('GET /api/fx official routing and pair= shorthand', async () => {
    const r = await getJson(app, '/api/fx?base=USD&quote=COP&from=2025-01-01&to=2025-03-31&interval=1mo');
    expect(r.status).toBe(200);
    expect(r.body.series).toMatchObject({ base: 'USD', quote: 'COP', source: 'banrep-trm' });
    expect(r.body.series.points.at(-1)).toEqual({ date: '2025-03-31', rate: 4192.57 });
    const p = await getJson(app, '/api/fx?pair=EUR/COP&from=2025-01-03&to=2025-01-03');
    expect(p.body.series.source).toBe('ecb*banrep-trm');
    expect((await getJson(app, '/api/fx?base=USD&quote=COP&from=2025-01-01&source=bloomberg')).status).toBe(400);
    const unsupported = await getJson(app, '/api/fx?base=USD&quote=CLP&from=2025-01-01&to=2025-01-31&source=official');
    expect(unsupported.status).toBe(422);
  });

  it('GET /api/catalog', async () => {
    const r = await getJson(app, '/api/catalog');
    expect(r.body.instruments.length).toBeGreaterThan(150);
    expect(r.body.benchmarks.map((b: any) => b.id)).toEqual(expect.arrayContaining(['COLCAP', 'IBOV', 'SPX', 'MSCI_WORLD', 'SX5E']));
  });

  it('POST /api/batch', async () => {
    const res = await app.request('/api/batch', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        histories: [{ symbol: 'XBOG:ECOPETROL', from: '2025-01-01', to: '2025-03-31', interval: '1mo' }],
        fx: [
          { base: 'USD', quote: 'COP', from: '2025-01-01', to: '2025-03-31', interval: '1mo' },
          { base: 'BRL', quote: 'COP', from: '2025-01-02', to: '2025-01-31', interval: '1mo' },
        ],
      }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.histories[0].data.series.points).toHaveLength(3);
    expect(body.fx[0].data.series.source).toBe('banrep-trm');
    expect(body.fx[1].data.series.source).toBe('bcb-ptax*banrep-trm');
    expect(typeof body.tookMs).toBe('number');
  });

  it('POST /api/batch rejects bad bodies', async () => {
    const bad = await app.request('/api/batch', { method: 'POST', body: 'not json', headers: { 'Content-Type': 'application/json' } });
    expect(bad.status).toBe(400);
    const arr = await app.request('/api/batch', { method: 'POST', body: '[]', headers: { 'Content-Type': 'application/json' } });
    expect(arr.status).toBe(400);
  });

  it('unknown route -> JSON 404 listing endpoints', async () => {
    const r = await getJson(app, '/api/nope');
    expect(r.status).toBe(404);
    expect(r.body.error.message).toMatch(/\/api\/history/);
  });
});

describe('typed browser client against the app', () => {
  const { app } = setup();
  const client = new MarketDataClient({ baseUrl: 'http://test', fetch: (url, init) => app.request(url, init) });

  it('history, fx, quotes, catalog, search', async () => {
    const h = await client.history({ symbol: 'BVMF:PETR4', from: '2024-11-01', to: '2025-01-31', interval: '1mo' });
    expect(h.series.points.map((p) => p.date)).toEqual(['2024-11-29', '2024-12-30', '2025-01-31']);
    const fx = await client.fx({ base: 'USD', quote: 'BRL', from: '2025-01-02', to: '2025-01-31', interval: '1mo' });
    expect(fx.series.source).toBe('bcb-ptax');
    const q = await client.quotes(['AAPL']);
    expect(q.quotes[0]).toMatchObject({ ok: true });
    expect((await client.catalog()).benchmarks.length).toBeGreaterThan(4);
    expect((await client.search('petr')).results[0]?.exchange).toBe('BVMF');
    expect((await client.health()).ok).toBe(true);
  });

  it('monthEndData builds one batch for the monthly table', async () => {
    const r = await client.monthEndData(['XBOG:ECOPETROL', 'BVMF:PETR4'], ['COP', 'BRL', 'USD'], 'USD', '2025-01-01', '2025-02-28');
    expect(r.histories.every((x) => x.ok)).toBe(true);
    expect(r.fx.map((x) => (x.ok ? `${x.data.series.base}${x.data.series.quote}:${x.data.series.source}` : 'err'))).toEqual([
      'COPUSD:banrep-trm',
      'BRLUSD:bcb-ptax',
    ]);
  });

  it('throws typed errors', async () => {
    await expect(client.history({ symbol: 'PETR4.SA', from: 'bad' })).rejects.toBeInstanceOf(MarketDataApiError);
    await expect(client.history({ symbol: 'PETR4.SA', from: 'bad' })).rejects.toMatchObject({ status: 400, code: 'BAD_REQUEST' });
  });
});

describe('FileStore', () => {
  let dir = '';
  afterAll(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('round-trips entries and deletes', async () => {
    dir = await mkdtemp(join(tmpdir(), 'pm-store-'));
    const store = new FileStore(dir);
    expect(await store.get('k')).toBeUndefined();
    await store.set('hist:yahoo:PETR4.SA:2024-01-01:2024-12-31:none', { value: { a: 1 }, storedAt: 1, expiresAt: null });
    expect(await store.get('hist:yahoo:PETR4.SA:2024-01-01:2024-12-31:none')).toEqual({ value: { a: 1 }, storedAt: 1, expiresAt: null });
    await store.delete('hist:yahoo:PETR4.SA:2024-01-01:2024-12-31:none');
    expect(await store.get('hist:yahoo:PETR4.SA:2024-01-01:2024-12-31:none')).toBeUndefined();
  });

  it('serves immutable history from disk after a "restart" without network', async () => {
    const d = await mkdtemp(join(tmpdir(), 'pm-store-'));
    try {
      const store = new FileStore(d);
      const { TieredCache } = await import('@pm/market-data');
      const first = createTestService({}, { cache: new TieredCache({ store }) });
      await first.service.history({ symbol: 'PETR4.SA', from: '2024-11-01', to: '2025-02-28' });
      const second = createTestService({ failingHosts: ['query2.finance.yahoo.com'] }, { cache: new TieredCache({ store }) });
      const h = await second.service.history({ symbol: 'PETR4.SA', from: '2024-11-01', to: '2025-02-28', interval: '1mo' });
      expect(h.series.points).toHaveLength(4);
      expect(second.fetch.calls).toHaveLength(0);
      expect(TTL.IMMUTABLE).toBe(Number.POSITIVE_INFINITY);
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });
});
