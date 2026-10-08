/**
 * Regression tests for the round-2 review (reviews/importers-r2.md, gaps I21–I29 and re-opened I2/I3/I4/I13/I20).
 * Inputs reproduce the reviewer's adversarial scripts (scratchpad/review-imp/t5..t10).
 */
import type { Instrument, Transaction } from '@pm/core';
import { describe, expect, it } from 'vitest';
import {
  accountKey,
  createIbkrFlexSyncHandler,
  createTokenVault,
  importFile,
  importFlexXml,
  importText,
  MemoryCredentialStore,
  runIbkrFlexSyncJobs,
  sinacorSuggestions,
  sinacorTicker,
  tesouroId,
  type ImportResult,
} from '../src';
import { writePdf, type PdfText } from './helpers/pdf-writer';
import { writeXlsx } from './helpers/xlsx-writer';
import { byLine } from './helpers/load';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const O = { portfolioId: 'p' };
const txs = (r: ImportResult) => r.transactions;
const ws = (name: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'ibkr-flex-ws', name), 'utf8');

describe('I21 — duplicates respect accounts and never drop legitimate in-file repeats', () => {
  it('B3 Negociação: 3 identical lots (2 XP + 1 Nu) → 300 shares', async () => {
    const neg = writeXlsx([{ name: 'Negociação', rows: [
      ['Data do Negócio', 'Tipo de Movimentação', 'Mercado', 'Prazo/Vencimento', 'Instituição', 'Código de Negociação', 'Quantidade', 'Preço', 'Valor'],
      ['04/03/2024', 'Compra', 'Mercado à Vista', '-', 'XP INVESTIMENTOS', 'ITSA4', 100, 10, 1000],
      ['04/03/2024', 'Compra', 'Mercado à Vista', '-', 'XP INVESTIMENTOS', 'ITSA4', 100, 10, 1000],
      ['04/03/2024', 'Compra', 'Mercado à Vista', '-', 'NU INVEST', 'ITSA4', 100, 10, 1000],
    ] }]);
    const r = await importFile({ data: neg }, O);
    expect(txs(r).reduce((s, t) => s + (t.quantity ?? 0), 0)).toBe(300);
    expect(r.stats.possibleDuplicates).toBe(0);
    expect(byLine(r, 3).issues.find((i) => i.code === 'POSSIBLE_DUPLICATE_IN_FILE')?.severity).toBe('info');
    expect(byLine(r, 4).issues.some((i) => i.code === 'POSSIBLE_DUPLICATE_IN_FILE')).toBe(false); // other institution
  });
  it('B3 Movimentação: the same dividend at two institutions is two dividends', async () => {
    const mov = writeXlsx([{ name: 'Movimentação', rows: [
      ['Entrada/Saída', 'Data', 'Movimentação', 'Produto', 'Instituição', 'Quantidade', 'Preço unitário', 'Valor da Operação'],
      ['Credito', '20/04/2024', 'Dividendo', 'PETR4 - PETROLEO BRASILEIRO S.A. PETROBRAS', 'XP INVESTIMENTOS', 100, 1.89, 189],
      ['Credito', '20/04/2024', 'Dividendo', 'PETR4 - PETROLEO BRASILEIRO S.A. PETROBRAS', 'NU INVEST', 100, 1.89, 189],
    ] }]);
    const r = await importFile({ data: mov }, O);
    expect(txs(r).reduce((s, t) => s + (t.amount ?? 0), 0)).toBe(378);
  });
  it('two identical GMF charges the same day are both kept', async () => {
    const r = await importText('Fecha;Concepto;Valor;Moneda\n04/03/2024;GMF 4x1000;-400;COP\n04/03/2024;GMF 4x1000;-400;COP\n05/03/2024;Retiro;-100000;COP\n', { ...O, dateFormat: 'DMY' });
    expect(txs(r).filter((t) => t.type === 'TAX')).toHaveLength(2);
  });
  it('deposits to two brokers are not duplicates; the same account from another source is', async () => {
    const existing: Transaction[] = [{ id: 'd1', portfolioId: 'p', date: '2024-03-04', type: 'DEPOSIT', currency: 'COP', amount: 1_000_000, account: 'Trii', source: 'import:extracto-co' }];
    const other = await importText('date,type,currency,amount,account\n2024-03-06,DEPOSIT,COP,1000000,Davivienda Corredores\n', { ...O, existingTransactions: existing });
    expect(other.stats).toMatchObject({ imported: 1, possibleDuplicates: 0 });
    const same = await importText('date,type,currency,amount,account\n2024-03-05,DEPOSIT,COP,1000000,TRII S.A.S.\n', { ...O, existingTransactions: existing });
    expect(same.stats.possibleDuplicates).toBe(1);
  });
  it('each existing transaction absorbs at most one imported row', async () => {
    const first = await importText('date,type,currency,amount\n2024-03-04,TAX,COP,400\n', O);
    // A later statement (other source) has the known GMF and a second, new one the same day.
    const r = await importText('Fecha;Concepto;Valor;Moneda\n04/03/2024;GMF 4x1000;-400;COP\n04/03/2024;GMF 4x1000;-400;COP\n', { ...O, dateFormat: 'DMY', existingTransactions: first.transactions });
    expect(r.stats).toMatchObject({ imported: 1, possibleDuplicates: 1 });
  });
  it('normalizes institution names', () => {
    expect(accountKey('XP INVESTIMENTOS CCTVM S/A')).toBe(accountKey('XP'));
    expect(accountKey('NU INVEST CORRETORA DE VALORES S.A.')).toBe('nu');
    expect(accountKey('Davivienda Corredores')).not.toBe(accountKey('Trii'));
  });
});

