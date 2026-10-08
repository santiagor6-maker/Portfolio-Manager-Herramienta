/**
 * Tiny PDF writer for test fixtures: text placed at absolute positions with the standard Helvetica
 * font (WinAnsiEncoding, so Portuguese/Spanish accents work). Produces valid xref tables.
 * `userPassword` encrypts the content with the Standard Security Handler (V1/R2, RC4 40-bit), like
 * the password-protected notas that XP, Clear and Rico send. Test-only (uses node:crypto for MD5).
 */
import { createHash } from 'node:crypto';

export type PdfText = [x: number, y: number, text: string, size?: number];

function latin1(s: string): string {
  // Map a few non-Latin-1 punctuation marks to WinAnsi code points.
  const map: Record<string, string> = { '–': '\x96', '—': '\x97', '’': '\x92', '“': '\x93', '”': '\x94', '€': '\x80' };
  return s.replace(/[–—’“”€]/g, (c) => map[c] ?? '?');
}

const PAD = [0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08, 0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a];

const md5 = (...parts: number[][]) => [...createHash('md5').update(Uint8Array.from(parts.flat())).digest()];

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

const bytesOf = (s: string) => [...s].map((c) => c.charCodeAt(0) & 0xff);
const pad = (pw: string) => [...bytesOf(pw), ...PAD].slice(0, 32);
const hex = (b: number[]) => b.map((x) => x.toString(16).padStart(2, '0')).join('');

export function writePdf(pages: PdfText[][], opts: { userPassword?: string; ownerPassword?: string } = {}): Uint8Array {
  const esc = (s: string) => latin1(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  type Obj = { dict: string; stream?: string };
  const objs: Obj[] = [];
  const add = (o: Obj) => {
    objs.push(o);
    return objs.length;
  };
  const catalog = add({ dict: '' });
  const pagesObj = add({ dict: '' });
  const font = add({ dict: '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>' });
  const pageIds: number[] = [];
  for (const items of pages) {
    const content = items.map(([x, y, t, size]) => `BT /F1 ${size ?? 8} Tf ${x} ${y} Td (${esc(t)}) Tj ET`).join('\n');
    const c = add({ dict: '', stream: content });
    pageIds.push(add({ dict: `<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${c} 0 R >>` }));
  }
  objs[catalog - 1]!.dict = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1]!.dict = `<< /Type /Pages /Kids [${pageIds.map((p) => `${p} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

  // Encryption (Standard Security Handler, V1 R2).
  const id = md5(bytesOf('portafolio-pro-test'));
  let key: number[] | undefined;
  let encryptRef: number | undefined;
  if (opts.userPassword !== undefined) {
    const P = -44; // print allowed etc.
    const O = rc4(md5(pad(opts.ownerPassword ?? `${opts.userPassword}-owner`)).slice(0, 5), pad(opts.userPassword));
    const p4 = [P & 255, (P >> 8) & 255, (P >> 16) & 255, (P >>> 24) & 255];
    key = md5(pad(opts.userPassword), O, p4, id).slice(0, 5);
    const U = rc4(key, PAD);
    encryptRef = add({ dict: `<< /Filter /Standard /V 1 /R 2 /O <${hex(O)}> /U <${hex(U)}> /P ${P} >>` });
  }
  const objKey = (n: number) => md5(key!, [n & 255, (n >> 8) & 255, (n >> 16) & 255, 0, 0]).slice(0, 10);

  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    const n = i + 1;
    if (o.stream !== undefined) {
      const data = key && n !== encryptRef ? String.fromCharCode(...rc4(objKey(n), bytesOf(o.stream))) : o.stream;
      out += `${n} 0 obj\n<< /Length ${data.length} >>\nstream\n${data}\nendstream\nendobj\n`;
    } else out += `${n} 0 obj\n${o.dict}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R${encryptRef ? ` /Encrypt ${encryptRef} 0 R` : ''} /ID [<${hex(id)}> <${hex(id)}>] >>\nstartxref\n${xref}\n%%EOF\n`;
  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
  return bytes;
}
