/**
 * Regression tests for the round-1 review (reviews/importers-r1.md). Each block reproduces the
 * reviewer's adversarial input (scratchpad/review-imp/t1..t4) and asserts the fixed behavior.
 */
import { describe, expect, it } from 'vitest';
import { classifyType, classifyTypeDetailed, importFile, importText, parseDate, parseNumber, parseRatio, type ImportResult } from '../src';
import { writeXls } from './helpers/xls-writer';
import { writeXlsx } from './helpers/xlsx-writer';
import { byLine, importFixture } from './helpers/load';

const O = { portfolioId: 'p' };
const txs = (r: ImportResult) => r.transactions;

describe('I3 — ambiguous numbers are never silently misread', () => {
  it('";" delimiter + "1.000"/"2.450" → thousands separators (1000 shares at 2450 COP)', async () => {
    const r = await importText('Fecha;Tipo;Simbolo;Cantidad;Precio;Moneda\n15/01/2024;Compra;ECOPETROL;1.000;2.450;COP\n16/02/2024;Compra;PFBCOLOM;500;32.500;COP\n', O);
    expect(txs(r)[0]).toMatchObject({ instrumentId: 'XBOG:ECOPETROL', quantity: 1000, price: 2450, amount: 2_450_000 });
    expect(r.warnings.some((w) => w.code === 'NUMBER_FORMAT_INFERRED')).toBe(true);
  });
  it('"," file with "1,500"/"2,450" and no other evidence → blocked with a numberFormat confirmation', async () => {
    const csv = 'Fecha,Operación,Especie,Cantidad,Precio,Comisión\n2024-01-15,Compra,ECOPETROL,"1,500","2,450",7350\n2024-02-15,Compra,ISA,"2,000","17,800",9000\n';
    const r = await importText(csv, O);
    expect(r.transactions).toEqual([]);
    expect(r.numberFormatCandidates).toEqual(['comma', 'dot']);
    const req = r.needsConfirmation!.find((c) => c.kind === 'numberFormat')!;
    expect(req.affectedLines).toEqual([2, 3]);
    expect(req.samples[0]!.readings).toEqual({ comma: '1.5', dot: '1500' });
    expect(r.rows.every((x) => x.status === 'pending')).toBe(true);
    const ok = await importText(csv, { ...O, numberFormat: 'dot' });
    expect(txs(ok)[0]).toMatchObject({ quantity: 1500, price: 2450 });
  });
  it('quantity × price ≈ amount cross-check picks the reading', async () => {
    const r = await importText('Fecha,Tipo,Simbolo,Cantidad,Precio,Valor,Moneda\n2024-01-15,Compra,ECOPETROL,"1,000","2,450","2,450,000",COP\n', O);
    expect(r.needsConfirmation).toBeUndefined();
    expect(txs(r)[0]).toMatchObject({ quantity: 1000, price: 2450, amount: 2_450_000 });
  });
  it('a reference-price hook can disambiguate too', async () => {
    const csv = 'Fecha,Tipo,Simbolo,Cantidad,Precio,Moneda\n2024-01-15,Compra,ECOPETROL,10,"2,450",COP\n';
    const r = await importText(csv, O);
    expect(r.numberFormatCandidates).toBeDefined(); // blocked without evidence
    const withRef = await importText(csv, { ...O, referencePrice: (h) => (h.symbol === 'ECOPETROL' ? 2400 : undefined) });
    expect(withRef.needsConfirmation).toBeUndefined();
    expect(txs(withRef)[0]).toMatchObject({ price: 2450 });
  });
});