describe('I22 — Flex XML corporate actions, summary rows and sales tax', () => {
  const xml = `<FlexQueryResponse queryName="q" type="AF"><FlexStatements count="1"><FlexStatement accountId="U1" fromDate="20240101" toDate="20241231">
<Trades>
<Trade accountId="U1" currency="USD" assetCategory="STK" symbol="NVDA" isin="US67066G1040" listingExchange="NASDAQ" tradeID="1" transactionID="11" tradeDate="20240103" quantity="10" tradePrice="500" proceeds="-5000" ibCommission="-1" ibCommissionCurrency="USD" buySell="BUY" levelOfDetail="EXECUTION"/>
<Trade accountId="U1" currency="USD" assetCategory="STK" symbol="NVDA" isin="US67066G1040" listingExchange="NASDAQ" tradeID="1" transactionID="" tradeDate="20240103" quantity="10" tradePrice="500" proceeds="-5000" ibCommission="-1" ibCommissionCurrency="USD" buySell="BUY" levelOfDetail="ORDER"/>
</Trades>
<CashTransactions>
<CashTransaction accountId="U1" currency="USD" assetCategory="STK" symbol="NVDA" isin="US67066G1040" dateTime="20240327" amount="0.4" type="Dividends" description="NVDA(US67066G1040) CASH DIVIDEND USD 0.04 PER SHARE" transactionID="21" levelOfDetail="DETAIL"/>
<CashTransaction accountId="U1" currency="USD" assetCategory="STK" symbol="NVDA" isin="US67066G1040" dateTime="20240327" amount="-0.12" type="Withholding Tax" description="NVDA(US67066G1040) CASH DIVIDEND - US TAX" transactionID="22" levelOfDetail="DETAIL"/>
<CashTransaction accountId="U1" currency="USD" assetCategory="" symbol="" dateTime="20240327" amount="0.4" type="Dividends" description="" transactionID="" levelOfDetail="SUMMARY"/>
</CashTransactions>
<CorporateActions>
<CorporateAction accountId="U1" currency="USD" assetCategory="STK" symbol="NVDA" isin="US67066G1040" reportDate="20240610" dateTime="20240607;202500" description="NVDA(US67066G1040) SPLIT 10 FOR 1 (NVDA, NVIDIA CORP, US67066G1040)" quantity="90" type="FS" transactionID="31"/>
<CorporateAction accountId="U1" currency="USD" assetCategory="STK" symbol="XYZ" isin="US0000000001" reportDate="20240710" dateTime="20240709;202500" description="XYZ(US0000000001) SPINOFF 1 FOR 10 (ABC, ABC CORP)" quantity="5" type="SO" transactionID="32"/>
</CorporateActions>
<SalesTaxes><SalesTax accountId="U1" currency="USD" date="20240401" salesTax="-0.5" description="VAT on market data" transactionID="41"/></SalesTaxes>
<StmtFunds><StatementOfFundsLine accountId="U1" currency="USD" date="20240401" amount="1"/></StmtFunds>
</FlexStatement></FlexStatements></FlexQueryResponse>`;
  it('imports the split, the detail dividend once, the sales tax; reports the rest', async () => {
    const r = await importFlexXml(xml, O);
    expect(txs(r).map((t) => [t.type, t.instrumentId ?? '', t.quantity ?? t.ratio ?? t.amount])).toEqual([
      ['BUY', 'XNAS:NVDA', 10], ['DIVIDEND', 'XNAS:NVDA', 0.4], ['SPLIT', 'XNAS:NVDA', 10], ['TAX', '', 0.5],
    ]);
    expect(txs(r).find((t) => t.type === 'DIVIDEND')!.taxes).toBe(0.12);
    expect(r.corporateActions).toEqual([expect.objectContaining({ kind: 'spinoff', date: '2024-07-09' })]);
    expect(r.warnings.filter((w) => w.code === 'UNHANDLED_SECTION').map((w) => w.params)).toEqual([{ section: 'StatementOfFundsLine', count: 1 }]);
  });
});

