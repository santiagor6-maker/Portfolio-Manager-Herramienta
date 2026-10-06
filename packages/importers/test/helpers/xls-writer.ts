/**
 * Minimal Excel 97-2003 (.xls, BIFF8 in a Compound File) writer for test fixtures.
 * Cells: strings (SST), integers (RK), floats (NUMBER), Dates (NUMBER with a date XF).
 * `mini: true` stores the small Workbook stream in the CFB mini stream (as Excel does for tiny files).
 */
export type XlsCell = string | number | Date | null;

class Buf {
  bytes: number[] = [];
  u8(v: number) {
    this.bytes.push(v & 0xff);
  }
  u16(v: number) {
    this.u8(v);
    this.u8(v >> 8);
  }
  u32(v: number) {
    this.u16(v & 0xffff);
    this.u16(v >>> 16);
  }
  f64(v: number) {
    const dv = new DataView(new ArrayBuffer(8));
    dv.setFloat64(0, v, true);
    for (let i = 0; i < 8; i++) this.u8(dv.getUint8(i));
  }
  str16(s: string) {
    // XLUnicodeString body: cch(u16) flags(u8) chars
    const high = [...s].some((c) => c.charCodeAt(0) > 0xff);
    this.u16(s.length);
    this.u8(high ? 1 : 0);
    for (const ch of s) high ? this.u16(ch.charCodeAt(0)) : this.u8(ch.charCodeAt(0));
  }
}

function record(out: Buf, type: number, body: Buf) {
  out.u16(type);
  out.u16(body.bytes.length);
  out.bytes.push(...body.bytes);
}

function biff(sheets: { name: string; rows: XlsCell[][] }[]): Uint8Array {
  const sst: string[] = [];
  const sstIdx = new Map<string, number>();
  for (const sh of sheets) for (const r of sh.rows) for (const c of r) if (typeof c === 'string' && !sstIdx.has(c)) sstIdx.set(c, sst.push(c) - 1);
  const bof = (dt: number) => {
    const b = new Buf();
    b.u16(0x0600);
    b.u16(dt);
    b.u16(0x0dbb);
    b.u16(0x07cc);
    b.u32(0);
    b.u32(0x06);
    return b;
  };
  const glob = new Buf();
  record(glob, 0x0809, bof(0x0005));
  for (const fmt of [0, 14]) {
    const xf = new Buf();
    xf.u16(0);
    xf.u16(fmt);
    for (let i = 0; i < 16; i++) xf.u8(0);
    record(glob, 0x00e0, xf);
  }
  const boundPos: number[] = [];
  for (const sh of sheets) {
    const b = new Buf();
    boundPos.push(glob.bytes.length + 4);
    b.u32(0);
    b.u8(0);
    b.u8(0);
    b.u8(sh.name.length);
    b.u8(0);
    for (const ch of sh.name) b.u8(ch.charCodeAt(0));
    record(glob, 0x0085, b);
  }
  const s = new Buf();
  s.u32(sst.length);
  s.u32(sst.length);
  for (const str of sst) s.str16(str);
  record(glob, 0x00fc, s);
  record(glob, 0x000a, new Buf());
  const all = new Buf();
  all.bytes.push(...glob.bytes);
  sheets.forEach((sh, si) => {
    const pos = all.bytes.length;
    const p = boundPos[si]!;
    all.bytes[p] = pos & 0xff;
    all.bytes[p + 1] = (pos >> 8) & 0xff;
    all.bytes[p + 2] = (pos >> 16) & 0xff;
    all.bytes[p + 3] = (pos >>> 24) & 0xff;
    const ws = new Buf();
    record(ws, 0x0809, bof(0x0010));
    sh.rows.forEach((row, r) => {
      row.forEach((v, c) => {
        if (v === null || v === undefined) return;
        const b = new Buf();
        b.u16(r);
        b.u16(c);
        if (typeof v === 'string') {
          b.u16(0);
          b.u32(sstIdx.get(v)!);
          record(ws, 0x00fd, b);
        } else if (v instanceof Date) {
          b.u16(1);
          b.f64(v.getTime() / 86400000 + 25569);
          record(ws, 0x0203, b);
        } else if (Number.isInteger(v) && Math.abs(v) < 2 ** 29) {
          b.u16(0);
          b.u32(((v << 2) | 2) >>> 0);
          record(ws, 0x027e, b);
        } else {
          b.u16(0);
          b.f64(v);
          record(ws, 0x0203, b);
        }
      });
    });
    record(ws, 0x000a, new Buf());
    all.bytes.push(...ws.bytes);
  });
  return new Uint8Array(all.bytes);
}