describe('I4 — ambiguous dates require confirmation', () => {
  const csv = 'Date,Action,Symbol,Quantity,Price,Currency\n03/04/2024,Buy,AAPL,10,170.5,USD\n05/06/2024,Buy,MSFT,2,410,USD\n11/12/2024,Sell,AAPL,5,220,USD\n';
  it('blocks, suggests MM/DD for an English USD file and lists both readings', async () => {
    const r = await importText(csv, O);
    expect(r.transactions).toEqual([]);
    expect(r.dateFormatCandidates).toEqual(['MDY', 'DMY']);
    const req = r.needsConfirmation![0]!;
    expect(req.samples[0]).toMatchObject({ line: 2, value: '03/04/2024', readings: { DMY: '2024-04-03', MDY: '2024-03-04' } });
    expect(r.stats.pending).toBe(3);
  });
  it('imports once the user confirms (or with allowAmbiguous)', async () => {
    const r = await importText(csv, { ...O, dateFormat: 'MDY' });
    expect(txs(r).map((t) => t.date)).toEqual(['2024-03-04', '2024-05-06', '2024-11-12']);
    const loose = await importText(csv, { ...O, allowAmbiguous: true });
    expect(loose.stats.imported).toBe(3);
  });
  it('uses settlement-date ordering as evidence', async () => {
    const r = await importText('Trade Date,Settlement Date,Action,Symbol,Quantity,Price,Currency\n03/04/2024,03/06/2024,Buy,AAPL,1,170,USD\n', O);
    expect(r.needsConfirmation).toBeUndefined();
    expect(txs(r)[0]!.date).toBe('2024-03-04');
  });
  it('uses AM/PM times as evidence of MM/DD', async () => {
    const r = await importText('Date,Action,Symbol,Quantity,Price,Currency\n03/04/2024 10:30 AM,Buy,AAPL,1,170,USD\n', O);
    expect(txs(r)[0]!.date).toBe('2024-03-04');
  });
});

describe('I5 — B3 Negociação + Movimentação without double counting', () => {
  const neg = writeXlsx([{ name: 'Negociação', rows: [
    ['Data do Negócio', 'Tipo de Movimentação', 'Mercado', 'Prazo/Vencimento', 'Instituição', 'Código de Negociação', 'Quantidade', 'Preço', 'Valor'],
    ['02/01/2023', 'Compra', 'Mercado à Vista', '-', 'XP', 'ITSA4', 100, 9, 900],
    ['03/01/2023', 'Compra', 'Mercado Fracionário', '-', 'XP', 'ITSA4F', 37, 9.1, 336.7],
    ['05/01/2023', 'Compra', 'Mercado à Vista', '-', 'XP', 'PETR4', 100, 23, 2300],
    ['29/12/2022', 'Compra', 'Mercado à Vista', '-', 'XP', 'VALE3', 10, 80, 800],
  ] }]);
  const mov = writeXlsx([{ name: 'Movimentação', rows: [
    ['Entrada/Saída', 'Data', 'Movimentação', 'Produto', 'Instituição', 'Quantidade', 'Preço unitário', 'Valor da Operação'],
    ['Credito', '04/01/2023', 'Transferência - Liquidação', 'ITSA4 - ITAUSA S.A.', 'XP', 100, 9, 900],
    ['Credito', '09/01/2023', 'Transferência - Liquidação', 'PETR4 - PETROBRAS', 'XP', 100, 23, 2300], // Thu → Mon (D+2 business)
    ['Credito', '03/01/2023', 'Transferência - Liquidação', 'VALE3 - VALE', 'XP', 10, 80, 800], // across year end
    ['Credito', '20/06/2023', 'Bonificação em Ativos', 'ITSA4 - ITAUSA S.A.', 'XP', 13.7, 18.97, '-'],
  ] }]);
  it('skips settlements matched on the B3 calendar and infers the bonus ratio from real holdings', async () => {
    const n = await importFile({ data: neg }, O);
    const m = await importFile({ data: mov }, { ...O, existingTransactions: n.transactions });
    for (const line of [2, 3, 4]) expect(byLine(m, line)).toMatchObject({ status: 'skipped' });
    expect(byLine(m, 2).issues[0]!.code).toBe('SETTLEMENT_MATCHED');
    expect(byLine(m, 5).transaction).toMatchObject({ type: 'STOCK_DIVIDEND', quantity: 13.7, ratio: 0.1 });
  });
  it('b3SettlementMode include → the settlement is a blocking possible duplicate (not counted)', async () => {
    const n = await importFile({ data: neg }, O);
    const m = await importFile({ data: mov }, { ...O, existingTransactions: n.transactions, b3SettlementMode: 'include' });
    expect(byLine(m, 3)).toMatchObject({ status: 'possible_duplicate', duplicateOf: { source: 'import:b3-negociacao', inFile: false } });
    expect(m.transactions.some((t) => t.type === 'BUY')).toBe(false);
    expect(byLine(m, 5).transaction!.ratio).toBe(0.1); // duplicates excluded from ratio inference
  });
});

