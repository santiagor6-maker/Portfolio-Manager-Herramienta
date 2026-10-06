/**
 * File → RawTable[]: file-kind sniffing, CSV (delimiter sniffing, line numbers), XLSX (read-excel-file,
 * browser-safe "universal" build) and HTML tables disguised as .xls (common in Brazilian bank exports).
 */
import Papa from 'papaparse';
import readXlsxFile from 'read-excel-file/universal';
import { decodeBytes, toUint8Array, type TextEncodingName } from './decode';
import { parseXls } from './xls';
import type { Cell, FileKind, ImportData, RawTable } from './types';
import { cellToString } from './util';

export interface ReadResult {
  kind: FileKind;
  tables: RawTable[];
  encoding?: TextEncodingName;
  delimiter?: string;
  /** Decoded text for text formats (CSV/HTML/JSON). */
  text?: string;
  /** Raw bytes (PDF). */
  bytes?: Uint8Array;
  error?: { code: string; detail?: string };
}

export async function toBytesOrText(data: ImportData): Promise<Uint8Array | string> {
  if (typeof data === 'string') return data;
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (typeof (data as { arrayBuffer?: unknown }).arrayBuffer === 'function') {
    return new Uint8Array(await (data as { arrayBuffer(): Promise<ArrayBuffer> }).arrayBuffer());
  }
  return toUint8Array(data as unknown as ArrayBuffer);
}

export function sniffKind(bytes: Uint8Array | string, fileName?: string): FileKind {
  if (typeof bytes !== 'string') {
    if (bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) return 'xlsx';
    if (bytes.length >= 8 && bytes[0] === 0xd0 && bytes[1] === 0xcf && bytes[2] === 0x11 && bytes[3] === 0xe0) return 'xls';
    // %PDF (allow a few junk bytes before the header, as PDF readers do)
    const head = String.fromCharCode(...bytes.subarray(0, Math.min(1024, bytes.length)));
    if (head.includes('%PDF-')) return 'pdf';
  } else if (bytes.trimStart().startsWith('%PDF-')) return 'pdf';
  const head = (typeof bytes === 'string' ? bytes.slice(0, 2048) : decodeBytes(bytes.subarray(0, 2048)).text)
    .replace(/^﻿/, '')
    .trimStart()
    .toLowerCase();
  if (!head) return 'unknown';
  if (head.startsWith('{') || head.startsWith('[')) return 'json';
  if (head.startsWith('<!doctype html') || head.startsWith('<html') || head.startsWith('<table') || /<table[\s>]/.test(head)) return 'html';
  if (fileName && /\.xlsx$/i.test(fileName)) return 'unknown';
  return 'csv';
}

const DELIMS = [',', ';', '\t', '|'] as const;

/** Count delimiters outside quotes in one line. */
function countOutsideQuotes(line: string, d: string): number {
  let n = 0;
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') q = !q;
    else if (!q && c === d) n++;
  }
  return n;
}

/** Pick the delimiter whose per-line count is most consistent across the first lines. */
export function sniffDelimiter(text: string): string {
  const lines = text.split(/\r\n|\n|\r/).filter((l) => l.trim() !== '').slice(0, 40);
  let best: string = ',';
  let bestScore = -1;
  for (const d of DELIMS) {
    const counts = lines.map((l) => countOutsideQuotes(l, d));
    const freq = new Map<number, number>();
    for (const c of counts) if (c > 0) freq.set(c, (freq.get(c) ?? 0) + 1);
    let modeFreq = 0;
    let mode = 0;
    for (const [c, f] of freq) if (f > modeFreq || (f === modeFreq && c > mode)) [mode, modeFreq] = [c, f];
    // Lines that contain the delimiter at all (multi-section files such as IBKR have varying counts).
    const present = counts.filter((c) => c > 0).length;
    const score = modeFreq * 2 + present + (d === '\t' ? 0.5 : 0);
    if (score > bestScore) {
      bestScore = score;
      best = d;
    }
  }
  return best;
}

export function parseCsvText(text: string, name = 'csv', delimiter?: string): { table: RawTable; delimiter: string } {
  const clean = text.replace(/^﻿/, '');
  // Excel "sep=;" hint line
  let body = clean;
  let lineOffset = 0;
  let delim = delimiter;
  const sep = /^sep=(.)\r?\n/i.exec(body);
  if (sep) {
    delim = delim ?? sep[1]!;
    body = body.slice(sep[0].length);
    lineOffset = 1;
  }
  delim = delim ?? sniffDelimiter(body);
  const parsed = Papa.parse<string[]>(body, { delimiter: delim, skipEmptyLines: false, quoteChar: '"' });
  const rows: Cell[][] = [];
  const lines: number[] = [];
  let line = 1 + lineOffset;
  for (const r of parsed.data) {
    const fields = Array.isArray(r) ? r : [];
    const embeddedNewlines = fields.reduce((n, f) => n + ((f ?? '').match(/\r\n|\n|\r/g)?.length ?? 0), 0);
    if (!(fields.length === 1 && (fields[0] ?? '').trim() === '') && fields.length > 0) {
      rows.push(fields.map((f) => (f ?? '').replace(/ /g, ' ').trim()));
      lines.push(line);
    }
    line += 1 + embeddedNewlines;
  }
  return { table: { name, rows, lines }, delimiter: delim };
}

