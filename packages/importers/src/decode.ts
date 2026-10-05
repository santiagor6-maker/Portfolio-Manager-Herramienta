/**
 * Byte → text decoding with encoding detection. Brazilian and Colombian banks/brokers frequently
 * export Windows-1252 (Latin-1) CSVs; Excel "Unicode text" exports are UTF-16LE.
 */

export type TextEncodingName = 'utf-8' | 'utf-16le' | 'utf-16be' | 'windows-1252';

export interface DecodedText {
  text: string;
  encoding: TextEncodingName;
  hadBom: boolean;
}

// Windows-1252 code points for bytes 0x80..0x9F (the rest equals ISO-8859-1 / Unicode).
const W1252_HIGH = [
  0x20ac, 0x81, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x8d,
  0x017d, 0x8f, 0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a,
  0x0153, 0x9d, 0x017e, 0x0178,
];

export function decodeWindows1252(bytes: Uint8Array): string {
  let out = '';
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    const end = Math.min(bytes.length, i + CHUNK);
    const codes: number[] = new Array(end - i);
    for (let j = i; j < end; j++) {
      const b = bytes[j]!;
      codes[j - i] = b >= 0x80 && b <= 0x9f ? W1252_HIGH[b - 0x80]! : b;
    }
    out += String.fromCharCode(...codes);
  }
  return out;
}

function decodeUtf16(bytes: Uint8Array, littleEndian: boolean): string {
  let out = '';
  const codes: number[] = [];
  for (let i = 0; i + 1 < bytes.length; i += 2) {
    codes.push(littleEndian ? bytes[i]! | (bytes[i + 1]! << 8) : (bytes[i]! << 8) | bytes[i + 1]!);
    if (codes.length >= 8192) {
      out += String.fromCharCode(...codes);
      codes.length = 0;
    }
  }
  return out + String.fromCharCode(...codes);
}

/** Encode Windows-1252 (for tests / exporting legacy files). Unmappable chars become '?'. */
export function encodeWindows1252(text: string): Uint8Array {
  const reverse = new Map<number, number>();
  W1252_HIGH.forEach((cp, i) => reverse.set(cp, 0x80 + i));
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c < 0x80 || (c >= 0xa0 && c <= 0xff)) out[i] = c;
    else out[i] = reverse.get(c) ?? 0x3f;
  }
  return out;
}

export function toUint8Array(data: ArrayBuffer | Uint8Array): Uint8Array {
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

export function decodeBytes(data: ArrayBuffer | Uint8Array, forced?: string): DecodedText {
  const bytes = toUint8Array(data);
  const f = forced?.toLowerCase().replace(/_/g, '-');
  if (f) {
    if (f === 'utf-8' || f === 'utf8') return { text: stripBom(new TextDecoder('utf-8').decode(bytes)), encoding: 'utf-8', hadBom: false };
    if (f === 'utf-16le' || f === 'utf-16') return { text: stripBom(decodeUtf16(bytes, true)), encoding: 'utf-16le', hadBom: false };
    if (f === 'utf-16be') return { text: stripBom(decodeUtf16(bytes, false)), encoding: 'utf-16be', hadBom: false };
    return { text: decodeWindows1252(bytes), encoding: 'windows-1252', hadBom: false };
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return { text: new TextDecoder('utf-8').decode(bytes.subarray(3)), encoding: 'utf-8', hadBom: true };
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return { text: decodeUtf16(bytes.subarray(2), true), encoding: 'utf-16le', hadBom: true };
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return { text: decodeUtf16(bytes.subarray(2), false), encoding: 'utf-16be', hadBom: true };
  }
  // UTF-16 without BOM: lots of zero bytes in odd (LE) or even (BE) positions.
  const sample = Math.min(bytes.length, 4000);
  let zeroOdd = 0;
  let zeroEven = 0;
  for (let i = 0; i < sample; i++) {
    if (bytes[i] === 0) {
      if (i % 2) zeroOdd++;
      else zeroEven++;
    }
  }
  if (sample > 8 && zeroOdd > sample * 0.3 && zeroEven < sample * 0.05) return { text: decodeUtf16(bytes, true), encoding: 'utf-16le', hadBom: false };
  if (sample > 8 && zeroEven > sample * 0.3 && zeroOdd < sample * 0.05) return { text: decodeUtf16(bytes, false), encoding: 'utf-16be', hadBom: false };
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8', hadBom: false };
  } catch {
    return { text: decodeWindows1252(bytes), encoding: 'windows-1252', hadBom: false };
  }
}

function stripBom(s: string): string {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}
