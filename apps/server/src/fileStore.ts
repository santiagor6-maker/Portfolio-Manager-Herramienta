/**
 * File-system implementation of the market-data PersistentStore.
 * One JSON file per key (sha1 of the key, sharded by the first 2 hex chars), atomic writes
 * (write to temp file + rename). Expired entries are kept: the cache serves them on upstream
 * errors (stale-if-error) and overwrites them on refresh.
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { CacheEntry, PersistentStore } from '@pm/market-data';

export class FileStore implements PersistentStore {
  constructor(readonly dir: string) {}

  private pathFor(key: string): { dir: string; file: string } {
    const h = createHash('sha1').update(key).digest('hex');
    const dir = join(this.dir, h.slice(0, 2));
    return { dir, file: join(dir, `${h}.json`) };
  }

  async get(key: string): Promise<CacheEntry | undefined> {
    const { file } = this.pathFor(key);
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as { key: string; entry: CacheEntry };
      // Guard against (astronomically unlikely) hash collisions.
      return parsed.key === key ? parsed.entry : undefined;
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
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key).file, { force: true });
  }
}
