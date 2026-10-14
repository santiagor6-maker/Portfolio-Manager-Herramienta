/**
 * Ready-to-mount e-mail inbox webhook (I2, hardened in I41/I42): an inbound-mail provider (Cloudflare
 * Email Workers, Postmark, Mailgun "store and forward", SES → Lambda) POSTs the raw message here.
 *
 * Checks, in order:
 *  1. the shared secret, ONLY in the `x-inbox-secret` header (never in the URL: URLs end up in logs);
 *  2. the size, counted while streaming the body (no trust in content-length);
 *  3. exactly ONE `From` header, parsed with an RFC 5322 parser on the raw header (comments and quoted
 *     strings removed, display name ignored, never decoded): the addr-spec is what is checked;
 *  4. the sender allowlist on that addr-spec;
 *  5. the provider's authentication verdict: only the TOPMOST Authentication-Results header (or the
 *     first one whose authserv-id is a configured `authservIds`) — headers added further down travel
 *     with the message and can be forged by the sender — and DMARC-style alignment: `dmarc=pass` for
 *     the From domain, or `dkim=pass` with `header.d`, or `spf=pass` with the `smtp.mailfrom` domain,
 *     aligned with the From domain (equal, or one a subdomain of the other below the public suffix);
 *     an explicit `dmarc=fail` always rejects;
 *  6. the recipient token (importar+TOKEN@…) → portfolio;
 *  7. resource limits: attachments (count and size) and PDF pages / decompressed bytes / time.
 * The result is handed to `save` as a DRAFT the user reviews. Fetch API only.
 *
 *   const inbox = createEmailInboxHandler({
 *     secret: process.env.INBOX_SECRET!,
 *     authservIds: ['mx.cloudflare.net'],                          // the provider's authserv-id
 *     resolveRecipient: async (token) => portfolios.byInboxToken(token),
 *     save: async (target, result) => drafts.add(target.portfolioId, result),
 *     allowedSenders: [/@(xpi|btgpactual|nuinvest|bancointer)\.com\.br$/i],
 *   });
 *   app.post('/api/inbox/email', (c) => inbox(c.req.raw));
 */
import type { Instrument, Transaction } from '@pm/core';
import { importEmail, type EmailImportResult } from '../email';

export interface InboxTarget {
  portfolioId: string;
  existingTransactions?: Transaction[];
  existingInstruments?: Instrument[];
  /** Stored PDF passwords (e.g. first CPF digits) for encrypted notes. */
  pdfPasswords?: string[];
  account?: string;
}

export interface EmailInboxHandlerOptions {
  /** Shared secret the provider sends in the `x-inbox-secret` header. */
  secret: string;
  /** Recipient token (the part after "+" in importar+TOKEN@…) → portfolio; undefined → 404. */
  resolveRecipient: (token: string) => Promise<InboxTarget | undefined> | InboxTarget | undefined;
  save: (target: InboxTarget, result: EmailImportResult) => Promise<void> | void;
  /** Sender addresses accepted (exact address or regex on the addr-spec); empty/undefined = any sender. */
  allowedSenders?: (string | RegExp)[];
  /** Require an aligned SPF/DKIM/DMARC pass (see above). Default true. */
  requireAuthResults?: boolean;
  /**
   * authserv-id(s) of YOUR provider's Authentication-Results header (e.g. "mx.google.com",
   * "mx.cloudflare.net", "amazonses.com"). When set, only the first header with one of these ids is
   * trusted; otherwise the topmost header is.
   */
  authservIds?: string[];
  /** Maximum message size in bytes (default 25 MB), enforced while reading the body. */
  maxBytes?: number;
  /** Attachments per message (default 20) and per-attachment size (default 15 MB). */
  maxAttachments?: number;
  maxAttachmentBytes?: number;
  /** PDF limits for the attachments (defaults: 60 pages, 50 MB decompressed, 20 s). */
  pdfLimits?: { maxPdfPages?: number; maxPdfInflatedBytes?: number; pdfTimeoutMs?: number };
}

const res = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });

function safeEqual(a: string, b: string): boolean {
  let d = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) d |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return d === 0;
}

class TooLarge extends Error {}

/** Read the body with a hard cap, whatever content-length says. */
async function readCapped(req: Request, max: number): Promise<Uint8Array> {
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > max) {
      await reader.cancel();
      throw new TooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

const latin1 = (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192));
  return s;
};

/** Raw MIME from the body: raw message, or JSON from providers ({ RawEmail } Postmark, { "body-mime" } Mailgun, { raw } base64). */
function rawMessage(contentType: string, body: Uint8Array): string {
  if (/json/i.test(contentType)) {
    const j = JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>;
    const v = j.RawEmail ?? j['body-mime'] ?? j.raw;
    if (typeof v !== 'string') throw new Error('no raw message');
    return j.raw === v && !/\r?\n/.test(v) ? atob(v) : v;
  }
  return latin1(body);
}

