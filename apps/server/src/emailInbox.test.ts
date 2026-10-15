import { describe, expect, it } from 'vitest';
import { MemoryStore } from '@pm/market-data';
import { createTestService } from '../../../packages/market-data/test/helpers';
import { createApp, maskQuery } from './app';
import { EmailInbox, parseAllowedSenders, parseRecipients } from './emailInbox';

const API = 'secret-api-token';
const SECRET = 'inbox-secret-0123456789abcdef';
const TOKEN = 'tok12345678';
const OK_AUTH = 'Authentication-Results: mx.exemplo; spf=pass smtp.mailfrom=xpi.com.br; dkim=pass header.d=xpi.com.br';
const csv = (q = 3) => `date,type,symbol,exchange,quantity,price,currency\r\n2024-03-11,BUY,AAPL,XNAS,${q},170.5,USD\r\n`;
const mail = (o: { from?: string; auth?: string; to?: string; body?: string } = {}) =>
  [
    `From: XP <${o.from ?? 'notas@mail.xpi.com.br'}>`, `To: ${o.to ?? `importar+${TOKEN}@portafolio.exemplo`}`, 'Subject: Nota de corretagem', o.auth ?? OK_AUTH,
    'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="b"', '',
    '--b', 'Content-Type: text/csv; name="c.csv"', 'Content-Disposition: attachment; filename="c.csv"', '', o.body ?? csv(), '--b--', '',
  ].join('\r\n');

function setup(o: { apiToken?: string; inbox?: boolean; perHour?: number; maxBytes?: number } = {}) {
  const store = new MemoryStore();
  const lines: string[] = [];
  const inbox =
    o.inbox === false
      ? undefined
      : new EmailInbox({ secret: SECRET, store, recipients: { [TOKEN]: 'p1' }, allowedSenders: parseAllowedSenders('@xpi.com.br,confirm@broker.exemplo'), maxBytes: o.maxBytes });
  const app = createApp({ service: createTestService().service, log: (l) => lines.push(l), apiToken: o.apiToken ?? API, emailInbox: inbox, inboxPerHour: o.perHour, logSecrets: [SECRET] });
  const post = (body: string, q = '', headers: Record<string, string> = { Authorization: `Bearer ${API}`, 'x-inbox-secret': SECRET }) =>
    app.request(`/api/inbox/email${q}`, { method: 'POST', headers: { 'content-type': 'message/rfc822', ...headers }, body });
  const auth = { Authorization: `Bearer ${API}` };
  return { app, store, post, auth, lines };
}

