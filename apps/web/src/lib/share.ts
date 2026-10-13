/**
 * W10: read-only share links without a backend account. The rendered report travels compressed
 * (deflate-raw) inside the URL fragment (`/compartido#p1.…`): browsers never send the fragment to the
 * server, so the data only lives in the link. With a passphrase the payload is AES-GCM encrypted
 * (PBKDF2, see lib/crypto) and the link alone reveals nothing (`#e1.…`).
 */
import { decryptText, encryptText, type EncryptedFile } from './crypto';

export interface SharePayload {
  v: 1;
  /** Title (portfolio · period). */
  t: string;
  /** Report body HTML (rendered by the app, shown in a script-less sandbox). */
  h: string;
  /** Generated at (ISO). */
  g: string;
  lang: string;
}

function toB64Url(u: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64Url(s: string): Uint8Array {
  const b = s.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b + '='.repeat((4 - (b.length % 4)) % 4)), (c) => c.charCodeAt(0));
}

async function pipe(data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const out = new Blob([data as BlobPart]).stream().pipeThrough(stream);
  return new Uint8Array(await new Response(out).arrayBuffer());
}

/** Encodes the payload for the URL fragment; with a passphrase it is encrypted. */
export async function encodeShare(p: SharePayload, passphrase?: string): Promise<string> {
  const packed = toB64Url(await pipe(new TextEncoder().encode(JSON.stringify(p)), new CompressionStream('deflate-raw')));
  if (!passphrase) return `p1.${packed}`;
  const enc = await encryptText(packed, passphrase);
  return `e1.${toB64Url(new TextEncoder().encode(JSON.stringify(enc)))}`;
}

export function isEncryptedShare(fragment: string): boolean {
  return fragment.replace(/^#/, '').startsWith('e1.');
}

/** Decodes a fragment; throws 'invalid_link' or 'wrong_passphrase'. */
export async function decodeShare(fragment: string, passphrase?: string): Promise<SharePayload> {
  const f = fragment.replace(/^#/, '');
  let packed: string;
  try {
    if (f.startsWith('e1.')) {
      if (!passphrase) throw new Error('needs_passphrase');
      const enc = JSON.parse(new TextDecoder().decode(fromB64Url(f.slice(3)))) as EncryptedFile;
      packed = await decryptText(enc, passphrase);
    } else if (f.startsWith('p1.')) packed = f.slice(3);
    else throw new Error('invalid_link');
  } catch (e) {
    if (e instanceof Error && (e.message === 'wrong_passphrase' || e.message === 'needs_passphrase')) throw e;
    throw new Error('invalid_link');
  }
  try {
    const json = new TextDecoder().decode(await pipe(fromB64Url(packed), new DecompressionStream('deflate-raw')));
    const p = JSON.parse(json) as SharePayload;
    if (p.v !== 1 || typeof p.h !== 'string') throw new Error('invalid_link');
    return p;
  } catch {
    throw new Error('invalid_link');
  }
}

/** Removes anything executable from the report HTML before it is shared (defence in depth). */
export function sanitizeReportHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
    .replace(/javascript:/gi, '');
}
