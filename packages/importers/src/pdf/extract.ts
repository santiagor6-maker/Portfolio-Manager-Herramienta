/**
 * PDF text extraction with pdf.js (pdfjs-dist), browser- and Node-safe:
 * positioned text items → lines (grouped by baseline) → cells (split by horizontal gaps).
 * In the browser set `GlobalWorkerOptions.workerSrc` (or pass a configured pdf.js module as
 * `options.pdfjs`); in Node the legacy build runs with its built-in fake worker.
 */
import { findHeaderRow, headerRowScore } from '../mapping';
import type { Cell, RawTable } from '../types';

export interface PdfItem {
  x: number;
  y: number;
  w: number;
  str: string;
  /** Font size (from the text matrix), when known. */
  size?: number;
}

export interface PdfLine {
  page: number;
  y: number;
  items: PdfItem[];
  /** Items joined with single spaces (two+ spaces where there is a column gap). */
  text: string;
  /** Items merged into cells separated by large gaps. */
  cells: string[];
  /** Left / right x of each cell. */
  cellX: [number, number][];
}

export interface PdfDocument {
  pageCount: number;
  lines: PdfLine[];
  /** Whole text, lines joined with \n. */
  text: string;
}

interface PdfJsLike {
  getDocument(src: unknown): { promise: Promise<PdfDocProxy> };
}
interface PdfDocProxy {
  numPages: number;
  getPage(n: number): Promise<{ getTextContent(): Promise<{ items: unknown[] }> }>;
  destroy?(): Promise<void>;
}

let cached: Promise<PdfJsLike> | undefined;
async function loadPdfJs(): Promise<PdfJsLike> {
  // Literal specifier so bundlers (Vite) can resolve it; the legacy build also works in Node.
  cached ??= import('pdfjs-dist/legacy/build/pdf.mjs') as unknown as Promise<PdfJsLike>;
  return cached;
}

/** Group text items into lines and cells. Exported for tests and custom parsers. */
export function itemsToLines(page: number, items: PdfItem[]): PdfLine[] {
  const sorted = items.filter((i) => i.str.trim() !== '').sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: PdfLine[] = [];
  for (const it of sorted) {
    const line = lines.find((l) => Math.abs(l.y - it.y) <= 2.5);
    if (line) line.items.push(it);
    else lines.push({ page, y: it.y, items: [it], text: '', cells: [], cellX: [] });
  }
  for (const l of lines) {
    l.items.sort((a, b) => a.x - b.x);
    const cells: string[] = [];
    const cellX: [number, number][] = [];
    let text = '';
    let prevEnd = -Infinity;
    let cur = '';
    let curX = 0;
    // Column gap relative to the font size: small fonts (6-7 pt statements) sit in tight columns.
    const sizes = l.items.map((i) => i.size).filter((x): x is number => !!x && x > 0);
    const size = sizes.length ? sizes.reduce((a, b) => a + b, 0) / sizes.length : 8;
    const colGap = Math.max(4, Math.min(12, size * 1.5));
    for (const it of l.items) {
      const gap = it.x - prevEnd;
      const s = it.str.trim();
      if (cur && gap > colGap) {
        cells.push(cur);
        cellX.push([curX, prevEnd]);
        cur = s;
        curX = it.x;
        text += `  ${s}`;
      } else {
        if (!cur) curX = it.x;
        cur = cur ? (gap > 1 ? `${cur} ${s}` : `${cur}${s}`) : s;
        text += text ? (gap > 1 ? ` ${s}` : s) : s;
      }
      prevEnd = it.x + it.w;
    }
    if (cur) {
      cells.push(cur);
      cellX.push([curX, prevEnd]);
    }
    l.cells = cells;
    l.cellX = cellX;
    l.text = text;
  }
  return lines.sort((a, b) => b.y - a.y);
}

/** Thrown when the PDF is encrypted and the password is missing (`reason: 'required'`) or wrong. */
export class PdfPasswordError extends Error {
  constructor(readonly reason: 'required' | 'incorrect') {
    super(reason === 'required' ? 'PDF protected with a password' : 'Incorrect PDF password');
    this.name = 'PdfPasswordError';
  }
}

/** A resource limit was hit (I42): too many pages, too much decompressed data, or too slow. */
export class PdfLimitError extends Error {
  constructor(readonly reason: 'pages' | 'inflated' | 'time', readonly limit: number) {
    super(`PDF limit exceeded: ${reason} (${limit})`);
    this.name = 'PdfLimitError';
  }
}

export interface PdfLimits {
  maxPdfPages?: number;
  maxPdfInflatedBytes?: number;
  pdfTimeoutMs?: number;
}

const DEFAULT_LIMITS = { maxPdfPages: 500, maxPdfInflatedBytes: 200 * 1024 * 1024, pdfTimeoutMs: 60_000 };

/**
 * Zip-bomb guard: inflate every FlateDecode stream with a streaming decompressor and stop as soon as the
 * total exceeds `max` (nothing is kept in memory). Encrypted or broken streams are skipped (pdf.js
 * still has the page and time limits). Uses DecompressionStream (browsers, Node ≥ 18).
 */
