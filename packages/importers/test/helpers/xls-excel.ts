/**
 * "Saved by Excel" .xls (BIFF8) writer for realistic fixtures (I31). Unlike the minimal writer
 * (xls-writer.ts), it reproduces what Excel 97-2016 actually writes, which is what breaks naive readers:
 *
 *  Container (CFB):
 *   - "\x05SummaryInformation" and "\x05DocumentSummaryInformation" streams next to "Workbook", in the
 *     mini stream (MiniFAT), with the directory as a red-black tree (siblings, not a flat list);
 *   - the Workbook chain FRAGMENTED: its sectors are interleaved with the directory, MiniFAT and
 *     mini-stream sectors, and the FAT sector sits at the end of the file.
 *  Workbook globals:
 *   - INTERFACEHDR, WRITEACCESS, CODEPAGE 1200, WINDOW1, DATEMODE (1900 or 1904), FONT ×5, custom
 *     FORMAT records (dd/mm/yyyy;@ …), 15 style XFs + cell XFs, STYLE, BOUNDSHEET with a hidden sheet;
 *   - an SST larger than 8 224 bytes, split over CONTINUE records in the middle of a string, with the
 *     character width changing at the split (compressed ↔ UTF-16), rich-text runs and phonetic data;
 *   - EXTSST.
 *  Worksheets:
 *   - INDEX, DIMENSIONS, ROW blocks with DBCELL, WINDOW2, MERGEDCELLS for a merged title;
 *   - cells as LABELSST, LABEL, RSTRING, NUMBER, RK (integer and ×100 forms), MULRK, BLANK, MULBLANK,
 *     BOOLERR (#N/A), FORMULA with cached numbers and FORMULA + STRING for text results.
 */
export type ExcelCell =
  | null
  | string
  | number
  | Date
  | { rich: string } // RSTRING-like rich text kept in the SST with formatting runs
  | { label: string } // inline LABEL record (old writers / some bank exporters)
  | { formula: number } // cached numeric formula result
  | { formulaText: string } // formula returning text (FORMULA + STRING)
  | { error: true }; // #N/A

export interface ExcelSheet {
  name: string;
  rows: ExcelCell[][];
  hidden?: boolean;
  /** Merge A1 across the first N columns (title row). */
  mergeTitle?: number;
}

class Buf {
  bytes: number[] = [];
  get length() {
    return this.bytes.length;
  }
  u8(v: number) {
    this.bytes.push(v & 0xff);
    return this;
  }
  u16(v: number) {
    return this.u8(v).u8(v >> 8);
  }
  u32(v: number) {
    return this.u16(v & 0xffff).u16(v >>> 16);
  }
  f64(v: number) {
    const dv = new DataView(new ArrayBuffer(8));
    dv.setFloat64(0, v, true);
    for (let i = 0; i < 8; i++) this.u8(dv.getUint8(i));
    return this;
  }
  raw(b: number[]) {
    for (const x of b) this.u8(x);
    return this;
  }
  /** XLUnicodeString: cch u16, flags, chars. */
  xstr(s: string) {
    const high = [...s].some((c) => c.charCodeAt(0) > 0xff);
    this.u16(s.length).u8(high ? 1 : 0);
    for (const ch of s) high ? this.u16(ch.charCodeAt(0)) : this.u8(ch.charCodeAt(0));
    return this;
  }
  /** ShortXLUnicodeString: cch u8, flags, chars. */
  sxstr(s: string) {
    this.u8(s.length).u8(0);
    for (const ch of s) this.u8(ch.charCodeAt(0));
    return this;
  }
}

const rec = (out: Buf, type: number, body: Buf | number[]) => {
  const b = Array.isArray(body) ? body : body.bytes;
  out.u16(type).u16(b.length).raw(b);
};

const bof = (dt: number) => new Buf().u16(0x0600).u16(dt).u16(0x2dd3).u16(0x07cd).u32(0x000100c1).u32(0x00000606);

/** Excel serial date (1900 system with the 1900-02-29 bug, or 1904). */
function serial(d: Date, date1904: boolean): number {
  return d.getTime() / 86400000 + 25569 - (date1904 ? 1462 : 0);
}