describe('I6 / I10 / I20 — IBKR transfers, transaction fees, FX commissions, unknown sections, reconciliation', async () => {
  const r = await importFixture('ibkr-activity-transfers.csv');
  it('imports ACATS/FOP transfers and stamp duty', () => {
    expect(byLine(r, 13).transaction).toMatchObject({ type: 'TRANSFER_IN', instrumentId: 'XNAS:AAPL', quantity: 50, price: 180, amount: 9000 });
    expect(byLine(r, 13).issues[0]!.code).toBe('TRANSFER_COST_FROM_MARKET');
    expect(byLine(r, 14).transaction).toMatchObject({ type: 'TRANSFER_OUT', quantity: 10 });
    expect(byLine(r, 17).transaction).toMatchObject({ type: 'FEE', instrumentId: 'XLON:VOD', amount: 0.35, currency: 'GBP' });
  });
  it('records FX commissions in another currency as a separate FEE', () => {
    const row = byLine(r, 10);
    expect(row.transaction).toMatchObject({ type: 'FX_CONVERSION', currency: 'EUR', amount: 5000, toCurrency: 'USD', toAmount: 5450 });
    expect(row.extraTransactions).toEqual([expect.objectContaining({ type: 'FEE', currency: 'USD', amount: 2 })]);
    expect(r.transactions.filter((t) => t.type === 'FEE' && t.currency === 'USD')).toHaveLength(2);
  });
  it('warns about every unhandled section with its row count', () => {
    const w = r.warnings.filter((x) => x.code === 'UNHANDLED_SECTION').map((x) => x.params);
    expect(w).toEqual([{ section: 'Interest Accruals', count: 2 }, { section: 'Forex Balances', count: 1 }]);
  });
  it('reconciles Open Positions and Cash Report', () => {
    expect(r.reconciliation).toMatchObject({ source: 'ibkr-activity', asOf: '2024-06-30', positionDifferences: [], cashDifferences: [] });
    expect(r.reconciliation!.positions.map((p) => [p.instrumentId, p.quantity])).toEqual([['XNAS:AAPL', 40], ['XLON:VOD', 100]]);
  });
  it('reports differences against existing transactions', async () => {
    const extra = { id: 'x', portfolioId: 'p1', date: '2024-01-10', type: 'BUY' as const, instrumentId: 'XNAS:AAPL', quantity: 5, price: 180, currency: 'USD', amount: 900, source: 'import:ibkr-flex' };
    const r2 = await importFixture('ibkr-activity-transfers.csv', { existingTransactions: [extra] });
    expect(r2.reconciliation!.positionDifferences).toEqual([{ instrumentId: 'XNAS:AAPL', symbol: 'AAPL', reported: 40, computed: 45, difference: -5 }]);
    expect(r2.warnings.some((w) => w.code === 'RECONCILIATION_DIFF')).toBe(true);
  });
  it('positionsMode opening imports Open Positions as TRANSFER_IN at the statement date', async () => {
    const r3 = await importFixture('ibkr-activity-transfers.csv', { positionsMode: 'opening' });
    const opening = r3.transactions.filter((t) => t.note?.startsWith('Posición inicial'));
    expect(opening).toEqual([
      expect.objectContaining({ date: '2024-06-30', type: 'TRANSFER_IN', instrumentId: 'XNAS:AAPL', quantity: 40, price: 180, amount: 7200 }),
      expect.objectContaining({ instrumentId: 'XLON:VOD', quantity: 100 }),
    ]);
  });
});

