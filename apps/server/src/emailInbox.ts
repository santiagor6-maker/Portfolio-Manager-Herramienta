/**
 * E-mail inbox (importers I2) mounted on this server: an inbound-mail provider (Cloudflare Email
 * Routing + a Worker, Mailgun routes, Amazon SES + Lambda, Postmark) POSTs each message forwarded to
 * `importar+<token>@your-domain` to POST /api/inbox/email. `createEmailInboxHandler` from
 * @pm/importers checks the shared secret, the sender allowlist and SPF/DKIM, maps the token to a
 * portfolio and imports the attachments; the result is kept here as a DRAFT the web app reviews
 * (GET /api/inbox/email/drafts) and acknowledges (DELETE). Nothing is booked automatically.
 *
 * Storage: the same never-pruned store as the IBKR sync (SYNC_DIR), one key per portfolio, written
 * under a per-portfolio lock. Single-user server: access to the drafts is controlled by API_TOKEN.
 */
import type { Instrument, Transaction } from '@pm/core';
import { createEmailInboxHandler, type EmailImportResult, type InboxTarget } from '@pm/importers';
import type { PersistentStore } from '@pm/market-data';
import { PORTFOLIO_ID_RE } from './ibkrSync';
import { KeyedLock } from './keyedLock';

export interface EmailDraft {
  id: string;
  receivedAt: string;
  from?: string;
  subject?: string;
  date?: string;
  transactions: Transaction[];
  /** New instruments referenced by the transactions. */
  instruments: Instrument[];
  attachments: { fileName?: string; imported: number; pending: number; errors: number; warnings: string[] }[];
  /** Attachments still waiting for a PDF password (re-import them in the web app). */
  needsPassword: string[];
  ignored: { fileName?: string; contentType: string }[];
}

export interface EmailDraftInbox {
  portfolioId: string;
  drafts: EmailDraft[];
}

/** What app.ts mounts. */
export interface EmailInboxMount {
  handler: (req: Request) => Promise<Response>;
  maxBytes: number;
  drafts(portfolioId: string): Promise<EmailDraftInbox>;
  clearDrafts(portfolioId: string, ids?: string[]): Promise<{ cleared: number }>;
}

export interface EmailInboxOptions {
  /** INBOX_SECRET (≥ 16 chars): the provider sends it in the `x-inbox-secret` header (never in the URL). */
  secret: string;
  store: PersistentStore;
  /** Recipient token (importar+TOKEN@…) → portfolio id. */
  recipients: Record<string, string>;
  /** Exact addresses or RegExps; must not be empty (use [/.*\/] only deliberately). */
  allowedSenders: (string | RegExp)[];
  maxBytes?: number;
  requireAuthResults?: boolean;
  /** INBOX_AUTHSERV_ID: authserv-id(s) of the provider's Authentication-Results header (importers I41). */
  authservIds?: string[];
  /** INBOX_MAX_ATTACHMENTS: attachments imported per message (default 20; importers I42). */
  maxAttachments?: number;
  /** Candidate passwords for encrypted PDF notes (e.g. first CPF digits). */
  pdfPasswords?: string[];
  /** Max unconfirmed drafts per portfolio; beyond it new mail is refused with 507. Default 200. */
  maxDrafts?: number;
  now?: () => Date;
}

/**
 * The portfolio's draft inbox is full (review R6, M42): the message is refused with 507 instead of
 * silently dropping unconfirmed drafts; the provider will retry or bounce it.
 */
export class InboxFullError extends Error {
  constructor(
    readonly portfolioId: string,
    readonly limit: number,
  ) {
    super(`The e-mail draft inbox of ${portfolioId} is full (${limit} drafts not yet confirmed): confirm or delete drafts in the web app`);
    this.name = 'InboxFullError';
  }
}

const key = (portfolioId: string) => `email-inbox:default:${portfolioId}`;
const txKey = (t: Transaction) => t.importHash ?? t.id;

export class EmailInbox implements EmailInboxMount {
  readonly handler: (req: Request) => Promise<Response>;
  readonly maxBytes: number;
  private readonly lock = new KeyedLock();
  private readonly now: () => Date;
  private readonly maxDrafts: number;

