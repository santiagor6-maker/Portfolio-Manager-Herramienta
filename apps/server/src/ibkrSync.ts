/**
 * IBKR Flex Web Service sync, mounted on this server (the token never reaches the browser and IBKR
 * sends no CORS headers). Wraps `createIbkrFlexSyncHandler` / `runIbkrFlexSyncJobs` from
 * @pm/importers with:
 *   - a CredentialStore over a PersistentStore (a FileStore in its own directory, never pruned and
 *     never touched by DELETE /api/cache); tokens are AES-256-GCM encrypted with SYNC_SECRET;
 *   - an inbox per portfolio for the optional daily job: the server keeps the transactions it has
 *     already synced (`seen`, so each run only brings new rows) and the ones the web app has not
 *     collected yet (`pending`), read with GET and acknowledged with DELETE /api/sync/ibkr-flex/inbox.
 * Single-user server: every request is user 'default' (access is controlled by API_TOKEN).
 */
import type { Instrument, Transaction } from '@pm/core';
import {
  createIbkrFlexSyncHandler,
  createTokenVault,
  FlexError,
  runIbkrFlexSyncJobs,
  type CredentialStore,
  type IbkrFlexSyncHandlerOptions,
  type IbkrFlexSyncJob,
} from '@pm/importers';
import type { PersistentStore } from '@pm/market-data';

export const SYNC_USER = 'default';

export interface IbkrFlexInbox {
  portfolioId: string;
  /** New transactions synced by the daily job and not yet collected by the web app. */
  pending: Transaction[];
  /** New instruments referenced by `pending`. */
  instruments: Instrument[];
  lastRun?: { at: string; ok: boolean; imported?: number; error?: string };
}

interface InboxState extends IbkrFlexInbox {
  /** Every transaction synced so far (dedupe base for the next run). */
  seen: Transaction[];
  seenInstruments: Instrument[];
}

/** What app.ts mounts. */
export interface IbkrFlexSyncMount {
  handler: (req: Request) => Promise<Response>;
  inbox(portfolioId: string): Promise<IbkrFlexInbox>;
  clearInbox(portfolioId: string, ids?: string[]): Promise<{ cleared: number }>;
}

export interface IbkrDailyJob {
  portfolioId: string;
  credentialId?: string;
  account?: string;
}

export interface IbkrFlexSyncOptions {
  /** Encryption secret (SYNC_SECRET, at least 16 characters; 32 random ones recommended). */
  secret: string;
  store: PersistentStore;
  fetch?: IbkrFlexSyncHandlerOptions['fetch'];
  userAgent?: string;
  /** Poll settings of GetStatement (tests use delayMs 0). */
  delayMs?: number;
  maxAttempts?: number;
  now?: () => Date;
}

export function credentialStore(store: PersistentStore, now: () => Date = () => new Date()): CredentialStore {
  return {
    async get(key) {
      const e = await store.get(key);
      return typeof e?.value === 'string' ? e.value : undefined;
    },
    async set(key, value) {
      await store.set(key, { value, storedAt: now().getTime(), expiresAt: null });
    },
    async delete(key) {
      await store.delete(key);
    },
  };
}

type FlexFetch = NonNullable<IbkrFlexSyncHandlerOptions['fetch']>;

/** IBKR hosts allowed to receive the Flex token (SendRequest and the `<Url>` it returns). */
export function isIbkrHost(url: string): boolean {
  try {
    const u = new URL(url);
    const h = u.hostname.toLowerCase();
    return u.protocol === 'https:' && !u.username && !u.password && (h === 'interactivebrokers.com' || h.endsWith('.interactivebrokers.com'));
  } catch {
    return false;
  }
}

/**
 * Fetch used for IBKR (review R4, M35): the token travels in the query string, so it is only ever
 * sent over HTTPS to *.interactivebrokers.com, whatever `<Url>` SendRequest answers. 60 s timeout.
 */
export function guardedFlexFetch(inner?: FlexFetch, timeoutMs = 60_000): FlexFetch {
  const base: FlexFetch =
    inner ??
    (async (url, init) => {
      const r = await globalThis.fetch(url, { headers: init?.headers ?? {}, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) });
      return { ok: r.ok, status: r.status, text: () => r.text() };
    });
  return (url, init) => {
    if (!isIbkrHost(url)) {
      let host = '?';
      try {
        host = new URL(url).host;
      } catch {
        // keep '?'
      }
      return Promise.reject(new FlexError(`Refused to send the Flex token to ${host}: only https://*.interactivebrokers.com is allowed`));
    }
    return base(url, init);
  };
}

/** Promise-chain lock per key: inbox read-modify-write never interleaves (review R4, M35). */
class KeyedLock {
  private readonly tails = new Map<string, Promise<unknown>>();
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }
}

const txKey = (t: Transaction) => t.importHash ?? t.id;

const inboxKey = (portfolioId: string) => `ibkr-flex-inbox:${SYNC_USER}:${portfolioId}`;
export const PORTFOLIO_ID_RE = /^[\w.-]{1,100}$/;

export class IbkrFlexSync implements IbkrFlexSyncMount {
  readonly handler: (req: Request) => Promise<Response>;
  private readonly opts: IbkrFlexSyncHandlerOptions;
  private readonly now: () => Date;
  private readonly lock = new KeyedLock();

  private constructor(
    private readonly store: PersistentStore,
    opts: IbkrFlexSyncHandlerOptions,
    now: () => Date,
  ) {
    this.opts = opts;
    this.now = now;
    this.handler = createIbkrFlexSyncHandler(opts);
  }