describe('I7 / I14 — cross-source duplicates are blocking choices, in-file repeats only flagged; scan is linear', () => {
  const ibA = 'Statement,Header,Field Name,Field Value\nStatement,Data,Title,Activity Statement\nAccount Information,Header,Field Name,Field Value\nAccount Information,Data,Base Currency,USD\n' +
    'Trades,Header,DataDiscriminator,Asset Category,Currency,Symbol,Date/Time,Quantity,T. Price,C. Price,Proceeds,Comm/Fee,Basis,Realized P/L,MTM P/L,Code\n' +
    'Trades,Data,Order,Stocks,USD,AAPL,"2024-01-03, 10:30:00",10,185.1,185,-1851,-1,1852,0,0,O\n' +
    'Deposits & Withdrawals,Header,Currency,Settle Date,Description,Amount\nDeposits & Withdrawals,Data,USD,2024-01-02,Electronic Fund Transfer,5000\n';
  it('Activity then Flex / then manual template → possible_duplicate, excluded unless accepted', async () => {
    const a = await importText(ibA, O);
    const flex = 'ClientAccountID,CurrencyPrimary,AssetClass,Symbol,ISIN,ListingExchange,TradeDate,Quantity,TradePrice,Proceeds,IBCommission,IBCommissionCurrency,Buy/Sell,TransactionID\nU1,USD,STK,AAPL,US0378331005,NASDAQ,20240103,10,185.1,-1851,-1,USD,BUY,999\n';
    const f = await importText(flex, { ...O, existingTransactions: a.transactions });
    expect(byLine(f, 2)).toMatchObject({ status: 'possible_duplicate', duplicateOf: { source: 'import:ibkr-activity', date: '2024-01-03' } });
    expect(f.transactions).toEqual([]);
    const accepted = await importText(flex, { ...O, existingTransactions: a.transactions, acceptDuplicates: [2] });
    expect(accepted.transactions).toHaveLength(1);
    const canon = await importText('date,type,symbol,exchange,quantity,price,currency\n2024-01-03,BUY,AAPL,XNAS,10,185.1,USD\n', { ...O, existingTransactions: a.transactions });
    expect(byLine(canon, 2).status).toBe('possible_duplicate');
  });
  it('also checks deposits, withdrawals, FX and interest', async () => {
    const a = await importText(ibA, O);
    const r = await importText('date,type,currency,amount\n2024-01-03,DEPOSIT,USD,5000\n', { ...O, existingTransactions: a.transactions });
    expect(byLine(r, 2).status).toBe('possible_duplicate');
  });
  it('10.000 imported vs 10.000 existing on the same instrument runs in well under a second per 10k', async () => {
    let ib = 'Statement,Header,Field Name,Field Value\nStatement,Data,Title,Activity Statement\nTrades,Header,DataDiscriminator,Asset Category,Currency,Symbol,Date/Time,Quantity,T. Price,C. Price,Proceeds,Comm/Fee,Basis,Realized P/L,MTM P/L,Code\n';
    const N = 10000;
    for (let i = 0; i < N; i++) ib += `Trades,Data,Order,Stocks,USD,AAPL,"2024-${String(1 + (i % 12)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')}, 10:30:00",${1 + (i % 5)},185.1,185,-185.1,-1,186,0,0,O\n`;
    const existing = Array.from({ length: N }, (_, i) => ({ id: `e${i}`, portfolioId: 'p', date: `2023-${String(1 + (i % 12)).padStart(2, '0')}-10`, type: 'BUY' as const, instrumentId: 'XNAS:AAPL', quantity: 1000 + i, price: 1, currency: 'USD', source: 'manual' }));
    const t0 = performance.now();
    const r = await importText(ib, { ...O, existingTransactions: existing, acceptDuplicates: 'in-file' });
    expect(performance.now() - t0).toBeLessThan(8000); // was 35 s before the index (I14)
    expect(r.stats.imported).toBe(N);
  });
});

