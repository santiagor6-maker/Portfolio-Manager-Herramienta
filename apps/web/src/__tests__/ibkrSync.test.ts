import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Transaction } from '@pm/core';
import { db, resetDbInstance } from '../db/schema';
import { exportBackup, getMeta, saveSetting } from '../db/repo';
import { useApp } from '../store/app';
import {
  checkIbkrInboxes,
  clearIbkrInbox,
  connectIbkr,
  disconnectIbkr,
  fetchIbkrInbox,
  inboxToImportResult,
  SyncError,
  syncIbkrNow,
} from '../services/ibkrSync';
import { syncErrorText } from '../components/IbkrSync';

type Call = { url: string; method: string; headers: Record<string, string>; body?: Record<string, unknown> };
let calls: Call[] = [];

/** Mocked fetch: each test queues the responses the "server" returns. */
function mockServer(...responses: { status?: number; body: unknown }[]) {
  const queue = [...responses];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({
        url,
        method: init.method ?? 'GET',
        headers: (init.headers ?? {}) as Record<string, string>,
        body: init.body ? JSON.parse(String(init.body)) : undefined,
      });
      const r = queue.shift() ?? { status: 500, body: {} };
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'Content-Type': 'application/json' } });
    }),
  );
}

const tx = (id: string, over: Partial<Transaction> = {}): Transaction => ({
  id,
  portfolioId: 'p1',
  date: '2026-10-01',
  type: 'BUY',
  instrumentId: 'XNAS:MSFT',
  quantity: 2,
  price: 400,
  amount: 800,
  currency: 'USD',
  ...over,
});

let n = 0;
beforeEach(() => {
  resetDbInstance(`ibkr-db-${++n}`);
  calls = [];
  useApp.setState((s) => ({ settings: { ...s.settings, serverUrl: 'http://srv:8787/', apiToken: 'secret-api' }, ibkrInbox: {} }));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await db.delete();
});

