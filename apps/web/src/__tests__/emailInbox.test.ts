import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Transaction } from '@pm/core';
import { db, resetDbInstance } from '../db/schema';
import { useApp } from '../store/app';
import { checkEmailDrafts, clearEmailDrafts, draftsToImportResult, fetchEmailDrafts } from '../services/emailInbox';
import { emailErrorText } from '../components/EmailInbox';

let calls: { url: string; method: string; body?: unknown }[] = [];
function mockServer(...responses: { status?: number; body: unknown }[]) {
  const q = [...responses];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit = {}) => {
      calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined });
      const r = q.shift() ?? { status: 500, body: {} };
      return new Response(JSON.stringify(r.body), { status: r.status ?? 200, headers: { 'Content-Type': 'application/json' } });
    }),
  );
}
const tx = (id: string, over: Partial<Transaction> = {}): Transaction => ({ id, portfolioId: 'p1', date: '2026-10-01', type: 'BUY', instrumentId: 'BVMF:PETR4', quantity: 100, price: 38, amount: 3800, currency: 'BRL', importHash: id, ...over });

let n = 0;
beforeEach(() => {
  resetDbInstance(`mail-${++n}`);
  calls = [];
  useApp.setState((s) => ({ settings: { ...s.settings, serverUrl: '', apiToken: 'k' }, emailDrafts: {} }));
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await db.delete();
});

describe('e-mail inbox', () => {
  it('lists drafts, previews them de-duplicated and acknowledges by id', async () => {
    await db.transactions.add(tx('h-old'));
    const drafts = [
      { id: 'd1', receivedAt: '2026-10-02T10:00:00Z', from: 'notas@xpi.com.br', subject: 'Nota 123', transactions: [tx('h-old'), tx('h-new', { date: '2026-10-02' })], instruments: [] },
    ];
    mockServer({ body: { portfolioId: 'p1', drafts } }, { body: { cleared: 1 } });
    const got = await fetchEmailDrafts('p1');
    expect(calls[0]).toMatchObject({ url: '/api/inbox/email/drafts?portfolioId=p1', method: 'GET' });
    expect(useApp.getState().emailDrafts.p1).toBe(1);
    const r = await draftsToImportResult('p1', got);
    expect(r.rows.map((x) => x.status)).toEqual(['duplicate', 'ok']);
    expect(r.transactions).toHaveLength(1);
    await clearEmailDrafts('p1', ['d1']);
    expect(calls[1]).toMatchObject({ method: 'DELETE', body: { ids: ['d1'] } });
    expect(useApp.getState().emailDrafts.p1).toBe(0);
  });

  it('only checks on load once the inbox was used, and explains 401/403/503', async () => {
    mockServer();
    expect(await checkEmailDrafts()).toBe(0);
    expect(calls).toHaveLength(0);
    const t = (k: string) => k;
    for (const [status, kind] of [
      [503, 'mail.err.notConfigured'],
      [401, 'mail.err.unauthorized'],
      [403, 'mail.err.forbidden'],
    ] as const) {
      mockServer({ status, body: { error: { code: status === 503 ? 'NOT_CONFIGURED' : 'X', message: 'm' } } });
      const e = await fetchEmailDrafts('p1').catch((x) => x);
      expect(emailErrorText(e, t)).toBe(kind);
    }
  });
});
