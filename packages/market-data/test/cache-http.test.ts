import { describe, expect, it } from 'vitest';
import {
  HOUR,
  HttpClient,
  historyTtlMs,
  Limiter,
  LruCache,
  MemoryStore,
  MINUTE,
  parseRetryAfter,
  TieredCache,
  TTL,
} from '../src/index';

describe('TTL policy', () => {
  const today = '2026-10-05';
  it('closed months are immutable', () => {
    expect(historyTtlMs('2026-09-30', today)).toBe(Number.POSITIVE_INFINITY);
    expect(historyTtlMs('2020-01-31', today)).toBe(TTL.IMMUTABLE);
  });
  it('earlier this month: 12h; reaching today: 10 min', () => {
    expect(historyTtlMs('2026-10-02', today)).toBe(12 * HOUR);
    expect(historyTtlMs('2026-10-05', today)).toBe(10 * MINUTE);
  });
  it('quote TTL within 5-15 min', () => {
    expect(TTL.QUOTE).toBeGreaterThanOrEqual(5 * MINUTE);
    expect(TTL.QUOTE).toBeLessThanOrEqual(15 * MINUTE);
  });
});

describe('LruCache', () => {
  it('evicts least recently used', () => {
    const c = new LruCache<number>(2);
    const e = (v: number) => ({ value: v, storedAt: 0, expiresAt: null });
    c.set('a', e(1));
    c.set('b', e(2));
    c.peek('a'); // a becomes most recent
    c.set('c', e(3));
    expect(c.peek('b')).toBeUndefined();
    expect(c.peek('a')?.value).toBe(1);
    expect(c.size).toBe(2);
  });
});

describe('TieredCache', () => {
  function setup(persistMinTtlMs = HOUR) {
    let now = 1_000_000;
    const store = new MemoryStore();
    const cache = new TieredCache({ store, now: () => now, persistMinTtlMs });
    return { cache, store, advance: (ms: number) => (now += ms) };
  }

  it('expires entries after their TTL; immutable never expires', async () => {
    const { cache, advance } = setup();
    await cache.set('q', 1, 10 * MINUTE);
    await cache.set('h', 2, TTL.IMMUTABLE);
    advance(9 * MINUTE);
    expect(await cache.get('q')).toBe(1);
    advance(2 * MINUTE);
    expect(await cache.get('q')).toBeUndefined();
    advance(10 * 365 * 24 * HOUR);
    expect(await cache.get('h')).toBe(2);
  });

  it('persists only long-lived entries and reads them back after a restart', async () => {
    const { cache, store } = setup();
    await cache.set('quote', 1, 10 * MINUTE);
    await cache.set('closed', [1, 2], TTL.IMMUTABLE);
    expect(store.data.has('quote')).toBe(false);
    expect(store.data.get('closed')?.expiresAt).toBeNull();
    const fresh = new TieredCache({ store });
    expect(await fresh.get('closed')).toEqual([1, 2]);
  });

  it('getOrLoad de-duplicates concurrent loads', async () => {
    const { cache } = setup();
    let calls = 0;
    const loader = async () => {
      calls++;
      await new Promise((r) => setTimeout(r, 5));
      return 42;
    };
    const rs = await Promise.all([1, 2, 3].map(() => cache.getOrLoad('k', MINUTE, loader)));
    expect(rs.map((r) => r.value)).toEqual([42, 42, 42]);
    expect(calls).toBe(1);
    expect((await cache.getOrLoad('k', MINUTE, loader)).from).toBe('memory');
  });

  it('serves a stale entry when the upstream fails (stale-if-error)', async () => {
    const { cache, advance } = setup();
    await cache.getOrLoad('k', MINUTE, async () => 'v1');
    advance(2 * MINUTE);
    const r = await cache.getOrLoad('k', MINUTE, async () => {
      throw new Error('down');
    });
    expect(r).toEqual({ value: 'v1', from: 'stale' });
    await expect(cache.getOrLoad('other', MINUTE, async () => Promise.reject(new Error('down')))).rejects.toThrow('down');
  });

  it('TTL may depend on the loaded value', async () => {
    const { cache, advance } = setup();
    await cache.getOrLoad('k', (v: number) => (v > 0 ? MINUTE : HOUR), async () => 1);
    advance(2 * MINUTE);
    expect(await cache.get('k')).toBeUndefined();
  });
});

