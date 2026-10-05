/**
 * Portafolio Pro market-data HTTP API (Hono). Runtime-agnostic: `createApp()` returns a Hono app
 * that works with @hono/node-server (see main.ts), serverless adapters, or `app.request()` in tests.
 */
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import {
  MarketDataError,
  MarketDataService,
  startOfMonth,
  toErrorBody,
  type BatchRequest,
  type FxSourceMode,
  type HealthResponse,
  type Interval,
  type PriceAdjustment,
} from '@pm/market-data';

export const VERSION = '0.1.0';

export interface AppOptions {
  service?: MarketDataService;
  /** Allowed CORS origins (default '*'). */
  corsOrigin?: string | string[];
  /** Request log sink (default console.log). Pass null to silence. */
  log?: ((line: string) => void) | null;
}

const MAX_BODY_BYTES = 256 * 1024;

function bad(message: string): never {
  throw new MarketDataError('BAD_REQUEST', message);
}

function intParam(v: string | undefined, name: string, min: number, max: number, def: number): number {
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) bad(`"${name}" must be an integer between ${min} and ${max}`);
  return n;
}

function oneOf<T extends string>(v: string | undefined, name: string, allowed: readonly T[]): T | undefined {
  if (v === undefined || v === '') return undefined;
  if (!(allowed as readonly string[]).includes(v)) bad(`"${name}" must be one of: ${allowed.join(', ')}`);
  return v as T;
}

function required(c: Context, name: string, hint: string): string {
  const v = c.req.query(name);
  if (v === undefined || v.trim() === '') bad(`Missing query parameter "${name}" (${hint})`);
  return v.trim();
}

/** Cache-Control for a historical range: closed months are immutable. */
function historyCacheControl(to: string | undefined, today: string): string {
  if (to && to < startOfMonth(today)) return 'public, max-age=86400, stale-while-revalidate=604800';
  return 'public, max-age=300';
}

export function createApp(opts: AppOptions = {}): Hono {
  const service = opts.service ?? new MarketDataService();
  const log = opts.log === undefined ? (line: string) => console.log(line) : opts.log;
  const app = new Hono();

  app.use('*', cors({ origin: opts.corsOrigin ?? '*', allowMethods: ['GET', 'POST', 'OPTIONS'], maxAge: 86400 }));

  // Timing + request log.
  app.use('*', async (c, next) => {
    const started = performance.now();
    await next();
    const ms = performance.now() - started;
    c.header('Server-Timing', `total;dur=${ms.toFixed(1)}`);
    log?.(`${c.req.method} ${c.req.path}${new URL(c.req.url).search} -> ${c.res.status} ${ms.toFixed(0)}ms`);
  });

  app.onError((err, c) => {
    const body = toErrorBody(err);
    const status = err instanceof MarketDataError ? err.status : 500;
    if (status >= 500) log?.(`ERROR ${c.req.method} ${c.req.path}: ${body.code} ${body.message}`);
    return c.json({ error: body }, status as 400);
  });

  app.notFound((c) =>
    c.json(
      {
        error: {
          code: 'NOT_FOUND',
          message: `No route ${c.req.method} ${c.req.path}. Endpoints: /api/health, /api/search, /api/quote, /api/history, /api/fx, /api/catalog, POST /api/batch`,
        },
      },
      404,
    ),
  );

  app.get('/', (c) => c.redirect('/api/health'));

  app.get('/api/health', (c) => {
    const body: HealthResponse = {
      ok: true,
      service: 'portafolio-pro-market-data',
      version: VERSION,
      time: new Date().toISOString(),
      cache: { memoryEntries: service.cache.memory.size, persistent: !!service.cache.store },
    };
    return c.json(body);
  });

  app.get('/api/search', async (c) => {
    const q = required(c, 'q', 'text to search, e.g. q=ecopetrol');
    const limit = intParam(c.req.query('limit'), 'limit', 1, 50, 20);
    const res = await service.search(q, limit);
    c.header('Cache-Control', 'public, max-age=3600');
    return c.json(res);
  });

  app.get('/api/quote', async (c) => {
    const raw = c.req.query('ids') ?? c.req.query('symbols') ?? c.req.query('symbol');
    if (!raw?.trim()) bad('Missing query parameter "ids" (comma-separated instrument ids or provider symbols, e.g. ids=BVMF:PETR4,ECOPETROL.CL,AAPL)');
    const ids = [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))];
    if (ids.length > 100) bad('Too many ids (max 100)');
    const quotes = await service.quotes(ids);
    c.header('Cache-Control', 'public, max-age=60');
    return c.json({ quotes });
  });

  app.get('/api/history', async (c) => {
    const symbol = required(c, 'symbol', 'instrument id or provider symbol, e.g. symbol=BVMF:PETR4 or PETR4.SA');
    const from = required(c, 'from', 'start date YYYY-MM-DD');
    const to = c.req.query('to') || undefined;
    const interval = oneOf<Interval>(c.req.query('interval'), 'interval', ['1d', '1mo']);
    const adjust = oneOf<PriceAdjustment>(c.req.query('adjust'), 'adjust', ['none', 'splits']);
    const res = await service.history({ symbol, from, to, interval, adjust });
    c.header('Cache-Control', historyCacheControl(to, service.today()));
    return c.json(res);
  });

  app.get('/api/fx', async (c) => {
    let base = c.req.query('base');
    let quote = c.req.query('quote');
    const pair = c.req.query('pair');
    if (pair && (!base || !quote)) {
      const m = /^([A-Za-z]{3})[/:-]?([A-Za-z]{3})$/.exec(pair.trim());
      if (!m) bad('"pair" must look like USDCOP or USD/COP');
      base = m[1];
      quote = m[2];
    }
    if (!base || !quote) bad('Missing "base" and "quote" (e.g. base=USD&quote=COP)');
    const from = required(c, 'from', 'start date YYYY-MM-DD');
    const to = c.req.query('to') || undefined;
    const interval = oneOf<Interval>(c.req.query('interval'), 'interval', ['1d', '1mo']);
    const source = oneOf<FxSourceMode>(c.req.query('source'), 'source', ['auto', 'official', 'yahoo']);
    const res = await service.fxSeries({ base, quote, from, to, interval, source });
    c.header('Cache-Control', historyCacheControl(to, service.today()));
    return c.json(res);
  });

  app.get('/api/catalog', (c) => {
    c.header('Cache-Control', 'public, max-age=3600');
    return c.json(service.catalog.data);
  });

  app.post('/api/batch', async (c) => {
    const len = Number(c.req.header('content-length') ?? 0);
    if (len > MAX_BODY_BYTES) bad(`Body too large (max ${MAX_BODY_BYTES} bytes)`);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      bad('Body must be JSON: { "histories": [{symbol, from, to?, interval?}], "fx": [{base, quote, from, to?, interval?, source?}], "quotes": ["id", ...] }');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) bad('Body must be a JSON object');
    const res = await service.batch(body as BatchRequest);
    return c.json(res);
  });

  return app;
}
