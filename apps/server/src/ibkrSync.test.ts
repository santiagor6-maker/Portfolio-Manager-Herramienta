import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { MemoryStore } from '@pm/market-data';
import { createTestService } from '../../../packages/market-data/test/helpers';
import { createApp } from './app';
import { FileStore } from './fileStore';
import { tokenMatches } from './app';
import { guardedFlexFetch, IbkrFlexSync, isIbkrHost, msUntilHourUtc, parseDailyJobs } from './ibkrSync';

// Recorded Flex Web Service responses from the importers package (no network).
const FX = join(dirname(fileURLToPath(import.meta.url)), '../../../packages/importers/test/fixtures/ibkr-flex-ws');
const ws = (name: string) => readFileSync(join(FX, name), 'utf8');

const TOKEN = 'FLEXTOKEN-1234567890';
const API = 'secret-api-token';
const SECRET = 'a-sync-secret-of-32-characters!!';

/** Mocked IBKR: SendRequest -> reference; GetStatement -> "in progress" once, then the statement. */
function mockIbkr(opts: { expired?: boolean } = {}) {
  const calls: { url: string; ua?: string }[] = [];
  let polls = 0;
  const fetch = async (url: string, init?: { headers?: Record<string, string> }) => {
    calls.push({ url, ua: init?.headers?.['User-Agent'] ?? init?.headers?.['user-agent'] });
    const body = opts.expired
      ? ws('token-expired.xml')
      : url.includes('/SendRequest')
        ? ws('send-request.xml')
        : polls++ === 0
          ? ws('in-progress.xml')
          : ws('statement.xml');
    return { ok: true, status: 200, text: async () => body };
  };
  return { fetch, calls };
}

async function setup(o: { apiToken?: string; allowLocalAdmin?: boolean; expired?: boolean; sync?: boolean } = {}) {
  const ibkr = mockIbkr({ expired: o.expired });
  const store = new MemoryStore();
  const sync = o.sync === false ? undefined : await IbkrFlexSync.create({ secret: SECRET, store, fetch: ibkr.fetch, delayMs: 0 });
  const app = createApp({ service: createTestService().service, log: null, apiToken: o.apiToken, allowLocalAdmin: o.allowLocalAdmin, ibkrFlexSync: sync });
  const post = (body: unknown, headers: Record<string, string> = { Authorization: `Bearer ${API}` }, env?: unknown) =>
    app.request('/api/sync/ibkr-flex', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) }, env);
  return { app, sync: sync!, store, ibkr, post };
}

describe('POST /api/sync/ibkr-flex (importers handler mounted on the server)', () => {
  it('save -> sync with a mocked IBKR: token encrypted at rest, statement imported, never echoed', async () => {
    const { post, store, ibkr } = await setup({ apiToken: API });
    const saved = await post({ action: 'save', token: TOKEN, queryId: '987654' });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({ credentialId: 'default' });
    const raw = JSON.stringify([...store.data.values()]);
    expect(raw).not.toContain(TOKEN);
    expect(raw).not.toContain('987654');

    const res = await post({ action: 'sync', portfolioId: 'p1' });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const text = await res.text();
    expect(text).not.toContain(TOKEN);
    const result = JSON.parse(text) as { transactions: { portfolioId: string }[]; stats: { imported: number } };
    expect(result.transactions.length).toBeGreaterThan(0);
    expect(result.transactions.every((t) => t.portfolioId === 'p1')).toBe(true);
    // SendRequest with token + query id, then GetStatement polled until ready, with a User-Agent.
    expect(ibkr.calls[0]!.url).toMatch(/\/SendRequest\?.*t=FLEXTOKEN-1234567890.*q=987654/);
    expect(ibkr.calls.filter((c) => c.url.includes('/GetStatement'))).toHaveLength(2);
    expect(ibkr.calls.every((c) => c.ua === 'PortafolioPro/1.0')).toBe(true);

    expect((await post({ action: 'delete' })).status).toBe(200);
    expect((await post({ action: 'sync', portfolioId: 'p1' })).status).toBe(404);
  });

  it('IBKR errors map to 502 with the Spanish message (expired token)', async () => {
    const { post } = await setup({ apiToken: API, expired: true });
    await post({ action: 'save', token: TOKEN, queryId: '1' });
    const res = await post({ action: 'sync', portfolioId: 'p1' });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: { code: 'FLEX_1012' } });
  });

  it('same protection as the other mutating endpoints: token, Origin allowlist, loopback opt-in', async () => {
    const withToken = await setup({ apiToken: API });
    expect((await withToken.post({ action: 'save', token: TOKEN, queryId: '1' }, {})).status).toBe(401);
    expect((await withToken.post({ action: 'save', token: TOKEN, queryId: '1' }, { Authorization: `Bearer ${API}`, Origin: 'https://evil.example' })).status).toBe(403);

    const noToken = await setup();
    expect((await noToken.post({ action: 'save', token: TOKEN, queryId: '1' }, {})).status).toBe(403); // no socket
    const loop = { incoming: { socket: { remoteAddress: '127.0.0.1' } } };
    expect((await noToken.post({ action: 'save', token: TOKEN, queryId: '1' }, {}, loop)).status).toBe(403); // not opted in
    const local = await setup({ allowLocalAdmin: true });
    expect((await local.post({ action: 'save', token: TOKEN, queryId: '1' }, {}, loop)).status).toBe(200);
    expect((await local.post({ action: 'save', token: TOKEN, queryId: '1' }, {}, { incoming: { socket: { remoteAddress: '10.0.0.5' } } })).status).toBe(403);

    const off = await setup({ apiToken: API, sync: false });
    expect((await off.post({ action: 'save', token: TOKEN, queryId: '1' })).status).toBe(503);
  });

  it('oversized bodies are rejected before reaching the handler', async () => {
    const { app, sync } = await setup({ apiToken: API });
    const small = createApp({ service: createTestService().service, log: null, apiToken: API, ibkrFlexSync: sync, syncMaxBodyBytes: 100 });
    const res = await small.request('/api/sync/ibkr-flex', { method: 'POST', headers: { Authorization: `Bearer ${API}` }, body: JSON.stringify({ action: 'sync', portfolioId: 'p1', existingTransactions: new Array(50).fill({ id: 'x' }) }) });
    expect(res.status).toBe(413);
    expect(app).toBeDefined();
  });
});

