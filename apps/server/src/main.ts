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
 *   MD_FROZEN_DIR (directory of *.json recorded histories of delisted securities, see frozen.ts),
 *   SNAPSHOT_EXCHANGES (default XBOG,XLON; 'none' disables) / SNAPSHOT_HOURS (12): local price snapshot,
 *   provider keys: BRAPI_TOKEN, TWELVEDATA_API_KEY, FMP_API_KEY, EODHD_API_TOKEN,
 *   ALPHAVANTAGE_API_KEY (+ALPHAVANTAGE_PREMIUM=1), STOOQ_API_KEY, COINGECKO_API_KEY, SOCRATA_APP_TOKEN.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { keysFromEnv, MarketDataService, validateFrozen, type CustomFeedInstrument, type FrozenHistory } from '@pm/market-data';
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

// Recorded histories of securities that no longer trade (review R3, M29). A bad file is reported
// and skipped; it never prevents the server from starting.
const frozenHistories: FrozenHistory[] = [];
if (env.MD_FROZEN_DIR) {
  const dir = resolve(env.MD_FROZEN_DIR);
  for (const name of readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
    try {
      frozenHistories.push(validateFrozen(JSON.parse(readFileSync(join(dir, name), 'utf8'))));
    } catch (e) {
      console.warn(`  skipped frozen history ${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  console.log(`Loaded ${frozenHistories.length} frozen histor${frozenHistories.length === 1 ? 'y' : 'ies'} from ${dir}`);
}

const store = new FileStore(cacheDir, { maxFiles: Number(env.CACHE_MAX_FILES ?? 20_000) });
const service = new MarketDataService({
  store,
  keys: keysFromEnv(env),
  customFeeds,
  frozenHistories,
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

// Local price snapshot (review R3, M2): periodically record the current-year closes of the
// catalog's BVC and London instruments, served if every live provider fails later.
const snapshotExchanges = (env.SNAPSHOT_EXCHANGES ?? 'XBOG,XLON').split(',').map((x) => x.trim()).filter((x) => x && x !== 'none');
if (snapshotExchanges.length) {
  const hours = Number(env.SNAPSHOT_HOURS ?? 12);
  const run = async () => {
    const started = Date.now();
    const r = await service.recordSnapshot(snapshotExchanges);
    console.log(`snapshot ${snapshotExchanges.join(',')}: ${r.ok} recorded, ${r.failed.length} failed in ${Math.round((Date.now() - started) / 1000)}s`);
  };
  setTimeout(() => void run().catch((e) => console.error('snapshot failed', e)), 30_000).unref();
  setInterval(() => void run().catch((e) => console.error('snapshot failed', e)), hours * 3_600_000).unref();
}

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    server.close();
    process.exit(0);
  });
}