describe('I23 — SINACOR name → ticker by exact nome de pregão', () => {
  it.each([
    ['GERDAU MET PN N1', 'GOAU4'], ['GERDAU PN N1', 'GGBR4'], ['ISHARES BOVA CI ER', 'BOVA11'], ['APPLE DRN', 'AAPL34'],
    ['FII KINEA RI KNCR11 CI ER', 'KNCR11'], ['ITAUUNIBANCO PN EJ N1', 'ITUB4'], ['PETROBRAS PN EDJ N2', 'PETR4'], ['ELETROBRAS PNB N1', 'ELET6'],
  ])('%s → %s', (spec, ticker) => expect(sinacorTicker(spec)).toBe(ticker));
  it('asks instead of guessing (no prefix matches), with suggestions', () => {
    expect(sinacorTicker('GERDAU METALURGICA PN')).toBeUndefined();
    expect(sinacorSuggestions('GERDAU XYZ PN')).toEqual(['GGBR4', 'GOAU4']);
  });
  it('a full note: ETF, BDR, GERDAU MET, FII, day trade', async () => {
    const r = await importFile({ data: notePdf() }, O);
    expect(txs(r).map((t) => t.instrumentId)).toEqual(['BVMF:BOVA11', 'BVMF:GOAU4', 'BVMF:AAPL34', 'BVMF:KNCR11', 'BVMF:ITUB4', 'BVMF:PETR4', 'BVMF:PETR4', 'BVMF:WEGE3']);
  });
  it('unknown specifications come back as questions for the UI', async () => {
    const r = await importFile({ data: notePdf([['C', 'VISTA', 'EMPRESA NOVA ON NM', '', '10', '5,00', '50,00', 'D']]) }, O);
    expect(r.unknownSecurities).toEqual([{ key: 'EMPRESA NOVA ON NM', lines: [expect.any(Number)], suggestions: [] }]);
    const answered = await importFile({ data: notePdf([['C', 'VISTA', 'EMPRESA NOVA ON NM', '', '10', '5,00', '50,00', 'D']]) }, { ...O, securityMap: { 'EMPRESA NOVA ON NM': 'NOVA3' } });
    expect(txs(answered)[0]!.instrumentId).toBe('BVMF:NOVA3');
  });
});

type Tr = [string, string, string, string, string, string, string, string];
const DEFAULT_TRADES: Tr[] = [
  ['C', 'VISTA', 'ISHARES BOVA CI ER', '', '50', '126,30', '6.315,00', 'D'],
  ['C', 'VISTA', 'GERDAU MET PN N1', '', '300', '10,95', '3.285,00', 'D'],
  ['C', 'FRACIONARIO', 'APPLE DRN', '', '7', '48,10', '336,70', 'D'],
  ['C', 'VISTA', 'FII KINEA RI KNCR11 CI ER', '', '20', '97,40', '1.948,00', 'D'],
  ['V', 'VISTA', 'ITAUUNIBANCO PN EJ N1', '#', '100', '33,12', '3.312,00', 'C'],
  ['C', 'VISTA', 'PETROBRAS PN EDJ N2', 'D', '100', '37,00', '3.700,00', 'D'],
  ['V', 'VISTA', 'PETROBRAS PN EDJ N2', 'D', '100', '37,50', '3.750,00', 'C'],
  ['C', 'VISTA', 'WEG ON NM', '', '1.000', '35,20', '35.200,00', 'D'],
];
const DEFAULT_FIN: [string, string, string?][] = [
  ['Taxa de liquidação', '15,21', 'D'], ['Emolumentos', '3,04', 'D'], ['Taxa Operacional', '0,00', 'D'],
  ['I.R.R.F. s/ operações, base R$3.312,00', '0,16'], ['IRRF Day Trade: Base R$ 50,00 Projeção R$ 0,50', '0,50'],
  ['Líquido para 08/03/2024', '43.741,61', 'D'],
];
function notePdf(trades: Tr[] = DEFAULT_TRADES, fin = DEFAULT_FIN, opts: { stacked?: boolean; password?: string; nr?: string } = {}): Uint8Array {
  const nr = opts.nr ?? '55443322';
  const t: PdfText[] = [[230, 815, 'NOTA DE CORRETAGEM', 11]];
  if (opts.stacked) t.push([380, 795, 'Nr. nota'], [460, 795, nr], [380, 783, 'Folha'], [460, 783, '1'], [380, 771, 'Data pregão'], [460, 771, '06/03/2024']);
  else t.push([380, 795, 'Nr. nota'], [450, 795, 'Folha'], [500, 795, 'Data pregão'], [380, 783, nr], [450, 783, '1'], [500, 783, '06/03/2024']);
  t.push([40, 755, 'BTG PACTUAL CTVM S/A', 9], [40, 718, 'Negócios realizados', 9], [40, 705, 'Q Negociação'], [105, 705, 'C/V'], [125, 705, 'Tipo mercado'],
    [225, 705, 'Especificação do título'], [345, 705, 'Obs. (*)'], [390, 705, 'Quantidade'], [440, 705, 'Preço / Ajuste'], [500, 705, 'Valor Operação'], [565, 705, 'D/C']);
  let y = 692;
  for (const [side, market, spec, obs, qty, price, value, dc] of trades) {
    t.push([40, y, 'B3 RV LISTADO'], [108, y, side], [125, y, market], [225, y, spec]);
    if (obs) t.push([355, y, obs]);
    t.push([395, y, qty], [445, y, price], [505, y, value], [568, y, dc]);
    y -= 12;
  }
  y -= 12;
  t.push([320, y, 'Resumo Financeiro', 9]);
  y -= 13;
  for (const [l, v, dc] of fin) {
    t.push([320, y, l], [505, y, v]);
    if (dc) t.push([560, y, dc]);
    y -= 12;
  }
  return writePdf([t], opts.password ? { userPassword: opts.password } : {});
}

