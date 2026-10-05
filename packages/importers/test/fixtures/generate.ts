/**
 * Regenerates the binary fixtures (XLSX files and Windows-1252 encoded CSVs).
 * Run: npx tsx packages/importers/test/fixtures/generate.ts
 * Data is synthetic but follows the real export layouts.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeWindows1252 } from '../../src/decode';
import { writeXlsx, type XCell } from '../helpers/xlsx-writer';

const dir = dirname(fileURLToPath(import.meta.url));
const out = (name: string, data: Uint8Array | string) => writeFileSync(join(dir, name), data);

const XP = 'XP INVESTIMENTOS CCTVM S/A';
const NU = 'NU INVEST CORRETORA DE VALORES S.A.';

// B3 Área do Investidor — Negociação
const negociacao: XCell[][] = [
  ['Data do Negócio', 'Tipo de Movimentação', 'Mercado', 'Prazo/Vencimento', 'Instituição', 'Código de Negociação', 'Quantidade', 'Preço', 'Valor'],
  ['02/01/2023', 'Compra', 'Mercado à Vista', '-', XP, 'PETR4', 100, 23.45, 2345],
  ['15/02/2023', 'Compra', 'Mercado Fracionário', '-', XP, 'ITSA4F', 37, 8.92, 330.04],
  [new Date(Date.UTC(2023, 2, 10)), 'Compra', 'Mercado à Vista', '-', NU, 'HGLG11', 10, 160.5, 1605],
  ['20/04/2023', 'Venda', 'Mercado à Vista', '-', XP, 'PETR4', 50, 25.1, 1255],
  ['05/05/2023', 'Compra', 'Opção de Compra', '19/05/2023', XP, 'PETRE250', 100, 0.5, 50],
  ['12/06/2023', 'Compra', 'Mercado à Vista', '-', NU, 'BOVA11', 3, 'R$ 112,40', 'R$ 337,20'],
];
out('b3-negociacao.xlsx', writeXlsx([{ name: 'Negociação', rows: negociacao }]));

// B3 Área do Investidor — Movimentação
const movimentacao: XCell[][] = [
  ['Entrada/Saída', 'Data', 'Movimentação', 'Produto', 'Instituição', 'Quantidade', 'Preço unitário', 'Valor da Operação'],
  ['Credito', '04/01/2023', 'Transferência - Liquidação', 'PETR4 - PETROLEO BRASILEIRO S.A. PETROBRAS', XP, 100, 23.45, 2345],
  ['Credito', '17/02/2023', 'Transferência - Liquidação', 'ITSA4 - ITAUSA S.A.', XP, 37, 8.92, 330.04],
  ['Credito', '14/03/2023', 'Transferência - Liquidação', 'HGLG11 - CSHG LOGISTICA FDO INV IMOB - FII', NU, 10, 160.5, 1605],
  ['Credito', '14/04/2023', 'Rendimento', 'HGLG11 - CSHG LOGISTICA FDO INV IMOB - FII', NU, 10, 1.1, 11],
  ['Credito', '20/04/2023', 'Juros Sobre Capital Próprio', 'ITSA4 - ITAUSA S.A.', XP, 37, 0.0149, 0.55],
  ['Credito', '20/04/2023', 'Dividendo', 'PETR4 - PETROLEO BRASILEIRO S.A. PETROBRAS', XP, 100, 1.89, 189],
  ['Credito', '20/04/2023', 'Dividendo - Transferido', 'PETR4 - PETROLEO BRASILEIRO S.A. PETROBRAS', XP, 100, 1.89, 189],
  ['Debito', '24/04/2023', 'Transferência - Liquidação', 'PETR4 - PETROLEO BRASILEIRO S.A. PETROBRAS', XP, 50, 25.1, 1255],
  ['Credito', '15/05/2023', 'Desdobro', 'ITSA4 - ITAUSA S.A.', XP, 37, '-', '-'],
  ['Credito', '20/06/2023', 'Bonificação em Ativos', 'ITSA4 - ITAUSA S.A.', XP, 7, 18.97, '-'],
  ['Credito', '01/07/2023', 'Atualização', 'Tesouro Selic 2029', NU, 1, '-', '-'],
  ['Credito', '15/07/2023', 'Compra / Venda', 'Tesouro IPCA+ 2035', NU, 0.5, 2150.3, 1075.15],
  ['Credito', '01/08/2023', 'Direito de Subscrição', 'ITSA1 - ITAUSA S.A.', XP, 2, '-', '-'],
  ['Credito', '10/08/2023', 'Transferência', 'VALE3 - VALE S.A.', NU, 30, '-', '-'],
  ['Credito', '20/09/2023', 'Desdobro', 'BBAS3 - BANCO DO BRASIL S.A.', XP, 100, '-', '-'],
  ['Debito', '15/10/2023', 'Leilão de Fração', 'ITSA4 - ITAUSA S.A.', XP, 0.4, 9.5, 3.8],
  ['Credito', '01/11/2023', 'Empréstimo', 'PETR4 - PETROLEO BRASILEIRO S.A. PETROBRAS', XP, 50, '-', '-'],
];
out('b3-movimentacao.xlsx', writeXlsx([{ name: 'Movimentação', rows: movimentacao }]));

// eToro account statement (several sheets, the useful one is "Account Activity")
const etoro: XCell[][] = [
  ['Date', 'Type', 'Details', 'Amount', 'Units', 'Realized Equity Change', 'Realized Equity', 'Balance', 'Position ID', 'Asset type', 'NWA'],
  ['02/01/2023 10:00:00', 'Deposit', '1000 USD', 1000, '-', 1000, 1000, 1000, '-', '-', 0],
  ['03/01/2023 14:30:05', 'Open Position', 'AAPL/USD', 250, 2, 0, 1000, 750, '2412345678', 'Stocks', 0],
  ['04/01/2023 09:00:00', 'Open Position', 'BTC/USD', 100, 0.006, 0, 1000, 650, '2412345679', 'Crypto', 0],
  ['05/01/2023 11:00:00', 'Open Position', 'EURUSD/USD', 50, 46.2, 0, 1000, 600, '2412345680', 'CFD', 0],
  ['16/02/2023 08:00:00', 'Dividend', 'AAPL/USD', 0.35, '-', 0.35, 1000.35, 600.35, '2412345678', 'Stocks', 0],
  ['20/03/2023 10:15:00', 'Open Position', 'SAP.DE/EUR', 120, 1, 0, 1000.35, 480.35, '2412345681', 'Stocks', 0],
  ['15/06/2023 16:00:00', 'Position closed', 'AAPL/USD', 370, 2, 120, 1120.35, 850.35, '2412345678', 'Stocks', 0],
  ['01/07/2023 12:00:00', 'Withdraw Fee', '-', -5, '-', -5, 1115.35, 845.35, '-', '-', 0],
  ['01/07/2023 12:00:00', 'Withdraw Request', '-', -500, '-', 0, 1115.35, 345.35, '-', '-', 0],
];
out(
  'etoro-account-statement.xlsx',
  writeXlsx([
    { name: 'Account Summary', rows: [['Details', ''], ['Name', 'Juan Pérez'], ['Currency', 'USD']] },
    { name: 'Closed Positions', rows: [['Position ID', 'Action', 'Amount', 'Units', 'Open Date', 'Close Date'], ['2412345678', 'Buy Apple', 250, 2, '03/01/2023 14:30:05', '15/06/2023 16:00:00']] },
    { name: 'Account Activity', rows: etoro },
  ]),
);

// Colombian brokerage statement, Windows-1252, ';' delimiter, comma decimals, preamble + totals.
const extracto = [
  'DAVIVIENDA CORREDORES S.A. Comisionista de Bolsa',
  'Extracto de movimientos - Cuenta de inversión',
  'Cliente: JUAN PÉREZ;Identificación: 1.020.304.050',
  'Periodo: 01/01/2024 - 31/03/2024',
  '',
  'Fecha;Operación;Especie;Descripción;Cantidad;Precio;Valor bruto;Comisión;IVA;Retención en la fuente;Valor neto',
  '02/01/2024;Consignación;;Abono por transferencia;;;5.000.000,00;;;;5.000.000,00',
  '03/01/2024;Compra;ECOPETROL;ECOPETROL S.A.;1.000;2.450,00;2.450.000,00;7.350,00;1.396,50;;2.458.746,50',
  '15/01/2024;Compra;PFBCOLOM;BANCOLOMBIA S.A. PREFERENCIAL;50;32.980,00;1.649.000,00;4.947,00;939,93;;1.654.886,93',
  '20/02/2024;Venta;ECOPETROL;ECOPETROL S.A.;400;2.520,00;1.008.000,00;3.024,00;574,56;;1.004.401,44',
  '15/03/2024;Pago de dividendos;ECOPETROL;Dividendo ordinario 2023;600;312,00;187.200,00;;;18.720,00;168.480,00',
  '20/03/2024;GMF 4x1000;;Gravamen a los movimientos financieros;;;;;;4.000,00;-4.000,00',
  '28/03/2024;Retiro;;Transferencia a cuenta de ahorros;;;-1.000.000,00;;;;-1.000.000,00',
  ';;;;;;;;;;',
  'Total movimientos;;;;;;;;;;',
].join('\r\n');
out('extracto-davivienda-latin1.csv', encodeWindows1252(extracto));

// Brazilian brokerage notes summarized, Windows-1252, ';' delimiter, comma decimals.
const notas = [
  'Data pregão;Nota;Corretora;C/V;Código;Especificação do título;Quantidade;Preço;Valor;Taxa de liquidação;Emolumentos;Corretagem;ISS;IRRF',
  '02/01/2023;123456;XP Investimentos;C;PETR4;PETROBRAS PN N2;100;23,45;2.345,00;0,59;0,12;4,90;0,24;0,00',
  '02/01/2023;123456;XP Investimentos;C;VALE3;VALE ON NM;20;88,10;1.762,00;0,59;0,12;4,90;0,24;0,00',
  '15/03/2023;123789;XP Investimentos;V;PETR4;PETROBRAS PN N2;50;25,10;1.255,00;0,31;0,06;4,90;0,24;0,06',
  '15/03/2023;123790;Clear;C;ITSA4;ITAUSA PN N1;200;8,95;1.790,00;0,45;0,09;0,00;0,00;0,00',
].join('\r\n');
out('nota-corretagem-latin1.csv', encodeWindows1252(notas));

console.log('fixtures written to', dir);