const END = 0xfffffffe;
const FREE = 0xffffffff;

export function writeXls(sheets: { name: string; rows: XlsCell[][] }[], opts: { mini?: boolean } = {}): Uint8Array {
  let wb = biff(sheets);
  const mini = !!opts.mini && wb.length < 4096;
  if (!mini && wb.length < 4096) {
    const padded = new Uint8Array(4096);
    padded.set(wb);
    wb = padded;
  }
  const S = 512;
  const sectors: Uint8Array[] = [];
  const fat: number[] = [];
  const alloc = (data: Uint8Array): number => {
    const n = Math.max(1, Math.ceil(data.length / S));
    const start = sectors.length;
    for (let i = 0; i < n; i++) {
      const sec = new Uint8Array(S);
      sec.set(data.subarray(i * S, (i + 1) * S));
      sectors.push(sec);
      fat[start + i] = i === n - 1 ? END : start + i + 1;
    }
    return start;
  };
  sectors.push(new Uint8Array(S)); // FAT sector (filled at the end)
  fat[0] = 0xfffffffd;
  const dirIndex = sectors.length;
  sectors.push(new Uint8Array(S));
  fat[dirIndex] = END;
  let rootStart = END;
  let rootSize = 0;
  let wbStart: number;
  let firstMiniFat = END;
  let nMiniFat = 0;
  if (mini) {
    const nMini = Math.ceil(wb.length / 64);
    const miniFat = new Uint8Array(S).fill(0xff);
    const dv = new DataView(miniFat.buffer);
    for (let i = 0; i < nMini; i++) dv.setUint32(i * 4, i === nMini - 1 ? END : i + 1, true);
    firstMiniFat = alloc(miniFat);
    nMiniFat = 1;
    const ms = new Uint8Array(nMini * 64);
    ms.set(wb);
    rootStart = alloc(ms);
    rootSize = ms.length;
    wbStart = 0;
  } else wbStart = alloc(wb);
  // Directory
  const dir = sectors[dirIndex]!;
  const dv = new DataView(dir.buffer);
  const entry = (i: number, name: string, type: number, child: number, start: number, size: number) => {
    const o = i * 128;
    for (let k = 0; k < name.length; k++) dv.setUint16(o + k * 2, name.charCodeAt(k), true);
    dv.setUint16(o + 0x40, (name.length + 1) * 2, true);
    dir[o + 0x42] = type;
    dir[o + 0x43] = 1;
    dv.setUint32(o + 0x44, FREE, true);
    dv.setUint32(o + 0x48, FREE, true);
    dv.setUint32(o + 0x4c, child, true);
    dv.setUint32(o + 0x74, start, true);
    dv.setUint32(o + 0x78, size, true);
  };
  entry(0, 'Root Entry', 5, 1, rootStart, rootSize);
  entry(1, 'Workbook', 2, FREE, wbStart, wb.length);
  for (const i of [2, 3]) {
    dv.setUint32(i * 128 + 0x44, FREE, true);
    dv.setUint32(i * 128 + 0x48, FREE, true);
    dv.setUint32(i * 128 + 0x4c, FREE, true);
  }
  // FAT
  const fatSec = new DataView(sectors[0]!.buffer);
  for (let i = 0; i < S / 4; i++) fatSec.setUint32(i * 4, fat[i] ?? FREE, true);
  // Header
  const header = new Uint8Array(S);
  const h = new DataView(header.buffer);
  header.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
  h.setUint16(0x18, 0x3e, true);
  h.setUint16(0x1a, 3, true);
  h.setUint16(0x1c, 0xfffe, true);
  h.setUint16(0x1e, 9, true);
  h.setUint16(0x20, 6, true);
  h.setUint32(0x2c, 1, true);
  h.setUint32(0x30, dirIndex, true);
  h.setUint32(0x38, 4096, true);
  h.setUint32(0x3c, firstMiniFat, true);
  h.setUint32(0x40, nMiniFat, true);
  h.setUint32(0x44, END, true);
  h.setUint32(0x48, 0, true);
  for (let i = 0; i < 109; i++) h.setUint32(0x4c + i * 4, i === 0 ? 0 : FREE, true);
  const out = new Uint8Array(S * (1 + sectors.length));
  out.set(header);
  sectors.forEach((sec, i) => out.set(sec, S * (i + 1)));
  return out;
}