describe('I24 / I25 — SINACOR layouts, password, IRRF day trade, credited costs, option costs', () => {
  it('stacked header layout (Nu, Inter)', async () => {
    const r = await importFile({ data: notePdf([['C', 'VISTA', 'VALE ON NM', '', '10', '60,00', '600,00', 'D']], [['Taxa de liquidação', '0,15', 'D']], { stacked: true }) }, O);
    expect(txs(r)).toEqual([expect.objectContaining({ date: '2024-03-06', instrumentId: 'BVMF:VALE3', fees: 0.15 })]);
  });
  it('a detected note without readable trades is reported', async () => {
    const r = await importFile({ data: notePdf([], [['Taxa de liquidação', '0,15', 'D']]) }, O);
    expect(r.warnings.some((w) => w.code === 'NOTE_WITHOUT_TRADES')).toBe(true);
  });
  it('password-protected notes: asks, rejects a wrong password, imports with the right one', async () => {
    const pdf = notePdf([['C', 'VISTA', 'VALE ON NM', '', '10', '60,00', '600,00', 'D']], [], { password: '123' });
    const ask = await importFile({ data: pdf }, O);
    expect(ask).toMatchObject({ needsPassword: 'required', errors: [expect.objectContaining({ code: 'PDF_PASSWORD_REQUIRED' })] });
    expect((await importFile({ data: pdf }, { ...O, pdfPassword: '999' })).needsPassword).toBe('incorrect');
    expect(txs(await importFile({ data: pdf }, { ...O, pdfPassword: '123' }))).toHaveLength(1);
  });
  it('scanned PDFs (no text) are reported', async () => {
    expect((await importFile({ data: writePdf([[]]) }, O)).errors[0]!.code).toBe('PDF_NO_TEXT');
  });
  it('IRRF s/ operações goes to swing sales and IRRF day trade to day-trade sales', async () => {
    const r = await importFile({ data: notePdf() }, O);
    const itub = txs(r).find((t) => t.instrumentId === 'BVMF:ITUB4')!;
    const petrSell = txs(r).find((t) => t.instrumentId === 'BVMF:PETR4' && t.type === 'SELL')!;
    expect(itub.taxes).toBe(0.16);
    expect(petrSell.taxes).toBe(0.5);
    expect(petrSell.note).toContain('day trade');
    expect(r.warnings.some((w) => w.code === 'NOTA_TOTALS_MISMATCH')).toBe(false);
  });
  it('a credited cost ("C") reduces costs', async () => {
    const r = await importFile({ data: notePdf([['C', 'VISTA', 'MAGAZ LUIZA ON NM', '', '10.000', '2,1300', '21.300,00', 'D']], [['Taxa de liquidação', '5,32', 'D'], ['Taxa Operacional', '4,90', 'C'], ['Líquido para 12/03/2024', '21.300,42', 'D']]) }, O);
    expect(txs(r)[0]).toMatchObject({ instrumentId: 'BVMF:MGLU3', fees: 0.42 });
    expect(r.warnings.some((w) => w.code === 'NOTA_TOTALS_MISMATCH')).toBe(false);
  });
  it('option costs (and their share of common costs) are not loaded onto spot trades', async () => {
    const r = await importFile({ data: notePdf([
      ['C', 'OPCAO DE COMPRA', 'PETRC400 PN', '', '1.000', '1,00', '1.000,00', 'D'],
      ['C', 'VISTA', 'PETROBRAS PN N2', '', '100', '37,00', '3.700,00', 'D'],
    ], [['Taxa de liquidação', '1,18', 'D'], ['Taxa de termo/opções', '3,70', 'D'], ['Emolumentos', '0,50', 'D'], ['Líquido para 08/03/2024', '4.705,38', 'D']]) }, O);
    expect(txs(r)[0]!.fees).toBeCloseTo((1.68 * 3700) / 4700, 6); // ≈ 1,32
  });
  it('two notes with identical trades the same day are both imported', async () => {
    const a = notePdf([['C', 'VISTA', 'PETROBRAS PN N2', '', '100', '37,00', '3.700,00', 'D']], [['Taxa de liquidação', '0,93', 'D']], { nr: '1001' });
    const b = notePdf([['C', 'VISTA', 'PETROBRAS PN N2', '', '100', '37,00', '3.700,00', 'D']], [['Taxa de liquidação', '0,93', 'D']], { nr: '1002' });
    const ra = await importFile({ data: a }, O);
    const rb = await importFile({ data: b }, { ...O, existingTransactions: ra.transactions });
    // A different nota number is a different trade: never a duplicate of the first note.
    expect(rb.stats).toMatchObject({ imported: 1, possibleDuplicates: 0 });
    // Re-importing the same note is still caught.
    expect((await importFile({ data: a }, { ...O, existingTransactions: [...ra.transactions, ...rb.transactions] })).stats.imported).toBe(0);
  });
});

