/**
 * Two-tier cache: in-memory LRU in front of an optional persistent store (file system on the
 * server, IndexedDB or nothing in the browser). Includes in-flight de-duplication of loads and
 * stale-if-error (an expired entry is served when the upstream fails).
 *
 * TTL policy (see `historyTtlMs`):
 *  - ranges that end before the current month: immutable (as-traded closes of closed months
 *    never change; that is why we un-adjust Yahoo's retroactive split adjustment),
 *  - ranges ending earlier this month: 12 h,
 *  - ranges reaching today: 10 min (quotes: 10 min, configurable 5-15).
 */
import type { ISODate } from '@pm/core';
import { startOfMonth } from './dates';

export interface CacheEntry<T = unknown> {
  value: T;
  storedAt: number;
  /** Epoch ms; null = never expires. */
  expiresAt: number | null;
}

/** Pluggable persistent store. Implementations must be safe to call concurrently. */
export interface PersistentStore {
  get(key: string): Promise<CacheEntry | undefined>;
  set(key: string, entry: CacheEntry): Promise<void>;
  delete(key: string): Promise<void>;
  /** Optional: delete every key starting with `prefix`; returns how many were removed. */
  deletePrefix?(prefix: string): Promise<number>;
}

export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const TTL = {
  IMMUTABLE: Number.POSITIVE_INFINITY,
  QUOTE: 10 * MINUTE,
  INTRADAY_HISTORY: 10 * MINUTE,
  RECENT_HISTORY: 12 * HOUR,
  SEARCH: DAY,
  SPLITS: DAY,
} as const;

/** TTL for a historical range ending at `to`, relative to `today`. */
export function historyTtlMs(to: ISODate, today: ISODate): number {
  if (to < startOfMonth(today)) return TTL.IMMUTABLE;
  if (to < today) return TTL.RECENT_HISTORY;
  return TTL.INTRADAY_HISTORY;
}

export class LruCache<T = unknown> {
  private readonly map = new Map<string, CacheEntry<T>>();

  constructor(private readonly maxEntries = 500) {}

  get size(): number {
    return this.map.size;
  }

  /** Returns the entry even if expired (caller decides); refreshes recency. */
  peek(key: string): CacheEntry<T> | undefined {
    const e = this.map.get(key);
    if (e) {
      this.map.delete(key);
      this.map.set(key, e);
    }
    return e;
  }

  set(key: string, entry: CacheEntry<T>): void {
    this.map.delete(key);
    this.map.set(key, entry);
    while (this.map.size > this.maxEntries) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  delete(key: string): void {
    this.map.delete(key);
  }

  keys(): string[] {
    return [...this.map.keys()];
  }

  clear(): void {
    this.map.clear();
  }
}

/** Persistent store kept in memory (tests, or as a no-op stand-in). */
export class MemoryStore implements PersistentStore {
  readonly data = new Map<string, CacheEntry>();
  async get(key: string) {
    return this.data.get(key);
  }
  async set(key: string, entry: CacheEntry) {
    this.data.set(key, entry);
  }
  async delete(key: string) {
    this.data.delete(key);
  }
  async deletePrefix(prefix: string) {
    let n = 0;
    for (const k of [...this.data.keys()]) if (k.startsWith(prefix) && this.data.delete(k)) n++;
    return n;
  }
}

export interface TieredCacheOptions {
  maxEntries?: number;
  store?: PersistentStore;
  /** Only entries whose TTL is at least this long are written to the persistent store. */
  persistMinTtlMs?: number;
  now?: () => number;
}

export interface LoadResult<T> {
  value: T;
  /** 'memory' | 'store' hit, fresh 'load', or 'stale' (expired entry served after a load error). */
  from: 'memory' | 'store' | 'load' | 'stale';
}

export class TieredCache {
  readonly memory: LruCache;
  readonly store?: PersistentStore;
  private readonly persistMinTtlMs: number;
  private readonly now: () => number;
  private readonly inflight = new Map<string, Promise<LoadResult<unknown>>>();

  constructor(opts: TieredCacheOptions = {}) {
    this.memory = new LruCache(opts.maxEntries ?? 1000);
    this.store = opts.store;
    this.persistMinTtlMs = opts.persistMinTtlMs ?? HOUR;
    this.now = opts.now ?? Date.now;
  }

  private fresh(e: CacheEntry | undefined): boolean {
    return !!e && (e.expiresAt === null || e.expiresAt > this.now());
  }

  /** Fresh value or undefined. */
  async get<T>(key: string): Promise<T | undefined> {
    const r = await this.lookup(key);
    return r && this.fresh(r.entry) ? (r.entry.value as T) : undefined;
  }

  private async lookup(key: string): Promise<{ entry: CacheEntry; tier: 'memory' | 'store' } | undefined> {
    const m = this.memory.peek(key);
    if (m && this.fresh(m)) return { entry: m, tier: 'memory' };
    if (this.store) {
      try {
        const s = await this.store.get(key);
        if (s) {
          if (this.fresh(s)) this.memory.set(key, s);
          if (this.fresh(s) || !m) return { entry: s, tier: 'store' };
        }
      } catch {
        // A broken persistent store must never break reads.
      }
    }
    return m ? { entry: m, tier: 'memory' } : undefined;
  }

  async set<T>(key: string, value: T, ttlMs: number, opts: { persist?: boolean } = {}): Promise<void> {
    const storedAt = this.now();
    const entry: CacheEntry<T> = {
      value,
      storedAt,
      expiresAt: Number.isFinite(ttlMs) ? storedAt + ttlMs : null,
    };
    this.memory.set(key, entry);
    if (this.store && opts.persist !== false && ttlMs >= this.persistMinTtlMs) {
      try {
        await this.store.set(key, entry);
      } catch {
        // ignore persistence failures
      }
    }
  }

  async delete(key: string): Promise<void> {
    this.memory.delete(key);
    await this.store?.delete(key).catch(() => undefined);
  }

  /** Invalidate every entry whose key starts with `prefix` (memory and store). */
  async deletePrefix(prefix: string): Promise<{ memory: number; store: number }> {
    let memory = 0;
    for (const k of this.memory.keys()) {
      if (k.startsWith(prefix)) {
        this.memory.delete(k);
        memory++;
      }
    }
    const store = (await this.store?.deletePrefix?.(prefix).catch(() => 0)) ?? 0;
    return { memory, store };
  }

  /**
   * Return a fresh cached value or run `loader` once (concurrent callers share the load).
   * `ttl` may depend on the loaded value. On loader failure an expired entry is served.
   */
  async getOrLoad<T>(
    key: string,
    ttl: number | ((value: T) => number),
    loader: () => Promise<T>,
    opts: { persist?: boolean } = {},
  ): Promise<LoadResult<T>> {
    const found = await this.lookup(key);
    if (found && this.fresh(found.entry)) return { value: found.entry.value as T, from: found.tier };
    const running = this.inflight.get(key);
    if (running) return running as Promise<LoadResult<T>>;
    const p = (async (): Promise<LoadResult<T>> => {
      try {
        const value = await loader();
        await this.set(key, value, typeof ttl === 'function' ? ttl(value) : ttl, opts);
        return { value, from: 'load' };
      } catch (e) {
        if (found) return { value: found.entry.value as T, from: 'stale' };
        throw e;
      }
    })().finally(() => this.inflight.delete(key));
    this.inflight.set(key, p as Promise<LoadResult<unknown>>);
    return p;
  }
}
