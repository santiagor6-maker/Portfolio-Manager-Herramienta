import type { CsvCell } from './csv';

/**
 * Minimal dependency-free XLSX reader (T44): ZIP central directory + "deflate-raw" through the
 * platform DecompressionStream (browsers and Node >= 18), shared strings and inline strings.
 * Enough to read official spreadsheets (B3 Área do Investidor, DIAN exógena) — not a general parser.
 */
export interface ReadSheet {
  name: string;
  rows: CsvCell[][];
}

const dec = new TextDecoder();

async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const DS = (globalThis as { DecompressionStream?: new (f: string) => TransformStream<Uint8Array, Uint8Array> }).DecompressionStream;
  if (!DS) throw new Error('DecompressionStream not available: cannot read compressed XLSX in this runtime');
  const stream = new Blob([new Uint8Array(data)]).stream().pipeThrough(new DS('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function unzip(bytes: Uint8Array): Promise<Map<string, Uint8Array>> {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Not a ZIP/XLSX file');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const out = new Map<string, Uint8Array>();
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('Corrupt ZIP central directory');
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const local = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    const lNameLen = dv.getUint16(local + 26, true);
    const lExtraLen = dv.getUint16(local + 28, true);
    const start = local + 30 + lNameLen + lExtraLen;
    const raw = bytes.subarray(start, start + csize);
    if (method === 0) out.set(name, raw);
    else if (method === 8) out.set(name, await inflateRaw(raw));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const unescapeXml = (s: string) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&');

const textOf = (xml: string) => unescapeXml([...xml.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((m) => m[1]).join(''));

function colIndex(ref: string): number {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

export async function readXlsx(bytes: Uint8Array): Promise<ReadSheet[]> {
  const files = await unzip(bytes);
  const get = (n: string) => {
    const f = files.get(n);
    return f ? dec.decode(f) : undefined;
  };
  const shared = [...(get('xl/sharedStrings.xml') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]!));
  const wb = get('xl/workbook.xml') ?? '';
  const rels = get('xl/_rels/workbook.xml.rels') ?? '';
  const target = new Map([...rels.matchAll(/<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)].map((m) => [m[1]!, m[2]!]));
  const sheets: ReadSheet[] = [];
  for (const m of wb.matchAll(/<sheet\b[^>]*name="([^"]*)"[^>]*r:id="([^"]+)"/g)) {
    const t = target.get(m[2]!) ?? '';
    const path = t.startsWith('/') ? t.slice(1) : `xl/${t.replace(/^\.\//, '')}`;
    const xml = get(path) ?? '';
    const rows: CsvCell[][] = [];
    for (const r of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const row: CsvCell[] = [];
      for (const c of (r[1] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = c[1] ?? '';
        const body = c[2] ?? '';
        const ref = /r="([A-Z]+\d+)"/.exec(attrs)?.[1] ?? '';
        const type = /t="([^"]+)"/.exec(attrs)?.[1];
        const v = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
        let value: CsvCell = '';
        if (type === 's') value = shared[Number(v)] ?? '';
        else if (type === 'inlineStr') value = textOf(body);
        else if (type === 'str') value = unescapeXml(v ?? '');
        else if (type === 'b') value = v === '1';
        else if (v !== undefined) value = Number(v);
        row[ref ? colIndex(ref) : row.length] = value;
      }
      rows.push(Array.from(row, (x) => x ?? ''));
    }
    sheets.push({ name: unescapeXml(m[1]!), rows });
  }
  return sheets;
}