describe('daily IBKR Flex job and inbox', () => {
  it('runDaily brings only new transactions, the web app collects and acknowledges them', async () => {
    const { app, sync, post } = await setup({ apiToken: API });
    await post({ action: 'save', token: TOKEN, queryId: '987654' });
    const first = await sync.runDaily([{ portfolioId: 'p1' }]);
    expect(first[0]).toMatchObject({ ok: true });
    const n = first[0]!.imported!;
    expect(n).toBeGreaterThan(0);

    const auth = { Authorization: `Bearer ${API}` };
    const inbox = await (await app.request('/api/sync/ibkr-flex/inbox?portfolioId=p1', { headers: auth })).json();
    expect(inbox.pending).toHaveLength(n);
    expect(inbox.lastRun).toMatchObject({ ok: true, imported: n });
    expect(inbox.seen).toBeUndefined();

    // Same statement again: nothing new (dedupe against what the server already synced).
    const second = await sync.runDaily([{ portfolioId: 'p1' }]);
    expect(second[0]).toMatchObject({ ok: true, imported: 0 });

    const ack = await app.request('/api/sync/ibkr-flex/inbox?portfolioId=p1', { method: 'DELETE', headers: auth });
    expect(await ack.json()).toEqual({ cleared: n });
    expect((await sync.inbox('p1')).pending).toEqual([]);
    expect((await sync.runDaily([{ portfolioId: 'p1' }]))[0]).toMatchObject({ ok: true, imported: 0 });

    expect((await app.request('/api/sync/ibkr-flex/inbox?portfolioId=../x', { headers: auth })).status).toBe(400);
    expect((await app.request('/api/sync/ibkr-flex/inbox?portfolioId=p1')).status).toBe(401);
  });

  it('a failing job is recorded in its inbox and does not stop the others', async () => {
    const { sync, post } = await setup({ apiToken: API });
    await post({ action: 'save', token: TOKEN, queryId: '1' });
    const r = await sync.runDaily([{ portfolioId: 'p2', credentialId: 'missing' }, { portfolioId: 'p1' }]);
    expect(r.map((x) => x.ok)).toEqual([false, true]);
    expect((await sync.inbox('p2')).lastRun).toMatchObject({ ok: false, error: expect.stringMatching(/credenciales/) });
  });

  it('IBKR_FLEX_DAILY parsing and scheduling', () => {
    expect(parseDailyJobs(undefined)).toEqual([]);
    expect(parseDailyJobs('none')).toEqual([]);
    expect(parseDailyJobs('p1, p2:ira')).toEqual([{ portfolioId: 'p1' }, { portfolioId: 'p2', credentialId: 'ira' }]);
    expect(() => parseDailyJobs('../etc')).toThrow(/invalid entry/);
    expect(msUntilHourUtc(6, new Date('2026-10-09T05:30:00Z'))).toBe(30 * 60_000);
    expect(msUntilHourUtc(6, new Date('2026-10-09T06:00:00Z'))).toBe(24 * 3_600_000);
  });
});