describe('I26 — CDT rates and dates', () => {
  const cdt = (items: PdfText[]) => importFile({ data: writePdf([[[180, 800, 'CERTIFICADO DE DEPÓSITO A TÉRMINO', 11], ...items]]) }, O);
  it('converts N.M.V. to E.A.', async () => {
    const r = await cdt([[40, 770, 'Entidad emisora:'], [180, 770, 'Banco de Bogotá S.A.'], [40, 740, 'Valor nominal:'], [180, 740, '$ 20.000.000'],
      [40, 725, 'Tasa nominal:'], [180, 725, '10,80% N.M.V.'], [40, 710, 'Fecha de apertura:'], [180, 710, '01/02/2024'], [40, 695, 'Fecha de vencimiento:'], [180, 695, '01/02/2025']]);
    expect(r.instruments[0]!.accrual!.annualRate).toBeCloseTo(0.1135, 4);
    expect(byLine(r, 1).issues.map((i) => i.code)).toContain('CDT_RATE_NOMINAL');
  });
  it('"intereses al vencimiento" is not the maturity; withholding is read', async () => {
    const r = await cdt([[40, 770, 'Entidad emisora:'], [180, 770, 'Bancolombia S.A.'], [40, 755, 'Modalidad de pago de intereses: al vencimiento'],
      [40, 740, 'Fecha de apertura: 15/01/2024'], [40, 725, 'Fecha de vencimiento: 15/07/2024'], [40, 710, 'Valor de la inversión: $ 10.000.000,00'],
      [40, 695, 'Tasa: 9,50% E.A.'], [40, 680, 'Retención en la fuente: 4%']]);
    expect(r.instruments[0]!.accrual).toMatchObject({ annualRate: 0.095, issueDate: '2024-01-15', maturity: '2024-07-15' });
    expect(txs(r)[0]!.note).toContain('retención 4%');
  });
  it('maturity not after issue → error, never a 0-day CDT', async () => {
    const r = await cdt([[40, 770, 'Entidad emisora:'], [180, 770, 'Bancolombia S.A.'], [40, 740, 'Fecha de apertura: 15/01/2024'],
      [40, 725, 'Fecha de vencimiento: 15/01/2024'], [40, 710, 'Valor de la inversión: $ 10.000.000,00'], [40, 695, 'Tasa: 9,50% E.A.']]);
    expect(r.errors[0]!.code).toBe('CDT_INVALID_DATES');
  });
});

