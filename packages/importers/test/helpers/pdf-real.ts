/**
 * PDF writer for "real-like" fixtures (I31). The round-2 writer emits one `Tj` per cell in Helvetica,
 * uncompressed, in reading order — the friendliest possible PDF. Real broker PDFs are not like that,
 * so this writer reproduces what report engines (Crystal Reports, JasperReports, iText, SINACOR's own
 * generator) actually produce, and what text extraction has to survive:
 *
 *  - FlateDecode-compressed content streams;
 *  - text positioned with `Tm` matrices or `Td`, in other fonts (Courier, Times, Helvetica-Bold);
 *  - text drawn per cell, per WORD (one show operator per word) or per GLYPH (each character
 *    positioned separately, as some generators do for justified/kerned output);
 *  - `TJ` arrays with kerning adjustments inside words;
 *  - right-aligned numbers (x computed from the font metrics), table rules and boxes;
 *  - drawing order unrelated to reading order (shuffled), headers/footers drawn first;
 *  - encryption: RC4-40 (V1/R2) or AES-128 (V4/R4, AESV2), with the document ID, like XP/Clear/Rico
 *    password-protected notes.
 * Test-only (node:crypto, node:zlib).
 */
import { createCipheriv, createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';

export type FontKey = 'H' | 'HB' | 'C' | 'T';
export interface RealText {
  x: number;
  y: number;
  text: string;
  size?: number;
  font?: FontKey;
  /** 'right': x is the right edge (numbers in columns). */
  align?: 'left' | 'right';
}
export interface RealPage {
  texts: RealText[];
  /** Horizontal/vertical rules [x1, y1, x2, y2]. */
  rules?: [number, number, number, number][];
  /** Rectangles [x, y, w, h]. */
  boxes?: [number, number, number, number][];
}
export interface RealPdfOptions {
  /** How text is drawn. Default 'cell'. */
  mode?: 'cell' | 'word' | 'glyph' | 'tj';
  /** Default font for texts without one. */
  font?: FontKey;
  compress?: boolean;
  /** Shuffle drawing order with this seed (0 = reading order). */
  shuffle?: number;
  encrypt?: { userPassword: string; ownerPassword?: string; aes?: boolean };
  producer?: string;
}

// Helvetica AFM widths (1/1000 em) for ASCII 32..126; accented Latin-1 letters use their base letter.
const HELV = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584,
  584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667,
  667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556,
  500, 722, 500, 500, 500, 334, 260, 334, 584,
];
// Helvetica-Bold: close enough for layout (pdf.js measures with its own metrics anyway).
const BASE: Record<string, string> = { á: 'a', à: 'a', â: 'a', ã: 'a', é: 'e', ê: 'e', í: 'i', ó: 'o', ô: 'o', õ: 'o', ú: 'u', ç: 'c', ñ: 'n', Á: 'A', Ã: 'A', Â: 'A', É: 'E', Ê: 'E', Í: 'I', Ó: 'O', Õ: 'O', Ú: 'U', Ç: 'C', Ñ: 'N' };

function charWidth(ch: string, font: FontKey): number {
  if (font === 'C') return 600;
  const c = BASE[ch] ?? ch;
  const code = c.charCodeAt(0);
  const w = code >= 32 && code <= 126 ? HELV[code - 32]! : 556;
  if (font === 'T') return Math.round(w * 0.9);
  if (font === 'HB') return Math.round(w * 1.05);
  return w;
}
export function textWidth(s: string, size: number, font: FontKey): number {
  return ([...s].reduce((a, ch) => a + charWidth(ch, font), 0) * size) / 1000;
}

function latin1(s: string): string {
  const map: Record<string, string> = { '–': '\x96', '—': '\x97', '’': '\x92', '“': '\x93', '”': '\x94', '€': '\x80' };
  return s.replace(/[–—’“”€]/g, (c) => map[c] ?? '?');
}
const esc = (s: string) => latin1(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 0x100000000;
  };
}

const FONT_RES: Record<FontKey, string> = { H: 'F1', HB: 'F2', C: 'F3', T: 'F4' };
const FONT_NAME: Record<FontKey, string> = { H: 'Helvetica', HB: 'Helvetica-Bold', C: 'Courier', T: 'Times-Roman' };