export async function pdfInflatedSize(bytes: Uint8Array, max: number): Promise<number> {
  const DS = (globalThis as { DecompressionStream?: new (f: string) => TransformStream<Uint8Array, Uint8Array> }).DecompressionStream;
  if (!DS) return 0;
  let text = '';
  for (let i = 0; i < bytes.length; i += 65536) text += String.fromCharCode(...bytes.subarray(i, i + 65536));
  let total = 0;
  const re = /<<((?:(?!>>\s*stream)[\s\S]){0,2000})>>\s*stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (!/FlateDecode/.test(m[1]!)) continue;
    const start = m.index + m[0].length;
    const end = text.indexOf('endstream', start);
    if (end < 0) break;
    re.lastIndex = end;
    const chunk = bytes.subarray(start, end);
    try {
      const reader = new Blob([new Uint8Array(chunk)]).stream().pipeThrough(new DS('deflate')).getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > max) {
          await reader.cancel();
          return total;
        }
      }
    } catch {
      // encrypted / truncated stream: not measurable here
    }
  }
  return total;
}

export async function extractPdf(bytes: Uint8Array, pdfjsModule?: unknown, password?: string, limits: PdfLimits = {}): Promise<PdfDocument> {
  const lim = { ...DEFAULT_LIMITS, ...limits };
  const started = Date.now();
  if ((await pdfInflatedSize(bytes, lim.maxPdfInflatedBytes)) > lim.maxPdfInflatedBytes) throw new PdfLimitError('inflated', lim.maxPdfInflatedBytes);
  const pdfjs = (pdfjsModule as PdfJsLike | undefined) ?? (await loadPdfJs());
  const params: Record<string, unknown> = {
    data: bytes.slice(), // pdf.js may transfer/detach the buffer
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
    verbosity: 0,
  };
  if (password) params.password = password;
  let doc: PdfDocProxy;
  try {
    doc = await pdfjs.getDocument(params).promise;
  } catch (e) {
    const err = e as { name?: string; code?: number };
    // pdf.js PasswordException: code 1 = NEED_PASSWORD, 2 = INCORRECT_PASSWORD.
    if (err?.name === 'PasswordException') throw new PdfPasswordError(err.code === 2 ? 'incorrect' : 'required');
    throw e;
  }
  if (doc.numPages > lim.maxPdfPages) {
    await doc.destroy?.();
    throw new PdfLimitError('pages', lim.maxPdfPages);
  }
  const lines: PdfLine[] = [];
  const deadline = started + lim.pdfTimeoutMs;
  const withDeadline = <T>(p: Promise<T>): Promise<T> => {
    const left = deadline - Date.now();
    if (left <= 0) return Promise.reject(new PdfLimitError('time', lim.pdfTimeoutMs));
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      p,
      new Promise<T>((_, rej) => {
        timer = setTimeout(() => rej(new PdfLimitError('time', lim.pdfTimeoutMs)), left);
      }),
    ]).finally(() => clearTimeout(timer));
  };
  for (let p = 1; p <= doc.numPages; p++) {
    let content: { items: unknown[] };
    try {
      const page = await withDeadline(doc.getPage(p));
      content = await withDeadline(page.getTextContent());
    } catch (e) {
      await doc.destroy?.();
      throw e;
    }
    const items: PdfItem[] = [];
    for (const raw of content.items) {
      const it = raw as { str?: string; transform?: number[]; width?: number };
      if (typeof it.str !== 'string' || !it.transform) continue;
      const size = Math.hypot(it.transform[2]!, it.transform[3]!);
      items.push({ x: it.transform[4]!, y: it.transform[5]!, w: it.width ?? 0, str: it.str, ...(size > 0 ? { size } : {}) });
    }
    lines.push(...itemsToLines(p, items));
  }
  await doc.destroy?.();
  return { pageCount: doc.numPages, lines, text: lines.map((l) => l.text).join('\n') };
}

/**
 * Table view of a PDF: one row per line. When a header line is found (≥ 3 known column names), the
 * following lines are aligned to the header's columns by horizontal overlap, so empty cells keep
 * their position. Line numbers are 1-based over the document.
 */
export function pdfToTable(doc: PdfDocument, name = 'pdf'): RawTable {
  const raw: RawTable = { name, rows: doc.lines.map((l) => l.cells), lines: doc.lines.map((_, i) => i + 1) };
  const h = findHeaderRow(raw, doc.lines.length);
  if (headerRowScore(raw.rows[h] ?? []) < 2.5) return raw;
  const header = doc.lines[h]!;
  const cols = header.cellX;
  const rows: Cell[][] = raw.rows.map((r, i) => {
    if (i <= h) return r;
    const line = doc.lines[i]!;
    const out: Cell[] = cols.map(() => '');
    line.cells.forEach((c, k) => {
      const [x0, x1] = line.cellX[k]!;
      let best = -1;
      let bestScore = -Infinity;
      cols.forEach(([h0, h1], j) => {
        const overlap = Math.min(x1, h1) - Math.max(x0, h0);
        const dist = -Math.abs((x0 + x1) / 2 - (h0 + h1) / 2);
        const score = overlap > 0 ? 1000 + overlap : dist;
        if (score > bestScore) [best, bestScore] = [j, score];
      });
      if (best >= 0) out[best] = out[best] ? `${out[best]} ${c}` : c;
    });
    return out;
  });
  return { name, rows, lines: raw.lines };
}