  constructor(private readonly o: EmailInboxOptions) {
    if (!o.allowedSenders.length) throw new Error('INBOX_ALLOWED_SENDERS is required (a sender allowlist)');
    for (const [token, pid] of Object.entries(o.recipients)) {
      if (!/^[\w-]{8,64}$/.test(token)) throw new Error(`INBOX_RECIPIENTS: token "${token}" must be 8-64 letters, digits, _ or -`);
      if (!PORTFOLIO_ID_RE.test(pid)) throw new Error(`INBOX_RECIPIENTS: invalid portfolio id "${pid}"`);
    }
    this.now = o.now ?? (() => new Date());
    this.maxDrafts = o.maxDrafts ?? 200;
    this.maxBytes = o.maxBytes ?? 10 * 1024 * 1024;
    this.handler = createEmailInboxHandler({
      secret: o.secret,
      allowedSenders: o.allowedSenders,
      maxBytes: this.maxBytes,
      requireAuthResults: o.requireAuthResults !== false,
      ...(o.authservIds?.length ? { authservIds: o.authservIds } : {}),
      ...(o.maxAttachments ? { maxAttachments: o.maxAttachments } : {}),
      resolveRecipient: async (token) => {
        const portfolioId = Object.prototype.hasOwnProperty.call(o.recipients, token) ? o.recipients[token] : undefined;
        if (!portfolioId) return undefined;
        // Dedupe against what is already waiting in the inbox (the same mail forwarded twice).
        const pending = await this.drafts(portfolioId);
        if (pending.drafts.length >= this.maxDrafts) throw new InboxFullError(portfolioId, this.maxDrafts); // before importing
        const t: InboxTarget = { portfolioId, existingTransactions: pending.drafts.flatMap((d) => d.transactions) };
        if (o.pdfPasswords?.length) t.pdfPasswords = o.pdfPasswords;
        return t;
      },
      save: (target, result) => this.save(target.portfolioId, result),
    });
  }

  private async state(portfolioId: string): Promise<EmailDraftInbox> {
    const e = await this.o.store.get(key(portfolioId));
    return (e?.value as EmailDraftInbox | undefined) ?? { portfolioId, drafts: [] };
  }

  private async write(s: EmailDraftInbox): Promise<void> {
    await this.o.store.set(key(s.portfolioId), { value: s, storedAt: this.now().getTime(), expiresAt: null });
  }

  private save(portfolioId: string, r: EmailImportResult): Promise<void> {
    return this.lock.run(portfolioId, async () => {
      const s = await this.state(portfolioId);
      if (s.drafts.length >= this.maxDrafts) throw new InboxFullError(portfolioId, this.maxDrafts);
      const seen = new Set(s.drafts.flatMap((d) => d.transactions.map(txKey)));
      const transactions = r.transactions.filter((t) => !seen.has(txKey(t)));
      const instruments = new Map<string, Instrument>();
      for (const a of r.attachments) for (const i of a.result.instruments) instruments.set(i.id, i);
      const at = this.now();
      const draft: EmailDraft = {
        // Random ids: unique across restarts and processes (M42).
        id: `mail-${globalThis.crypto.randomUUID()}`,
        receivedAt: at.toISOString(),
        ...(r.from ? { from: r.from } : {}),
        ...(r.subject ? { subject: r.subject.slice(0, 300) } : {}),
        ...(r.date ? { date: r.date } : {}),
        transactions,
        instruments: [...instruments.values()].filter((i) => transactions.some((t) => t.instrumentId === i.id)),
        attachments: r.attachments.map((a) => ({
          fileName: a.fileName,
          imported: a.result.stats.imported,
          pending: a.result.stats.pending,
          errors: a.result.stats.errors,
          warnings: [...new Set(a.result.warnings.map((w) => w.code))].slice(0, 20),
        })),
        needsPassword: r.needsPassword,
        ignored: r.ignored.slice(0, 20),
      };
      await this.write({ portfolioId, drafts: [...s.drafts, draft] });
    });
  }

  async drafts(portfolioId: string): Promise<EmailDraftInbox> {
    return this.state(portfolioId);
  }

  /** Acknowledge drafts (or transactions) the web app imported; without ids the inbox is emptied. */
  async clearDrafts(portfolioId: string, ids?: string[]): Promise<{ cleared: number }> {
    return this.lock.run(portfolioId, async () => {
      const s = await this.state(portfolioId);
      if (!ids) {
        await this.write({ portfolioId, drafts: [] });
        return { cleared: s.drafts.length };
      }
      const ack = new Set(ids);
      const drafts = s.drafts.filter((d) => !ack.has(d.id));
      await this.write({ portfolioId, drafts });
      return { cleared: s.drafts.length - drafts.length };
    });
  }
}

/**
 * INBOX_ALLOWED_SENDERS: comma-separated. `confirm@xpi.com.br` = that address; `@xpi.com.br` = any
 * address of that domain or its subdomains. '*' (alone) accepts any sender — not recommended.
 */
export function parseAllowedSenders(spec: string | undefined): (string | RegExp)[] {
  const items = (spec ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (items.length === 1 && items[0] === '*') return [/^.+$/];
  return items.map((s) => {
    if (s.startsWith('@')) {
      const domain = s.slice(1);
      if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(domain)) throw new Error(`INBOX_ALLOWED_SENDERS: invalid domain "${s}"`);
      return new RegExp(`@([a-z0-9-]+\\.)*${domain.replace(/\./g, '\\.')}$`, 'i');
    }
    if (!/^[^@\s]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(s)) throw new Error(`INBOX_ALLOWED_SENDERS: invalid address "${s}"`);
    return s;
  });
}

/** INBOX_RECIPIENTS: "token:portfolioId,..." (the token is the part after "+" in importar+TOKEN@…). */
export function parseRecipients(spec: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of (spec ?? '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const [token, portfolioId] = item.split(':');
    if (!token || !portfolioId) throw new Error(`INBOX_RECIPIENTS: "${item}" must be token:portfolioId`);
    out[token] = portfolioId;
  }
  return out;
}