function drawText(t: RealText, o: RealPdfOptions, r: () => number): string[] {
  const font = t.font ?? o.font ?? 'H';
  const size = t.size ?? 7;
  const f = `/${FONT_RES[font]} ${size} Tf`;
  const x0 = t.align === 'right' ? t.x - textWidth(t.text, size, font) : t.x;
  const mode = o.mode ?? 'cell';
  const fx = (n: number) => n.toFixed(2);
  if (mode === 'cell') return [`BT ${f} 1 0 0 1 ${fx(x0)} ${fx(t.y)} Tm (${esc(t.text)}) Tj ET`];
  if (mode === 'tj') {
    // Kerning inside words (small adjustments), real spaces between words.
    const parts = [...t.text].map((ch, i) => (i > 0 && /[A-Za-z]/.test(ch) && r() < 0.25 ? `${Math.round(r() * 30 - 15)} (${esc(ch)})` : `(${esc(ch)})`));
    return [`BT ${f} ${fx(x0)} ${fx(t.y)} Td [${parts.join(' ')}] TJ ET`];
  }
  if (mode === 'word') {
    const out: string[] = [];
    let x = x0;
    for (const w of t.text.split(/( +)/)) {
      if (w.trim()) out.push(`BT ${f} 1 0 0 1 ${fx(x)} ${fx(t.y)} Tm (${esc(w)}) Tj ET`);
      x += textWidth(w, size, font);
    }
    return out;
  }
  // glyph: each character positioned on its own.
  const out: string[] = [];
  let x = x0;
  for (const ch of t.text) {
    if (ch !== ' ') out.push(`BT ${f} 1 0 0 1 ${fx(x)} ${fx(t.y)} Tm (${esc(ch)}) Tj ET`);
    x += textWidth(ch, size, font);
  }
  return out;
}

// --- encryption --------------------------------------------------------------------------------
const PAD = [0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08, 0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a];
const md5 = (...parts: number[][]) => [...createHash('md5').update(Uint8Array.from(parts.flat())).digest()];
const bytesOf = (s: string) => [...s].map((c) => c.charCodeAt(0) & 0xff);
const pad = (pw: string) => [...bytesOf(pw), ...PAD].slice(0, 32);
const hex = (b: number[]) => b.map((x) => x.toString(16).padStart(2, '0')).join('');
function rc4(key: number[], data: number[]): number[] {
  const S = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + S[i]! + key[i % key.length]!) & 255;
    [S[i], S[j]] = [S[j]!, S[i]!];
  }
  const out: number[] = [];
  for (let k = 0, i = 0, j = 0; k < data.length; k++) {
    i = (i + 1) & 255;
    j = (j + S[i]!) & 255;
    [S[i], S[j]] = [S[j]!, S[i]!];
    out.push(data[k]! ^ S[(S[i]! + S[j]!) & 255]!);
  }
  return out;
}

interface Crypt {
  dict: string;
  encrypt(objNum: number, data: number[]): number[];
}

function makeCrypt(enc: NonNullable<RealPdfOptions['encrypt']>, id: number[]): Crypt {
  const P = -1028;
  const p4 = [P & 255, (P >> 8) & 255, (P >> 16) & 255, (P >>> 24) & 255];
  const owner = enc.ownerPassword ?? `${enc.userPassword}-owner`;
  if (!enc.aes) {
    const O = rc4(md5(pad(owner)).slice(0, 5), pad(enc.userPassword));
    const key = md5(pad(enc.userPassword), O, p4, id).slice(0, 5);
    const U = rc4(key, PAD);
    return {
      dict: `<< /Filter /Standard /V 1 /R 2 /O <${hex(O)}> /U <${hex(U)}> /P ${P} >>`,
      encrypt: (n, data) => rc4(md5(key, [n & 255, (n >> 8) & 255, (n >> 16) & 255, 0, 0]).slice(0, 10), data),
    };
  }
  // V4 / R4 with AESV2 (128-bit).
  let ok = md5(pad(owner));
  for (let i = 0; i < 50; i++) ok = md5(ok);
  let O = rc4(ok, pad(enc.userPassword));
  for (let i = 1; i <= 19; i++) O = rc4(ok.map((b) => b ^ i), O);
  let key = md5(pad(enc.userPassword), O, p4, id);
  for (let i = 0; i < 50; i++) key = md5(key.slice(0, 16));
  key = key.slice(0, 16);
  let U = rc4(key, md5(PAD, id));
  for (let i = 1; i <= 19; i++) U = rc4(key.map((b) => b ^ i), U);
  U = [...U, ...new Array(16).fill(0)];
  return {
    dict: `<< /Filter /Standard /V 4 /R 4 /Length 128 /CF << /StdCF << /CFM /AESV2 /AuthEvent /DocOpen /Length 16 >> >> /StmF /StdCF /StrF /StdCF /O <${hex(O)}> /U <${hex(U)}> /P ${P} >>`,
    encrypt: (n, data) => {
      const k = md5(key, [n & 255, (n >> 8) & 255, (n >> 16) & 255, 0, 0], [0x73, 0x41, 0x6c, 0x54]).slice(0, 16);
      const iv = md5([n & 255, 7, 7, 7]).slice(0, 16);
      const c = createCipheriv('aes-128-cbc', Uint8Array.from(k), Uint8Array.from(iv));
      return [...iv, ...c.update(Uint8Array.from(data)), ...c.final()];
    },
  };
}

