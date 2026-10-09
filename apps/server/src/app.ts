/**
 * Portafolio Pro market-data HTTP API (Hono). Runtime-agnostic: `createApp()` returns a Hono app
 * that works with @hono/node-server (see main.ts), serverless adapters, or `app.request()` in tests.
 *
 * Safe defaults (review R1, M10-M12, M17): CORS and a server-side Origin check restricted to an
 * allowlist (local web dev origins by default), optional bearer token, per-client token-bucket
 * rate limit, streamed body-size limit (chunked bodies included), batch caps by items and by
 * estimated points, symbol validation, and no internal error messages in responses.
 */
import { Hono, type Context } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { cors } from 'hono/cors';
import {
  INDEX_IDS,
  MarketDataError,
  MarketDataService,
  startOfMonth,
  toErrorBody,
  type BatchRequest,
  type FxSide,
  type FxSourceMode,
  type HealthResponse,
  type Interval,
  type PriceAdjustment,
} from '@pm/market-data';
import { PORTFOLIO_ID_RE, type IbkrFlexSyncMount } from './ibkrSync';

export const VERSION = '0.2.0';

/** Web dev/preview origins allowed by default. */
export const DEFAULT_CORS_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:4173', 'http://127.0.0.1:4173'];

export interface RateLimitOptions {
  /** Bucket size (burst). Default 120 requests. */
  capacity: number;
  /** Tokens refilled per second. Default 2 (= 120/min sustained). */
  refillPerSecond: number;
}

export interface AppOptions {
  service?: MarketDataService;
  /** Allowed browser origins, or '*' to allow any (not recommended). Default DEFAULT_CORS_ORIGINS. */
  corsOrigin?: string | string[];
  /** When set, every /api request except /api/health needs `Authorization: Bearer <token>` or `x-api-key`. */
  apiToken?: string;
  /** Per-client rate limit; `false` disables it. */
  rateLimit?: RateLimitOptions | false;
  /** Use the first X-Forwarded-For address as client id (only behind a trusted proxy). */
  trustProxy?: boolean;
  /** Max request body in bytes (default 64 KiB), enforced on the streamed bytes. */
  maxBodyBytes?: number;
  /**
   * Accepted `Host` header names (DNS-rebinding protection), e.g. ['localhost', '127.0.0.1'].
   * Undefined = no check (serverless / reverse-proxy deployments set their own).
   */
  allowedHosts?: string[];
  /**
   * Allow DELETE /api/cache without API_TOKEN from a REAL loopback socket (never behind a proxy,
   * never when the socket is unknown). Default false.
   */
  allowLocalAdmin?: boolean;
  /**
   * IBKR Flex sync (POST /api/sync/ibkr-flex, GET/DELETE /api/sync/ibkr-flex/inbox). Undefined =
   * not configured (SYNC_SECRET unset): the routes answer 503. Same protection as DELETE /api/cache.
   */
  ibkrFlexSync?: IbkrFlexSyncMount;
  /** Max body of POST /api/sync/* (it may carry the portfolio's transactions). Default 5 MiB. */
  syncMaxBodyBytes?: number;
  /** Request log sink (default console.log). Pass null to silence. */
  log?: ((line: string) => void) | null;
  now?: () => number;
}

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
  if (v.length > 200) bad(`Query parameter "${name}" too long`);
  return v.trim();
}

/** Cache-Control for a historical range: closed months are immutable. */
function historyCacheControl(to: string | undefined, today: string): string {
  if (to && to < startOfMonth(today)) return 'public, max-age=86400, stale-while-revalidate=604800';
  return 'public, max-age=300';
}