describe('e-mail inbox mounted on the server (importers createEmailInboxHandler)', () => {
  it('an authenticated broker mail becomes a draft; GET lists it, DELETE acknowledges it', async () => {
    const { app, post, auth } = setup();
    const res = await post(mail());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ portfolioId: 'p1', transactions: 1 });
    const inbox = await (await app.request('/api/inbox/email/drafts?portfolioId=p1', { headers: auth })).json();
    expect(inbox.drafts).toHaveLength(1);
    expect(inbox.drafts[0]).toMatchObject({ subject: 'Nota de corretagem', attachments: [{ fileName: 'c.csv', imported: 1 }], needsPassword: [] });
    expect(inbox.drafts[0].transactions[0]).toMatchObject({ instrumentId: 'XNAS:AAPL', portfolioId: 'p1', quantity: 3 });

    // The same mail forwarded twice: the second draft has no duplicate transactions.
    await post(mail());
    const two = await (await app.request('/api/inbox/email/drafts?portfolioId=p1', { headers: auth })).json();
    expect(two.drafts).toHaveLength(2);
    expect(two.drafts[1].transactions).toEqual([]);

    const ack = await app.request('/api/inbox/email/drafts?portfolioId=p1', { method: 'DELETE', headers: auth, body: JSON.stringify({ ids: [two.drafts[0].id] }) });
    expect(await ack.json()).toEqual({ cleared: 1 });
    const del = await app.request('/api/inbox/email/drafts?portfolioId=p1', { method: 'DELETE', headers: auth });
    expect(await del.json()).toEqual({ cleared: 1 });
    expect((await (await app.request('/api/inbox/email/drafts?portfolioId=p1', { headers: auth })).json()).drafts).toEqual([]);
  });

  it('rejects a missing API token, a wrong inbox secret, unknown senders, unauthenticated mail and unknown recipients', async () => {
    const { post, store } = setup();
    expect((await post(mail(), '', { 'x-inbox-secret': SECRET })).status).toBe(401); // no API token
    expect((await post(mail(), '', { Authorization: `Bearer ${API}`, 'x-inbox-secret': 'wrong-secret-0123456789abc' })).status).toBe(401);
    expect((await post(mail({ from: 'evil@xpi.com.br.phish.exemplo' }))).status).toBe(403);
    expect((await post(mail({ from: 'someone@other.exemplo' }))).status).toBe(403);
    expect((await post(mail({ auth: 'Authentication-Results: mx; spf=fail; dkim=none' }))).status).toBe(403);
    expect((await post(mail({ to: 'importar+nobody9999@portafolio.exemplo' }))).status).toBe(404);
    expect((await post(mail(), '', { Authorization: `Bearer ${API}`, 'x-inbox-secret': SECRET, Origin: 'https://evil.example' })).status).toBe(403);
    expect([...store.data.keys()]).toEqual([]);
  });

  it('?api_key= is accepted on the webhook only and never logged; the inbox secret only in its header (importers I42)', async () => {
    const { app, post, lines, auth } = setup();
    const brokerAuth = 'Authentication-Results: mx.exemplo; dkim=pass header.d=broker.exemplo; spf=pass smtp.mailfrom=broker.exemplo';
    expect((await post(mail({ from: 'confirm@broker.exemplo', auth: brokerAuth }), `?api_key=${API}&secret=${SECRET}`, {})).status).toBe(400); // SECRET_IN_URL
    const res = await post(mail({ from: 'confirm@broker.exemplo', auth: brokerAuth }), `?api_key=${API}`, { 'x-inbox-secret': SECRET });
    expect(res.status).toBe(200);
    expect(lines.join('\n')).not.toContain(API);
    expect(lines.join('\n')).not.toContain(SECRET);
    expect(lines.join('\n')).toMatch(/api_key=\*\*\*&secret=\*\*\*/);
    // ?api_key= does not open the drafts endpoints.
    expect((await app.request(`/api/inbox/email/drafts?portfolioId=p1&api_key=${API}`)).status).toBe(401);
    expect((await app.request('/api/inbox/email/drafts?portfolioId=p1', { headers: auth })).status).toBe(200);
  });

  it('M40 masking cannot be bypassed: encoded names, mistyped variants, secrets under any name', async () => {
    const { post, lines } = setup();
    // Encoded name: Hono would decode it, but only the exact raw `api_key` authenticates.
    expect((await post(mail(), `?api%5Fkey=${API}&secret=${SECRET}`, {})).status).toBe(401);
    expect((await post(mail(), `?x=1;api_key=${API}&secret=${SECRET}`, {})).status).toBe(401);
    expect((await post(mail(), `?api_key%3D=${API}`, {})).status).toBe(401);
    expect((await post(mail(), `?Secret=${encodeURIComponent(SECRET)}&note=${API}`, {})).status).toBe(401);
    const log = lines.join('\n');
    for (const leaked of [API, SECRET, encodeURIComponent(SECRET), 'api%5Fkey=s']) expect(log).not.toContain(leaked);
    expect(maskQuery('?q=ok&Api_Key=zz&token=t1&other=has-secret-api-token-inside', [API])).toBe('?q=ok&Api_Key=***&token=***&other=***');
    expect(maskQuery('', [API])).toBe('');
  });

  it('size limit (streamed) and hourly cap for all senders together', async () => {
    const big = setup({ maxBytes: 600 });
    expect((await big.post(mail({ body: csv().repeat(20) }))).status).toBe(413);
    const capped = setup({ perHour: 2 });
    expect((await capped.post(mail())).status).toBe(200);
    expect((await capped.post(mail())).status).toBe(200);
    const third = await capped.post(mail());
    expect(third.status).toBe(429);
    expect(third.headers.get('retry-after')).toBeTruthy();
  });

  it('M42 a full draft inbox refuses new mail with 507 (nothing dropped); draft ids are random', async () => {
    const store = new MemoryStore();
    const mk = () => new EmailInbox({ secret: SECRET, store, recipients: { [TOKEN]: 'p1' }, allowedSenders: ['notas@mail.xpi.com.br'], maxDrafts: 2 });
    const app = createApp({ service: createTestService().service, log: null, apiToken: API, emailInbox: mk() });
    const post = (q: number) => app.request('/api/inbox/email', { method: 'POST', headers: { Authorization: `Bearer ${API}`, 'x-inbox-secret': SECRET, 'content-type': 'message/rfc822' }, body: mail({ body: csv(q) }) });
    expect((await post(1)).status).toBe(200);
    expect((await post(2)).status).toBe(200);
    const full = await post(3);
    expect(full.status).toBe(507);
    expect(await full.json()).toMatchObject({ error: { code: 'INBOX_FULL', details: { portfolioId: 'p1', limit: 2 } } });
    const drafts = (await mk().drafts('p1')).drafts;
    expect(drafts.map((d) => d.transactions[0]!.quantity)).toEqual([1, 2]); // the oldest were kept
    expect(drafts[0]!.id).toMatch(/^mail-[0-9a-f-]{36}$/);
    expect(new Set(drafts.map((d) => d.id)).size).toBe(2);
    // After confirming, mail is accepted again (a new process: ids stay unique).
    await mk().clearDrafts('p1', [drafts[0]!.id]);
    const app2 = createApp({ service: createTestService().service, log: null, apiToken: API, emailInbox: mk() });
    const again = await app2.request('/api/inbox/email', { method: 'POST', headers: { Authorization: `Bearer ${API}`, 'x-inbox-secret': SECRET, 'content-type': 'message/rfc822' }, body: mail({ body: csv(4) }) });
    expect(again.status).toBe(200);
    expect(new Set((await mk().drafts('p1')).drafts.map((d) => d.id)).size).toBe(2);
  });

  it('not configured -> 503; without API_TOKEN only an opted-in loopback socket reaches the drafts', async () => {
    const off = setup({ inbox: false });
    expect((await off.app.request('/api/inbox/email/drafts?portfolioId=p1', { headers: off.auth })).status).toBe(503);
    const store = new MemoryStore();
    const inbox = new EmailInbox({ secret: SECRET, store, recipients: { [TOKEN]: 'p1' }, allowedSenders: ['confirm@broker.exemplo'] });
    const noToken = createApp({ service: createTestService().service, log: null, emailInbox: inbox });
    expect((await noToken.request('/api/inbox/email/drafts?portfolioId=p1')).status).toBe(403);
    const local = createApp({ service: createTestService().service, log: null, emailInbox: inbox, allowLocalAdmin: true });
    expect((await local.request('/api/inbox/email/drafts?portfolioId=p1', {}, { incoming: { socket: { remoteAddress: '127.0.0.1' } } })).status).toBe(200);
  });

  it('configuration parsing is strict', () => {
    expect(parseRecipients('tok12345678:p1, other_token_x:p-2')).toEqual({ tok12345678: 'p1', other_token_x: 'p-2' });
    expect(() => parseRecipients('nocolon')).toThrow(/token:portfolioId/);
    const senders = parseAllowedSenders('@xpi.com.br, Confirm@Broker.Exemplo');
    expect(senders[1]).toBe('confirm@broker.exemplo');
    const re = senders[0] as RegExp;
    expect(re.test('notas@xpi.com.br')).toBe(true);
    expect(re.test('notas@mail.xpi.com.br')).toBe(true);
    expect(re.test('x@evilxpi.com.br')).toBe(false);
    expect(re.test('x@xpi.com.br.evil.exemplo')).toBe(false);
    expect(() => parseAllowedSenders('not-an-address')).toThrow(/invalid address/);
    expect(() => new EmailInbox({ secret: SECRET, store: new MemoryStore(), recipients: { [TOKEN]: 'p1' }, allowedSenders: [] })).toThrow(/allowlist/);
    expect(() => new EmailInbox({ secret: SECRET, store: new MemoryStore(), recipients: { short: 'p1' }, allowedSenders: ['a@b.co'] })).toThrow(/8-64/);
    expect(() => new EmailInbox({ secret: 'short', store: new MemoryStore(), recipients: { [TOKEN]: 'p1' }, allowedSenders: ['a@b.co'] })).toThrow(/16 characters/);
  });
});