export function writeRealPdf(pages: RealPage[], o: RealPdfOptions = {}): Uint8Array {
  type Obj = { dict: string; stream?: number[] };
  const objs: Obj[] = [];
  const add = (x: Obj) => objs.push(x);
  add({ dict: '' }); // 1 catalog
  add({ dict: '' }); // 2 pages
  const fontIds: Record<FontKey, number> = { H: 0, HB: 0, C: 0, T: 0 };
  for (const k of ['H', 'HB', 'C', 'T'] as FontKey[]) {
    add({ dict: `<< /Type /Font /Subtype /Type1 /BaseFont /${FONT_NAME[k]} /Encoding /WinAnsiEncoding >>` });
    fontIds[k] = objs.length;
  }
  const r = rng(o.shuffle ?? 0);
  const pageIds: number[] = [];
  for (const p of pages) {
    const ops: string[] = [];
    for (const [x, y, w, h] of p.boxes ?? []) ops.push(`0.92 g ${x} ${y} ${w} ${h} re f 0 g`);
    for (const [x1, y1, x2, y2] of p.rules ?? []) ops.push(`0.4 w ${x1} ${y1} m ${x2} ${y2} l S`);
    let texts = p.texts.flatMap((t) => drawText(t, o, r));
    if (o.shuffle) {
      texts = texts.map((t) => ({ t, k: r() })).sort((a, b) => a.k - b.k).map((x) => x.t);
    }
    ops.push(...texts);
    const content = ops.join('\n');
    const data = bytesOf(content);
    add(o.compress ? { dict: '/Filter /FlateDecode', stream: [...deflateSync(Uint8Array.from(data))] } : { dict: '', stream: data });
    const c = objs.length;
    const fonts = (Object.keys(fontIds) as FontKey[]).map((k) => `/${FONT_RES[k]} ${fontIds[k]} 0 R`).join(' ');
    add({ dict: `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << ${fonts} >> /ProcSet [/PDF /Text] >> /Contents ${c} 0 R >>` });
    pageIds.push(objs.length);
  }
  objs[0]!.dict = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[1]!.dict = `<< /Type /Pages /Kids [${pageIds.map((p) => `${p} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
  add({ dict: `<< /Producer (${esc(o.producer ?? 'SINACOR Report Engine')}) /Creator (Portafolio Pro fixtures) >>` });
  const infoId = objs.length;
  const id = md5(bytesOf(`fixture-${o.producer ?? ''}-${pages.length}`));
  let crypt: Crypt | undefined;
  let encryptRef: number | undefined;
  if (o.encrypt) {
    crypt = makeCrypt(o.encrypt, id);
    add({ dict: crypt.dict });
    encryptRef = objs.length;
  }
  let out = '%PDF-1.6\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [];
  objs.forEach((x, i) => {
    const n = i + 1;
    offsets.push(out.length);
    if (x.stream) {
      const data = crypt && n !== encryptRef ? crypt.encrypt(n, x.stream) : x.stream;
      out += `${n} 0 obj\n<< /Length ${data.length} ${x.dict} >>\nstream\n${String.fromCharCode(...data)}\nendstream\nendobj\n`;
    } else if (n === infoId && crypt) {
      out += `${n} 0 obj\n<< >>\nendobj\n`; // keep the Info dictionary free of (encrypted) strings
    } else out += `${n} 0 obj\n${x.dict}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((v) => `${String(v).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R /Info ${infoId} 0 R${encryptRef ? ` /Encrypt ${encryptRef} 0 R` : ''} /ID [<${hex(id)}> <${hex(id)}>] >>\nstartxref\n${xref}\n%%EOF\n`;
  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
  return bytes;
}