/** Token bucket per client id. */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();
  constructor(
    private readonly opts: RateLimitOptions,
    private readonly now: () => number = Date.now,
  ) {}

  take(id: string, cost = 1): { ok: boolean; retryAfterS: number } {
    const t = this.now();
    const b = this.buckets.get(id) ?? { tokens: this.opts.capacity, at: t };
    b.tokens = Math.min(this.opts.capacity, b.tokens + ((t - b.at) / 1000) * this.opts.refillPerSecond);
    b.at = t;
    this.buckets.set(id, b);
    if (this.buckets.size > 10_000) this.buckets.delete(this.buckets.keys().next().value!);
    if (b.tokens >= cost) {
      b.tokens -= cost;
      return { ok: true, retryAfterS: 0 };
    }
    return { ok: false, retryAfterS: Math.ceil((cost - b.tokens) / this.opts.refillPerSecond) };
  }
}

/** Remote address of the TCP socket (Node server), or undefined (serverless, app.request). */
function socketAddress(c: Context): string | undefined {
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return env?.incoming?.socket?.remoteAddress;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/** Rate-limit key: proxy-reported client (only if trusted), else the socket, else a shared bucket. */
function clientId(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || c.req.header('x-real-ip') || c.req.header('cf-connecting-ip');
    if (ip) return ip;
  }
  return socketAddress(c) ?? 'anonymous';
}

const sha256 = async (s: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));

/**
 * Constant-time token check (review R4, M35): both sides are hashed first, so neither the length
 * nor the position of the first differing byte leaks through timing. WebCrypto: works serverless.
 */
export async function tokenMatches(given: string | undefined, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(given ?? ''), sha256(expected)]);
  let diff = given === undefined ? 1 : 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

function hostName(host: string | undefined): string {
  if (!host) return '';
  if (host.startsWith('[')) return host.slice(0, host.indexOf(']') + 1).toLowerCase();
  return host.split(':')[0]!.toLowerCase();
}