/** RK value: integer form, or ×100 integer form, else undefined (NUMBER needed). */
function toRk(v: number): number | undefined {
  if (Number.isInteger(v) && Math.abs(v) < 2 ** 29) return ((v << 2) | 2) >>> 0;
  const c = Math.round(v * 100);
  if (Math.abs(c - v * 100) < 1e-9 && Math.abs(c) < 2 ** 29) return ((c << 2) | 3) >>> 0;
  return undefined;
}

interface SstString {
  text: string;
  runs?: [number, number][];
  ext?: number[];
}

/** SST + CONTINUE records, splitting strings at the 8 224-byte limit like Excel (with a new flags byte). */
function sstRecords(strings: SstString[], total: number): Buf {
  const LIMIT = 8224;
  const parts: Buf[] = [new Buf().u32(total).u32(strings.length)];
  let cur = parts[0]!;
  const fresh = () => {
    cur = new Buf();
    parts.push(cur);
  };
  for (const s of strings) {
    const chars = [...s.text].map((c) => c.charCodeAt(0));
    let high = chars.some((c) => c > 0xff);
    const header = 3 + (s.runs ? 2 : 0) + (s.ext ? 4 : 0);
    if (cur.length + header + (high ? 2 : 1) > LIMIT) fresh();
    cur.u16(chars.length).u8((high ? 1 : 0) | (s.runs ? 8 : 0) | (s.ext ? 4 : 0));
    if (s.runs) cur.u16(s.runs.length);
    if (s.ext) cur.u32(s.ext.length);
    let i = 0;
    while (i < chars.length) {
      const avail = Math.floor((LIMIT - cur.length) / (high ? 2 : 1));
      if (avail <= 0) {
        fresh();
        // The continuation decides its own width: compressed when the rest fits in Latin-1.
        high = chars.slice(i).some((c) => c > 0xff);
        cur.u8(high ? 1 : 0);
        continue;
      }
      const take = Math.min(avail, chars.length - i);
      for (let k = 0; k < take; k++) high ? cur.u16(chars[i + k]!) : cur.u8(chars[i + k]!);
      i += take;
    }
    const tail: number[] = [];
    for (const [ich, ifnt] of s.runs ?? []) tail.push(ich & 0xff, ich >> 8, ifnt & 0xff, ifnt >> 8);
    tail.push(...(s.ext ?? []));
    for (let k = 0; k < tail.length; k += 4) {
      if (cur.length + 4 > LIMIT) fresh();
      cur.raw(tail.slice(k, k + 4));
    }
  }
  const out = new Buf();
  parts.forEach((p, k) => rec(out, k === 0 ? 0x00fc : 0x003c, p));
  return out;
}

const XF_GENERAL = 15;
const XF_DATE = 16; // custom 164 dd/mm/yyyy;@
const XF_NUM = 17; // builtin 4 #,##0.00
const XF_MONEY = 18; // custom 165 "$" #,##0.00
const XF_DATE_BUILTIN = 19; // builtin 14