describe('I4 — weak date evidence asks', () => {
  it('a statement grouped by security (MDY happens to be ordered) asks, suggesting DD/MM', async () => {
    const r = await importText('Fecha;Operación;Especie;Cantidad;Precio;Moneda\n01/05/2024;Compra;ECOPETROL;10;2400;COP\n02/03/2024;Compra;ECOPETROL;10;2400;COP\n03/04/2024;Compra;ISA;10;17000;COP\n04/06/2024;Compra;ISA;10;17000;COP\n', O);
    expect(r.dateFormatCandidates).toEqual(['DMY', 'MDY']);
    expect(txs(r)).toEqual([]);
  });
  it('a long chronological Spanish statement confirms DD/MM by itself', async () => {
    const rows = ['05/01', '01/02', '10/03', '02/04', '11/05', '03/06', '12/07', '04/08', '09/09'].map((d) => `${d}/2024;Compra;ECOPETROL;10;2400;COP`).join('\n');
    const r = await importText(`Fecha;Operación;Especie;Cantidad;Precio;Moneda\n${rows}\n`, O);
    expect(r.needsConfirmation).toBeUndefined();
    expect(txs(r)[1]!.date).toBe('2024-02-01');
  });
});

describe('I3 — mixed currencies: ambiguous values in a minority currency ask per row', () => {
  const csv = 'Fecha;Operación;Especie;Cantidad;Precio;Moneda\n15/01/2024;Compra;ECOPETROL;1.000;2.450;COP\n16/01/2024;Compra;ECOPETROL;500;2.460;COP\n17/01/2024;Compra;SIRI;1.000;1.725;USD\n';
  it('only the USD row waits; the COP rows import', async () => {
    const r = await importText(csv, O);
    expect(txs(r).map((t) => t.instrumentId)).toEqual(['XBOG:ECOPETROL', 'XBOG:ECOPETROL']);
    expect(byLine(r, 4).status).toBe('pending');
    expect(r.needsConfirmation).toEqual([expect.objectContaining({ kind: 'numberFormat', scope: 'rows', affectedLines: [4] })]);
  });
  it('answered per row, or by a reference price', async () => {
    const r = await importText(csv, { ...O, rowNumberFormats: { 4: 'dot' } });
    expect(txs(r)[2]).toMatchObject({ instrumentId: 'XNYS:SIRI', quantity: 1, price: 1.725 });
    const ref = await importText(csv, { ...O, referencePrice: (h) => (h.symbol === 'SIRI' ? 1.7 : undefined) });
    expect(txs(ref)[2]).toMatchObject({ price: 1.725 });
  });
});

describe('I2 — mountable sync handler with an encrypted token vault', () => {
  const recorded = () => {
    const bodies = [ws('send-request.xml'), ws('statement.xml')];
    return async () => ({ ok: true, status: 200, text: async () => bodies.shift()! });
  };
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    new Request('https://app.local/api/sync/ibkr-flex', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  it('save → sync → delete; the token is stored encrypted', async () => {
    const store = new MemoryCredentialStore();
    const handler = createIbkrFlexSyncHandler({ vault: await createTokenVault('a-long-test-secret-0123456789'), store, fetch: recorded(), sleep: async () => {} });
    const saved = await handler(post({ action: 'save', token: 'tok-SECRET-123', queryId: '987654' }));
    expect(saved.status).toBe(200);
    expect(store.rawValues().join()).not.toContain('tok-SECRET-123');
    const res = await handler(post({ action: 'sync', portfolioId: 'p1' }));
    expect(res.status).toBe(200);
    const result = (await res.json()) as ImportResult;
    expect(result.stats.imported).toBeGreaterThan(5);
    expect(result.transactions.every((t) => t.source === 'import:ibkr-flex')).toBe(true);
    expect((await handler(post({ action: 'delete' }))).status).toBe(200);
    expect((await handler(post({ action: 'sync', portfolioId: 'p1' }))).status).toBe(404);
  });
  it('authorization, bad requests and Flex errors map to HTTP statuses', async () => {
    const vault = await createTokenVault('a-long-test-secret-0123456789');
    const store = new MemoryCredentialStore();
    const expired = async () => ({ ok: true, status: 200, text: async () => ws('token-expired.xml') });
    const handler = createIbkrFlexSyncHandler({ vault, store, fetch: expired, authorize: (req) => req.headers.get('x-user') ?? undefined });
    expect((await handler(post({ action: 'save', token: 't', queryId: 'q' }))).status).toBe(401);
    expect((await handler(post({ action: 'nope' }, { 'x-user': 'u1' }))).status).toBe(400);
    await handler(post({ action: 'save', token: 't', queryId: 'q' }, { 'x-user': 'u1' }));
    const res = await handler(post({ action: 'sync', portfolioId: 'p' }, { 'x-user': 'u1' }));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: { code: 'FLEX_1012', message: expect.stringMatching(/expiró/) } });
    // Another user cannot read u1's credential.
    expect((await handler(post({ action: 'sync', portfolioId: 'p' }, { 'x-user': 'u2' }))).status).toBe(404);
  });
  it('scheduled jobs (daily cron) sync and persist, isolating failures', async () => {
    const vault = await createTokenVault('a-long-test-secret-0123456789');
    const store = new MemoryCredentialStore();
    const h = createIbkrFlexSyncHandler({ vault, store, authorize: () => 'u1' });
    await h(post({ action: 'save', token: 't', queryId: 'q' }));
    const saved: ImportResult[] = [];
    const out = await runIbkrFlexSyncJobs(
      [
        { userId: 'u1', portfolioId: 'p1', load: async () => ({ transactions: [], instruments: [] }), save: async (r) => void saved.push(r) },
        { userId: 'u9', portfolioId: 'p9', load: async () => ({ transactions: [], instruments: [] }), save: async () => {} },
      ],
      { vault, store, fetch: recorded(), sleep: async () => {} },
    );
    expect(out[0]).toMatchObject({ ok: true, imported: saved[0]!.stats.imported });
    expect(out[1]).toMatchObject({ ok: false, error: expect.stringMatching(/credenciales/) });
  });
});

