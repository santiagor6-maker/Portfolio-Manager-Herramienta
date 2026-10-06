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
    for (const it of l.items) {
      const gap = it.x - prevEnd;
      const s = it.str.trim();
      if (cur && gap > 12) {
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

export async function extractPdf(bytes: Uint8Array, pdfjsModule?: unknown): Promise<PdfDocument> {
  const pdfjs = (pdfjsModule as PdfJsLike | undefined) ?? (await loadPdfJs());
  const doc = await pdfjs.getDocument({
    data: bytes.slice(), // pdf.js may transfer/detach the buffer
    isEvalSupported: false,
    useSystemFonts: false,
    disableFontFace: true,
    verbosity: 0,
  }).promise;
  const lines: PdfLine[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    const items: PdfItem[] = [];
    for (const raw of content.items) {
      const it = raw as { str?: string; transform?: number[]; width?: number };
      if (typeof it.str !== 'string' || !it.transform) continue;
      items.push({ x: it.transform[4]!, y: it.transform[5]!, w: it.width ?? 0, str: it.str });
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