function globals(sheets: ExcelSheet[], sst: SstString[], sstTotal: number, date1904: boolean, filepass: boolean): { buf: Buf; boundPos: number[] } {
  const g = new Buf();
  rec(g, 0x0809, bof(0x0005));
  // "Password to open": FILEPASS (RC4 CryptoAPI header stub) right after the BOF, as Excel writes it.
  if (filepass) rec(g, 0x002f, new Buf().u16(1).u16(4).u16(2).raw(new Array(48).fill(0x11)));
  rec(g, 0x00e1, new Buf().u16(1200));
  rec(g, 0x00c1, [0, 0]);
  rec(g, 0x00e2, []);
  const user = new Buf().xstr('Usuario Corredor');
  while (user.length < 112) user.u8(0x20);
  rec(g, 0x005c, user);
  rec(g, 0x0042, new Buf().u16(1200));
  rec(g, 0x0161, new Buf().u16(0));
  rec(g, 0x013d, new Buf().raw(sheets.flatMap((_, i) => [i + 1, 0])));
  rec(g, 0x009c, new Buf().u16(14));
  rec(g, 0x0019, new Buf().u16(0));
  rec(g, 0x0012, new Buf().u16(0));
  rec(g, 0x0013, new Buf().u16(0));
  rec(g, 0x01af, new Buf().u16(0));
  rec(g, 0x01bc, new Buf().u16(0));
  rec(g, 0x003d, new Buf().u16(0x0168).u16(0x001e).u16(0x3c00).u16(0x2a00).u16(0x0038).u16(0).u16(0).u16(1).u16(0x0258));
  rec(g, 0x0040, new Buf().u16(0));
  rec(g, 0x008d, new Buf().u16(0));
  rec(g, 0x0022, new Buf().u16(date1904 ? 1 : 0));
  rec(g, 0x000e, new Buf().u16(1));
  rec(g, 0x01b7, new Buf().u16(0));
  rec(g, 0x00da, new Buf().u16(0));
  for (const [name, bold] of [['Arial', false], ['Arial', false], ['Arial', false], ['Arial', false], ['Calibri', true]] as const) {
    rec(g, 0x0031, new Buf().u16(200).u16(0).u16(0x7fff).u16(bold ? 700 : 400).u16(0).u8(0).u8(2).u8(0).u8(0).sxstr(name));
  }
  const fmt = (id: number, code: string) => rec(g, 0x041e, new Buf().u16(id).xstr(code));
  fmt(5, '"$"#,##0_);\\("$"#,##0\\)');
  fmt(164, 'dd/mm/yyyy;@');
  fmt(165, '"$" #,##0.00;[Red]\\-"$" #,##0.00');
  fmt(166, '_-* #,##0.00\\ _€_-;\\-* #,##0.00\\ _€_-;_-* "-"??\\ _€_-;_-@_-');
  const xf = (font: number, format: number, style: boolean) => {
    const b = new Buf().u16(font).u16(format).u16(style ? 0xfff5 : 0x0001).u16(0x0020).u16(0).u32(0).u32(0).u16(0x20c0);
    rec(g, 0x00e0, b);
  };
  for (let i = 0; i < 15; i++) xf(0, 0, true);
  xf(0, 0, false); // 15 general
  xf(0, 164, false); // 16 date (custom)
  xf(0, 4, false); // 17 #,##0.00
  xf(0, 165, false); // 18 money
  xf(0, 14, false); // 19 builtin date
  rec(g, 0x0293, new Buf().u16(0x8000).u8(0).u8(0xff));
  rec(g, 0x0160, new Buf().u16(0));
  const boundPos: number[] = [];
  for (const sh of sheets) {
    boundPos.push(g.length + 4);
    rec(g, 0x0085, new Buf().u32(0).u8(sh.hidden ? 1 : 0).u8(0).sxstr(sh.name));
  }
  rec(g, 0x008c, new Buf().u16(57).u16(57));
  g.raw(sstRecords(sst, sstTotal).bytes);
  const ext = new Buf().u16(8);
  for (let i = 0; i < Math.ceil(sst.length / 8); i++) ext.u32(0).u16(0).u16(0);
  rec(g, 0x00ff, ext);
  rec(g, 0x000a, []);
  return { buf: g, boundPos };
}

