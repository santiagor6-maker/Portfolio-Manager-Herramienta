/**
 * Node entry point: `npm run start -w @pm/server` (or `npx tsx apps/server/src/main.ts`).
 * Env:
 *   PORT (8787), HOST (127.0.0.1 — set 0.0.0.0 only behind a firewall/proxy),
 *   CORS_ORIGIN (comma-separated allowlist; default local web dev origins; '*' = any),
 *   API_TOKEN (optional bearer token), TRUST_PROXY=1 (use X-Forwarded-For for rate limiting),
 *   RATE_LIMIT_PER_MIN (default 120; a batch costs one token per item), ALLOWED_HOSTS (Host header
 *   allowlist; default localhost/127.0.0.1/[::1] when HOST is loopback), ALLOW_LOCAL_ADMIN=1
 *   (DELETE /api/cache without token from a direct loopback socket),
 *   CACHE_DIR (.cache/market-data), CACHE_MAX_FILES (20000),
 *   MD_CUSTOM_FEEDS_FILE (JSON array of user-defined feeds),
 *   provider keys: BRAPI_TOKEN, TWELVEDATA_API_KEY, FMP_API_KEY, EODHD_API_TOKEN,
 *   ALPHAVANTAGE_API_KEY (+ALPHAVANTAGE_PREMIUM=1), STOOQ_API_KEY, COINGECKO_API_KEY, SOCRATA_APP_TOKEN.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { keysFromEnv, MarketDataService, type CustomFeedInstrument } from '@pm/market-data';
import { createApp, DEFAULT_CORS_ORIGINS } from './app';
import { FileStore } from './fileStore';

const env = process.env;
const port = Number(env.PORT ?? 8787);
const hostname = env.HOST ?? '127.0.0.1';
const cacheDir = resolve(env.CACHE_DIR ?? '.cache/market-data');
const corsOrigin = env.CORS_ORIGIN ? env.CORS_ORIGIN.split(',').map((s) => s.trim()) : DEFAULT_CORS_ORIGINS;
const perMin = Number(env.RATE_LIMIT_PER_MIN ?? 120);
const loopbackHost = ['127.0.0.1', 'localhost', '::1'].includes(hostname);
const allowedHosts = env.ALLOWED_HOSTS
  ? env.ALLOWED_HOSTS.split(',').map((s) => s.trim())
  : loopbackHost
    ? ['localhost', '127.0.0.1', '[::1]']
    : undefined;

let customFeeds: CustomFeedInstrument[] = [];
if (env.MD_CUSTOM_FEEDS_FILE) {
  customFeeds = JSON.parse(readFileSync(resolve(env.MD_CUSTOM_FEEDS_FILE), 'utf8')) as CustomFeedInstrument[];
  console.log(`Loaded ${customFeeds.length} custom feed(s) from ${env.MD_CUSTOM_FEEDS_FILE}`);
}

const store = new FileStore(cacheDir, { maxFiles: Number(env.CACHE_MAX_FILES ?? 20_000) });
const service = new MarketDataService({
  store,
  keys: keysFromEnv(env),
  customFeeds,
  httpOptions: {
    onRequest: ({ url, status, ms, attempt }) => {
      const u = new URL(url);
      console.log(`  upstream ${u.host}${u.pathname.slice(0, 60)} -> ${status} ${ms}ms${attempt ? ` (retry ${attempt})` : ''}`);
    },
  },
});

const app = createApp({
  service,
  corsOrigin,
  apiToken: env.API_TOKEN || undefined,
  trustProxy: env.TRUST_PROXY === '1',
  rateLimit: perMin > 0 ? { capacity: perMin, refillPerSecond: perMin / 60 } : false,
  allowedHosts,
  allowLocalAdmin: env.ALLOW_LOCAL_ADMIN === '1',
});

const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`Portafolio Pro market-data API on http://${hostname}:${info.port} (cache: ${cacheDir})`);
  console.log(`  providers: ${JSON.stringify(service.providers())}`);
  if (hostname === '0.0.0.0' && !env.API_TOKEN) console.warn('  WARNING: listening on all interfaces without API_TOKEN');
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    server.close();
    process.exit(0);
  });
}