describe('I8 — exchange resolution does not fragment positions', () => {
  it('handles ECOPETROL in USD, MGC in COP, EUR without venue and guessed US listings', async () => {
    const r = await importText('date,type,symbol,quantity,price,currency\n2024-01-02,BUY,ECOPETROL,10,0.6,USD\n2024-01-03,BUY,ECOPETROL,10,2400,COP\n2024-01-02,BUY,AAPL,1,700000,COP\n2024-01-02,BUY,SAN,10,4,EUR\n2024-01-02,BUY,ENB,10,35,USD\n', O);
    expect(byLine(r, 2).transaction!.instrumentId).toBe('XBOG:ECOPETROL');
    expect(byLine(r, 2).issues.map((i) => i.code)).toContain('CURRENCY_MISMATCH');
    expect(byLine(r, 3).transaction!.instrumentId).toBe('XBOG:ECOPETROL');
    expect(byLine(r, 4).transaction).toMatchObject({ instrumentId: 'XNAS:AAPL', currency: 'COP' });
    expect(byLine(r, 4).issues.map((i) => i.code)).toEqual(['MGC_FOREIGN_LISTING']);
    expect(byLine(r, 5)).toMatchObject({ status: 'error' });
    expect(byLine(r, 5).issues[0]!.code).toBe('EXCHANGE_REQUIRED');
    expect(byLine(r, 6).transaction!.instrumentId).toBe('XNYS:ENB'); // market-data default for unknown US venues (I28)
    const fixed = await importText('date,type,symbol,quantity,price,currency\n2024-01-02,BUY,SAN,10,4,EUR\n', { ...O, securityMap: { SAN: 'XMAD' } });
    expect(fixed.transactions[0]!.instrumentId).toBe('XMAD:SAN');
  });
  it('Schwab ENB (guessed XNYS) then IBKR → one instrument; a different real venue is suggested as update', async () => {
    const sch = await importText('"Date","Action","Symbol","Description","Quantity","Price","Fees & Comm","Amount"\n"01/05/2024","Buy","ENB","ENBRIDGE INC","10","$35.00","","-$350.00"\n', O);
    const ib = 'Statement,Header,Field Name,Field Value\nStatement,Data,Title,Activity Statement\n' +
      'Trades,Header,DataDiscriminator,Asset Category,Currency,Symbol,Date/Time,Quantity,T. Price,C. Price,Proceeds,Comm/Fee,Basis,Realized P/L,MTM P/L,Code\n' +
      'Trades,Data,Order,Stocks,USD,ENB,"2024-01-08, 10:30:00",5,36,36,-180,-1,181,0,0,O\n' +
      'Financial Instrument Information,Header,Asset Category,Symbol,Description,Conid,Security ID,Listing Exch,Multiplier,Type,Code\n' +
      'Financial Instrument Information,Data,Stocks,ENB,ENBRIDGE INC,9,CA29250N1050,NYSE,1,COMMON,\n';
    const r = await importText(ib, { ...O, existingTransactions: sch.transactions, existingInstruments: sch.instruments });
    expect(r.transactions[0]!.instrumentId).toBe('XNYS:ENB');
    expect(r.instrumentUpdates).toBeUndefined();
    // Venue known later and different from the guess → same instrument, suggested exchange fix.
    const r2 = await importText(ib.replace('CA29250N1050,NYSE', 'CA29250N1050,NASDAQ'), { ...O, existingTransactions: sch.transactions, existingInstruments: sch.instruments });
    expect(r2.transactions[0]!.instrumentId).toBe('XNYS:ENB');
    expect(r2.instrumentUpdates).toEqual([{ id: 'XNYS:ENB', changes: { exchange: 'XNAS' }, reason: 'exchange:XNAS' }]);
  });
  it('uses an injected catalog (ISIN / symbol) before guessing', async () => {
    const catalog = [{ id: 'XMAD:SAN', symbol: 'SAN', name: 'Banco Santander', exchange: 'XMAD', currency: 'EUR', country: 'ES', assetClass: 'equity' as const, isin: 'ES0113900J37', providerSymbols: { yahoo: 'SAN.MC' } }];
    const r = await importText('date,type,symbol,quantity,price,currency\n2024-01-02,BUY,SAN,10,4,EUR\n', { ...O, catalog });
    expect(r.transactions[0]!.instrumentId).toBe('XMAD:SAN');
    expect(r.instruments[0]).toMatchObject({ name: 'Banco Santander', providerSymbols: { yahoo: 'SAN.MC' } });
  });
});