function sheetStream(sh: ExcelSheet, sstIndex: (s: SstString) => number, date1904: boolean): Buf {
  const w = new Buf();
  rec(w, 0x0809, bof(0x0010));
  const nRows = sh.rows.length;
  const width = Math.max(1, ...sh.rows.map((r) => r.length));
  rec(w, 0x020b, new Buf().u32(0).u32(0).u32(nRows).u32(0));
  for (const [t, v] of [[0x000d, 1], [0x000c, 100], [0x000f, 1], [0x0011, 0], [0x005f, 1], [0x002a, 0], [0x002b, 0], [0x0082, 1]] as const) rec(w, t, new Buf().u16(v));
  rec(w, 0x0080, new Buf().u16(0).u16(0).u16(0).u16(0));
  rec(w, 0x0225, new Buf().u16(0).u16(255));
  rec(w, 0x0081, new Buf().u16(0x04c1));
  rec(w, 0x0055, new Buf().u16(10));
  rec(w, 0x007d, new Buf().u16(0).u16(width - 1).u16(4000).u16(XF_GENERAL).u16(0).u16(0));
  rec(w, 0x0200, new Buf().u32(0).u32(nRows).u16(0).u16(width).u16(0));
  // Rows in blocks of 32: ROW records, then cells, then DBCELL.
  for (let b0 = 0; b0 < nRows; b0 += 32) {
    const block = sh.rows.slice(b0, b0 + 32);
    block.forEach((row, k) => rec(w, 0x0208, new Buf().u16(b0 + k).u16(0).u16(Math.max(1, row.length)).u16(255).u16(0).u16(0).u16(0x0100).u16(XF_GENERAL)));
    block.forEach((row, k) => {
      const r = b0 + k;
      let c = 0;
      while (c < row.length) {
        const v = row[c];
        // Runs of numbers → MULRK; runs of blanks → MULBLANK.
        if (typeof v === 'number' && toRk(v) !== undefined && typeof row[c + 1] === 'number' && toRk(row[c + 1] as number) !== undefined) {
          let e = c;
          while (typeof row[e + 1] === 'number' && toRk(row[e + 1] as number) !== undefined) e++;
          const b = new Buf().u16(r).u16(c);
          for (let k2 = c; k2 <= e; k2++) b.u16(XF_NUM).u32(toRk(row[k2] as number)!);
          b.u16(e);
          rec(w, 0x00bd, b);
          c = e + 1;
          continue;
        }
        if (v === null && row[c + 1] === null && c + 1 < row.length) {
          let e = c;
          while (row[e + 1] === null && e + 1 < row.length) e++;
          const b = new Buf().u16(r).u16(c);
          for (let k2 = c; k2 <= e; k2++) b.u16(XF_GENERAL);
          b.u16(e);
          rec(w, 0x00be, b);
          c = e + 1;
          continue;
        }
        const head = new Buf().u16(r).u16(c);
        if (v === null || v === undefined) rec(w, 0x0201, head.u16(XF_GENERAL));
        else if (typeof v === 'string') rec(w, 0x00fd, head.u16(XF_GENERAL).u32(sstIndex({ text: v })));
        else if (v instanceof Date) rec(w, 0x0203, head.u16(sh.name.endsWith('2') ? XF_DATE_BUILTIN : XF_DATE).f64(serial(v, date1904)));
        else if (typeof v === 'number') {
          const rk = toRk(v);
          if (rk !== undefined) rec(w, 0x027e, head.u16(XF_NUM).u32(rk));
          else rec(w, 0x0203, head.u16(XF_MONEY).f64(v));
        } else if ('rich' in v) rec(w, 0x00fd, head.u16(XF_GENERAL).u32(sstIndex({ text: v.rich, runs: [[0, 4], [Math.min(3, v.rich.length - 1), 0]] })));
        else if ('label' in v) rec(w, 0x0204, head.u16(XF_GENERAL).xstr(v.label));
        else if ('formula' in v) {
          // =F{r}*G{r} with the cached result.
          const rgce = [0x24, r & 0xff, r >> 8, 5, 0xc0, 0x24, r & 0xff, r >> 8, 6, 0xc0, 0x05];
          rec(w, 0x0006, head.u16(XF_MONEY).f64(v.formula).u16(0).u32(0).u16(rgce.length).raw(rgce));
        } else if ('formulaText' in v) {
          const rgce = [0x24, r & 0xff, r >> 8, 2, 0xc0];
          rec(w, 0x0006, head.u16(XF_GENERAL).raw([0, 0, 0, 0, 0, 0, 0xff, 0xff]).u16(0).u32(0).u16(rgce.length).raw(rgce));
          rec(w, 0x0207, new Buf().xstr(v.formulaText));
        } else if ('error' in v) rec(w, 0x0205, head.u16(XF_GENERAL).u8(0x2a).u8(1));
        c++;
      }
    });
    rec(w, 0x00d7, new Buf().u32(0).raw(block.flatMap(() => [0, 0])));
  }
  rec(w, 0x023e, new Buf().u16(0x06b6).u16(0).u16(0).u32(0x40).u16(0).u16(0).u32(0));
  rec(w, 0x001d, new Buf().u8(3).u16(0).u16(0).u16(0).u16(1).u16(0).u16(0).u8(0).u8(0));
  if (sh.mergeTitle) rec(w, 0x00e5, new Buf().u16(1).u16(0).u16(0).u16(0).u16(sh.mergeTitle - 1));
  rec(w, 0x000a, []);
  return w;
}

