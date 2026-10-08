/**
 * Server-side sync glue, ready to mount (I2). Runtime-agnostic: Web Fetch API `Request`/`Response`
 * and WebCrypto (Node ≥ 20, Deno, Bun, Cloudflare Workers) — no Node-only APIs.
 *
 *   import { createIbkrFlexSyncHandler, createTokenVault, MemoryCredentialStore } from '@pm/importers';
 *   const handler = createIbkrFlexSyncHandler({
 *     vault: await createTokenVault(process.env.SYNC_SECRET!),     // ≥ 32 random chars
 *     store: myDbCredentialStore,                                  // or new MemoryCredentialStore()
 *     authorize: async (req) => userIdFromSession(req),            // undefined → 401
 *     userAgent: 'PortafolioPro/1.0',
 *   });
 *   app.post('/api/sync/ibkr-flex', (c) => handler(c.req.raw));    // Hono
 *
 * Actions (JSON body):
 *   { action: 'save', token, queryId, credentialId? }            → { credentialId }   (token encrypted at rest)
 *   { action: 'sync', credentialId, portfolioId, existingTransactions?, existingInstruments?, account?, catalog? }
 *                                                                  → ImportResult
 *   { action: 'delete', credentialId }                            → { ok: true }
 * The token never reaches the browser after it is saved; daily syncs run with `runIbkrFlexSyncJobs`.
 */
import type { Instrument, Transaction } from '@pm/core';
import type { ImportOptions, ImportResult } from '../types';
import { FlexError, syncIbkrFlex, type FlexClientOptions } from './ibkr-flex';

export interface CredentialStore {
  get(key: string): Promise<string | undefined>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

/** In-memory store (tests / single-process dev). Use a DB-backed store in production. */
export class MemoryCredentialStore implements CredentialStore {
  private readonly m = new Map<string, string>();
  async get(key: string) {
    return this.m.get(key);
  }
  async set(key: string, value: string) {
    this.m.set(key, value);
  }
  async delete(key: string) {
    this.m.delete(key);
  }
  /** For tests: raw stored (encrypted) values. */
  rawValues(): string[] {
    return [...this.m.values()];
  }
}

export interface TokenVault {
  encrypt(plain: string): Promise<string>;
  decrypt(sealed: string): Promise<string>;
}

const b64 = (bytes: Uint8Array) => {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/** AES-256-GCM vault; the key is derived from `secret` with SHA-256. Sealed format: base64(iv[12] ‖ ciphertext). */
export async function createTokenVault(secret: string): Promise<TokenVault> {
  if (!secret || secret.length < 16) throw new Error('SYNC secret must have at least 16 characters');
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new Error('WebCrypto is not available');
  const raw = await subtle.digest('SHA-256', new TextEncoder().encode(secret));
  const key = await subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
  return {
    async encrypt(plain) {
      const iv = globalThis.crypto.getRandomValues(new Uint8Array(12));
      const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plain)));
      const out = new Uint8Array(iv.length + ct.length);
      out.set(iv);
      out.set(ct, iv.length);
      return b64(out);
    },
    async decrypt(sealed) {
      const bytes = unb64(sealed);
      const pt = await subtle.decrypt({ name: 'AES-GCM', iv: bytes.subarray(0, 12) }, key, bytes.subarray(12));
      return new TextDecoder().decode(pt);
    },
  };
}

