/**
 * Node entry point: `npm run start -w @pm/server` (or `npx tsx apps/server/src/main.ts`).
 * Env: PORT (default 8787), HOST (default 0.0.0.0), CACHE_DIR (default .cache/market-data),
 *      CORS_ORIGIN (comma-separated, default *), SOCRATA_APP_TOKEN (optional, datos.gov.co).
 */
import { resolve } from 'node:path';
import { serve } from '@hono/node-server';
import { MarketDataService } from '@pm/market-data';
import { createApp } from './app';
import { FileStore } from './fileStore';

const port = Number(process.env.PORT ?? 8787);
const hostname = process.env.HOST ?? '0.0.0.0';
const cacheDir = resolve(process.env.CACHE_DIR ?? '.cache/market-data');
const corsOrigin = process.env.CORS_ORIGIN ? process.env.CORS_ORIGIN.split(',').map((s) => s.trim()) : '*';

const service = new MarketDataService({
  store: new FileStore(cacheDir),
  trmAppToken: process.env.SOCRATA_APP_TOKEN,
  httpOptions: {
    onRequest: ({ url, status, ms, attempt }) => {
      const u = new URL(url);
      console.log(`  upstream ${u.host}${u.pathname.slice(0, 60)} -> ${status} ${ms}ms${attempt ? ` (retry ${attempt})` : ''}`);
    },
  },
});

const app = createApp({ service, corsOrigin });

const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`Portafolio Pro market-data API on http://localhost:${info.port} (cache: ${cacheDir})`);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    server.close();
    process.exit(0);
  });
}