function biff(sheets: ExcelSheet[], date1904: boolean, filepass = false): Uint8Array {
  // Collect SST strings (LABELSST cells + rich strings), counting every use like Excel's cstTotal.
  const sst: SstString[] = [];
  const idx = new Map<string, number>();
  let total = 0;
  const key = (s: SstString) => `${s.runs ? 'r' : 'p'}|${s.text}`;
  const add = (s: SstString) => {
    total++;
    const k = key(s);
    if (!idx.has(k)) {
      // Every 7th plain string carries phonetic (ExtRst) data, as Excel writes for some locales.
      const withExt = !s.runs && sst.length % 7 === 3 ? { ...s, ext: [1, 0, 8, 0, 0, 0, 0, 0, 0, 0, 0, 0] } : s;
      idx.set(k, sst.push(withExt) - 1);
    }
    return idx.get(k)!;
  };
  for (const sh of sheets) {
    for (const row of sh.rows) {
      for (const v of row) {
        if (typeof v === 'string') add({ text: v });
        else if (v && typeof v === 'object' && !(v instanceof Date) && 'rich' in v) add({ text: v.rich, runs: [[0, 4], [Math.min(3, v.rich.length - 1), 0]] });
      }
    }
  }
  const lookup = (s: SstString) => idx.get(key(s))!;
  const { buf: g, boundPos } = globals(sheets, sst, total, date1904, filepass);
  const all = new Buf().raw(g.bytes);
  sheets.forEach((sh, i) => {
    const pos = all.length;
    const p = boundPos[i]!;
    all.bytes[p] = pos & 0xff;
    all.bytes[p + 1] = (pos >> 8) & 0xff;
    all.bytes[p + 2] = (pos >> 16) & 0xff;
    all.bytes[p + 3] = (pos >>> 24) & 0xff;
    all.raw(sheetStream(sh, lookup, date1904).bytes);
  });
  return new Uint8Array(all.bytes);
}

/** Property-set stream stub (SummaryInformation / DocumentSummaryInformation): header + one empty section. */
function propertySet(fmtid: number[]): Uint8Array {
  const b = new Buf().u16(0xfffe).u16(0).u32(0x00020006).raw(new Array(16).fill(0)).u32(1).raw(fmtid).u32(48);
  b.u32(68).u32(2).u32(1).u32(24).u32(0x13).u32(0x0000_04b0).u32(2).u16(1200);
  while (b.length < 116) b.u8(0);
  return new Uint8Array(b.bytes);
}

const END = 0xfffffffe;
const FREE = 0xffffffff;
const FATSECT = 0xfffffffd;