describe('IBKR Flex sync client', () => {
  it('connects: posts action save with the API token and remembers the query (not the Flex token)', async () => {
    mockServer({ body: { credentialId: 'default' } });
    await connectIbkr(' tok-123 ', '987654');
    expect(calls[0]!.url).toBe('http://srv:8787/api/sync/ibkr-flex');
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.headers.Authorization).toBe('Bearer secret-api');
    expect(calls[0]!.body).toEqual({ action: 'save', token: 'tok-123', queryId: '987654' });
    const conn = await getMeta<Record<string, unknown>>('ibkrFlex');
    expect(conn).toMatchObject({ credentialId: 'default', queryId: '987654' });
    expect(JSON.stringify(conn)).not.toContain('tok-123');
  });

  it('maps 503 / 401 / IBKR / network errors to clear messages', async () => {
    const t = (k: string, o?: Record<string, unknown>) => `${k}${o?.message ? `: ${o.message}` : ''}`;
    mockServer({ status: 503, body: { error: { code: 'NOT_CONFIGURED', message: 'SYNC_SECRET' } } });
    const e1 = await connectIbkr('a', '1').catch((e) => e);
    expect(e1).toBeInstanceOf(SyncError);
    expect(e1.kind).toBe('notConfigured');

    mockServer({ status: 401, body: { error: { code: 'UNAUTHORIZED', message: 'Missing or invalid API token' } } });
    const e2 = await connectIbkr('a', '1').catch((e) => e);
    expect(e2.kind).toBe('unauthorized');

    mockServer({ status: 502, body: { error: { code: 'FLEX_1012', message: 'Token vencido' } } });
    const e3 = await syncIbkrNow('p1').catch((e) => e);
    expect(e3.kind).toBe('ibkr');
    expect(syncErrorText(e3, t)).toBe('ibkr.err.ibkr: Token vencido (FLEX_1012)');

    // A retryable IBKR error comes as 503 with a FLEX_ code: still an IBKR error, not "not configured".
    mockServer({ status: 503, body: { error: { code: 'FLEX_1019', message: 'Generando extracto' } } });
    expect((await syncIbkrNow('p1').catch((e) => e)).kind).toBe('ibkr');

    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    const e4 = await syncIbkrNow('p1').catch((e) => e);
    expect(e4.kind).toBe('offline');
  });

  it('sync now sends the portfolio and its transactions for server-side de-duplication', async () => {
    await db.transactions.add(tx('t-old'));
    mockServer({ body: { credentialId: 'c1' } }, { body: { transactions: [], rows: [], instruments: [], stats: {} } });
    await connectIbkr('tok', '42');
    await syncIbkrNow('p1', 'IBKR');
    const body = calls[1]!.body!;
    expect(body).toMatchObject({ action: 'sync', portfolioId: 'p1', credentialId: 'c1', account: 'IBKR' });
    expect((body.existingTransactions as Transaction[]).map((t) => t.id)).toEqual(['t-old']);
    expect((await getMeta<{ lastSync?: number }>('ibkrFlex'))?.lastSync).toBeGreaterThan(0);
  });

  it('reads the daily inbox, de-duplicates it into an import preview and clears it after confirming', async () => {
    const existing = tx('t-old', { importHash: 'h1' });
    await db.transactions.add(existing);
    const pending = [tx('n1', { importHash: 'h1' }), tx('n2', { date: '2026-10-02', importHash: 'h2', instrumentId: 'XNYS:KO', currency: 'USD' })];
    const ko = { id: 'XNYS:KO', symbol: 'KO', name: 'Coca-Cola', currency: 'USD', assetClass: 'EQUITY' };
    mockServer({ body: { portfolioId: 'p1', pending, instruments: [ko], lastRun: { ok: true } } }, { body: { cleared: 2 } });
    const inbox = await fetchIbkrInbox('p1');
    expect(calls[0]!.url).toBe('http://srv:8787/api/sync/ibkr-flex/inbox?portfolioId=p1');
    expect(useApp.getState().ibkrInbox.p1).toBe(2);

    const r = inboxToImportResult(inbox, [existing], []);
    expect(r.rows.map((x) => x.status)).toEqual(['duplicate', 'ok']);
    expect(r.transactions.map((t) => t.id)).toEqual(['n2']);
    expect(r.instruments.map((i) => i.id)).toEqual(['XNYS:KO']);
    expect(r.stats).toMatchObject({ imported: 1, duplicates: 1, newInstruments: 1 });

    await clearIbkrInbox('p1');
    expect(calls[1]).toMatchObject({ method: 'DELETE', url: 'http://srv:8787/api/sync/ibkr-flex/inbox?portfolioId=p1' });
    expect(useApp.getState().ibkrInbox.p1).toBe(0);
  });

  it('checks inboxes on load only when connected, and disconnect deletes the credential', async () => {
    mockServer();
    expect(await checkIbkrInboxes()).toBe(0);
    expect(calls).toHaveLength(0);

    await db.portfolios.add({ id: 'p1', name: 'Mío', baseCurrency: 'USD', costMethod: 'FIFO', createdAt: '2026-01-01' } as never);
    mockServer({ body: { credentialId: 'c1' } }, { body: { pending: [tx('n1')], instruments: [] } }, { body: { ok: true } });
    await connectIbkr('tok', '42');
    expect(await checkIbkrInboxes()).toBe(1);

    await disconnectIbkr();
    expect(calls[2]!.body).toEqual({ action: 'delete', credentialId: 'c1' });
    expect(await getMeta('ibkrFlex')).toBeUndefined();
  });

  it('never writes the server API token into a backup', async () => {
    await saveSetting('apiToken', 'secret-api');
    await saveSetting('language', 'pt');
    const b = await exportBackup(false);
    expect(JSON.stringify(b)).not.toContain('secret-api');
    expect(b.settings.some((s) => s.key === 'language')).toBe(true);
  });
});