  static async create(o: IbkrFlexSyncOptions): Promise<IbkrFlexSync> {
    const now = o.now ?? (() => new Date());
    const h: IbkrFlexSyncHandlerOptions = {
      vault: await createTokenVault(o.secret),
      store: credentialStore(o.store, now),
      authorize: () => SYNC_USER,
      userAgent: o.userAgent ?? 'PortafolioPro/1.0',
      fetch: guardedFlexFetch(o.fetch),
    };
    if (o.delayMs !== undefined) h.delayMs = o.delayMs;
    if (o.maxAttempts !== undefined) h.maxAttempts = o.maxAttempts;
    return new IbkrFlexSync(o.store, h, now);
  }

  private async state(portfolioId: string): Promise<InboxState> {
    const e = await this.store.get(inboxKey(portfolioId));
    const v = e?.value as InboxState | undefined;
    return v ?? { portfolioId, pending: [], instruments: [], seen: [], seenInstruments: [] };
  }

  private async write(s: InboxState): Promise<void> {
    await this.store.set(inboxKey(s.portfolioId), { value: s, storedAt: this.now().getTime(), expiresAt: null });
  }

  async inbox(portfolioId: string): Promise<IbkrFlexInbox> {
    const { seen: _seen, seenInstruments: _si, ...rest } = await this.state(portfolioId);
    return rest;
  }

  /**
   * The web app acknowledges what it imported. With `ids` only those transactions leave the inbox,
   * so rows added by a sync that finished after the web read the inbox are not lost.
   */
  async clearInbox(portfolioId: string, ids?: string[]): Promise<{ cleared: number }> {
    return this.lock.run(portfolioId, async () => {
      const s = await this.state(portfolioId);
      const ack = ids ? new Set(ids) : undefined;
      const pending = ack ? s.pending.filter((t) => !ack.has(t.id) && !ack.has(txKey(t))) : [];
      const used = new Set(pending.map((t) => t.instrumentId));
      await this.write({ ...s, pending, instruments: ack ? s.instruments.filter((i) => used.has(i.id)) : [] });
      return { cleared: s.pending.length - pending.length };
    });
  }

  /** Run the daily sync for each job; errors are reported per job and recorded in its inbox. */
  async runDaily(jobs: IbkrDailyJob[]): Promise<Awaited<ReturnType<typeof runIbkrFlexSyncJobs>>> {
    // One daily run at a time; inbox writes are additionally locked per portfolio.
    return this.lock.run('\u0000daily', () => this.runDailyUnlocked(jobs));
  }

  private async runDailyUnlocked(jobs: IbkrDailyJob[]): Promise<Awaited<ReturnType<typeof runIbkrFlexSyncJobs>>> {
    // Transactions actually added per portfolio (a row may yield several, e.g. a separate FX fee).
    const added = new Map<string, number>();
    const mapped: IbkrFlexSyncJob[] = jobs.map((j) => {
      const job: IbkrFlexSyncJob = {
        userId: SYNC_USER,
        portfolioId: j.portfolioId,
        load: async () => {
          const s = await this.state(j.portfolioId);
          return { transactions: s.seen, instruments: s.seenInstruments };
        },
        save: (result) =>
          this.lock.run(j.portfolioId, async () => {
            // Re-read under the lock and dedupe again: the state may have changed since load().
            const s = await this.state(j.portfolioId);
            const seenKeys = new Set(s.seen.map(txKey));
            const txs = result.transactions.filter((t) => !seenKeys.has(txKey(t)));
            const known = new Set(s.seenInstruments.map((i) => i.id));
            const fresh = result.instruments.filter((i) => !known.has(i.id));
            added.set(j.portfolioId, (added.get(j.portfolioId) ?? 0) + txs.length);
            await this.write({
              ...s,
              seen: [...s.seen, ...txs],
              seenInstruments: [...s.seenInstruments, ...fresh],
              pending: [...s.pending, ...txs],
              instruments: [...s.instruments, ...fresh.filter((i) => !s.instruments.some((x) => x.id === i.id))],
            });
          }),
      };
      if (j.credentialId) job.credentialId = j.credentialId;
      if (j.account) job.account = j.account;
      return job;
    });
    const results = (await runIbkrFlexSyncJobs(mapped, this.opts)).map((r) =>
      r.ok && added.has(r.portfolioId) ? { ...r, imported: added.get(r.portfolioId)! } : r,
    );
    for (const r of results) {
      const lastRun: NonNullable<IbkrFlexInbox['lastRun']> = { at: this.now().toISOString(), ok: r.ok };
      if (r.imported !== undefined) lastRun.imported = r.imported;
      if (r.error) lastRun.error = r.error;
      await this.lock.run(r.portfolioId, async () => this.write({ ...(await this.state(r.portfolioId)), lastRun }));
    }
    return results;
  }
}

/** Parse IBKR_FLEX_DAILY: "portfolioId[:credentialId],..." */
export function parseDailyJobs(spec: string | undefined): IbkrDailyJob[] {
  if (!spec?.trim() || spec.trim() === 'none') return [];
  return spec.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const [portfolioId, credentialId] = s.split(':') as [string, string | undefined];
    if (!PORTFOLIO_ID_RE.test(portfolioId) || (credentialId !== undefined && !PORTFOLIO_ID_RE.test(credentialId))) {
      throw new Error(`IBKR_FLEX_DAILY: invalid entry "${s}" (expected portfolioId[:credentialId])`);
    }
    return credentialId ? { portfolioId, credentialId } : { portfolioId };
  });
}

/** Milliseconds until the next HH:00 UTC strictly after `now`. */
export function msUntilHourUtc(hour: number, now: Date): number {
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, 0, 0));
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  return next.getTime() - now.getTime();
}