export interface IbkrFlexSyncHandlerOptions {
  vault: TokenVault;
  store: CredentialStore;
  /** Resolve the authenticated user id from the request; undefined → 401. Default: single-user ('default'). */
  authorize?: (req: Request) => Promise<string | undefined> | string | undefined;
  fetch?: FlexClientOptions['fetch'];
  userAgent?: string;
  maxAttempts?: number;
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

interface SavedCredential {
  token: string;
  queryId: string;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

const storeKey = (userId: string, credentialId: string) => `ibkr-flex:${userId}:${credentialId}`;

async function loadCredential(o: IbkrFlexSyncHandlerOptions, userId: string, credentialId: string): Promise<SavedCredential | undefined> {
  const sealed = await o.store.get(storeKey(userId, credentialId));
  if (!sealed) return undefined;
  return JSON.parse(await o.vault.decrypt(sealed)) as SavedCredential;
}

function clientOptions(o: IbkrFlexSyncHandlerOptions, c: SavedCredential): FlexClientOptions {
  const f: FlexClientOptions = { token: c.token, queryId: c.queryId };
  if (o.fetch) f.fetch = o.fetch;
  if (o.userAgent) f.userAgent = o.userAgent;
  if (o.maxAttempts) f.maxAttempts = o.maxAttempts;
  if (o.delayMs !== undefined) f.delayMs = o.delayMs;
  if (o.sleep) f.sleep = o.sleep;
  return f;
}

/** Ready-to-mount `(Request) => Response` handler for IBKR Flex Web Service sync. */
export function createIbkrFlexSyncHandler(o: IbkrFlexSyncHandlerOptions): (req: Request) => Promise<Response> {
  return async (req) => {
    if (req.method !== 'POST') return json(405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'Usa POST.' } });
    const userId = o.authorize ? await o.authorize(req) : 'default';
    if (!userId) return json(401, { error: { code: 'UNAUTHORIZED', message: 'Sesión requerida.' } });
    let body: Record<string, unknown>;
    try {
      body = (await req.json()) as Record<string, unknown>;
    } catch {
      return json(400, { error: { code: 'BAD_REQUEST', message: 'JSON inválido.' } });
    }
    const credentialId = typeof body.credentialId === 'string' && body.credentialId ? body.credentialId : 'default';
    try {
      switch (body.action) {
        case 'save': {
          if (typeof body.token !== 'string' || typeof body.queryId !== 'string' || !body.token || !body.queryId) {
            return json(400, { error: { code: 'BAD_REQUEST', message: 'Faltan token y queryId.' } });
          }
          const sealed = await o.vault.encrypt(JSON.stringify({ token: body.token, queryId: body.queryId } satisfies SavedCredential));
          await o.store.set(storeKey(userId, credentialId), sealed);
          return json(200, { credentialId });
        }
        case 'delete':
          await o.store.delete(storeKey(userId, credentialId));
          return json(200, { ok: true });
        case 'sync': {
          if (typeof body.portfolioId !== 'string') return json(400, { error: { code: 'BAD_REQUEST', message: 'Falta portfolioId.' } });
          const cred = await loadCredential(o, userId, credentialId);
          if (!cred) return json(404, { error: { code: 'NO_CREDENTIAL', message: 'No hay credenciales de IBKR guardadas.' } });
          const opts: ImportOptions = { portfolioId: body.portfolioId, account: typeof body.account === 'string' ? body.account : 'Interactive Brokers' };
          if (Array.isArray(body.existingTransactions)) opts.existingTransactions = body.existingTransactions as Transaction[];
          if (Array.isArray(body.existingInstruments)) opts.existingInstruments = body.existingInstruments as Instrument[];
          if (Array.isArray(body.catalog)) opts.catalog = body.catalog as Instrument[];
          const result = await syncIbkrFlex(clientOptions(o, cred), opts);
          return json(200, result);
        }
        default:
          return json(400, { error: { code: 'BAD_REQUEST', message: 'Acción desconocida (save, sync, delete).' } });
      }
    } catch (e) {
      if (e instanceof FlexError) {
        const retryable = ['1001', '1004', '1009', '1018', '1019', '1021'].includes(e.code ?? '');
        return json(retryable ? 503 : 502, { error: { code: `FLEX_${e.code ?? 'ERROR'}`, message: e.message } });
      }
      return json(500, { error: { code: 'INTERNAL', message: e instanceof Error ? e.message : String(e) } });
    }
  };
}

export interface IbkrFlexSyncJob {
  userId: string;
  credentialId?: string;
  portfolioId: string;
  account?: string;
  /** Load the portfolio's current transactions/instruments so the sync only brings new rows. */
  load(): Promise<{ transactions: Transaction[]; instruments: Instrument[] }>;
  /** Persist the result (e.g. append `result.transactions`, create `result.instruments`). */
  save(result: ImportResult): Promise<void>;
}

/**
 * Run scheduled syncs (call it from a daily cron / Routine on the server). Errors are reported per job
 * and never stop the others.
 */
export async function runIbkrFlexSyncJobs(
  jobs: IbkrFlexSyncJob[],
  o: IbkrFlexSyncHandlerOptions,
): Promise<{ userId: string; portfolioId: string; ok: boolean; imported?: number; error?: string }[]> {
  const out: { userId: string; portfolioId: string; ok: boolean; imported?: number; error?: string }[] = [];
  for (const job of jobs) {
    try {
      const cred = await loadCredential(o, job.userId, job.credentialId ?? 'default');
      if (!cred) throw new Error('No hay credenciales de IBKR guardadas.');
      const { transactions, instruments } = await job.load();
      const result = await syncIbkrFlex(clientOptions(o, cred), {
        portfolioId: job.portfolioId, account: job.account ?? 'Interactive Brokers', existingTransactions: transactions, existingInstruments: instruments,
      });
      await job.save(result);
      out.push({ userId: job.userId, portfolioId: job.portfolioId, ok: true, imported: result.stats.imported });
    } catch (e) {
      out.push({ userId: job.userId, portfolioId: job.portfolioId, ok: false, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}