function decodeEntities(s: string): string {
  return s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * HTML table reader (no DOM needed, works in workers and Node). Handles nested tables (each becomes
 * its own table; a cell holding a nested table contributes no text) and expands `colspan`.
 */
export function parseHtmlTables(html: string): RawTable[] {
  type T = { rows: Cell[][]; lines: number[]; row?: Cell[]; cell?: string; span: number; rowNo: number };
  const done: T[] = [];
  const stack: T[] = [];
  const re = /<\/?(table|tr|td|th)\b[^>]*>|<br\s*\/?>|<!--[\s\S]*?-->|<[^>]+>|[^<]+/gi;
  let m: RegExpExecArray | null;
  const closeCell = (t: T) => {
    if (t.row && t.cell !== undefined) {
      t.row.push(decodeEntities(t.cell));
      for (let i = 1; i < t.span; i++) t.row.push('');
    }
    t.cell = undefined;
  };
  const closeRow = (t: T) => {
    closeCell(t);
    if (t.row) {
      t.rowNo++;
      if (t.row.some((c) => c !== '')) {
        t.rows.push(t.row);
        t.lines.push(t.rowNo);
      }
    }
    t.row = undefined;
  };
  while ((m = re.exec(html))) {
    const tok = m[0];
    const tag = m[1]?.toLowerCase();
    const closing = tok.startsWith('</');
    const top = stack[stack.length - 1];
    if (tag === 'table') {
      if (!closing) stack.push({ rows: [], lines: [], span: 1, rowNo: 0 });
      else if (top) {
        closeRow(top);
        done.push(stack.pop()!);
      }
    } else if (tag === 'tr' && top) {
      closeRow(top);
      if (!closing) top.row = [];
    } else if ((tag === 'td' || tag === 'th') && top) {
      closeCell(top);
      if (!closing) {
        if (!top.row) top.row = [];
        top.cell = '';
        const span = /colspan\s*=\s*["']?(\d+)/i.exec(tok);
        top.span = span ? Math.max(1, Math.min(50, Number(span[1]))) : 1;
      }
    } else if (/^<br/i.test(tok)) {
      if (top && top.cell !== undefined) top.cell += ' ';
    } else if (!tok.startsWith('<') && top && top.cell !== undefined) top.cell += tok;
  }
  while (stack.length) {
    const t = stack.pop()!;
    closeRow(t);
    done.push(t);
  }
  return done.filter((t) => t.rows.length).map((t, i) => ({ name: `tabla ${i + 1}`, rows: t.rows, lines: t.lines }));
}

export async function parseXlsx(bytes: Uint8Array): Promise<RawTable[]> {
  const buf = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength ? bytes.buffer : bytes.slice().buffer;
  const sheets = await readXlsxFile(buf as ArrayBuffer, { trim: true });
  return sheets.map((s) => {
    const rows: Cell[][] = [];
    const lines: number[] = [];
    s.data.forEach((r, i) => {
      const row = r.map((c) => (c === undefined ? null : (c as unknown as Cell)));
      if (row.some((c) => cellToString(c) !== '')) {
        rows.push(row);
        lines.push(i + 1);
      }
    });
    return { name: s.sheet, rows, lines };
  });
}

export async function readTables(data: ImportData, fileName?: string, encoding?: string): Promise<ReadResult> {
  const input = await toBytesOrText(data);
  const kind = sniffKind(input, fileName);
  if (kind === 'pdf') return { kind, tables: [], bytes: typeof input === 'string' ? new TextEncoder().encode(input) : input };
  if (kind === 'xls') {
    if (typeof input === 'string') return { kind, tables: [], error: { code: 'FILE_UNSUPPORTED' } };
    try {
      return { kind, tables: parseXls(input) };
    } catch (e) {
      return { kind, tables: [], error: { code: 'FILE_XLS_LEGACY', detail: e instanceof Error ? e.message : String(e) } };
    }
  }
  if (kind === 'xlsx') {
    if (typeof input === 'string') return { kind, tables: [], error: { code: 'FILE_UNSUPPORTED' } };
    try {
      return { kind, tables: await parseXlsx(input) };
    } catch (e) {
      return { kind, tables: [], error: { code: 'XLSX_READ_ERROR', detail: e instanceof Error ? e.message : String(e) } };
    }
  }
  const decoded = typeof input === 'string' ? { text: input, encoding: 'utf-8' as const } : decodeBytes(input, encoding);
  const text = decoded.text.replace(/^﻿/, '');
  if (kind === 'unknown') return { kind, tables: [], encoding: decoded.encoding, text, error: { code: 'FILE_UNSUPPORTED' } };
  if (kind === 'json') return { kind, tables: [], encoding: decoded.encoding, text };
  if (kind === 'html') return { kind, tables: parseHtmlTables(text), encoding: decoded.encoding, text };
  const { table, delimiter } = parseCsvText(text, fileName ?? 'csv');
  return { kind: 'csv', tables: [table], encoding: decoded.encoding, delimiter, text };
}
