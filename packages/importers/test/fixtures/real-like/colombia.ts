/**
 * Real-like Colombian statements (I31): a comisionista "Extracto de inversiones" PDF in the style of
 * Davivienda Corredores / Valores Bancolombia, an app statement in the style of Trii, and an Excel 97-2003
 * export (.xls saved by Excel) in the style of Acciones & Valores / Credicorp Capital.
 *
 * What makes them hard (and is common in real ones): the portfolio summary BEFORE the movements,
 * dated "SALDO ANTERIOR" / "SALDO FINAL" rows inside the table, descriptions wrapping onto a second line,
 * "$ 2.380.000" and "-$ 2.388.497" / "(9.554)" amounts, the column header repeated on page 2, page
 * footers, Spanish month dates ("05 mar. 2024"), and in the .xls: dates as date-formatted numbers,
 * formulas with cached values, a merged title, a hidden sheet, SST strings split over CONTINUE records.
 * Names, IDs and numbers are placeholders.
 */
import { writeRealPdf, type RealText } from '../../helpers/pdf-real';
import { writeExcelXls, type ExcelCell } from '../../helpers/xls-excel';

export interface CoMovement {
  date: string; // dd/mm/yyyy
  settle?: string;
  desc: string;
  /** Second line of the description (wraps in the PDF). */
  desc2?: string;
  symbol?: string;
  qty?: number;
  price?: number;
  gross?: number;
  fee?: number;
  iva?: number;
  net: number;
  /** Expected import: type and instrument (undefined = row must be skipped). */
  expect?: { type: string; instrumentId?: string; quantity?: number; amount?: number };
}