export function writeExcelXls(sheets: ExcelSheet[], opts: { date1904?: boolean; filepass?: boolean } = {}): Uint8Array {
  const wb = biff(sheets, !!opts.date1904, !!opts.filepass);
  if (wb.length < 4096) throw new Error('fixture too small: the Workbook stream must live in the FAT');
  const S = 512;
  const MS = 64;
  const si = propertySet([0xe0, 0x85, 0x9f, 0xf2, 0xf9, 0x4f, 0x68, 0x10, 0xab, 0x91, 0x08, 0x00, 0x2b, 0x27, 0xb3, 0xd9]);
  const dsi = propertySet([0x02, 0xd5, 0xcd, 0xd5, 0x9c, 0x2e, 0x1b, 0x10, 0x93, 0x97, 0x08, 0x00, 0x2b, 0x2c, 0xf9, 0xae]);
  // Mini stream: SI then DSI, 64-byte mini sectors.
  const miniSectors = (d: Uint8Array) => Math.ceil(d.length / MS);
  const siMini = 0;
  const dsiMini = miniSectors(si);
  const nMini = dsiMini + miniSectors(dsi);
  const miniStream = new Uint8Array(nMini * MS);
  miniStream.set(si, 0);
  miniStream.set(dsi, dsiMini * MS);
  const miniFat: number[] = [];
  for (let i = 0; i < nMini; i++) miniFat.push(i === dsiMini - 1 || i === nMini - 1 ? END : i + 1);

  // Sector layout (fragmented on purpose): WB part 1 | directory | MiniFAT | mini stream | WB part 2 | FAT.
  const wbSecs = Math.ceil(wb.length / S);
  const half = Math.ceil(wbSecs / 2);
  const nMiniStreamSecs = Math.ceil(miniStream.length / S);
  const layout: { kind: 'wb' | 'dir' | 'minifat' | 'ministream' | 'fat'; i: number }[] = [];
  for (let i = 0; i < half; i++) layout.push({ kind: 'wb', i });
  layout.push({ kind: 'dir', i: 0 });
  layout.push({ kind: 'minifat', i: 0 });
  for (let i = 0; i < nMiniStreamSecs; i++) layout.push({ kind: 'ministream', i });
  for (let i = half; i < wbSecs; i++) layout.push({ kind: 'wb', i });
  const nFat = Math.ceil((layout.length + 2) / (S / 4));
  for (let i = 0; i < nFat; i++) layout.push({ kind: 'fat', i });
  const at = (kind: string, i: number) => layout.findIndex((x) => x.kind === kind && x.i === i);

  const fat: number[] = new Array(nFat * (S / 4)).fill(FREE);
  const link = (kind: string, n: number) => {
    for (let i = 0; i < n; i++) fat[at(kind, i)] = i === n - 1 ? END : at(kind, i + 1);
  };
  link('wb', wbSecs);
  link('dir', 1);
  link('minifat', 1);
  link('ministream', nMiniStreamSecs);
  for (let i = 0; i < nFat; i++) fat[at('fat', i)] = FATSECT;

  // Directory: [Root, DocumentSummaryInformation, SummaryInformation, Workbook]; red-black tree with
  // SummaryInformation at the top, Workbook on its left and DocumentSummaryInformation on its right.
  const dir = new Uint8Array(S);
  const entry = (n: number, name: string, type: number, color: number, left: number, right: number, child: number, start: number, size: number) => {
    const o = n * 128;
    for (let i = 0; i < name.length; i++) {
      dir[o + i * 2] = name.charCodeAt(i) & 0xff;
      dir[o + i * 2 + 1] = name.charCodeAt(i) >> 8;
    }
    const dv = new DataView(dir.buffer, o, 128);
    dv.setUint16(0x40, (name.length + 1) * 2, true);
    dir[o + 0x42] = type;
    dir[o + 0x43] = color;
    dv.setUint32(0x44, left, true);
    dv.setUint32(0x48, right, true);
    dv.setUint32(0x4c, child, true);
    dv.setUint32(0x74, start, true);
    dv.setUint32(0x78, size, true);
  };
  entry(0, 'Root Entry', 5, 0, FREE, FREE, 2, at('ministream', 0), miniStream.length);
  entry(1, '\x05DocumentSummaryInformation', 2, 1, FREE, FREE, FREE, dsiMini, dsi.length);
  entry(2, '\x05SummaryInformation', 2, 1, 3, 1, FREE, siMini, si.length);
  entry(3, 'Workbook', 2, 1, FREE, FREE, FREE, at('wb', 0), wb.length);

  const header = new Uint8Array(S);
  const hv = new DataView(header.buffer);
  [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1].forEach((b, i) => (header[i] = b));
  hv.setUint16(0x18, 0x3e, true);
  hv.setUint16(0x1a, 3, true);
  hv.setUint16(0x1c, 0xfffe, true);
  hv.setUint16(0x1e, 9, true);
  hv.setUint16(0x20, 6, true);
  hv.setUint32(0x2c, nFat, true);
  hv.setUint32(0x30, at('dir', 0), true);
  hv.setUint32(0x38, 4096, true);
  hv.setUint32(0x3c, at('minifat', 0), true);
  hv.setUint32(0x40, 1, true);
  hv.setUint32(0x44, END, true);
  hv.setUint32(0x48, 0, true);
  for (let i = 0; i < 109; i++) hv.setUint32(0x4c + i * 4, i < nFat ? at('fat', i) : FREE, true);

  const out = new Uint8Array(S * (layout.length + 1));
  out.set(header, 0);
  layout.forEach((x, n) => {
    const o = S * (n + 1);
    if (x.kind === 'wb') out.set(wb.subarray(x.i * S, (x.i + 1) * S), o);
    else if (x.kind === 'dir') out.set(dir, o);
    else if (x.kind === 'minifat') {
      const dv = new DataView(out.buffer, o, S);
      for (let i = 0; i < S / 4; i++) dv.setUint32(i * 4, i < miniFat.length ? miniFat[i]! : FREE, true);
    } else if (x.kind === 'ministream') out.set(miniStream.subarray(x.i * S, (x.i + 1) * S), o);
    else {
      const dv = new DataView(out.buffer, o, S);
      for (let i = 0; i < S / 4; i++) dv.setUint32(i * 4, fat[x.i * (S / 4) + i] ?? FREE, true);
    }
  });
  return out;
}