export function createApp(opts: AppOptions = {}): Hono {
  const service = opts.service ?? new MarketDataService();
  const log = opts.log === undefined ? (line: string) => console.log(line) : opts.log;
  const origins = opts.corsOrigin ?? DEFAULT_CORS_ORIGINS;
  const anyOrigin = origins === '*' || (Array.isArray(origins) && origins.includes('*'));
  const allowed = new Set(Array.isArray(origins) ? origins : [origins]);
  const limiter = opts.rateLimit === false ? undefined : new RateLimiter(opts.rateLimit ?? { capacity: 120, refillPerSecond: 2 }, opts.now);
  const maxBody = opts.maxBodyBytes ?? 64 * 1024;
  const syncMaxBody = opts.syncMaxBodyBytes ?? 5 * 1024 * 1024;
  const allowedHosts = opts.allowedHosts ? new Set(opts.allowedHosts.map((h) => h.toLowerCase())) : undefined;
  let warnedShared = false;
  const app = new Hono();

  // Timing + request log (outermost, so it also logs rejected requests).
  app.use('*', async (c, next) => {
    const started = performance.now();
    await next();
    const ms = performance.now() - started;
    c.header('Server-Timing', `total;dur=${ms.toFixed(1)}`);
    log?.(`${c.req.method} ${c.req.path}${new URL(c.req.url).search.slice(0, 200)} -> ${c.res.status} ${ms.toFixed(0)}ms`);
  });

  app.use(
    '*',
    cors({
      origin: anyOrigin ? '*' : (o) => (allowed.has(o) ? o : null),
      allowMethods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
      allowHeaders: ['Content-Type', 'Authorization', 'x-api-key'],
      maxAge: 86400,
    }),
  );

  // DNS-rebinding protection: a same-origin GET carries no Origin, but it carries the attacker's Host.
  if (allowedHosts) {
    app.use('*', async (c, next) => {
      // The Node adapter builds c.req.url from the Host header; fetch-style requests carry it in the URL.
      if (!allowedHosts.has(hostName(c.req.header('host') ?? new URL(c.req.url).host))) {
        return c.json({ error: { code: 'FORBIDDEN_HOST', message: 'Host not allowed (set ALLOWED_HOSTS)' } }, 403);
      }
      return next();
    });
  }

  // Server-side Origin check: CORS only hides responses, it does not stop a foreign page from
  // making the server call providers on its behalf.
  app.use('/api/*', async (c, next) => {
    const origin = c.req.header('origin');
    if (origin && !anyOrigin && !allowed.has(origin)) {
      return c.json({ error: { code: 'FORBIDDEN_ORIGIN', message: `Origin ${origin} is not allowed (set CORS_ORIGIN)` } }, 403);
    }
    return next();
  });

  app.use('/api/*', async (c, next) => {
    if (opts.apiToken && c.req.path !== '/api/health' && c.req.method !== 'OPTIONS') {
      const auth = c.req.header('authorization');
      const token = auth?.startsWith('Bearer ') ? auth.slice(7) : c.req.header('x-api-key');
      if (!(await tokenMatches(token, opts.apiToken))) return c.json({ error: { code: 'UNAUTHORIZED', message: 'Missing or invalid API token' } }, 401);
    }
    if (limiter && c.req.method !== 'OPTIONS' && c.req.path !== '/api/health') {
      const id = clientId(c, !!opts.trustProxy);
      if (id === 'anonymous' && !warnedShared) {
        warnedShared = true;
        log?.('WARNING: no client address (serverless?): all clients share one rate-limit bucket; set TRUST_PROXY=1 behind a trusted proxy');
      }
      const r = limiter.take(id, 1);
      if (!r.ok) {
        c.header('Retry-After', String(r.retryAfterS));
        return c.json({ error: { code: 'RATE_LIMITED', message: `Too many requests; retry in ${r.retryAfterS}s` } }, 429);
      }
    }
    return next();
  });

  app.onError((err, c) => {
    const body = toErrorBody(err);
    const status = err instanceof MarketDataError ? err.status : 500;
    if (status >= 500) log?.(`ERROR ${c.req.method} ${c.req.path}: ${body.code} ${err instanceof Error ? err.message : String(err)}`);
    return c.json({ error: body }, status as 400);
  });

  app.notFound((c) =>
    c.json(
      {
        error: {
          code: 'NOT_FOUND',
          message: `No route ${c.req.method} ${c.req.path}. Endpoints: /api/health, /api/search, /api/quote, /api/history, /api/fx, /api/index, /api/catalog, POST /api/batch, POST /api/sync/ibkr-flex`,
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
      providers: service.providers(),
    };
    return c.json(body);
  });

  app.get('/api/search', async (c) => {
    const q = required(c, 'q', 'text to search, e.g. q=ecopetrol');
    const limit = intParam(c.req.query('limit'), 'limit', 1, 50, 20);
    const countries = c.req.query('countries')?.split(',').map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z]{2}$/.test(s));
    const res = await service.search(q, limit, countries?.length ? { preferredCountries: countries } : {});
    c.header('Cache-Control', 'public, max-age=3600');
    return c.json(res);
  });

  app.get('/api/quote', async (c) => {
    const raw = c.req.query('ids') ?? c.req.query('symbols') ?? c.req.query('symbol');
    if (!raw?.trim()) bad('Missing query parameter "ids" (comma-separated instrument ids or provider symbols, e.g. ids=BVMF:PETR4,ECOPETROL.CL,AAPL)');
    if (raw.length > 4000) bad('"ids" too long');
    const ids = [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))];
    if (ids.length > 50) bad('Too many ids (max 50)');
    const quotes = await service.quotes(ids);
    c.header('Cache-Control', 'public, max-age=60');
    return c.json({ quotes });
  });

  app.get('/api/history', async (c) => {
    const symbol = required(c, 'symbol', 'instrument id or provider symbol, e.g. symbol=BVMF:PETR4 or PETR4.SA');
    const from = required(c, 'from', 'start date YYYY-MM-DD');
    const to = c.req.query('to') || undefined;
    const interval = oneOf<Interval>(c.req.query('interval'), 'interval', ['1d', '1mo']);
    const adjust = oneOf<PriceAdjustment>(c.req.query('adjust'), 'adjust', ['none', 'splits', 'total']);
    const res = await service.history({ symbol, from, to, interval, adjust });
    c.header('Cache-Control', res.degraded ? 'no-store' : historyCacheControl(to, service.today()));
    return c.json(res);
  });

  app.get('/api/fx', async (c) => {
    let base = c.req.query('base');
    let quote = c.req.query('quote');
    const pair = c.req.query('pair');
    if (pair && (!base || !quote)) {
      const m = /^([A-Za-z]{3,5})[/:-]?([A-Za-z]{3})$/.exec(pair.trim());
      if (!m) bad('"pair" must look like USDCOP or USD/COP');
      base = m[1];
      quote = m[2];
    }
    if (!base || !quote) bad('Missing "base" and "quote" (e.g. base=USD&quote=COP)');
    const from = required(c, 'from', 'start date YYYY-MM-DD');
    const to = c.req.query('to') || undefined;
    const interval = oneOf<Interval>(c.req.query('interval'), 'interval', ['1d', '1mo']);
    const source = oneOf<FxSourceMode>(c.req.query('source'), 'source', ['auto', 'official', 'yahoo']);
    const sideRaw = c.req.query('side');
    const side = oneOf<FxSide | 'compra' | 'venda'>(sideRaw, 'side', ['buy', 'sell', 'compra', 'venda']);
    const res = await service.fxSeries({ base, quote, from, to, interval, source, side: side === 'compra' ? 'buy' : side === 'venda' ? 'sell' : side });
    c.header('Cache-Control', historyCacheControl(to, service.today()));
    return c.json(res);
  });

  const indexRoute = async (c: Context) => {
    const id = c.req.query('id') ?? c.req.query('series');
    if (!id) return c.json({ indices: service.indices.list() });
    if (!INDEX_IDS.includes(id.toUpperCase())) bad(`Unknown index "${id}". Available: ${INDEX_IDS.join(', ')}`);
    const from = required(c, 'from', 'start date YYYY-MM-DD');
    const to = c.req.query('to') || undefined;
    const res = await service.index({ id, from, to });
    c.header('Cache-Control', historyCacheControl(to, service.today()));
    return c.json(res);
  };
  app.get('/api/index', indexRoute);
  app.get('/api/rates', indexRoute);

  app.get('/api/catalog', (c) => {
    c.header('Cache-Control', 'public, max-age=3600');
    return c.json(service.catalog.data);
  });

  app.post(
    '/api/batch',
    bodyLimit({
      maxSize: maxBody,
      onError: (c) => c.json({ error: { code: 'BAD_REQUEST', message: `Body too large (max ${maxBody} bytes)` } }, 413),
    }),
    async (c) => {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        bad('Body must be JSON: { "histories": [{symbol, from, to?, interval?}], "fx": [{base, quote, from, ...}], "quotes": ["id"], "indices": [{id, from, to?}] }');
      }
      if (!body || typeof body !== 'object' || Array.isArray(body)) bad('Body must be a JSON object');
      // Charge one token per item (the request itself already paid one).
      if (limiter) {
        const b = body as Record<string, unknown>;
        const items = ['histories', 'fx', 'quotes', 'indices'].reduce((n, k) => n + (Array.isArray(b[k]) ? (b[k] as unknown[]).length : 0), 0);
        const r = items > 1 ? limiter.take(clientId(c, !!opts.trustProxy), items - 1) : { ok: true, retryAfterS: 0 };
        if (!r.ok) {
          c.header('Retry-After', String(r.retryAfterS));
          return c.json({ error: { code: 'RATE_LIMITED', message: `Batch of ${items} items exceeds your rate limit; retry in ${r.retryAfterS}s` } }, 429);
        }
      }
      return c.json(await service.batch(body as BatchRequest));
    },
  );

  /**
   * Guard of the mutating / secret-bearing endpoints. With API_TOKEN the auth middleware already
   * checked it (and the Origin check ran). Without it, only an explicit opt-in for a REAL loopback
   * socket, never behind a proxy (X-Forwarded-For can be forged and a local reverse proxy makes
   * every client look like 127.0.0.1) and never without a socket.
   */
  const adminForbidden = (c: Context, what: string): Response | undefined => {
    if (opts.apiToken) return undefined;
    const addr = socketAddress(c);
    if (!opts.allowLocalAdmin || opts.trustProxy || !addr || !LOOPBACK.has(addr)) {
      return c.json({ error: { code: 'FORBIDDEN', message: `${what} requires API_TOKEN (or ALLOW_LOCAL_ADMIN=1 on a direct loopback connection)` } }, 403);
    }
    return undefined;
  };

  /** Invalidate cached data for a symbol (fix a provider correction). Token or loopback only. */
  app.delete('/api/cache', async (c) => {
    const denied = adminForbidden(c, 'Cache invalidation');
    if (denied) return denied;
    const symbol = required(c, 'symbol', 'instrument id or provider symbol');
    return c.json(await service.invalidate(symbol));
  });

  // IBKR Flex Web Service sync (importers I2). The handler stores the Flex token encrypted and
  // never returns it; actions: save / sync / delete (see @pm/importers sync/server.ts).
  const syncGuard = (c: Context): Response | undefined => {
    const denied = adminForbidden(c, 'IBKR sync');
    if (denied) return denied;
    if (!opts.ibkrFlexSync) return c.json({ error: { code: 'NOT_CONFIGURED', message: 'IBKR sync is disabled: set SYNC_SECRET on the server' } }, 503);
    return undefined;
  };
  const portfolioParam = (c: Context): string => {
    const id = required(c, 'portfolioId', 'portfolio id');
    if (!PORTFOLIO_ID_RE.test(id)) bad('"portfolioId" has invalid characters');
    return id;
  };
  app.post(
    '/api/sync/ibkr-flex',
    async (c, next) => syncGuard(c) ?? next(),
    bodyLimit({
      maxSize: syncMaxBody,
      onError: (c) => c.json({ error: { code: 'BAD_REQUEST', message: `Body too large (max ${syncMaxBody} bytes)` } }, 413),
    }),
    async (c) => {
      const res = await opts.ibkrFlexSync!.handler(c.req.raw);
      res.headers.set('cache-control', 'no-store');
      return res;
    },
  );
  app.get('/api/sync/ibkr-flex/inbox', async (c) => {
    const denied = syncGuard(c);
    if (denied) return denied;
    c.header('Cache-Control', 'no-store');
    return c.json(await opts.ibkrFlexSync!.inbox(portfolioParam(c)));
  });
  // Acknowledge: optional JSON body { ids: [...] } removes only the transactions the web imported
  // (anything synced after the web read the inbox stays); without a body the inbox is emptied.
  app.delete(
    '/api/sync/ibkr-flex/inbox',
    async (c, next) => syncGuard(c) ?? next(),
    bodyLimit({
      maxSize: syncMaxBody,
      onError: (c) => c.json({ error: { code: 'BAD_REQUEST', message: `Body too large (max ${syncMaxBody} bytes)` } }, 413),
    }),
    async (c) => {
      const portfolioId = portfolioParam(c);
      const text = await c.req.text();
      let ids: string[] | undefined;
      if (text.trim()) {
        let body: unknown;
        try {
          body = JSON.parse(text);
        } catch {
          bad('Body must be JSON: { "ids": ["transaction id", ...] }');
        }
        const raw = (body as { ids?: unknown })?.ids;
        if (!Array.isArray(raw) || !raw.every((x) => typeof x === 'string')) bad('"ids" must be an array of transaction ids');
        ids = raw as string[];
      }
      return c.json(await opts.ibkrFlexSync!.clearInbox(portfolioId, ids));
    },
  );

  return app;
}
