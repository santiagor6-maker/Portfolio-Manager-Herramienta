/**
 * Minimal legacy Excel 97-2003 (.xls, BIFF8) reader — browser-safe, no dependencies.
 * Reads the Compound File (CFB) container, the "Workbook" stream and, per sheet, the cell
 * records LABELSST, LABEL, NUMBER, RK, MULRK, BOOLERR and FORMULA (cached results). Numbers with a
 * date number-format become Date cells. Enough for bank/broker exports (no formatting, no charts).
 */
import type { Cell, RawTable } from './types';
import { cellToString } from './util';

const END = 0xfffffffe;
const FREE = 0xffffffff;

function u16(b: Uint8Array, o: number): number {
  return b[o]! | (b[o + 1]! << 8);
}
function u32(b: Uint8Array, o: number): number {
  return (b[o]! | (b[o + 1]! << 8) | (b[o + 2]! << 16) | (b[o + 3]! << 24)) >>> 0;
}
function f64(b: Uint8Array, o: number): number {
  return new DataView(b.buffer, b.byteOffset + o, 8).getFloat64(0, true);
}

export function isCfb(bytes: Uint8Array): boolean {
  const sig = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];
  return bytes.length >= 512 && sig.every((v, i) => bytes[i] === v);
}

/** Extract a named stream from a Compound File Binary container. */
export function readCfbStream(bytes: Uint8Array, names: string[]): Uint8Array | undefined {
  const sectorSize = 1 << u16(bytes, 0x1e);
  const miniSize = 1 << u16(bytes, 0x20);
  const firstDir = u32(bytes, 0x30);
  const cutoff = u32(bytes, 0x38);
  const firstMiniFat = u32(bytes, 0x3c);
  const firstDifat = u32(bytes, 0x44);
  const nDifat = u32(bytes, 0x48);
  const sector = (n: number) => bytes.subarray((n + 1) * sectorSize, (n + 2) * sectorSize);
  // FAT sector list from the header DIFAT (+ DIFAT chain).
  const fatSectors: number[] = [];
  for (let i = 0; i < 109; i++) {
    const s = u32(bytes, 0x4c + i * 4);
    if (s !== FREE && s !== END) fatSectors.push(s);
  }
  let d = firstDifat;
  for (let k = 0; k < nDifat && d !== END && d !== FREE; k++) {
    const sec = sector(d);
    for (let i = 0; i < sectorSize / 4 - 1; i++) {
      const s = u32(sec, i * 4);
      if (s !== FREE && s !== END) fatSectors.push(s);
    }
    d = u32(sec, sectorSize - 4);
  }
  const fat: number[] = [];
  for (const fs of fatSectors) {
    const sec = sector(fs);
    for (let i = 0; i < sectorSize / 4; i++) fat.push(u32(sec, i * 4));
  }
  const chain = (start: number, table: number[]): number[] => {
    const out: number[] = [];
    let s = start;
    const seen = new Set<number>();
    while (s !== END && s !== FREE && s < table.length && !seen.has(s)) {
      seen.add(s);
      out.push(s);
      s = table[s]!;
    }
    return out;
  };
  const readChain = (start: number, size: number): Uint8Array => {
    const secs = chain(start, fat);
    const out = new Uint8Array(secs.length * sectorSize);
    secs.forEach((s, i) => out.set(sector(s), i * sectorSize));
    return out.subarray(0, size);
  };
  const dirBytes = readChain(firstDir, chain(firstDir, fat).length * sectorSize);
  type Entry = { name: string; type: number; start: number; size: number };
  const entries: Entry[] = [];
  for (let o = 0; o + 128 <= dirBytes.length; o += 128) {
    const len = u16(dirBytes, o + 0x40);
    let name = '';
    for (let i = 0; i + 2 < len; i += 2) name += String.fromCharCode(u16(dirBytes, o + i));
    entries.push({ name, type: dirBytes[o + 0x42]!, start: u32(dirBytes, o + 0x74), size: u32(dirBytes, o + 0x78) });
  }
  const root = entries.find((e) => e.type === 5);
  const entry = entries.find((e) => e.type === 2 && names.includes(e.name));
  if (!entry) return undefined;
  if (entry.size >= cutoff || !root) return readChain(entry.start, entry.size);
  // Small stream: lives in the mini stream (root entry data), addressed through the MiniFAT.
  const miniStream = readChain(root.start, root.size);
  const miniFatBytes = readChain(firstMiniFat, chain(firstMiniFat, fat).length * sectorSize);
  const miniFat: number[] = [];
  for (let i = 0; i + 4 <= miniFatBytes.length; i += 4) miniFat.push(u32(miniFatBytes, i));
  const secs = chain(entry.start, miniFat);
  const out = new Uint8Array(secs.length * miniSize);
  secs.forEach((s, i) => out.set(miniStream.subarray(s * miniSize, (s + 1) * miniSize), i * miniSize));
  return out.subarray(0, entry.size);
}