describe('HttpClient', () => {
  const noSleep = async () => undefined;

  it('retries 429 honouring Retry-After, then succeeds', async () => {
    let n = 0;
    const waits: number[] = [];
    const http = new HttpClient({
      sleep: async (ms) => void waits.push(ms),
      fetch: async () => (++n < 3 ? new Response('slow down', { status: 429, headers: { 'retry-after': '2' } }) : new Response('{"ok":1}')),
    });
    expect(await http.getJson('https://x.test/a')).toEqual({ ok: 1 });
    expect(n).toBe(3);
    expect(waits).toContain(2000);
  });

  it('persistent 429 -> RATE_LIMITED error', async () => {
    const http = new HttpClient({ sleep: noSleep, retries: 2, fetch: async () => new Response('', { status: 429 }) });
    await expect(http.getJson('https://x.test/a')).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('does not retry 4xx (other than 429)', async () => {
    let n = 0;
    const http = new HttpClient({ sleep: noSleep, fetch: async () => (n++, new Response('nope', { status: 404 })) });
    await expect(http.getJson('https://x.test/a')).rejects.toMatchObject({ status: 404 });
    expect(n).toBe(1);
  });

  it('retries network errors and 5xx', async () => {
    let n = 0;
    const http = new HttpClient({
      sleep: noSleep,
      fetch: async () => {
        n++;
        if (n === 1) throw new TypeError('fetch failed');
        if (n === 2) return new Response('', { status: 502 });
        return new Response('[1]');
      },
    });
    expect(await http.getJson('https://x.test/a')).toEqual([1]);
  });

  it('de-duplicates identical in-flight GETs and sends a browser User-Agent', async () => {
    let n = 0;
    let ua = '';
    const http = new HttpClient({
      sleep: noSleep,
      fetch: async (_u, init) => {
        n++;
        ua = new Headers(init?.headers).get('user-agent') ?? '';
        await new Promise((r) => setTimeout(r, 5));
        return new Response('{"v":1}');
      },
    });
    await Promise.all([http.getJson('https://x.test/a'), http.getJson('https://x.test/a'), http.getJson('https://x.test/a')]);
    expect(n).toBe(1);
    expect(ua).toMatch(/Mozilla\/5\.0/);
  });

  it('times out slow requests', async () => {
    const http = new HttpClient({
      sleep: noSleep,
      retries: 0,
      timeoutMs: 20,
      fetch: (_u, init) =>
        new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))),
    });
    await expect(http.getJson('https://x.test/slow')).rejects.toMatchObject({ code: 'TIMEOUT' });
  });

  it('parses Retry-After seconds and dates', () => {
    expect(parseRetryAfter('3')).toBe(3000);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter(new Date(Date.now() + 60_000).toUTCString())).toBeGreaterThan(50_000);
  });
});

describe('Limiter', () => {
  it('never exceeds the concurrency limit', async () => {
    const l = new Limiter({ concurrency: 2, minIntervalMs: 0 });
    let active = 0;
    let peak = 0;
    await Promise.all(
      Array.from({ length: 10 }, () =>
        l.run(async () => {
          active++;
          peak = Math.max(peak, active);
          await new Promise((r) => setTimeout(r, 3));
          active--;
        }),
      ),
    );
    expect(peak).toBe(2);
  });

  it('spaces request starts by minIntervalMs', async () => {
    const waits: number[] = [];
    const l = new Limiter({ concurrency: 5, minIntervalMs: 100 }, async (ms) => void waits.push(ms));
    await Promise.all([1, 2, 3].map(() => l.run(async () => undefined)));
    expect(waits.length).toBe(2);
    expect(Math.max(...waits)).toBeGreaterThan(150);
  });
});