const cop = (n: number, neg: 'minus' | 'paren' = 'minus') => {
  const s = Math.abs(Math.round(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  if (n >= 0) return `$ ${s}`;
  return neg === 'paren' ? `($ ${s})` : `-$ ${s}`;
};

export const DAVIVIENDA_MOVES: CoMovement[] = [
  { date: '01/03/2024', desc: 'SALDO ANTERIOR', net: 3_000_000 },
  { date: '04/03/2024', settle: '04/03/2024', desc: 'Consignación PSE', net: 5_000_000, expect: { type: 'DEPOSIT', amount: 5_000_000 } },
  {
    date: '05/03/2024', settle: '07/03/2024', desc: 'Compra acciones', desc2: 'Orden No. 000123 - BVC', symbol: 'ECOPETROL', qty: 1000, price: 2380,
    gross: 2_380_000, fee: 7140, iva: 1357, net: -2_388_497, expect: { type: 'BUY', instrumentId: 'XBOG:ECOPETROL', quantity: 1000 },
  },
  {
    date: '12/03/2024', settle: '14/03/2024', desc: 'Venta acciones', desc2: 'Orden No. 000124 - BVC', symbol: 'PFBCOLOM', qty: 100, price: 32500,
    gross: 3_250_000, fee: 9750, iva: 1853, net: 3_238_397, expect: { type: 'SELL', instrumentId: 'XBOG:PFCIBEST', quantity: 100 },
  },
  { date: '20/03/2024', settle: '20/03/2024', desc: 'Dividendo en efectivo', symbol: 'ISA', gross: 120_000, net: 120_000, expect: { type: 'DIVIDEND', instrumentId: 'XBOG:ISA', amount: 120_000 } },
  { date: '22/03/2024', desc: 'GMF 4x1000', gross: -9_554, net: -9_554, expect: { type: 'TAX', amount: 9_554 } },
  { date: '27/03/2024', settle: '27/03/2024', desc: 'Retiro a cuenta bancaria', gross: -1_000_000, net: -1_000_000, expect: { type: 'WITHDRAWAL', amount: 1_000_000 } },
];
export const DAVIVIENDA_MOVES_P2: CoMovement[] = [
  {
    date: '28/03/2024', settle: '02/04/2024', desc: 'Compra acciones', symbol: 'GRUPOSURA', qty: 50, price: 34000, gross: 1_700_000, fee: 5100, iva: 969,
    net: -1_706_069, expect: { type: 'BUY', instrumentId: 'XBOG:GRUPOSURA', quantity: 50 },
  },
  { date: '31/03/2024', desc: 'SALDO FINAL', net: 7_254_277 },
];
export const DAVIVIENDA_HOLDINGS = [
  ['ECOPETROL', 1000, 2410, 2_410_000],
  ['GRUPOSURA', 50, 34500, 1_725_000],
] as const;

const DV = { date: 40, settle: 82, desc: 150, sym: 250, qty: 330, price: 378, gross: 432, fee: 476, iva: 510, net: 562 };

function dvHeader(page: number, pages: number): RealText[] {
  return [
    { x: 40, y: 812, text: 'DAVIVIENDA CORREDORES S.A.', size: 10, font: 'HB' },
    { x: 40, y: 802, text: 'Comisionista de Bolsa - NIT 000.000.000-0 - Vigilada Superintendencia Financiera de Colombia', size: 6 },
    { x: 400, y: 812, text: 'EXTRACTO DE INVERSIONES', size: 9, font: 'HB' },
    { x: 400, y: 801, text: 'Periodo: 01/03/2024 - 31/03/2024', size: 7 },
    { x: 40, y: 786, text: 'Cliente: FULANO DE TAL', size: 7 },
    { x: 40, y: 777, text: 'Identificación: C.C. 00.000.000', size: 7 },
    { x: 300, y: 786, text: 'Cuenta: 000123', size: 7 },
    { x: 480, y: 24, text: `Página ${page} de ${pages}`, size: 6 },
    { x: 40, y: 24, text: 'Este extracto se considera aceptado si no se presentan observaciones dentro de los 30 días siguientes a su envío.', size: 5 },
  ];
}

function dvColumns(y: number): RealText[] {
  return [
    { x: DV.date, y, text: 'Fecha', size: 6, font: 'HB' }, { x: DV.settle, y, text: 'Fecha cumpl.', size: 6, font: 'HB' },
    { x: DV.desc, y, text: 'Descripción', size: 6, font: 'HB' }, { x: DV.sym, y, text: 'Especie', size: 6, font: 'HB' },
    { x: DV.qty - 25, y, text: 'Cantidad', size: 6, font: 'HB' }, { x: DV.price - 18, y, text: 'Precio', size: 6, font: 'HB' },
    { x: DV.gross - 32, y, text: 'Valor bruto', size: 6, font: 'HB' }, { x: DV.fee - 26, y, text: 'Comisión', size: 6, font: 'HB' },
    { x: DV.iva - 12, y, text: 'IVA', size: 6, font: 'HB' }, { x: DV.net - 30, y, text: 'Valor neto', size: 6, font: 'HB' },
  ];
}

function dvRows(moves: CoMovement[], y0: number): { texts: RealText[]; y: number } {
  const t: RealText[] = [];
  let y = y0;
  moves.forEach((m, i) => {
    const paren = i % 3 === 2;
    t.push({ x: DV.date, y, text: m.date, size: 6 }, { x: DV.desc, y, text: m.desc, size: 6 });
    if (m.settle) t.push({ x: DV.settle, y, text: m.settle, size: 6 });
    if (m.symbol) t.push({ x: DV.sym, y, text: m.symbol, size: 6 });
    if (m.qty !== undefined) t.push({ x: DV.qty, y, text: m.qty.toLocaleString('es-CO'), size: 6, align: 'right' });
    if (m.price !== undefined) t.push({ x: DV.price, y, text: cop(m.price), size: 6, align: 'right' });
    if (m.gross !== undefined) t.push({ x: DV.gross, y, text: cop(m.gross, paren ? 'paren' : 'minus'), size: 6, align: 'right' });
    if (m.fee !== undefined) t.push({ x: DV.fee, y, text: cop(m.fee), size: 6, align: 'right' });
    if (m.iva !== undefined) t.push({ x: DV.iva, y, text: cop(m.iva), size: 6, align: 'right' });
    t.push({ x: DV.net, y, text: cop(m.net, paren ? 'paren' : 'minus'), size: 6, align: 'right' });
    y -= 9;
    if (m.desc2) {
      t.push({ x: DV.desc, y, text: m.desc2, size: 5 });
      y -= 8;
    }
  });
  return { texts: t, y };
}

export function buildDaviviendaPdf(): Uint8Array {
  const p1: RealText[] = [...dvHeader(1, 2)];
  p1.push({ x: 40, y: 760, text: 'RESUMEN DEL PORTAFOLIO', size: 8, font: 'HB' });
  p1.push({ x: 40, y: 749, text: 'Especie', size: 6, font: 'HB' }, { x: 160, y: 749, text: 'Cantidad', size: 6, font: 'HB' },
    { x: 240, y: 749, text: 'Precio cierre', size: 6, font: 'HB' }, { x: 330, y: 749, text: 'Valor mercado', size: 6, font: 'HB' }, { x: 430, y: 749, text: '% Part.', size: 6, font: 'HB' });
  let y = 740;
  for (const [s, q, p, v] of DAVIVIENDA_HOLDINGS) {
    p1.push({ x: 40, y, text: s, size: 6 }, { x: 190, y, text: q.toLocaleString('es-CO'), size: 6, align: 'right' },
      { x: 290, y, text: cop(p), size: 6, align: 'right' }, { x: 390, y, text: cop(v), size: 6, align: 'right' }, { x: 450, y, text: '50,0%', size: 6, align: 'right' });
    y -= 9;
  }
  p1.push({ x: 40, y, text: 'Total portafolio', size: 6, font: 'HB' }, { x: 390, y, text: cop(4_135_000), size: 6, align: 'right' });
  y -= 22;
  p1.push({ x: 40, y, text: 'DETALLE DE MOVIMIENTOS', size: 8, font: 'HB' });
  y -= 12;
  p1.push(...dvColumns(y));
  const body = dvRows(DAVIVIENDA_MOVES, y - 11);
  p1.push(...body.texts);
  const p2: RealText[] = [...dvHeader(2, 2), { x: 40, y: 760, text: 'DETALLE DE MOVIMIENTOS (continuación)', size: 8, font: 'HB' }, ...dvColumns(748)];
  p2.push(...dvRows(DAVIVIENDA_MOVES_P2, 737).texts);
  return writeRealPdf([{ texts: p1, rules: [[38, 755, 585, 755]] }, { texts: p2 }], { mode: 'word', compress: true, shuffle: 5, producer: 'JasperReports' });
}

// ---------------------------------------------------------------------------------------------
// App statement (Trii-like): Spanish month dates, "COP" amounts with decimals, holdings at the end.

export const TRII_MOVES: { date: string; type: string; symbol: string; qty: number; price: number; amount: number; fee: number; expect: string }[] = [
  { date: '05 mar. 2024', type: 'Compra', symbol: 'ECOPETROL', qty: 200, price: 2390, amount: 478_000, fee: 2_390, expect: 'BUY' },
  { date: '12 mar. 2024', type: 'Compra', symbol: 'NUTRESA', qty: 10, price: 45_100, amount: 451_000, fee: 2_255, expect: 'BUY' },
  { date: '19 mar. 2024', type: 'Venta', symbol: 'ECOPETROL', qty: 50, price: 2_405, amount: 120_250, fee: 601.25, expect: 'SELL' },
];

export function buildTriiPdf(): Uint8Array {
  const t: RealText[] = [
    { x: 40, y: 810, text: 'trii', size: 14, font: 'HB' },
    { x: 40, y: 795, text: 'Extracto mensual de tu cuenta de inversión', size: 8 },
    { x: 40, y: 784, text: 'Periodo: 01/03/2024 - 31/03/2024', size: 7 },
    { x: 40, y: 764, text: 'Movimientos', size: 9, font: 'HB' },
  ];
  const X = { date: 40, type: 110, sym: 170, qty: 290, price: 370, amount: 470, fee: 550 };
  t.push({ x: X.date, y: 750, text: 'Fecha', size: 7, font: 'HB' }, { x: X.type, y: 750, text: 'Tipo', size: 7, font: 'HB' }, { x: X.sym, y: 750, text: 'Acción', size: 7, font: 'HB' },
    { x: X.qty - 30, y: 750, text: 'Cantidad', size: 7, font: 'HB' }, { x: X.price - 50, y: 750, text: 'Precio promedio', size: 7, font: 'HB' },
    { x: X.amount - 30, y: 750, text: 'Monto', size: 7, font: 'HB' }, { x: X.fee - 35, y: 750, text: 'Comisión', size: 7, font: 'HB' });
  let y = 738;
  const money = (n: number) => `COP ${n.toLocaleString('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  for (const m of TRII_MOVES) {
    t.push({ x: X.date, y, text: m.date, size: 7 }, { x: X.type, y, text: m.type, size: 7 }, { x: X.sym, y, text: m.symbol, size: 7 },
      { x: X.qty, y, text: String(m.qty), size: 7, align: 'right' }, { x: X.price, y, text: money(m.price), size: 7, align: 'right' },
      { x: X.amount, y, text: money(m.amount), size: 7, align: 'right' }, { x: X.fee, y, text: money(m.fee), size: 7, align: 'right' });
    y -= 11;
  }
  y -= 20;
  t.push({ x: 40, y, text: 'Portafolio al cierre', size: 9, font: 'HB' });
  y -= 13;
  t.push({ x: 110, y, text: 'Acción', size: 7, font: 'HB' }, { x: 200, y, text: 'Cantidad', size: 7, font: 'HB' }, { x: 280, y, text: 'Precio cierre', size: 7, font: 'HB' }, { x: 380, y, text: 'Valor', size: 7, font: 'HB' });
  y -= 11;
  for (const [s, q, p] of [['ECOPETROL', 150, 2410], ['NUTRESA', 10, 45000]] as const) {
    t.push({ x: 110, y, text: s, size: 7 }, { x: 230, y, text: String(q), size: 7, align: 'right' }, { x: 330, y, text: p.toLocaleString('es-CO'), size: 7, align: 'right' },
      { x: 420, y, text: (q * p).toLocaleString('es-CO'), size: 7, align: 'right' });
    y -= 11;
  }
  t.push({ x: 40, y: y - 6, text: 'Total portafolio   811.500', size: 7, font: 'HB' });
  return writeRealPdf([{ texts: t }], { mode: 'tj', font: 'H', compress: true, producer: 'trii app' });
}

// ---------------------------------------------------------------------------------------------
// Excel 97-2003 export (Acciones & Valores / Credicorp style)

export interface XlsMove {
  date: Date;
  settle: Date;
  op: string;
  desc: string;
  symbol: string;
  qty: number | null;
  price: number | null;
  gross: number;
  fee: number;
  iva: number;
  expect: string;
}

const d = (y: number, m: number, day: number) => new Date(Date.UTC(y, m - 1, day));

/** 60 movements so the SST exceeds one record (8 224 bytes) and continues mid-string. */
export function xlsMoves(): XlsMove[] {
  const out: XlsMove[] = [];
  const syms = ['ECOPETROL', 'PFBCOLOM', 'ISA', 'GEB', 'GRUPOSURA', 'CELSIA', 'NUTRESA', 'BOGOTA'];
  for (let i = 0; i < 60; i++) {
    const sym = syms[i % syms.length]!;
    const buy = i % 4 !== 3;
    const qty = 10 * ((i % 7) + 1);
    const price = 1000 + i * 37.5;
    const gross = Math.round(qty * price * 100) / 100;
    const fee = Math.round(gross * 0.003 * 100) / 100;
    const iva = Math.round(fee * 0.19 * 100) / 100;
    out.push({
      date: d(2024, 1 + Math.floor(i / 20), 2 + (i % 20)),
      settle: d(2024, 1 + Math.floor(i / 20), 4 + (i % 20)),
      op: buy ? 'Compra' : 'Venta',
      // Long descriptions with an em dash (U+2014, not Latin-1) force UTF-16 strings in the SST.
      desc: `${buy ? 'Compra' : 'Venta'} de acciones ${sym} — orden N° ${String(100000 + i)} — liquidación T+2 en DECEVAL, mercado de contado BVC`,
      symbol: sym,
      qty,
      price,
      gross,
      fee,
      iva,
      expect: buy ? 'BUY' : 'SELL',
    });
  }
  return out;
}

export function buildExcelXls(opts: { date1904?: boolean; filepass?: boolean } = {}): Uint8Array {
  const moves = xlsMoves();
  const rows: ExcelCell[][] = [
    ['ACCIONES & VALORES S.A. - Extracto de movimientos'],
    ['Cliente:', 'FULANO DE TAL', null, 'Periodo:', { label: '01/01/2024 - 31/03/2024' }],
    [null, null, null],
    ['Fecha', 'Fecha liquidación', 'Operación', 'Descripción', 'Nemotécnico', 'Cantidad', 'Precio', 'Valor bruto', 'Comisión', 'IVA', 'Valor neto', 'Estado'],
  ];
  moves.forEach((m, i) => {
    const sign = m.op === 'Compra' ? -1 : 1;
    const net = Math.round((sign * m.gross - m.fee - m.iva) * 100) / 100;
    rows.push([
      m.date, m.settle, i % 9 === 4 ? { rich: m.op } : m.op, m.desc, m.symbol, m.qty, m.price,
      { formula: m.gross }, m.fee, m.iva, net, i % 10 === 0 ? { formulaText: 'Cumplida' } : 'Cumplida',
    ]);
  });
  rows.push([null, null, null, null, null, null, null, null, null, null, null, null]);
  rows.push(['Total', null, null, null, null, null, null, { formula: moves.reduce((a, m) => a + m.gross, 0) }, null, null, { error: true }]);
  return writeExcelXls(
    [
      { name: 'Movimientos', rows, mergeTitle: 12 },
      { name: 'Resumen 2', rows: [['Especie', 'Cantidad', 'Fecha corte'], ['ECOPETROL', 100, d(2024, 3, 31)]] },
      { name: 'Hoja oculta', hidden: true, rows: [['tmp', 1, 2, 3]] },
    ],
    opts,
  );
}