describe('I28 — ids that @pm/market-data understands', () => {
  it('unknown US venue → XNYS (market-data default), one instrument per US symbol', async () => {
    const r = await importText('date,type,symbol,quantity,price,currency\n2024-01-02,BUY,ENB,10,35,USD\n', O);
    expect(txs(r)[0]!.instrumentId).toBe('XNYS:ENB');
    expect(r.instruments[0]!.providerSymbols!.yahoo).toBe('ENB');
  });
  it('Tesouro Direto → TD:<code>-<maturity>', () => {
    expect(tesouroId('Tesouro IPCA+ 2035')!.id).toBe('TD:NTNBP-2035-05-15');
    expect(tesouroId('Tesouro IPCA+ com Juros Semestrais 2040')!.id).toBe('TD:NTNB-2040-08-15');
    expect(tesouroId('Tesouro Selic 2029')!.id).toBe('TD:LFT-2029-03-01');
    expect(tesouroId('Tesouro Prefixado 2031')!.id).toBe('TD:LTN-2031-01-01');
    expect(tesouroId('Tesouro Renda+ Aposentadoria Extra 2050')).toBeUndefined();
  });
  it('funds (FIC) resolve by exact name against an injected catalog', async () => {
    const catalog: Instrument[] = [{ id: 'FIC:5-27-1234-1', symbol: '5-27-1234-1', name: 'Fiducuenta', exchange: 'FIC', currency: 'COP', country: 'CO', assetClass: 'fund' }];
    const r = await importText('Fecha;Operación;Producto;Unidades;Valor unidad;Valor;Moneda\n15/01/2024;Aporte;;;;1.000.000,00;COP\n16/01/2024;Compra;Fiducuenta;20,5;24.390,24;500.000,00;COP\n', { ...O, catalog, dateFormat: 'DMY' });
    expect(txs(r).find((t) => t.type === 'BUY')!.instrumentId).toBe('FIC:5-27-1234-1');
  });
});

