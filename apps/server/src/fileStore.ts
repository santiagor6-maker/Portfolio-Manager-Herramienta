/**
 * File-system implementation of the market-data PersistentStore.
 * One JSON file per key (sha1 of the key, sharded by the first 2 hex chars), atomic writes
 * (write to temp file + rename). Expired entries are kept: the cache serves them on upstream
 * errors (stale-if-error) and overwrites them on refresh.
 *
 * Bounded (review R1, M16): after every `pruneEvery` writes, if there are more than `maxFiles`
 * files the least recently used ones (by mtime; reads touch the file) are deleted.
 * `deletePrefix()` supports invalidation (DELETE /api/cache).
 */
import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CacheEntry, PersistentStore } from '@pm/market-data';

export interface FileStoreOptions {
  maxFiles?: number;
  pruneEvery?: number;
}

export class FileStore implements PersistentStore {
  private writes = 0;
  private readonly maxFiles: number;
  private readonly pruneEvery: number;

  constructor(
    readonly dir: string,
    opts: FileStoreOptions = {},
  ) {
    this.maxFiles = opts.maxFiles ?? 20_000;
    this.pruneEvery = opts.pruneEvery ?? 200;
  }

  private pathFor(key: string): { dir: string; file: string } {
    const h = createHash('sha1').update(key).digest('hex');
    const dir = join(this.dir, h.slice(0, 2));
    return { dir, file: join(dir, `${h}.json`) };
  }

  async get(key: string): Promise<CacheEntry | undefined> {
    const { file } = this.pathFor(key);
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as { key: string; entry: CacheEntry };
      if (parsed.key !== key) return undefined; // hash collision guard
      const now = new Date();
      await utimes(file, now, now).catch(() => undefined);
      return parsed.entry;
    } catch {
      return undefined;
    }
  }

  async set(key: string, entry: CacheEntry): Promise<void> {
    const { dir, file } = this.pathFor(key);
    await mkdir(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, JSON.stringify({ key, entry }), 'utf8');
    await rename(tmp, file);
    if (++this.writes % this.pruneEvery === 0) await this.prune().catch(() => undefined);
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key).file, { force: true });
  }

  private async files(): Promise<string[]> {
    const out: string[] = [];
    let shards: string[];
    try {
      shards = await readdir(this.dir);
    } catch {
      return out;
    }
    for (const s of shards) {
      try {
        for (const f of await readdir(join(this.dir, s))) if (f.endsWith('.json')) out.push(join(this.dir, s, f));
      } catch {
        // not a directory
      }
    }
    return out;
  }

  /** Delete least recently used files beyond `maxFiles`. Returns how many were removed. */
  async prune(maxFiles = this.maxFiles): Promise<number> {
    const files = await this.files();
    if (files.length <= maxFiles) return 0;
    const withTime = await Promise.all(files.map(async (f) => ({ f, t: (await stat(f).catch(() => undefined))?.mtimeMs ?? 0 })));
    withTime.sort((a, b) => a.t - b.t);
    const victims = withTime.slice(0, files.length - maxFiles);
    await Promise.all(victims.map((v) => rm(v.f, { force: true })));
    return victims.length;
  }

  async deletePrefix(prefix: string): Promise<number> {
    let n = 0;
    for (const f of await this.files()) {
      try {
        const { key } = JSON.parse(await readFile(f, 'utf8')) as { key: string };
        if (key.startsWith(prefix)) {
          await rm(f, { force: true });
          n++;
        }
      } catch {
        // ignore unreadable files
      }
    }
    return n;
  }
}
