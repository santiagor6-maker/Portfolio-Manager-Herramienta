/**
 * Forwarded e-mails (.eml) → imports (the Sharesight-style "forward your confirmations" inbox).
 *
 * Brazilian brokers e-mail the daily "nota de corretagem" as a (password-protected) PDF; Colombian
 * comisionistas send extracts as PDF/Excel; IBKR and US brokers send CSV/HTML confirmations. This module
 * parses the MIME message (multipart, base64, quoted-printable, RFC 2047 file names), runs every
 * supported attachment through `importFile` and de-duplicates across attachments (the same note attached
 * twice, a note forwarded again). Browser-safe: no Node APIs.
 *
 * The server side (receiving mail, checking SPF/DKIM and the sender, storing drafts) is not here:
 * `importEmail` is what such a webhook calls, and everything it returns is a normal ImportResult that
 * the user reviews before saving.
 */
import type { Transaction } from '@pm/core';
import { importFile } from './pipeline';
import type { ImportOptions, ImportResult } from './types';

export interface MimePart {
  headers: Record<string, string>;
  contentType: string;
  fileName?: string;
  body: Uint8Array;
}

export interface EmailMessage {
  from?: string;
  to?: string;
  subject?: string;
  date?: string;
  parts: MimePart[];
}

const latin1Bytes = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);
const bytesToLatin1 = (b: Uint8Array) => {
  let s = '';
  for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode(...b.subarray(i, i + 8192));
  return s;
};

function decodeBase64(s: string): Uint8Array {
  const clean = s.replace(/[^A-Za-z0-9+/=]/g, '');
  return latin1Bytes(atob(clean));
}

function decodeQuotedPrintable(s: string): Uint8Array {
  const t = s.replace(/=\r?\n/g, '');
  const out: number[] = [];
  for (let i = 0; i < t.length; i++) {
    if (t[i] === '=' && /^[0-9A-F]{2}$/i.test(t.slice(i + 1, i + 3))) {
      out.push(parseInt(t.slice(i + 1, i + 3), 16));
      i += 2;
    } else out.push(t.charCodeAt(i) & 0xff);
  }
  return Uint8Array.from(out);
}

function decodeCharset(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset || 'utf-8').decode(bytes);
  } catch {
    return bytesToLatin1(bytes);
  }
}

/** RFC 2047 encoded words: "=?UTF-8?B?Tm90YS5wZGY=?=", "=?ISO-8859-1?Q?nota_corretagem.pdf?=". */
export function decodeMimeWords(s: string): string {
  return s
    .replace(/\?=\s+=\?/g, '?==?')
    .replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi, (_, cs: string, enc: string, txt: string) =>
      decodeCharset(enc.toUpperCase() === 'B' ? decodeBase64(txt) : decodeQuotedPrintable(txt.replace(/_/g, ' ')), cs),
    );
}