/** Raw header fields (unfolded), in order, with their original values (not decoded). */
export function rawHeaderFields(raw: string): { name: string; value: string }[] {
  const end = /\r?\n\r?\n/.exec(raw);
  const head = (end ? raw.slice(0, end.index) : raw).replace(/\r?\n[ \t]+/g, ' ');
  const out: { name: string; value: string }[] = [];
  for (const line of head.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0 && /^[\x21-\x39\x3b-\x7e]+$/.test(line.slice(0, i))) out.push({ name: line.slice(0, i).toLowerCase(), value: line.slice(i + 1).trim() });
  }
  return out;
}

/**
 * RFC 5322 `From` → the single addr-spec (lower-cased), or undefined when it is not exactly one mailbox.
 * Comments "(…)" (nested) and quoted strings are removed first, so neither a comment nor a display name
 * — encoded or not — can supply the address.
 */
export function parseFromAddress(value: string): string | undefined {
  let s = '';
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i]!;
    if (c === '\\' && (quoted || depth)) {
      i++;
      continue;
    }
    if (quoted) {
      if (c === '"') quoted = false;
      continue;
    }
    if (depth) {
      if (c === '(') depth++;
      else if (c === ')') depth--;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === '(') depth = 1;
    else s += c;
  }
  if (quoted || depth) return undefined;
  if (/[,;]/.test(s)) return undefined; // a mailbox-list / group: exactly one mailbox is required
  const angles = s.match(/<([^<>]*)>/g);
  let addr: string;
  if (angles) {
    if (angles.length !== 1 || /[<>]/.test(s.replace(angles[0]!, ''))) return undefined;
    addr = angles[0]!.slice(1, -1).trim();
  } else addr = s.trim();
  addr = addr.toLowerCase();
  return /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+@([a-z0-9-]+\.)+[a-z]{2,}$/.test(addr) && !addr.includes('..') ? addr : undefined;
}

/** Multi-label public suffixes of the region (the organizational domain sits one label below). */
const PUBLIC_SUFFIXES = new Set([
  'com.br', 'net.br', 'org.br', 'gov.br', 'edu.br', 'art.br', 'ind.br', 'inf.br', 'com.co', 'net.co', 'org.co', 'gov.co', 'edu.co',
  'com.ar', 'com.mx', 'com.pe', 'com.cl', 'com.uy', 'com.ec', 'co.uk', 'org.uk', 'com.au', 'co.jp', 'com.es', 'co.in',
]);

/** Organizational domain (approximation of the PSL for the domains this app sees). */
export function orgDomain(domain: string): string {
  const labels = domain.toLowerCase().replace(/\.$/, '').split('.');
  const last2 = labels.slice(-2).join('.');
  return labels.slice(PUBLIC_SUFFIXES.has(last2) ? -3 : -2).join('.');
}

/** Relaxed DMARC alignment: same organizational domain. */
export function domainsAligned(a: string, b: string): boolean {
  return !!a && !!b && orgDomain(a) === orgDomain(b);
}

export interface AuthVerdict {
  ok: boolean;
  reason: string;
}

/**
 * Verdict from the trusted Authentication-Results header for a From domain. `fields` are the raw
 * header fields in order (topmost first, i.e. added by the last hop = your provider).
 */
export function authVerdict(fields: { name: string; value: string }[], fromDomain: string, authservIds?: string[]): AuthVerdict {
  const ars = fields.filter((f) => f.name === 'authentication-results');
  const ids = (authservIds ?? []).map((x) => x.toLowerCase());
  const servId = (v: string) => v.split(';')[0]!.trim().split(/\s+/)[0]!.toLowerCase();
  const trusted = ids.length ? ars.find((f) => ids.includes(servId(f.value))) : ars[0];
  if (!trusted) return { ok: false, reason: ids.length ? 'no Authentication-Results from the configured authserv-id' : 'no Authentication-Results' };
  const clauses = trusted.value.split(';').slice(1).map((c) => c.trim().replace(/\([^)]*\)/g, ' '));
  const prop = (c: string, name: string) => new RegExp(`\\b${name.replace('.', '\\.')}=([^\\s;]+)`, 'i').exec(c)?.[1]?.replace(/^.*@/, '').toLowerCase();
  let ok = false;
  let why = 'no aligned pass';
  for (const c of clauses) {
    const m = /^(dmarc|dkim|spf)\s*=\s*(\w+)/i.exec(c);
    if (!m) continue;
    const method = m[1]!.toLowerCase();
    const result = m[2]!.toLowerCase();
    if (method === 'dmarc' && result === 'fail') return { ok: false, reason: 'dmarc=fail' };
    if (result !== 'pass') continue;
    const d = method === 'dmarc' ? prop(c, 'header.from') : method === 'dkim' ? prop(c, 'header.d') ?? prop(c, 'header.i') : prop(c, 'smtp.mailfrom') ?? prop(c, 'smtp.helo');
    if (d && domainsAligned(d, fromDomain)) {
      ok = true;
      why = `${method}=pass aligned (${d})`;
    }
  }
  return { ok, reason: why };
}

