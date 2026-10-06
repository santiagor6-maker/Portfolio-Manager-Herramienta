/**
 * Tiny PDF writer for test fixtures: text placed at absolute positions with the standard Helvetica
 * font (WinAnsiEncoding, so Portuguese/Spanish accents work). Produces valid xref tables.
 */
export type PdfText = [x: number, y: number, text: string, size?: number];

function latin1(s: string): string {
  // Map a few non-Latin-1 punctuation marks to WinAnsi code points.
  const map: Record<string, string> = { '–': '\x96', '—': '\x97', '’': '\x92', '“': '\x93', '”': '\x94', '€': '\x80' };
  return s.replace(/[–—’“”€]/g, (c) => map[c] ?? '?');
}

export function writePdf(pages: PdfText[][]): Uint8Array {
  const esc = (s: string) => latin1(s).replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  const objs: string[] = [];
  const add = (o: string) => {
    objs.push(o);
    return objs.length;
  };
  const catalog = add('');
  const pagesObj = add('');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const pageIds: number[] = [];
  for (const items of pages) {
    const content = items.map(([x, y, t, size]) => `BT /F1 ${size ?? 8} Tf ${x} ${y} Td (${esc(t)}) Tj ET`).join('\n');
    const c = add(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
    pageIds.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${c} 0 R >>`));
  }
  objs[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objs[pagesObj - 1] = `<< /Type /Pages /Kids [${pageIds.map((p) => `${p} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
  return bytes;
}