/** RFC 2231 parameters (filename*=UTF-8''nota%20123.pdf, continuations filename*0*=...). */
function param(header: string, name: string): string | undefined {
  const ext: string[] = [];
  const re = new RegExp(`${name}\\*(\\d+)?\\*?=("([^"]*)"|[^;\\s]+)`, 'gi');
  let m: RegExpExecArray | null;
  let charset = 'utf-8';
  while ((m = re.exec(header))) {
    let v = m[3] ?? m[2]!;
    const cs = /^([^']*)'[^']*'(.*)$/.exec(v);
    if (cs) {
      if (cs[1]) charset = cs[1];
      v = cs[2]!;
    }
    ext.push(v);
  }
  if (ext.length) {
    const raw = ext.join('').replace(/%([0-9A-F]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
    return decodeCharset(latin1Bytes(raw), charset);
  }
  const plain = new RegExp(`(?:^|;)\\s*${name}=("([^"]*)"|[^;]+)`, 'i').exec(header);
  return plain ? decodeMimeWords((plain[2] ?? plain[1]!).trim()) : undefined;
}

function parseHeaders(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  const unfolded = block.replace(/\r?\n[ \t]+/g, ' ');
  for (const line of unfolded.split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}

function splitHead(raw: string): [string, string] {
  const m = /\r?\n\r?\n/.exec(raw);
  return m ? [raw.slice(0, m.index), raw.slice(m.index + m[0].length)] : [raw, ''];
}

function parseEntity(raw: string, out: MimePart[], depth = 0): Record<string, string> {
  const [head, body] = splitHead(raw);
  const headers = parseHeaders(head);
  const ct = headers['content-type'] ?? 'text/plain';
  const type = ct.split(';')[0]!.trim().toLowerCase();
  if (type.startsWith('multipart/') && depth < 8) {
    const boundary = param(ct, 'boundary');
    if (boundary) {
      const parts = body.split(new RegExp(`\\r?\\n?--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?[ \\t]*\\r?\\n?`));
      for (const p of parts.slice(1)) if (p.trim()) parseEntity(p, out, depth + 1);
    }
    return headers;
  }
  if (type === 'message/rfc822' && depth < 8) {
    parseEntity(body, out, depth + 1); // forwarded e-mail as attachment
    return headers;
  }
  const enc = (headers['content-transfer-encoding'] ?? '').toLowerCase();
  const bytes = enc === 'base64' ? decodeBase64(body) : enc === 'quoted-printable' ? decodeQuotedPrintable(body) : latin1Bytes(body);
  const part: MimePart = { headers, contentType: type, body: bytes };
  const fileName = param(headers['content-disposition'] ?? '', 'filename') ?? param(ct, 'name');
  if (fileName) part.fileName = fileName;
  out.push(part);
  return headers;
}

/** Parse a raw RFC 822 message (string or bytes). */
export function parseEmail(raw: string | Uint8Array): EmailMessage {
  const text = typeof raw === 'string' ? raw : bytesToLatin1(raw);
  const parts: MimePart[] = [];
  const headers = parseEntity(text, parts);
  const msg: EmailMessage = { parts };
  if (headers.from) msg.from = decodeMimeWords(headers.from);
  if (headers.to) msg.to = decodeMimeWords(headers.to);
  if (headers.subject) msg.subject = decodeMimeWords(headers.subject);
  if (headers.date) msg.date = headers.date;
  return msg;
}

const IMPORTABLE = /\.(pdf|csv|txt|xlsx|xls|htm|html|json)$/i;
const IMPORTABLE_TYPES = /^(application\/(pdf|vnd\.ms-excel|vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet|octet-stream|json)|text\/(csv|comma-separated-values))$/;

export interface EmailAttachmentResult {
  fileName: string;
  result: ImportResult;
}

export interface EmailImportResult {
  from?: string;
  subject?: string;
  date?: string;
  /** One import per attachment (de-duplicated against the previous ones). */
  attachments: EmailAttachmentResult[];
  /** Parts that are not importable (signatures, logos, plain text). */
  ignored: { fileName?: string; contentType: string }[];
  /** All transactions ready to save, across attachments. */
  transactions: Transaction[];
  /** Attachments still waiting for a PDF password. */
  needsPassword: string[];
}

export interface EmailImportOptions extends ImportOptions {
  /**
   * Candidate PDF passwords tried in order (XP, Clear and Rico use the first digits of the CPF):
   * the user stores them once, the inbox opens every note.
   */
  pdfPasswords?: string[];
  /** Import a table in the HTML body when the message has no importable attachment. Default true. */
  bodyTables?: boolean;
}

/** Import every supported attachment of a forwarded e-mail. */
export async function importEmail(raw: string | Uint8Array, options: EmailImportOptions): Promise<EmailImportResult> {
  const msg = parseEmail(raw);
  const out: EmailImportResult = { attachments: [], ignored: [], transactions: [], needsPassword: [] };
  if (msg.from) out.from = msg.from;
  if (msg.subject) out.subject = msg.subject;
  if (msg.date) out.date = msg.date;
  const existing = [...(options.existingTransactions ?? [])];
  const run = async (part: MimePart, fileName: string) => {
    const passwords = [options.pdfPassword, ...(options.pdfPasswords ?? [])].filter((p): p is string => !!p);
    let result: ImportResult | undefined;
    for (const pw of passwords.length ? passwords : [undefined]) {
      const opts: ImportOptions = { ...options, existingTransactions: existing };
      if (pw) opts.pdfPassword = pw;
      else delete opts.pdfPassword;
      result = await importFile({ data: part.body, fileName }, opts);
      if (result.needsPassword !== 'incorrect') break;
    }
    if (!result) return;
    if (result.needsPassword) out.needsPassword.push(fileName);
    out.attachments.push({ fileName, result });
    out.transactions.push(...result.transactions);
    existing.push(...result.transactions);
  };
  const files = msg.parts.filter((p) => !!p.fileName && (IMPORTABLE.test(p.fileName) || IMPORTABLE_TYPES.test(p.contentType)));
  for (const p of msg.parts) if (!files.includes(p) && (p.fileName || !/^text\//.test(p.contentType))) out.ignored.push({ ...(p.fileName ? { fileName: p.fileName } : {}), contentType: p.contentType });
  for (const p of files) await run(p, p.fileName!);
  if (!files.length && options.bodyTables !== false) {
    const html = msg.parts.find((p) => p.contentType === 'text/html' && /<table/i.test(bytesToLatin1(p.body)));
    if (html) {
      const cs = param(html.headers['content-type'] ?? '', 'charset') ?? 'utf-8';
      const text = decodeCharset(html.body, cs);
      await run({ ...html, body: new TextEncoder().encode(text) }, 'mensaje.html');
    }
  }
  return out;
}
