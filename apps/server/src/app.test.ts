import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { TTL } from '@pm/market-data';
import { MarketDataApiError, MarketDataClient } from '@pm/market-data/client';
import { createTestService, presplitOnly } from '../../../packages/market-data/test/helpers';
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

  it('CORS allowlist: the web dev origin is allowed and echoed', async () => {
    const pre = await app.request('/api/history', { method: 'OPTIONS', headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'GET' } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
    const r = await app.request('/api/health', { headers: { Origin: 'http://localhost:5173' } });
    expect(r.headers.get('access-control-allow-origin')).toBe('http://localhost:5173');
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
    // brapi itemizes Yahoo's 2024-12-12 dividend into dividend + JCP with payment dates (M8).
    expect(r.body.actions.map((a: any) => [a.date, a.subtype, a.amountPerShare, a.payDate])).toEqual([
      ['2024-12-12', 'ORDINARY', 1.450543, '2025-02-20'],
      ['2024-12-12', 'JCP', 0.1012, '2025-03-20'],
      ['2024-12-26', 'ORDINARY', 1.356891, '2025-05-20'],
    ]);
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
  const client = new MarketDataClient({ baseUrl: 'http://test', fetch: async (url, init) => app.request(url, init) });

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

// ------------------------------------------------------------------------------ review round 1
describe('round 2: server hardening and new routes', () => {
  it('M10 foreign Origin is refused server-side (not just hidden by CORS)', async () => {
    const { app, fetch } = setup();
    const r = await app.request('/api/history?symbol=AAPL&from=2025-01-01', { headers: { Origin: 'https://evil.example' } });
    expect(r.status).toBe(403);
    expect(r.headers.get('access-control-allow-origin')).toBeNull();
    expect(fetch.calls).toEqual([]);
    const pre = await app.request('/api/batch', { method: 'OPTIONS', headers: { Origin: 'https://evil.example', 'Access-Control-Request-Method': 'POST' } });
    expect(pre.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('M10 optional API token', async () => {
    const { service } = createTestService();
    const app = createApp({ service, log: null, apiToken: 's3cret' });
    expect((await app.request('/api/catalog')).status).toBe(401);
    expect((await app.request('/api/catalog', { headers: { Authorization: 'Bearer s3cret' } })).status).toBe(200);
    expect((await app.request('/api/catalog', { headers: { 'x-api-key': 's3cret' } })).status).toBe(200);
    expect((await app.request('/api/health')).status).toBe(200);
  });

  it('M10 per-client rate limit with Retry-After; batch costs more', async () => {
    let now = 0;
    const { service } = createTestService();
    const app = createApp({ service, log: null, rateLimit: { capacity: 3, refillPerSecond: 1 }, now: () => now });
    for (let i = 0; i < 3; i++) expect((await app.request('/api/catalog')).status).toBe(200);
    const r = await app.request('/api/catalog');
    expect(r.status).toBe(429);
    expect(r.headers.get('retry-after')).toBe('1');
    now += 1000;
    expect((await app.request('/api/catalog')).status).toBe(200);
  });

  it('M10 batch caps: items and estimated points', async () => {
    const { app } = setup();
    const post = (body: unknown) => app.request('/api/batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const many = await post({ quotes: Array.from({ length: 101 }, (_, i) => `S${i}`) });
    expect(many.status).toBe(400);
    const huge = await post({ histories: Array.from({ length: 10 }, () => ({ symbol: 'AAPL', from: '1970-01-01' })) });
    expect(huge.status).toBe(400);
    expect(((await huge.json()) as any).error.message).toMatch(/too large/);
  });

  it('M11 body limit counts streamed bytes (chunked, no Content-Length)', async () => {
    const { app } = setup();
    const chunk = new TextEncoder().encode(' '.repeat(16 * 1024));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(ctrl) {
        if (sent++ < 20) ctrl.enqueue(chunk);
        else ctrl.close();
      },
    });
    const r = await app.request('/api/batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: stream, duplex: 'half' } as RequestInit);
    expect(r.status).toBe(413);
  });

  it('M12 path-escape symbols are rejected without upstream calls', async () => {
    const { app, fetch } = setup();
    for (const s of ['CRYPTO:..', 'XNYS:..', encodeURIComponent('../v7/finance/quote')]) {
      const r = await app.request(`/api/history?symbol=${s}&from=2025-01-01`);
      expect(r.status, s).toBe(400);
    }
    expect(fetch.calls).toEqual([]);
  });

  it('M17 internal errors are not leaked', async () => {
    const { app } = setup();
    const res = await app.request('/api/batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ histories: [null], quotes: [123] }) });
    const body = (await res.json()) as any;
    expect(body.histories[0].error.code).toBe('BAD_REQUEST');
    expect(body.quotes[0].error.code).toBe('BAD_REQUEST');
    expect(JSON.stringify(body)).not.toMatch(/Cannot read|is not a function/);
  });

  it('GET /api/index (and /api/rates alias), list without id, batch indices', async () => {
    const { app } = setup();
    const list = await getJson(app, '/api/index');
    expect(list.body.indices.map((i: any) => i.id)).toEqual(expect.arrayContaining(['CDI', 'SELIC', 'IPCA', 'IPC_CO', 'IBR', 'UVR', 'DTF', 'CPI_US']));
    const cdi = await getJson(app, '/api/index?id=CDI&from=2025-01-02&to=2025-01-10');
    expect(cdi.status).toBe(200);
    expect(cdi.body.series).toMatchObject({ id: 'CDI', kind: 'periodRate', period: 'day' });
    const ipc = await getJson(app, '/api/rates?series=IPC_CO&from=2025-01-01&to=2025-01-31');
    expect(ipc.body.series.points).toHaveLength(1);
    expect((await getJson(app, '/api/index?id=NOPE&from=2025-01-01')).status).toBe(400);
  });

  it('GET /api/fx side=compra (PTAX buy)', async () => {
    const { app } = setup();
    const r = await getJson(app, '/api/fx?base=USD&quote=BRL&from=2025-01-02&to=2025-01-02&side=compra');
    expect(r.body).toMatchObject({ side: 'buy', series: { source: 'bcb-ptax', points: [{ rate: 6.191 }] } });
  });

  it('GET /api/history adjust=total and degraded responses are no-store', async () => {
    const { app } = setup();
    const tr = await getJson(app, '/api/history?symbol=ECOPETROL.CL&from=2025-03-28&to=2025-04-01&adjust=total');
    expect(tr.body.notes.join(' ')).toMatch(/total-return/);
    const { service } = createTestService({ failSplitHistory: true, routes: presplitOnly });
    const app2 = createApp({ service, log: null });
    const d = await app2.request('/api/history?symbol=NVDA&from=2024-01-02&to=2024-01-05');
    expect(d.headers.get('cache-control')).toBe('no-store');
    expect(((await d.json()) as any).degraded).toBe(true);
  });

  it('M16 DELETE /api/cache invalidates a symbol (loopback client)', async () => {
    const { app } = setup();
    await app.request('/api/history?symbol=PETR4.SA&from=2024-11-01&to=2025-02-28');
    const r = await app.request('/api/cache?symbol=BVMF:PETR4', { method: 'DELETE' });
    expect(r.status).toBe(200);
    expect(((await r.json()) as any).removed).toBeGreaterThan(0);
  });

  it('health lists providers', async () => {
    const { app } = setup();
    const r = await getJson(app, '/api/health');
    expect(r.body.providers.prices).toEqual(expect.arrayContaining(['yahoo', 'brapi', 'stooq', 'coingecko', 'tesouro', 'superfin']));
    expect(r.body.providers.fx).toEqual(expect.arrayContaining(['banrep-trm', 'banrep-sdmx', 'bcb-ptax', 'ecb', 'yahoo', 'coingecko']));
  });
});

describe('M16 FileStore is bounded and supports prefix invalidation', () => {
  it('prunes least recently used files and deletes by prefix', async () => {
    const d = await mkdtemp(join(tmpdir(), 'pm-store-'));
    try {
      const store = new FileStore(d, { maxFiles: 3, pruneEvery: 1000 });
      for (let i = 0; i < 5; i++) {
        await store.set(`hist:v2:yahoo:S${i}:2024`, { value: i, storedAt: 0, expiresAt: null });
        await new Promise((r) => setTimeout(r, 15));
      }
      expect(await store.prune()).toBe(2);
      expect(await store.get('hist:v2:yahoo:S0:2024')).toBeUndefined();
      expect(await store.get('hist:v2:yahoo:S4:2024')).toBeDefined();
      expect(await store.deletePrefix('hist:v2:yahoo:S4:')).toBe(1);
      expect(await store.get('hist:v2:yahoo:S4:2024')).toBeUndefined();
    } finally {
      await rm(d, { recursive: true, force: true });
    }
  });
});

describe('client chunking over the server caps', () => {
  function counted(opts: { failNthBatch?: number } = {}) {
    const { app } = setup();
    const stats = { quote: 0, batch: 0, inFlight: 0, peak: 0 };
    const client = new MarketDataClient({
      baseUrl: 'http://test',
      chunkConcurrency: 2,
      fetch: async (url, init) => {
        const path = new URL(url).pathname;
        if (path === '/api/quote') stats.quote++;
        if (path === '/api/batch') stats.batch++;
        stats.inFlight++;
        stats.peak = Math.max(stats.peak, stats.inFlight);
        try {
          if (path === '/api/batch' && stats.batch === opts.failNthBatch) return new Response('{"error":{"code":"UPSTREAM_ERROR","message":"boom"}}', { status: 502 });
          return await app.request(url, init);
        } finally {
          stats.inFlight--;
        }
      },
    });
    return { client, stats };
  }

  it('quotes: 130 ids (with duplicates) -> 3 requests of <=50, results aligned per input position', async () => {
    const { client, stats } = counted();
    const ids = [...Array.from({ length: 120 }, (_, i) => `NOPE${i}.SA`), 'AAPL', 'AAPL', ...Array.from({ length: 8 }, (_, i) => `ZZ${i}.SA`)];
    const { quotes } = await client.quotes(ids);
    expect(quotes).toHaveLength(130);
    expect(stats.quote).toBe(3); // 128 unique ids -> 50 + 50 + 28
    expect(stats.peak).toBeLessThanOrEqual(2);
    expect(quotes[120]).toMatchObject({ ok: true, data: { instrumentId: 'XNAS:AAPL' } });
    expect(quotes[121]).toEqual(quotes[120]);
    expect(quotes[0]).toMatchObject({ ok: false });
  });

  it('batch: 150 histories + 2 fx + 1 index -> 2 requests, merged in order, a failed chunk fails only its items', async () => {
    const { client, stats } = counted({ failNthBatch: 2 });
    const histories = Array.from({ length: 150 }, (_, i) => ({ symbol: i % 2 ? 'NOPE.SA' : 'PETR4.SA', from: '2024-11-01', to: '2025-02-28', interval: '1mo' as const }));
    const r = await client.batch({
      histories,
      fx: [{ base: 'USD', quote: 'COP', from: '2025-01-01', to: '2025-02-28', interval: '1mo' }, { base: 'USD', quote: 'BRL', from: '2025-01-02', to: '2025-01-31', interval: '1mo' }],
      indices: [{ id: 'CDI', from: '2025-01-02', to: '2025-01-10' }],
    });
    expect(stats.batch).toBe(2);
    expect(r.histories).toHaveLength(150);
    expect(r.fx).toHaveLength(2);
    expect(r.indices).toHaveLength(1);
    expect(r.histories[0]).toMatchObject({ ok: true, data: { instrument: { id: 'BVMF:PETR4' } } });
    expect(r.histories[1]).toMatchObject({ ok: false, error: { code: 'NOT_FOUND' } });
    // items 100..152 travelled in the 2nd chunk, which failed as a whole
    expect(r.histories[100]).toMatchObject({ ok: false, error: { code: 'UPSTREAM_ERROR', message: 'boom' } });
    expect(r.fx[0]).toMatchObject({ ok: false, error: { code: 'UPSTREAM_ERROR' } });
    expect(r.indices[0]).toMatchObject({ ok: false });
  });

  it('monthEndData with 120 instruments is chunked transparently', async () => {
    const { client, stats } = counted();
    const ids = Array.from({ length: 120 }, (_, i) => (i % 3 === 0 ? 'XBOG:ECOPETROL' : 'BVMF:PETR4'));
    const r = await client.monthEndData(ids, ['COP', 'BRL'], 'USD', '2025-01-01', '2025-02-28', undefined, ['CDI']);
    expect(stats.batch).toBe(2);
    expect(r.histories).toHaveLength(120);
    expect(r.histories.every((h) => h.ok)).toBe(true);
    expect(r.fx.map((f) => f.ok)).toEqual([true, true]);
    expect(r.indices).toHaveLength(1);
  });

  it('small requests still use a single call', async () => {
    const { client, stats } = counted();
    await client.batch({ quotes: ['AAPL'] });
    expect(stats.batch).toBe(1);
  });
});
