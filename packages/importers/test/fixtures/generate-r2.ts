/**
 * Round-2 binary fixtures: PDFs (SINACOR notes, CDT certificates, Colombian statement), legacy .xls
 * (BIFF8, regular and mini-stream) and B3 Posição (multi-sheet XLSX). Synthetic data, real layouts.
 * Run: npx tsx packages/importers/test/fixtures/generate-r2.ts
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writePdf, type PdfText } from '../helpers/pdf-writer';
import { writeXls } from '../helpers/xls-writer';
import { writeXlsx } from '../helpers/xlsx-writer';

const dir = dirname(fileURLToPath(import.meta.url));
const out = (name: string, data: Uint8Array) => writeFileSync(join(dir, name), data);

// ---------------------------------------------------------------------------
// SINACOR notes: 3 notes on 3 pages (options trade, two-column summary, unknown security)
// ---------------------------------------------------------------------------
type Trade = [side: string, market: string, prazo: string, spec: string, obs: string, qty: string, price: string, value: string, dc: string];

function notePage(nr: string, date: string, broker: string, trades: Trade[], left: [string, string][], right: [string, string, string?][]): PdfText[] {
  const t: PdfText[] = [
    [230, 815, 'NOTA DE CORRETAGEM', 11],
    [380, 795, 'Nr. nota'], [450, 795, 'Folha'], [500, 795, 'Data pregão'],
    [380, 783, nr], [450, 783, '1'], [500, 783, date],
    [40, 765, broker, 9],
    [40, 753, 'Av. Brigadeiro Faria Lima, 3600 - Itaim Bibi - São Paulo - SP'],
    [40, 738, 'Cliente'], [100, 738, 'JOAO DA SILVA'], [300, 738, 'C.P.F./C.N.P.J/C.V.M./C.O.B.'], [450, 738, '123.456.789-00'],
    [40, 718, 'Negócios realizados', 9],
    [40, 705, 'Q Negociação'], [105, 705, 'C/V'], [125, 705, 'Tipo mercado'], [195, 705, 'Prazo'], [225, 705, 'Especificação do título'],
    [345, 705, 'Obs. (*)'], [390, 705, 'Quantidade'], [440, 705, 'Preço / Ajuste'], [500, 705, 'Valor Operação'], [565, 705, 'D/C'],
  ];
  let y = 692;
  for (const [side, market, prazo, spec, obs, qty, price, value, dc] of trades) {
    t.push([40, y, '1-BOVESPA'], [108, y, side], [125, y, market]);
    if (prazo) t.push([195, y, prazo]);
    t.push([225, y, spec]);
    if (obs) t.push([355, y, obs]);
    t.push([395, y, qty], [445, y, price], [505, y, value], [568, y, dc]);
    y -= 12;
  }
  y -= 12;
  t.push([40, y, 'Resumo dos Negócios', 9], [320, y, 'Resumo Financeiro', 9]);
  y -= 13;
  const n = Math.max(left.length, right.length);
  for (let i = 0; i < n; i++) {
    const l = left[i];
    const r = right[i];
    if (l) t.push([40, y, l[0]], [230, y, l[1]]);
    if (r) {
      t.push([320, y, r[0]]);
      if (r[1]) t.push([505, y, r[1]]);
      if (r[2]) t.push([560, y, r[2]]);
    }
    y -= 12;
  }
  return t;
}

const note1 = notePage('12345678', '02/01/2023', 'XP INVESTIMENTOS CCTVM S/A', [
  ['C', 'VISTA', '', 'PETROBRAS PN N2', '', '100', '23,45', '2.345,00', 'D'],
  ['C', 'FRACIONARIO', '', 'ITAUSA PN N1', '#', '37', '8,92', '330,04', 'D'],
  ['V', 'VISTA', '', 'VALE ON NM', '', '20', '88,10', '1.762,00', 'C'],
  ['C', 'OPCAO DE COMPRA', '01/23', 'PETRA250 PN', '', '100', '0,50', '50,00', 'D'],
], [
  ['Debêntures', '0,00'], ['Vendas à vista', '1.762,00'], ['Compras à vista', '2.675,04'], ['Opções - compras', '50,00'],
  ['Opções - vendas', '0,00'], ['Operações à termo', '0,00'], ['Valor das oper. c/ títulos públ. (v. nom.)', '0,00'], ['Valor das operações', '4.487,04'],
], [
  ['Clearing'], ['Valor líquido das operações', '963,04', 'D'], ['Taxa de liquidação', '1,22', 'D'], ['Taxa de Registro', '0,00', 'D'],
  ['Total CBLC', '964,26', 'D'], ['Bolsa'], ['Taxa de termo/opções', '0,00', 'D'], ['Taxa A.N.A.', '0,00', 'D'], ['Emolumentos', '0,22', 'D'],
  ['Total Bovespa / Soma', '0,22', 'D'], ['Custos Operacionais'], ['Taxa Operacional', '4,90', 'D'], ['Execução', '0,00'], ['Taxa de Custódia', '0,00'],
  ['Impostos', '0,24'], ['I.R.R.F. s/ operações, base R$1.762,00', '0,09'], ['Outros', '0,00', 'D'], ['Total Custos / Despesas', '6,58', 'D'],
  ['Líquido para 04/01/2023', '969,71', 'D'],
]);

const note2 = notePage('87654321', '15/03/2023', 'CLEAR CORRETORA - GRUPO XP', [
  ['V', 'VISTA', '', 'PETROBRAS PN N2', '', '50', '25,10', '1.255,00', 'C'],
  ['C', 'VISTA', '', 'FII CSHG LOG HGLG11 CI', '', '10', '160,50', '1.605,00', 'D'],
], [['Vendas à vista', '1.255,00'], ['Compras à vista', '1.605,00'], ['Valor das operações', '2.860,00']], [
  ['Valor líquido das operações', '350,00', 'D'], ['Taxa de liquidação', '0,71', 'D'], ['Emolumentos', '0,14', 'D'], ['Taxa Operacional', '0,00', 'D'],
  ['Impostos', '0,00'], ['I.R.R.F. s/ operações, base R$1.255,00', '0,06'], ['Líquido para 17/03/2023', '350,91', 'D'],
]);

const note3 = notePage('99887766', '20/03/2023', 'RICO INVESTIMENTOS - GRUPO XP', [
  ['C', 'VISTA', '', 'MINERVA ON NM', '', '200', '10,00', '2.000,00', 'D'],
], [['Compras à vista', '2.000,00']], [
  ['Valor líquido das operações', '2.000,00', 'D'], ['Taxa de liquidação', '0,50', 'D'], ['Emolumentos', '0,10', 'D'],
  // Deliberately inconsistent "Líquido para" (should be 2.000,60) to exercise the consistency check.
  ['Líquido para 22/03/2023', '2.010,60', 'D'],
]);
out('nota-sinacor.pdf', writePdf([note1, note2, note3]));

// ---------------------------------------------------------------------------
// CDT certificates
// ---------------------------------------------------------------------------
out('cdt-bancolombia.pdf', writePdf([[
  [180, 800, 'CERTIFICADO DE DEPÓSITO A TÉRMINO - CDT', 11],
  [40, 770, 'Entidad emisora:'], [180, 770, 'Bancolombia S.A.'],
  [40, 755, 'Número del CDT:'], [180, 755, '7001234567'],
  [40, 740, 'Titular:'], [180, 740, 'JUAN PÉREZ'],
  [40, 725, 'Valor de la inversión:'], [180, 725, '$ 10.000.000,00'],
  [40, 710, 'Tasa:'], [180, 710, '11,25% E.A.'],
  [40, 695, 'Plazo:'], [180, 695, '360 días'],
  [40, 680, 'Fecha de apertura:'], [180, 680, '15/01/2024'],
  [40, 665, 'Fecha de vencimiento:'], [180, 665, '09/01/2025'],
  [40, 650, 'Pago de intereses:'], [180, 650, 'Al vencimiento'],
  [40, 620, 'Este título es nominativo y no negociable. Retención en la fuente según normas vigentes.'],
]]));
out('cdt-davivienda-ipc.pdf', writePdf([[
  [200, 800, 'BANCO DAVIVIENDA S.A.', 11],
  [170, 785, 'Constancia de inversión - Certificado de Depósito a Término'],
  [40, 750, 'No. título:'], [170, 750, 'CDT-889900'],
  [40, 735, 'Monto:'], [170, 735, '$ 25.000.000'],
  [40, 720, 'Tasa de interés:'], [170, 720, 'IPC + 4,50% E.A.'],
  [40, 705, 'Fecha de emisión:'], [170, 705, '1 de marzo de 2024'],
  [40, 690, 'Plazo:'], [170, 690, '540 días'],
  [40, 675, 'Periodicidad de pago:'], [170, 675, 'Trimestral'],
]]));

// ---------------------------------------------------------------------------
// Colombian brokerage statement (Trii) with a movements table, 2 pages
// ---------------------------------------------------------------------------
const cols = [40, 100, 185, 260, 320, 390, 460, 520];
const header = ['Fecha', 'Operación', 'Especie', 'Cantidad', 'Precio', 'Valor bruto', 'Comisión', 'Valor neto'];
const rowsP1: string[][] = [
  ['02/01/2024', 'Recarga', '', '', '', '3.000.000,00', '', '3.000.000,00'],
  ['15/01/2024', 'Compra', 'ECOPETROL', '500', '2.450,00', '1.225.000,00', '3.675,00', '1.228.675,00'],
  ['16/01/2024', 'Compra', 'CIBEST', '20', '38.500,00', '770.000,00', '2.310,00', '772.310,00'],
];
const rowsP2: string[][] = [
  ['20/02/2024', 'Venta', 'ECOPETROL', '200', '2.600,00', '520.000,00', '1.560,00', '518.440,00'],
  ['28/03/2024', 'Dividendo', 'ECOPETROL', '', '', '91.000,00', '', '91.000,00'],
];
const tablePage = (title: boolean, rows: string[][]): PdfText[] => {
  const t: PdfText[] = [];
  if (title) {
    t.push([40, 810, 'trii', 14], [40, 792, 'Extracto de movimientos - Primer trimestre 2024', 9], [40, 778, 'Cliente: Juan Pérez - C.C. 1.020.304.050']);
  }
  let y = 750;
  header.forEach((h, i) => t.push([cols[i]!, y, h]));
  for (const r of rows) {
    y -= 14;
    r.forEach((v, i) => {
      if (v) t.push([cols[i]!, y, v]);
    });
  }
  return t;
};
out('extracto-trii.pdf', writePdf([tablePage(true, rowsP1), tablePage(false, rowsP2)]));

// ---------------------------------------------------------------------------
// Legacy .xls (BIFF8): bank-style export with a title row, dates as date cells
// ---------------------------------------------------------------------------
const xlsRows = [
  ['Acciones & Valores S.A. - Movimientos', null, null, null, null, null],
  ['Fecha', 'Operación', 'Especie', 'Cantidad', 'Precio', 'Comisión'],
  [new Date(Date.UTC(2024, 0, 15)), 'Compra', 'ISA', 100, 17500.5, 8750],
  [new Date(Date.UTC(2024, 1, 20)), 'Venta', 'ISA', 40, 18200, 3640],
  [new Date(Date.UTC(2024, 2, 28)), 'Dividendo', 'ISA', null, null, null],
];
xlsRows[4]![5] = null;
out('extracto-av.xls', writeXls([{ name: 'Movimientos', rows: [...xlsRows.slice(0, 4), [new Date(Date.UTC(2024, 2, 28)), 'Dividendo', 'ISA', 60, 512.5, null]] }]));
out('extracto-av-mini.xls', writeXls([{ name: 'Hoja1', rows: xlsRows.slice(0, 3) }], { mini: true }));

// ---------------------------------------------------------------------------
// B3 Posição (multi-sheet)
// ---------------------------------------------------------------------------
const posHeader = ['Produto', 'Instituição', 'Conta', 'Código de Negociação', 'CNPJ da Empresa', 'Código ISIN / Distribuição', 'Tipo', 'Escriturador', 'Quantidade', 'Quantidade Disponível', 'Quantidade Indisponível', 'Motivo', 'Preço de Fechamento', 'Valor Atualizado'];
out('b3-posicao.xlsx', writeXlsx([
  { name: 'Acoes', rows: [posHeader,
    ['PETR4 - PETROLEO BRASILEIRO S.A. PETROBRAS', 'XP INVESTIMENTOS CCTVM S/A', '123', 'PETR4', '33.000.167/0001-01', 'BRPETRACNPR6', 'PN', 'BANCO BRADESCO', 50, 50, 0, '-', 37.5, 1875],
    ['ITSA4 - ITAUSA S.A.', 'XP INVESTIMENTOS CCTVM S/A', '123', 'ITSA4', '61.532.644/0001-15', 'BRITSAACNPR7', 'PN', 'ITAU', 81, 81, 0, '-', 10.1, 818.1],
  ] },
  { name: 'Fundo de Investimento', rows: [posHeader,
    ['HGLG11 - CSHG LOGISTICA FDO INV IMOB - FII', 'NU INVEST', '9', 'HGLG11', '11.728.688/0001-47', 'BRHGLGCTF004', 'Cotas', 'BTG', 10, 10, 0, '-', 158, 1580],
  ] },
]));

console.log('round-2 fixtures written to', dir);