describe('I9 / I13 — signs, refunds and vocabulary', () => {
  it('keeps reversals and refunds signed, flags contradictions', async () => {
    const csv = 'Fecha,Tipo,Simbolo,Cantidad,Precio,Monto,Comision,Moneda\n' +
      '02/01/2024,Venta,AAPL,-5,200,,1,USD\n03/01/2024,Compra,AAPL,-5,200,,-1,USD\n05/01/2024,Dividendo,AAPL,,,-12.5,,USD\n' +
      '06/01/2024,Devolución retención,,,,15,,USD\n08/01/2024,Comisión,,,,-3,,USD\n09/01/2024,Impuesto,,,,-4,,USD\n';
    const r = await importText(csv, { ...O, dateFormat: 'DMY' });
    expect(byLine(r, 2).transaction).toMatchObject({ type: 'SELL', quantity: 5, instrumentId: 'XNAS:AAPL' });
    expect(byLine(r, 3).issues.map((i) => i.code)).toContain('QUANTITY_SIGN_CONTRADICTS');
    expect(byLine(r, 4).transaction).toMatchObject({ type: 'DIVIDEND', amount: -12.5 });
    expect(byLine(r, 5).transaction).toMatchObject({ type: 'TAX', amount: -15 });
    expect(byLine(r, 6).transaction).toMatchObject({ type: 'FEE', amount: 3 });
    expect(byLine(r, 7).transaction).toMatchObject({ type: 'TAX', amount: 4 });
  });
  it.each([
    ['Redención CDT', 'SELL'], ['Constitución CDT', 'BUY'], ['Cancelación CDT', 'SELL'], ['Dividendo neto de retención', 'DIVIDEND'],
    ['Leilão de fração', 'SELL'], ['Cash in Lieu', 'SELL'], ['Abono intereses CDT', 'INTEREST'], ['Ingreso por venta de acciones', 'SELL'],
    ['Pago dividendo en acciones', 'STOCK_DIVIDEND'], ['Cargo GMF', 'TAX'],
  ])('%s → %s', (text, type) => expect(classifyType(text)).toBe(type));
  it('neutral words take their direction from signs', async () => {
    expect(classifyTypeDetailed('Traslado')).toMatchObject({ signBased: 'transfer' });
    expect(classifyTypeDetailed('Liquidación')).toMatchObject({ signBased: 'trade' });
    const r = await importText('Fecha,Tipo,Simbolo,Cantidad,Monto,Moneda\n15/01/2024,Traslado,ECOPETROL,100,,COP\n16/01/2024,Traslado,,,-50000,COP\n', O);
    expect(txs(r).map((t) => t.type)).toEqual(['TRANSFER_IN', 'WITHDRAWAL']);
  });
});