export function createEmailInboxHandler(o: EmailInboxHandlerOptions): (req: Request) => Promise<Response> {
  if (!o.secret || o.secret.length < 16) throw new Error('INBOX secret must have at least 16 characters');
  const maxBytes = o.maxBytes ?? 25 * 1024 * 1024;
  return async (req) => {
    if (req.method !== 'POST') return res(405, { error: { code: 'METHOD_NOT_ALLOWED' } });
    if (new URL(req.url).searchParams.has('secret')) {
      return res(400, { error: { code: 'SECRET_IN_URL', message: 'Envía el secreto en la cabecera x-inbox-secret, nunca en la URL.' } });
    }
    if (!safeEqual(req.headers.get('x-inbox-secret') ?? '', o.secret)) return res(401, { error: { code: 'UNAUTHORIZED' } });
    if (Number(req.headers.get('content-length') ?? 0) > maxBytes) return res(413, { error: { code: 'TOO_LARGE' } });
    let raw: string;
    try {
      raw = rawMessage(req.headers.get('content-type') ?? '', await readCapped(req, maxBytes));
    } catch (e) {
      if (e instanceof TooLarge) return res(413, { error: { code: 'TOO_LARGE' } });
      return res(400, { error: { code: 'BAD_REQUEST', message: 'Se esperaba el mensaje MIME completo.' } });
    }
    const fields = rawHeaderFields(raw);
    const froms = fields.filter((f) => f.name === 'from');
    if (froms.length !== 1) return res(400, { error: { code: 'BAD_FROM', message: 'El mensaje debe tener exactamente un encabezado From.' } });
    const from = parseFromAddress(froms[0]!.value);
    if (!from) return res(400, { error: { code: 'BAD_FROM', message: 'Encabezado From inválido (se exige un único buzón).' } });
    if (o.allowedSenders?.length && !o.allowedSenders.some((a) => (typeof a === 'string' ? a.toLowerCase() === from : a.test(from)))) {
      return res(403, { error: { code: 'SENDER_NOT_ALLOWED', message: `Remitente no autorizado: ${from}` } });
    }
    if (o.requireAuthResults !== false) {
      const v = authVerdict(fields, from.split('@')[1]!, o.authservIds);
      if (!v.ok) return res(403, { error: { code: 'NOT_AUTHENTICATED', message: `El correo no pasó SPF/DKIM/DMARC alineado con ${from.split('@')[1]} (${v.reason}).` } });
    }
    const to = fields.filter((f) => ['delivered-to', 'x-original-to', 'to'].includes(f.name)).map((f) => f.value).join(' ');
    const token = /[\w.-]+\+([\w-]{6,64})@/.exec(to)?.[1];
    const target = token ? await o.resolveRecipient(token) : undefined;
    if (!target) return res(404, { error: { code: 'UNKNOWN_RECIPIENT' } });
    const result = await importEmail(raw, {
      portfolioId: target.portfolioId,
      ...(target.existingTransactions ? { existingTransactions: target.existingTransactions } : {}),
      ...(target.existingInstruments ? { existingInstruments: target.existingInstruments } : {}),
      ...(target.pdfPasswords ? { pdfPasswords: target.pdfPasswords } : {}),
      ...(target.account ? { account: target.account } : {}),
      maxAttachments: o.maxAttachments ?? 20,
      maxAttachmentBytes: o.maxAttachmentBytes ?? 15 * 1024 * 1024,
      limits: { maxPdfPages: 60, maxPdfInflatedBytes: 50 * 1024 * 1024, pdfTimeoutMs: 20_000, ...o.pdfLimits },
    });
    await o.save(target, result);
    return res(200, {
      portfolioId: target.portfolioId,
      attachments: result.attachments.map((a) => ({ fileName: a.fileName, imported: a.result.stats.imported, pending: a.result.stats.pending, errors: a.result.stats.errors })),
      ignored: result.ignored.filter((i) => i.reason).length,
      needsPassword: result.needsPassword,
      transactions: result.transactions.length,
    });
  };
}