function rk(v: number): number {
  let n: number;
  if (v & 2) n = v >> 2;
  else {
    const buf = new DataView(new ArrayBuffer(8));
    buf.setUint32(4, v & 0xfffffffc, true);
    buf.setUint32(0, 0, true);
    n = buf.getFloat64(0, true);
  }
  return v & 1 ? n / 100 : n;
}

/** Read characters of an XLUnicodeString body starting at `o` (flags already consumed). */
function chars(b: Uint8Array, o: number, cch: number, high: boolean): string {
  let s = '';
  if (high) for (let i = 0; i < cch; i++) s += String.fromCharCode(u16(b, o + i * 2));
  else for (let i = 0; i < cch; i++) s += String.fromCharCode(b[o + i]!);
  return s;
}

const BUILTIN_DATE_FORMATS = new Set([14, 15, 16, 17, 18, 19, 20, 21, 22, 45, 46, 47]);

function excelDate(serial: number): Date {
  return new Date(Math.round((serial - 25569) * 86400000));
}

/** Parse the SST across CONTINUE boundaries. `parts` are the SST record body followed by its CONTINUE bodies. */
function parseSst(parts: Uint8Array[]): string[] {
  const out: string[] = [];
  let pi = 0;
  let buf = parts[0]!;
  let o = 8;
  const total = u32(buf, 4);
  const next = () => {
    pi++;
    buf = parts[pi]!;
    o = 0;
  };
  for (let n = 0; n < total; n++) {
    if (o >= buf.length) {
      if (pi + 1 >= parts.length) break;
      next();
    }
    const cch = u16(buf, o);
    let flags = buf[o + 2]!;
    o += 3;
    let runs = 0;
    let ext = 0;
    if (flags & 8) {
      runs = u16(buf, o);
      o += 2;
    }
    if (flags & 4) {
      ext = u32(buf, o);
      o += 4;
    }
    let s = '';
    let left = cch;
    while (left > 0) {
      const high = (flags & 1) === 1;
      const avail = Math.floor((buf.length - o) / (high ? 2 : 1));
      const take = Math.min(left, avail);
      s += chars(buf, o, take, high);
      o += take * (high ? 2 : 1);
      left -= take;
      if (left > 0) {
        if (pi + 1 >= parts.length) break;
        next();
        flags = buf[o]!; // continuation starts with a fresh flags byte
        o += 1;
      }
    }
    let skip = runs * 4 + ext;
    while (skip > 0) {
      const t = Math.min(skip, buf.length - o);
      o += t;
      skip -= t;
      if (skip > 0) {
        if (pi + 1 >= parts.length) break;
        next();
      }
    }
    out.push(s);
  }
  return out;
}

