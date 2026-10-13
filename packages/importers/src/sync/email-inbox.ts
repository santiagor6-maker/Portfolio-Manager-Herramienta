/**
 * Ready-to-mount e-mail inbox webhook (I2): an inbound-mail provider (Cloudflare Email Workers, Postmark,
 * Mailgun "store and forward", SES → Lambda) POSTs the raw message here; the handler checks the shared
 * secret, the sender and the provider's authentication results (SPF/DKIM), maps the recipient
 * (`importar+<token>@dominio`) to a portfolio, runs `importEmail` and hands the result to `save` as a
 * DRAFT the user reviews. Fetch API only (Node ≥ 20, Workers, Deno, Bun).
 *
 *   const inbox = createEmailInboxHandler({
 *     secret: process.env.INBOX_SECRET!,                       // header x-inbox-secret
 *     resolveRecipient: async (token) => portfolios.byInboxToken(token),
 *     save: async (target, result) => drafts.add(target.portfolioId, result),
 *     allowedSenders: [/@(xpi|xpinvestimentos|btgpactual|nuinvest|bancointer)\.com\.br$/i],
 *   });
 *   app.post('/api/inbox/email', (c) => inbox(c.req.raw));      // Hono
 */
import type { Instrument, Transaction } from '@pm/core';
import { importEmail, parseEmail, type EmailImportResult } from '../email';

export interface InboxTarget {
  portfolioId: string;
  existingTransactions?: Transaction[];
  existingInstruments?: Instrument[];
  /** Stored PDF passwords (e.g. first CPF digits) for encrypted notes. */
  pdfPasswords?: string[];
  account?: string;
}

export interface EmailInboxHandlerOptions {
  /** Shared secret the provider sends in `x-inbox-secret` (or `?secret=`). */
  secret: string;
  /** Recipient token (the part after "+" in importar+TOKEN@…) → portfolio; undefined → 404. */
  resolveRecipient: (token: string) => Promise<InboxTarget | undefined> | InboxTarget | undefined;
  save: (target: InboxTarget, result: EmailImportResult) => Promise<void> | void;
  /** Sender addresses accepted (exact address or regex); empty/undefined = any sender. */
  allowedSenders?: (string | RegExp)[];
  /** Require "spf=pass" or "dkim=pass" in Authentication-Results / ARC headers. Default true. */
  requireAuthResults?: boolean;
  /** Maximum message size in bytes (default 25 MB). */
  maxBytes?: number;
}

const res = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/** Raw MIME from the request: raw body, or JSON from providers ({ RawEmail } Postmark, { "body-mime" } Mailgun, { raw } base64). */
async function rawMessage(req: Request): Promise<string> {
  const ct = req.headers.get('content-type') ?? '';
  if (/json/i.test(ct)) {
    const j = (await req.json()) as Record<string, unknown>;
    const v = j.RawEmail ?? j['body-mime'] ?? j.raw;
    if (typeof v !== 'string') throw new Error('no raw message');
    return j.raw && !/\r?\n/.test(v) ? atob(v) : v;
  }
  if (/multipart\/form-data/i.test(ct)) {
    const f = await req.formData();
    const v = f.get('body-mime') ?? f.get('email') ?? f.get('raw');
    if (typeof v === 'string') return v;
    if (v && typeof (v as Blob).text === 'function') return (v as Blob).text();
    throw new Error('no raw message');
  }
  const buf = new Uint8Array(await req.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 8192) s += String.fromCharCode(...buf.subarray(i, i + 8192));
  return s;
}

function header(raw: string, name: string): string[] {
  const head = raw.split(/\r?\n\r?\n/)[0]!.replace(/\r?\n[ \t]+/g, ' ');
  return head.split(/\r?\n/).filter((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`)).map((l) => l.slice(name.length + 1).trim());
}

export function createEmailInboxHandler(o: EmailInboxHandlerOptions): (req: Request) => Promise<Response> {
  if (!o.secret || o.secret.length < 16) throw new Error('INBOX secret must have at least 16 characters');
  return async (req) => {
    if (req.method !== 'POST') return res(405, { error: { code: 'METHOD_NOT_ALLOWED' } });
    const given = req.headers.get('x-inbox-secret') ?? new URL(req.url).searchParams.get('secret') ?? '';
    if (!safeEqual(given, o.secret)) return res(401, { error: { code: 'UNAUTHORIZED' } });
    const len = Number(req.headers.get('content-length') ?? 0);
    if (len > (o.maxBytes ?? 25 * 1024 * 1024)) return res(413, { error: { code: 'TOO_LARGE' } });
    let raw: string;
    try {
      raw = await rawMessage(req);
    } catch {
      return res(400, { error: { code: 'BAD_REQUEST', message: 'Se esperaba el mensaje MIME completo.' } });
    }
    if (raw.length > (o.maxBytes ?? 25 * 1024 * 1024)) return res(413, { error: { code: 'TOO_LARGE' } });
    const msg = parseEmail(raw.split(/\r?\n\r?\n/)[0]! + '\r\n\r\n');
    const from = /<([^>]+)>/.exec(msg.from ?? '')?.[1] ?? (msg.from ?? '').trim();
    if (o.allowedSenders?.length && !o.allowedSenders.some((a) => (typeof a === 'string' ? a.toLowerCase() === from.toLowerCase() : a.test(from)))) {
      return res(403, { error: { code: 'SENDER_NOT_ALLOWED', message: `Remitente no autorizado: ${from}` } });
    }
    if (o.requireAuthResults !== false) {
      const auth = [...header(raw, 'Authentication-Results'), ...header(raw, 'ARC-Authentication-Results')].join(' ');
      if (!/\b(dkim|spf)=pass\b/i.test(auth)) return res(403, { error: { code: 'NOT_AUTHENTICATED', message: 'El correo no pasó SPF ni DKIM.' } });
    }
    const to = [...header(raw, 'Delivered-To'), ...header(raw, 'X-Original-To'), msg.to ?? ''].join(' ');
    const token = /[\w.-]+\+([\w-]{6,64})@/.exec(to)?.[1];
    const target = token ? await o.resolveRecipient(token) : undefined;
    if (!target) return res(404, { error: { code: 'UNKNOWN_RECIPIENT' } });
    const result = await importEmail(raw, {
      portfolioId: target.portfolioId,
      ...(target.existingTransactions ? { existingTransactions: target.existingTransactions } : {}),
      ...(target.existingInstruments ? { existingInstruments: target.existingInstruments } : {}),
      ...(target.pdfPasswords ? { pdfPasswords: target.pdfPasswords } : {}),
      ...(target.account ? { account: target.account } : {}),
    });
    await o.save(target, result);
    return res(200, {
      portfolioId: target.portfolioId,
      attachments: result.attachments.map((a) => ({ fileName: a.fileName, imported: a.result.stats.imported, pending: a.result.stats.pending, errors: a.result.stats.errors })),
      needsPassword: result.needsPassword,
      transactions: result.transactions.length,
    });
  };
}