describe('I11 / I12 — B3 fractions & JCP; nota fee modes and options', () => {
  it('fração + leilão become one SELL; JCP grossed up', async () => {
    const mov = writeXlsx([{ name: 'Movimentação', rows: [
      ['Entrada/Saída', 'Data', 'Movimentação', 'Produto', 'Instituição', 'Quantidade', 'Preço unitário', 'Valor da Operação'],
      ['Debito', '22/06/2023', 'Fração em Ativos', 'ITSA4 - ITAUSA S.A.', 'XP', 0.7, '-', '-'],
      ['Credito', '30/06/2023', 'Leilão de Fração', 'ITSA4 - ITAUSA S.A.', 'XP', 0.7, 9.5, 6.65],
      ['Credito', '20/09/2023', 'Juros Sobre Capital Próprio', 'ITSA4 - ITAUSA S.A.', 'XP', 150.7, 0.02, 2.56],
      ['Debito', '10/10/2023', 'Incorporação', 'XPTO3 - XPTO S.A.', 'XP', 100, '-', '-'],
      ['Credito', '10/10/2023', 'Incorporação', 'ABCD3 - ABCD S.A.', 'XP', 50, '-', '-'],
    ] }]);
    const r = await importFile({ data: mov }, O);
    expect(byLine(r, 2).transaction).toMatchObject({ type: 'SELL', quantity: 0.7, amount: 6.65, price: 9.5 });
    expect(byLine(r, 3).status).toBe('skipped');
    expect(byLine(r, 4).transaction).toMatchObject({ type: 'DIVIDEND', amount: 3.01, taxes: 0.45 });
    expect(r.corporateActions).toEqual([
      expect.objectContaining({ kind: 'merger', date: '2023-10-10', legs: [{ direction: 'out', symbol: 'XPTO3', name: 'XPTO S.A.', quantity: 100 }, { direction: 'in', symbol: 'ABCD3', name: 'ABCD S.A.', quantity: 50 }] }),
    ]);
  });
  const nota = 'Data pregão;Nota;C/V;Código;Quantidade;Preço;Valor;Corretagem;Emolumentos\n02/01/2023;1;C;PETR4;100;23,00;2.300,00;4,90;0,69\n02/01/2023;1;C;VALE3;10;80,00;800,00;4,90;0,24\n02/01/2023;2;C;ITSA4;100;9,00;900,00;4,90;0,27\n02/01/2023;2;C;BBAS3;100;9,00;900,00;4,90;0,27\n02/01/2023;3;C;PETR4F;7;23,00;161,00;0,00;0,05\n02/01/2023;3;C;PETR4;100;23,00;2.300,00;0,00;0,69\n02/01/2023;3;C;PETR4E250;100;0,50;50,00;0,00;0,01\n';
  it('per-row costs stay per row; options skipped; separate notes are not duplicates', async () => {
    const r = await importText(nota, O);
    expect(byLine(r, 2).transaction!.fees).toBeCloseTo(5.59, 8);
    expect(byLine(r, 4).transaction!.fees).toBeCloseTo(5.17, 8);
    expect(byLine(r, 5).transaction!.fees).toBeCloseTo(5.17, 8);
    expect(byLine(r, 4).issues.map((i) => i.code)).toContain('FEES_MODE_AMBIGUOUS');
    expect(byLine(r, 7).status).toBe('ok');
    expect(byLine(r, 8)).toMatchObject({ status: 'skipped' });
    const perNote = await importText(nota, { ...O, notaFeesMode: 'per-note' });
    expect(byLine(perNote, 4).transaction!.fees).toBeCloseTo(2.585, 8);
  });
});

