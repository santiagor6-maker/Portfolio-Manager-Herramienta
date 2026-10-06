/**
 * Passphrase-encrypted backups (AES-GCM 256, key from PBKDF2-SHA256, 250k iterations) using
 * WebCrypto. Lets users move their data between devices through any cloud folder without the
 * file being readable there.
 */
export interface EncryptedFile {
  app: 'portafolio-pro';
  enc: 'AES-GCM';
  kdf: 'PBKDF2-SHA256';
  iter: number;
  salt: string;
  iv: string;
  data: string;
}

const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

function b64Large(u: Uint8Array): string {
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}

async function deriveKey(pass: string, salt: Uint8Array, iter: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pass), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: salt as BufferSource, iterations: iter }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function encryptText(text: string, pass: string, iter = 250_000): Promise<EncryptedFile> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(pass, salt, iter);
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, new TextEncoder().encode(text)));
  return { app: 'portafolio-pro', enc: 'AES-GCM', kdf: 'PBKDF2-SHA256', iter, salt: b64(salt), iv: b64(iv), data: b64Large(data) };
}

export function isEncrypted(x: unknown): x is EncryptedFile {
  return !!x && typeof x === 'object' && (x as EncryptedFile).enc === 'AES-GCM' && typeof (x as EncryptedFile).data === 'string';
}

/** Throws 'wrong_passphrase' when the passphrase does not match. */
export async function decryptText(f: EncryptedFile, pass: string): Promise<string> {
  const key = await deriveKey(pass, unb64(f.salt), f.iter);
  try {
    const out = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(f.iv) as BufferSource }, key, unb64(f.data) as BufferSource);
    return new TextDecoder().decode(out);
  } catch {
    throw new Error('wrong_passphrase');
  }
}