describe('I13 / I29 / I20', () => {
  it('Fidelity SPAXX (core money market) is cash, not a missing instrument', async () => {
    const fid = '\n\nRun Date,Action,Symbol,Security Description,Security Type,Quantity,Price ($),Commission ($),Fees ($),Accrued Interest ($),Amount ($),Settlement Date\n' +
      '03/15/2024,DIVIDEND RECEIVED FIDELITY GOVERNMENT MONEY MARKET (SPAXX) (Cash),SPAXX,FIDELITY GOVERNMENT MONEY MARKET,Cash,,,,,,2.40,\n' +
      '03/15/2024,REINVESTMENT FIDELITY GOVERNMENT MONEY MARKET (SPAXX) (Cash),SPAXX,FIDELITY GOVERNMENT MONEY MARKET,Cash,2.4,1,,,,-2.40,\n';
    const r = await importText(fid, O);
    expect(r.errors).toEqual([]);
    expect(txs(r)).toEqual([expect.objectContaining({ type: 'INTEREST', amount: 2.4 })]);
    expect(byLine(r, 5).issues[0]!.code).toBe('MONEY_MARKET_SWEEP');
  });
  it('neutral words (Traslado, Liquidación, Transferência) are classified by sign, and flagged when the file has no signs', async () => {
    const head = 'Fecha;Operación;Especie;Cantidad;Precio;Valor;Moneda\n';
    const signed = await importText(`${head}15/01/2024;Traslado;ECOPETROL;100;;;COP\n16/01/2024;Liquidación;ECOPETROL;-100;2.400;240.000;COP\n17/01/2024;Transferência;;;;-50.000;COP\n`, O);
    expect(txs(signed).map((t) => t.type)).toEqual(['TRANSFER_IN', 'SELL', 'WITHDRAWAL']);
    expect(signed.warnings.some((w) => w.code === 'DIRECTION_ASSUMED')).toBe(false);
    const unsigned = await importText(`${head}15/01/2024;Traslado;ECOPETROL;100;;;COP\n17/01/2024;Transferência;;;;50.000;COP\n`, O);
    expect(txs(unsigned).map((t) => t.type)).toEqual(['TRANSFER_IN', 'DEPOSIT']);
    expect(byLine(unsigned, 2).issues.map((i) => i.code)).toContain('DIRECTION_ASSUMED');
  });
  it('the holdings section of a PDF statement feeds reconciliation, not movements', async () => {
    const cols = [40, 100, 185, 260, 320, 390, 460, 520];
    const row = (y: number, cells: string[]): PdfText[] => cells.map((c, i) => [cols[i]!, y, c] as PdfText).filter((x) => x[2] !== '');
    const page: PdfText[] = [
      [40, 810, 'trii - Extracto mensual', 11], [40, 795, 'Periodo: 01/03/2024 - 31/03/2024'], [40, 770, 'Movimientos', 9],
      ...row(755, ['Fecha', 'Operación', 'Especie', 'Cantidad', 'Precio', 'Valor bruto', 'Comisión', 'Valor neto']),
      ...row(742, ['18/03/2024', 'Compra', 'ECOPETROL', '1.000', '2.380', '2.380.000', '7.140', '2.387.140']),
      [40, 690, 'Portafolio al cierre', 9],
      ...row(675, ['', 'Especie', 'Cantidad', 'Precio cierre', 'Valor', '', '', '']),
      ...row(662, ['', 'ECOPETROL', '1.000', '2.410', '2.410.000', '', '', '']),
      [40, 630, 'Total portafolio   2.410.000'],
    ];
    const r = await importFile({ data: writePdf([page]) }, O);
    expect(r.errors).toEqual([]);
    expect(txs(r)).toHaveLength(1);
    expect(r.reconciliation).toMatchObject({ asOf: '2024-03-31', positionDifferences: [] });
  });
  it('reconciliation ignores holdings of other brokers', async () => {
    const existing: Transaction[] = [
      { id: 's1', portfolioId: 'p', date: '2023-05-01', type: 'BUY', instrumentId: 'XNYS:KO', quantity: 30, price: 60, amount: 1800, currency: 'USD', account: 'Schwab', source: 'import:schwab' },
      { id: 's0', portfolioId: 'p', date: '2023-05-01', type: 'DEPOSIT', amount: 5000, currency: 'USD', account: 'Schwab', source: 'import:schwab' },
    ];
    const ib = 'Statement,Header,Field Name,Field Value\nStatement,Data,Period,"January 1, 2024 - December 31, 2024"\n' +
      'Trades,Header,DataDiscriminator,Asset Category,Currency,Symbol,Date/Time,Quantity,T. Price,C. Price,Proceeds,Comm/Fee,Basis,Realized P/L,MTM P/L,Code\n' +
      'Trades,Data,Order,Stocks,USD,AAPL,"2024-01-03, 10:30:00",10,185,185,-1850,-1,1851,0,0,O\n' +
      'Deposits & Withdrawals,Header,Currency,Settle Date,Description,Amount\nDeposits & Withdrawals,Data,USD,2024-01-02,Electronic Fund Transfer,2000\n' +
      'Open Positions,Header,DataDiscriminator,Asset Category,Currency,Symbol,Quantity,Mult,Cost Price,Cost Basis,Close Price,Value,Unrealized P/L,Code\n' +
      'Open Positions,Data,Summary,Stocks,USD,AAPL,10,1,185.1,1851,250,2500,649,\n' +
      'Cash Report,Header,Currency Summary,Currency,Total,Securities,Futures,Month to Date,Year to Date,\nCash Report,Data,Ending Cash,USD,149,149,0,,,\n';
    const r = await importText(ib, { ...O, existingTransactions: existing });
    expect(r.reconciliation).toMatchObject({ positionDifferences: [], cashDifferences: [] });
  });
});