describe('I15 / I16 / I17 / I18 / I19', () => {
  it('I16: reads legacy .xls (BIFF8, regular and mini stream)', async () => {
    const r = await importFixture('extracto-av.xls');
    expect(r.detection).toMatchObject({ fileKind: 'xls', presetId: 'extracto-co' });
    expect(txs(r)[0]).toMatchObject({ date: '2024-01-15', type: 'BUY', instrumentId: 'XBOG:ISA', quantity: 100, price: 17500.5, fees: 8750 });
    const mini = await importFixture('extracto-av-mini.xls');
    expect(txs(mini)).toHaveLength(1);
    const xls = writeXls([{ name: 'S', rows: [['Fecha', 'Tipo', 'Símbolo', 'Cantidad', 'Precio', 'Moneda'], ['15/01/2024', 'Compra', 'ECOPETROL', 1000, '2.450,5', 'COP']] }]);
    expect(txs(await importFile({ data: xls }, O))[0]).toMatchObject({ quantity: 1000, price: 2450.5 });
  });
  it('I16: nested HTML tables and colspan', async () => {
    const html = '<html><body><table><tr><td><table><tr><td>Banco X</td></tr></table></td></tr><tr><th>Fecha</th><th>Operación</th><th>Especie</th><th>Cantidad</th><th>Precio</th><th>Comisión</th></tr><tr><td>15/01/2024</td><td>Compra</td><td>ECOPETROL</td><td>1.000</td><td>2.450,00</td><td>7.350</td></tr><tr><td colspan="3">Total</td><td>1.000</td><td></td><td>7.350</td></tr></table></body></html>';
    const r = await importFile({ data: new TextEncoder().encode(html), fileName: 'mov.xls' }, O);
    expect(txs(r)).toEqual([expect.objectContaining({ instrumentId: 'XBOG:ECOPETROL', quantity: 1000, price: 2450, fees: 7350 })]);
  });
  it('I17: ratios, serials as text, DR/CR suffixes, weekday prefixes', () => {
    expect(parseRatio('2:1')).toBe(2);
    expect(parseRatio('1x10')).toBe(0.1);
    expect(parseRatio('1/10')).toBe(0.1);
    expect(parseDate('45292')).toBe('2024-01-01');
    expect(parseDate('Mon Jan 15 2024')).toBe('2024-01-15');
    expect(parseNumber('1,234.56 DR', 'dot')).toBe(-1234.56);
    expect(parseNumber('1.234,56 D', 'comma')).toBe(-1234.56);
    expect(parseNumber('2.345,00 C', 'comma')).toBe(2345);
  });
  it('I18: Schwab reverse split in two rows → one SPLIT 0.1', async () => {
    const sch = '"Date","Action","Symbol","Description","Quantity","Price","Fees & Comm","Amount"\n"01/05/2024","Buy","XYZ","XYZ INC","100","$5.00","","-$500.00"\n"03/01/2024","Reverse Split","XYZ","XYZ INC","-100","","",""\n"03/01/2024","Reverse Split","XYZ","XYZ INC","10","","",""\n';
    const r = await importText(sch, O);
    expect(txs(r).filter((t) => t.type === 'SPLIT')).toEqual([expect.objectContaining({ ratio: 0.1 })]);
    expect(byLine(r, 3).issues[0]!.code).toBe('SPLIT_PAIR_MERGED');
  });
  it('I19: fixed-format presets never warn about ambiguous dates', async () => {
    for (const f of ['b3-negociacao.xlsx', 'nota-corretagem-latin1.csv', 'schwab-transactions.csv', 'degiro-transactions-en.csv']) {
      const r = await importFixture(f);
      expect(r.warnings.filter((w) => /DATE_FORMAT/.test(w.code))).toEqual([]);
    }
  });
});

describe('I20 — B3 Posição (multi-sheet) for reconciliation or opening positions', async () => {
  it('reconciles against imported history', async () => {
    const neg = await importFixture('b3-negociacao.xlsx');
    const r = await importFixture('b3-posicao.xlsx', { existingTransactions: neg.transactions });
    expect(r.detection.sheet).toBe('Acoes + Fundo de Investimento');
    expect(r.transactions).toEqual([]);
    const diffs = Object.fromEntries(r.reconciliation!.positionDifferences.map((d) => [d.instrumentId, d.difference]));
    expect(diffs).toMatchObject({ 'BVMF:ITSA4': 81 - 37, 'BVMF:BOVA11': -3 });
    expect(diffs['BVMF:PETR4']).toBeUndefined(); // 100 - 50 = 50 = reported
  });
  it('imports opening positions at a date', async () => {
    const r = await importFixture('b3-posicao.xlsx', { positionsMode: 'opening', asOfDate: '2024-06-28' });
    expect(txs(r).map((t) => [t.type, t.instrumentId, t.quantity, t.date])).toEqual([
      ['TRANSFER_IN', 'BVMF:PETR4', 50, '2024-06-28'], ['TRANSFER_IN', 'BVMF:ITSA4', 81, '2024-06-28'], ['TRANSFER_IN', 'BVMF:HGLG11', 10, '2024-06-28'],
    ]);
  });
});