describe('M35 hardening of the IBKR sync', () => {
  it('the Flex token only goes to https://*.interactivebrokers.com, whatever <Url> SendRequest returns', async () => {
    expect(isIbkrHost('https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/SendRequest?t=x')).toBe(true);
    expect(isIbkrHost('https://gdcdyn.interactivebrokers.com/x')).toBe(true);
    for (const bad of ['https://evil.example/GetStatement', 'https://interactivebrokers.com.evil.example/x', 'http://ndcdyn.interactivebrokers.com/x', 'https://user:pw@ndcdyn.interactivebrokers.com/x', 'not a url']) {
      expect(isIbkrHost(bad)).toBe(false);
    }
    const seen: string[] = [];
    const inner = async (url: string) => {
      seen.push(url);
      const body = url.includes('/SendRequest') ? ws('send-request.xml').replace(/<Url>[^<]*<\/Url>/, '<Url>https://evil.example/GetStatement</Url>') : ws('statement.xml');
      return { ok: true, status: 200, text: async () => body };
    };
    const sync = await IbkrFlexSync.create({ secret: SECRET, store: new MemoryStore(), fetch: inner, delayMs: 0 });
    const app = createApp({ service: createTestService().service, log: null, apiToken: API, ibkrFlexSync: sync });
    const post = (body: unknown) => app.request('/api/sync/ibkr-flex', { method: 'POST', headers: { Authorization: `Bearer ${API}` }, body: JSON.stringify(body) });
    await post({ action: 'save', token: TOKEN, queryId: '1' });
    const res = await post({ action: 'sync', portfolioId: 'p1' });
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).toMatch(/Refused to send the Flex token to evil\.example/);
    expect(seen.some((u) => u.includes('evil.example'))).toBe(false);
    await expect(guardedFlexFetch(inner)('https://evil.example/?t=x')).rejects.toThrow(/Refused/);
  });

  it('API token comparison is constant-time (hash, then XOR) and exact', async () => {
    expect(await tokenMatches('secret-api-token', API)).toBe(true);
    expect(await tokenMatches('secret-api-tokeN', API)).toBe(false);
    expect(await tokenMatches('secret', API)).toBe(false);
    expect(await tokenMatches(undefined, API)).toBe(false);
    expect(await tokenMatches('', '')).toBe(true);
    expect(await tokenMatches(undefined, '')).toBe(false);
  });

  it('overlapping daily runs never duplicate the inbox; an acknowledgement by ids keeps later rows', async () => {
    const { sync, post, app } = await setup({ apiToken: API });
    await post({ action: 'save', token: TOKEN, queryId: '987654' });
    const [a, b] = await Promise.all([sync.runDaily([{ portfolioId: 'p1' }]), sync.runDaily([{ portfolioId: 'p1' }])]);
    const n = a[0]!.imported! + b[0]!.imported!;
    const inbox = await sync.inbox('p1');
    expect(inbox.pending).toHaveLength(n);
    expect(new Set(inbox.pending.map((t) => t.id)).size).toBe(n);
    expect(Math.min(a[0]!.imported!, b[0]!.imported!)).toBe(0);

    // The web acknowledges only what it read; the rest stays.
    const firstId = inbox.pending[0]!.id;
    const auth = { Authorization: `Bearer ${API}` };
    const ack = await app.request('/api/sync/ibkr-flex/inbox?portfolioId=p1', { method: 'DELETE', headers: auth, body: JSON.stringify({ ids: [firstId] }) });
    expect(await ack.json()).toEqual({ cleared: 1 });
    expect((await sync.inbox('p1')).pending.map((t) => t.id)).not.toContain(firstId);
    expect((await sync.inbox('p1')).pending).toHaveLength(n - 1);
    const badAck = await app.request('/api/sync/ibkr-flex/inbox?portfolioId=p1', { method: 'DELETE', headers: auth, body: JSON.stringify({ ids: [1] }) });
    expect(badAck.status).toBe(400);

    // Concurrent acknowledgements and a run: no lost update.
    await Promise.all([sync.clearInbox('p1', [inbox.pending[1]!.id]), sync.runDaily([{ portfolioId: 'p1' }]), sync.clearInbox('p1', [inbox.pending[2]!.id])]);
    expect((await sync.inbox('p1')).pending).toHaveLength(n - 3);
  });
});

describe('credential store on disk', () => {
  const dirs: string[] = [];
  afterAll(async () => {
    for (const d of dirs) await rm(d, { recursive: true, force: true });
  });

  it('FileStore with fileMode 0600 keeps only the encrypted token', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pm-sync-'));
    dirs.push(dir);
    const sync = await IbkrFlexSync.create({ secret: SECRET, store: new FileStore(dir, { maxFiles: Number.MAX_SAFE_INTEGER, fileMode: 0o600 }), fetch: mockIbkr().fetch, delayMs: 0 });
    const app = createApp({ service: createTestService().service, log: null, apiToken: API, ibkrFlexSync: sync });
    const res = await app.request('/api/sync/ibkr-flex', { method: 'POST', headers: { Authorization: `Bearer ${API}` }, body: JSON.stringify({ action: 'save', token: TOKEN, queryId: '42' }) });
    expect(res.status).toBe(200);
    const shard = (await readdir(dir))[0]!;
    const file = join(dir, shard, (await readdir(join(dir, shard)))[0]!);
    expect(await readFile(file, 'utf8')).not.toContain(TOKEN);
    const { stat } = await import('node:fs/promises');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });
});