/** Parse a BIFF8 .xls file into raw tables (one per worksheet). */
export function parseXls(bytes: Uint8Array): RawTable[] {
  const wb = readCfbStream(bytes, ['Workbook', 'Book']);
  if (!wb) throw new Error('No Workbook stream');
  type Rec = { type: number; off: number; data: Uint8Array };
  const recs: Rec[] = [];
  for (let o = 0; o + 4 <= wb.length; ) {
    const type = u16(wb, o);
    const len = u16(wb, o + 2);
    recs.push({ type, off: o, data: wb.subarray(o + 4, o + 4 + len) });
    o += 4 + len;
  }
  const sheets: { name: string; pos: number }[] = [];
  let sst: string[] = [];
  const customFormats = new Map<number, string>();
  const xfFormats: number[] = [];
  for (let i = 0; i < recs.length; i++) {
    const r = recs[i]!;
    if (r.type === 0x0085) {
      const cch = r.data[6]!;
      const high = (r.data[7]! & 1) === 1;
      sheets.push({ pos: u32(r.data, 0), name: chars(r.data, 8, cch, high) });
    } else if (r.type === 0x00fc) {
      const parts = [r.data];
      while (recs[i + 1]?.type === 0x003c) parts.push(recs[++i]!.data);
      sst = parseSst(parts);
    } else if (r.type === 0x041e) {
      const cch = u16(r.data, 2);
      customFormats.set(u16(r.data, 0), chars(r.data, 5, cch, (r.data[4]! & 1) === 1));
    } else if (r.type === 0x00e0) {
      xfFormats.push(u16(r.data, 2));
    } else if (r.type === 0x000a) break; // EOF of globals
  }
  const isDateXf = (xf: number) => {
    const fmt = xfFormats[xf];
    if (fmt === undefined) return false;
    if (BUILTIN_DATE_FORMATS.has(fmt)) return true;
    const f = customFormats.get(fmt)?.replace(/"[^"]*"|\[[^\]]*\]/g, '').toLowerCase();
    return !!f && /[dy]/.test(f) && !/^[#0.,%]+$/.test(f);
  };
  const tables: RawTable[] = [];
  for (const sh of sheets) {
    let idx = recs.findIndex((r) => r.off === sh.pos);
    if (idx < 0) continue;
    const grid = new Map<number, Map<number, Cell>>();
    const put = (row: number, col: number, v: Cell) => {
      let m = grid.get(row);
      if (!m) grid.set(row, (m = new Map()));
      m.set(col, v);
    };
    const numberCell = (xf: number, n: number): Cell => (isDateXf(xf) ? excelDate(n) : n);
    let pendingFormula: { row: number; col: number } | undefined;
    for (idx = idx + 1; idx < recs.length; idx++) {
      const { type, data: d } = recs[idx]!;
      if (type === 0x000a) break;
      if (type === 0x00fd) put(u16(d, 0), u16(d, 2), sst[u32(d, 6)] ?? '');
      else if (type === 0x0203) put(u16(d, 0), u16(d, 2), numberCell(u16(d, 4), f64(d, 6)));
      else if (type === 0x027e) put(u16(d, 0), u16(d, 2), numberCell(u16(d, 4), rk(u32(d, 6))));
      else if (type === 0x00bd) {
        const row = u16(d, 0);
        const first = u16(d, 2);
        const n = (d.length - 6) / 6;
        for (let k = 0; k < n; k++) put(row, first + k, numberCell(u16(d, 4 + k * 6), rk(u32(d, 6 + k * 6))));
      } else if (type === 0x0204) {
        const cch = u16(d, 6);
        put(u16(d, 0), u16(d, 2), chars(d, 9, cch, (d[8]! & 1) === 1));
      } else if (type === 0x0205) put(u16(d, 0), u16(d, 2), d[7] ? null : d[6] === 1);
      else if (type === 0x0006) {
        const row = u16(d, 0);
        const col = u16(d, 2);
        if (d[12] === 0xff && d[13] === 0xff) {
          if (d[6] === 0) pendingFormula = { row, col };
          else if (d[6] === 1) put(row, col, d[8] === 1);
        } else put(row, col, numberCell(u16(d, 4), f64(d, 6)));
      } else if (type === 0x0207 && pendingFormula) {
        const cch = u16(d, 0);
        put(pendingFormula.row, pendingFormula.col, chars(d, 3, cch, (d[2]! & 1) === 1));
        pendingFormula = undefined;
      }
    }
    const rowNums = [...grid.keys()].sort((a, b) => a - b);
    const rows: Cell[][] = [];
    const lines: number[] = [];
    for (const r of rowNums) {
      const m = grid.get(r)!;
      const width = Math.max(...m.keys()) + 1;
      const row: Cell[] = Array.from({ length: width }, (_, c) => m.get(c) ?? null);
      if (row.some((c) => cellToString(c) !== '')) {
        rows.push(row);
        lines.push(r + 1);
      }
    }
    tables.push({ name: sh.name, rows, lines });
  }
  return tables;
}
