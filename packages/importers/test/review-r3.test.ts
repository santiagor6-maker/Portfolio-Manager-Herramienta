/**
 * Regression tests for the round-3 review (reviews/importers-r3.md): I20 (IBKR accounts), I30 (nomes de
 * pregão: renames, coverage, fuzzy suggestions, learned answers), I31 (real-like corpus), I32 (BDR
 * classes), I33 (spin-off proposals), I2 (server inbox through the normal pipeline).
 */
import type { Instrument, Transaction } from '@pm/core';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  accountsCompatible,
  importEmail,
  importFile,
  importFlexXml,
  importText,
  importTransactionBatch,
  parseXls,
  readCfbStream,
  resolveSpec,
  securityMapFromTransactions,
  sinacorSuggestions,
  sinacorTicker,
  type ImportResult,
} from '../src';
import { buildExcelXls, DAVIVIENDA_MOVES, DAVIVIENDA_MOVES_P2, TRII_MOVES, xlsMoves } from './fixtures/real-like/colombia';
import { NOTES, noteTotals, type NoteSpec } from './fixtures/real-like/sinacor';
import { byLine } from './helpers/load';
import { writeXlsx } from './helpers/xlsx-writer';

const O = { portfolioId: 'p' };
const txs = (r: ImportResult) => r.transactions;
const corpus = (name: string) => new Uint8Array(readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'real-like', name)));

// -------------------------------------------------------------------------------------------------
describe('I20 — two IBKR accounts are reconciled separately', () => {
  const activity = (acct: string) =>
    'Statement,Header,Field Name,Field Value\nStatement,Data,Title,Activity Statement\nStatement,Data,Period,"January 1, 2024 - June 30, 2024"\n' +
    `Account Information,Header,Field Name,Field Value\nAccount Information,Data,Account,${acct}\nAccount Information,Data,Base Currency,USD\n` +
    'Trades,Header,DataDiscriminator,Asset Category,Currency,Symbol,Date/Time,Quantity,T. Price,C. Price,Proceeds,Comm/Fee,Basis,Realized P/L,MTM P/L,Code\n' +
    'Trades,Data,Order,Stocks,USD,AAPL,"2024-01-03, 10:30:00",10,185,185,-1850,-1,1851,0,0,O\n' +
    'Deposits & Withdrawals,Header,Currency,Settle Date,Description,Amount\nDeposits & Withdrawals,Data,USD,2024-01-02,Electronic Fund Transfer,2000\n' +
    'Open Positions,Header,DataDiscriminator,Asset Category,Currency,Symbol,Quantity,Mult,Cost Price,Cost Basis,Close Price,Value,Unrealized P/L,Code\n' +
    'Open Positions,Data,Summary,Stocks,USD,AAPL,10,1,185,1850,200,2000,150,\n' +
    'Cash Report,Header,Currency Summary,Currency,Total,Securities,Futures,Month to Date,Year to Date,\nCash Report,Data,Ending Cash,USD,149,149,0,0,0,\n';
  const otherAccount: Transaction[] = [
    { id: 'k', portfolioId: 'p', date: '2023-05-01', type: 'BUY', instrumentId: 'XNYS:KO', quantity: 30, price: 60, amount: 1800, currency: 'USD', account: 'U1111111', source: 'import:ibkr-activity' },
    { id: 'd', portfolioId: 'p', date: '2023-05-01', type: 'DEPOSIT', amount: 5000, currency: 'USD', account: 'U1111111', source: 'import:ibkr-activity' },
  ];
  it('imported transactions carry the U-number; another U-number is another account', async () => {
    const r = await importText(activity('U2222222'), { ...O, existingTransactions: otherAccount });
    expect(txs(r).every((t) => t.account === 'U2222222')).toBe(true);
    expect(r.reconciliation).toMatchObject({ positionDifferences: [], cashDifferences: [] });
  });
  it('history without account: kept by default (single account), dropped when the portfolio has other IBKR accounts', async () => {
    const unlabeled = otherAccount.map(({ account: _a, ...t }) => t);
    const single = await importText(activity('U2222222'), { ...O, existingTransactions: unlabeled });
    expect(single.reconciliation!.positionDifferences.map((d) => d.symbol)).toEqual(['KO']);
    expect(single.reconciliation!.unassignedTransactions).toBe(2);
    expect(single.warnings.some((w) => w.code === 'RECONCILIATION_UNASSIGNED')).toBe(true);
    const third: Transaction = { id: 'z', portfolioId: 'p', date: '2023-06-01', type: 'DEPOSIT', amount: 1, currency: 'EUR', account: 'U3333333', source: 'import:ibkr-flex' };
    const multi = await importText(activity('U2222222'), { ...O, existingTransactions: [...unlabeled, third] });
    expect(multi.reconciliation).toMatchObject({ positionDifferences: [], cashDifferences: [] });
  });
  it('account compatibility: numbers vs institution labels', () => {
    expect(accountsCompatible('U1111111', 'U2222222')).toBe(false);
    expect(accountsCompatible('U1111111', 'Interactive Brokers')).toBe(true);
    expect(accountsCompatible('IBKR', 'Interactive Brokers')).toBe(true);
    expect(accountsCompatible('Charles Schwab', 'Schwab')).toBe(true);
    expect(accountsCompatible('Nubank', 'NU INVEST CORRETORA DE VALORES S.A.')).toBe(true);
    expect(accountsCompatible('U1111111', 'XP')).toBe(false);
  });
  it('dedup: an Activity CSV and a Flex sync of the same account still match; two accounts never do', async () => {
    const a = await importText(activity('U2222222'), O);
    const flex = 'ClientAccountID,CurrencyPrimary,AssetClass,Symbol,ISIN,ListingExchange,TradeDate,Quantity,TradePrice,Proceeds,IBCommission,IBCommissionCurrency,Buy/Sell,TransactionID\n';
    const same = await importText(`${flex}U2222222,USD,STK,AAPL,US0378331005,NASDAQ,20240103,10,185,-1850,-1,USD,BUY,999\n`, { ...O, existingTransactions: a.transactions });
    expect(same.stats.possibleDuplicates).toBe(1);
    const other = await importText(`${flex}U3333333,USD,STK,AAPL,US0378331005,NASDAQ,20240103,10,185,-1850,-1,USD,BUY,998\n`, { ...O, existingTransactions: a.transactions });
    expect(other.stats).toMatchObject({ imported: 1, possibleDuplicates: 0 });
  });
});

// -------------------------------------------------------------------------------------------------
describe('I30 — nomes de pregão: renames, coverage, fuzzy suggestions, learned answers', () => {
  it.each([
    ['ISA ENERGIA PN N1', 'ISAE4'], ['TRAN PAULIST PN N1', 'TRPL4'], ['ELETROBRAS ON N1', 'ELET3'], ['AXIA ENERGIA ON N1', 'AXIA3'],
    ['REDE D OR ON NM', 'RDOR3'], ['MINERVA ON NM', 'BEEF3'], ['AZZAS 2154 ON NM', 'AZZA3'], ['AUREN ON NM', 'AURE3'],
    ['FII MAXI REN CI ER', 'MXRF11'], ['IT NOW IDIV CI', 'DIVO11'], ['META PLATFOR DRN', 'M1TA34'], ['NU HOLDINGS DR3', 'ROXO34'],
    ['COGNA ON ON NM', 'COGN3'], ['AMBEV S/A ON', 'ABEV3'], ['KLABIN S/A UNT N2', 'KLBN11'],
  ])('%s → %s', (spec, ticker) => expect(sinacorTicker(spec)).toBe(ticker));
  it('renamed tickers resolve to the current id (one instrument per security), like @pm/market-data', async () => {
    const r = await importText('date,type,symbol,exchange,quantity,price,currency\n2023-05-02,BUY,TRPL4,BVMF,10,25,BRL\n2023-05-02,BUY,ELET3,BVMF,10,40,BRL\n2023-05-02,BUY,CCRO3,BVMF,10,12,BRL\n', O);
    expect(txs(r).map((t) => t.instrumentId)).toEqual(['BVMF:ISAE4', 'BVMF:AXIA3', 'BVMF:MOTV3']);
    expect(byLine(r, 2).issues.map((i) => i.code)).toContain('TICKER_RENAMED');
    // A portfolio that already holds the old id keeps using it (no split history).
    const old: Instrument = { id: 'BVMF:TRPL4', symbol: 'TRPL4', name: 'ISA CTEEP PN', exchange: 'BVMF', currency: 'BRL', country: 'BR', assetClass: 'equity' };
    const kept = await importText('date,type,symbol,exchange,quantity,price,currency\n2024-12-02,BUY,ISAE4,BVMF,10,23,BRL\n', { ...O, existingInstruments: [old] });
    expect(txs(kept)[0]!.instrumentId).toBe('BVMF:TRPL4');
  });
  it('fuzzy suggestions for unknown names (current codes, best first)', () => {
    expect(sinacorSuggestions('ISA ENERG PN N1')[0]).toBe('ISAE4');
    expect(sinacorSuggestions('PETROBRAZ PN N2')).toContain('PETR4');
    expect(sinacorSuggestions('ITAU UNIBANCO PN N1')).toContain('ITUB4');
    expect(sinacorSuggestions('EMPRESA NOVA ON NM')).toEqual([]);
  });
  it('catalog names (e.g. @pm/market-data) feed the suggestions', () => {
    const catalog = [{ id: 'BVMF:XYZW3', symbol: 'XYZW3', name: 'Xyzw Logística ON', exchange: 'BVMF' }];
    expect(resolveSpec('XYZW LOGISTICA ON NM', undefined, [{ name: 'xyzw logistica', ticker: 'XYZW3' }]).suggestions[0]).toBe('XYZW3');
    expect(catalog[0]!.symbol).toBe('XYZW3');
  });
  it('an answer given once is learned from the user’s own transactions (no extra storage)', async () => {
    const note = corpus('nota-nu-2024-07-02-senha-012.pdf');
    const first = await importFile({ data: note }, { ...O, pdfPassword: '012', securityMap: { 'EMPRESA NOVA ON NM': 'BVMF:NOVA3' } });
    expect(txs(first).find((t) => t.instrumentId === 'BVMF:NOVA3')!.note).toBe('Nota 223344 · EMPRESA NOVA ON NM');
    expect(securityMapFromTransactions(first.transactions)).toMatchObject({ 'empresa nova on nm': 'BVMF:NOVA3' });
    // A later note (simulated: same PDF, other note number filter not needed) resolves it without asking.
    const later = await importFile({ data: note }, { ...O, pdfPassword: '012', existingTransactions: first.transactions.map((t) => ({ ...t, importHash: `x${t.importHash}` })) });
    expect(later.unknownSecurities).toBeUndefined();
    const row = later.rows.find((x) => x.issues.some((i) => i.code === 'SECURITY_LEARNED'));
    expect(row?.issues.find((i) => i.code === 'SECURITY_LEARNED')!.params).toEqual({ spec: 'EMPRESA NOVA ON NM', id: 'BVMF:NOVA3' });
  });
  it('dated names: NATURA is NTCO3 before 2025-07-02 and NATU3 after', () => {
    expect(sinacorTicker('NATURA ON NM', '2024-07-02')).toBe('NTCO3');
    expect(sinacorTicker('NATURA ON NM', '2025-08-05')).toBe('NATU3');
  });
});

// -------------------------------------------------------------------------------------------------
describe('I32 — BDR class letters', () => {
  it('a letter after DRN (not a known mark) is asked, with the candidate classes', () => {
    expect(resolveSpec('ALPHABET DRN C')).toEqual({ suggestions: ['GOGL34', 'GOGL35'], reason: 'bdr_class' });
    expect(resolveSpec('ALPHABET DRN')).toMatchObject({ reason: 'multiclass' });
    expect(resolveSpec('APPLE DRN ED')).toEqual({ ticker: 'AAPL34', suggestions: [] }); // ED = ex-dividendo mark
    expect(resolveSpec('AMAZON DRN X')).toMatchObject({ reason: 'bdr_class', suggestions: ['AMZO34'] });
  });
  it('the Obs (*) column is read by position: a class letter in the specification is not taken as an Obs marker', async () => {
    const r = await importFile({ data: corpus('nota-btg-2024-05-14-senha-123.pdf') }, { ...O, pdfPassword: '123' });
    expect(r.errors.map((e) => [e.code, e.params])).toEqual([['BDR_CLASS_UNCERTAIN', { spec: 'ALPHABET DRN C' }]]);
    expect(r.unknownSecurities).toEqual([{ key: 'ALPHABET DRN C', lines: [expect.any(Number)], suggestions: ['GOGL34', 'GOGL35'] }]);
    const answered = await importFile({ data: corpus('nota-btg-2024-05-14-senha-123.pdf') }, { ...O, pdfPassword: '123', securityMap: { 'ALPHABET DRN C': 'GOGL35' } });
    expect(txs(answered).some((t) => t.instrumentId === 'BVMF:GOGL35')).toBe(true);
  });
});

// -------------------------------------------------------------------------------------------------
describe('I33 — spin-offs and mergers come as ready-to-confirm transactions', () => {
  const xml = `<FlexQueryResponse queryName="q" type="AF"><FlexStatements count="1"><FlexStatement accountId="U1234567" fromDate="20240101" toDate="20241231">
<Trades><Trade accountId="U1234567" currency="USD" assetCategory="STK" symbol="MMM" isin="US88579Y1010" listingExchange="NYSE" tradeID="1" transactionID="11" tradeDate="20240103" quantity="10" tradePrice="100" proceeds="-1000" ibCommission="-1" ibCommissionCurrency="USD" buySell="BUY" levelOfDetail="EXECUTION"/></Trades>
<CorporateActions><CorporateAction accountId="U1234567" currency="USD" assetCategory="STK" symbol="SOLV" isin="US83444M1018" reportDate="20240401" dateTime="20240401;202500" description="MMM(US88579Y1010) SPINOFF  1 FOR 4 (SOLV, SOLVENTUM CORP, US83444M1018)" quantity="2.5" type="SO" transactionID="32"/></CorporateActions>
</FlexStatement></FlexStatements></FlexQueryResponse>`;
  const ref = (h: { symbol?: string }) => (h.symbol === 'MMM' ? 90 : h.symbol === 'SOLV' ? 70 : undefined);
  it('the proposal is a @pm/core SPLIT/SPINOFF with target, ratio and market-value cost fraction', async () => {
    const r = await importFlexXml(xml, { ...O, referencePrice: ref });
    const ca = r.corporateActions![0]!;
    expect(ca.proposal).toMatchObject({
      transaction: { type: 'SPLIT', subtype: 'SPINOFF', instrumentId: 'XNYS:MMM', targetInstrumentId: 'XNYS:SOLV', ratio: 0.25, costFraction: 0.162791, date: '2024-04-01' },
      instruments: [expect.objectContaining({ id: 'XNYS:SOLV', isin: 'US83444M1018', name: 'SOLVENTUM CORP' })],
      costFractionSource: 'market',
      missing: [],
      applied: false,
    });
    expect(txs(r).some((t) => t.type === 'SPLIT')).toBe(false); // nothing applied without the user's click
  });
  it('one click: acceptCorporateActions applies it (and its new instrument); re-import is a no-op', async () => {
    const r = await importFlexXml(xml, { ...O, referencePrice: ref, acceptCorporateActions: 'all' });
    expect(txs(r).find((t) => t.type === 'SPLIT')).toMatchObject({ subtype: 'SPINOFF', targetInstrumentId: 'XNYS:SOLV', account: 'U1234567' });
    expect(r.instruments.map((i) => i.id)).toContain('XNYS:SOLV');
    expect(r.rows.find((x) => x.transaction?.type === 'SPLIT')!.status).toBe('ok');
    const again = await importFlexXml(xml, { ...O, referencePrice: ref, acceptCorporateActions: 'all', existingTransactions: r.transactions });
    expect(again.corporateActions![0]!.proposal).toMatchObject({ alreadyImported: true, applied: false });
  });
  it('without prices the cost fraction is asked; the answer completes it', async () => {
    const r = await importFlexXml(xml, O);
    expect(r.corporateActions![0]!.proposal!.missing).toEqual(['costFraction']);
    const line = r.corporateActions![0]!.line;
    const a = await importFlexXml(xml, { ...O, acceptCorporateActions: [line], corporateActionAnswers: { [line]: { costFraction: 0.12 } } });
    expect(txs(a).find((t) => t.type === 'SPLIT')).toMatchObject({ costFraction: 0.12 });
  });
  it('B3 Movimentação: incorporação → MERGER proposal from its out/in legs (ratio 0.5)', async () => {
    const mov = writeXlsx([{ name: 'Movimentação', rows: [
      ['Entrada/Saída', 'Data', 'Movimentação', 'Produto', 'Instituição', 'Quantidade', 'Preço unitário', 'Valor da Operação'],
      ['Debito', '10/10/2023', 'Incorporação', 'XPTO3 - XPTO S.A.', 'XP', 100, '-', '-'],
      ['Credito', '10/10/2023', 'Incorporação', 'ABCD3 - ABCD S.A.', 'XP', 50, '-', '-'],
    ] }]);
    const r = await importFile({ data: mov }, O);
    expect(r.corporateActions![0]!.proposal).toMatchObject({
      transaction: { type: 'SPLIT', subtype: 'MERGER', instrumentId: 'BVMF:XPTO3', targetInstrumentId: 'BVMF:ABCD3', ratio: 0.5, currency: 'BRL' },
      missing: [],
    });
  });
  it('Activity Statement: cash acquisitions are sales', async () => {
    const csv = 'Corporate Actions,Header,Asset Category,Currency,Report Date,Date/Time,Description,Quantity,Proceeds,Value,Realized P/L,Code\n' +
      'Corporate Actions,Data,Stocks,USD,2024-09-01,"2024-08-31, 20:25:00","XYZ(US98389B1008) Merged(Acquisition) FOR USD 12.50 PER SHARE (XYZ, XYZ CORP, US98389B1008)",-8,100,0,15,\n';
    const r = await importText(`Statement,Header,Field Name,Field Value\nStatement,Data,Title,Activity Statement\n${csv}`, O);
    expect(txs(r)).toEqual([expect.objectContaining({ type: 'SELL', quantity: 8, price: 12.5, amount: 100 })]);
  });
});

// -------------------------------------------------------------------------------------------------
describe('I2 — the server inbox goes through the normal pipeline (dedup included)', () => {
  const flex = 'ClientAccountID,CurrencyPrimary,AssetClass,Symbol,ISIN,ListingExchange,TradeDate,Quantity,TradePrice,Proceeds,IBCommission,IBCommissionCurrency,Buy/Sell,TransactionID\n' +
    'U1234567,USD,STK,AAPL,US0378331005,NASDAQ,20240103,10,185,-1850,-1,USD,BUY,999\nU1234567,USD,STK,MSFT,US5949181045,NASDAQ,20240104,5,370,-1850,-1,USD,BUY,1000\n';
  it('exact duplicates by importHash, other-source duplicates by economics, new rows ok', async () => {
    const synced = await importText(flex, O); // what the server stored in its inbox
    const inbox = { portfolioId: 'p', pending: synced.transactions, instruments: synced.instruments };
    // The portfolio already has the AAPL trade (same Flex row) and the MSFT trade typed by hand.
    const manual: Transaction = { id: 'm', portfolioId: 'p', date: '2024-01-04', type: 'BUY', instrumentId: 'XNAS:MSFT', quantity: 5, price: 370, amount: 1850, currency: 'USD', source: 'manual' };
    const r = importTransactionBatch(inbox, { ...O, existingTransactions: [synced.transactions[0]!, manual] });
    expect(r.rows.map((x) => x.status)).toEqual(['duplicate', 'possible_duplicate']);
    expect(r.transactions).toEqual([]);
    const fresh = importTransactionBatch(inbox, O);
    expect(fresh.transactions.map((t) => [t.id, t.importHash, t.source])).toEqual(synced.transactions.map((t) => [t.id, t.importHash, t.source]));
    expect(fresh.instruments.map((i) => i.id).sort()).toEqual(['XNAS:AAPL', 'XNAS:MSFT']);
  });
  it('the inbox JSON can be dropped on importFile like any file', async () => {
    const synced = await importText(flex, O);
    const json = JSON.stringify({ portfolioId: 'p', pending: synced.transactions, instruments: synced.instruments, lastRun: { ok: true } });
    const r = await importFile({ data: json, fileName: 'inbox.json' }, O);
    expect(r.detection.presetId).toBe('inbox');
    expect(r.stats.imported).toBe(2);
  });
  it('fields the importer does not build (spin-off subtype, cost fraction) survive the trip', () => {
    const t: Transaction = { id: 's', portfolioId: 'p', date: '2024-04-01', type: 'SPLIT', subtype: 'SPINOFF', instrumentId: 'XNYS:MMM', targetInstrumentId: 'XNYS:SOLV', ratio: 0.25, costFraction: 0.16, currency: 'USD', source: 'import:ibkr-flex', importHash: 'h1' };
    const inst: Instrument[] = [{ id: 'XNYS:MMM', symbol: 'MMM', name: '3M', exchange: 'XNYS', currency: 'USD', country: 'US', assetClass: 'equity' }];
    const r = importTransactionBatch({ pending: [t], instruments: inst }, O);
    expect(r.transactions[0]).toMatchObject({ subtype: 'SPINOFF', targetInstrumentId: 'XNYS:SOLV', costFraction: 0.16, importHash: 'h1', id: 's' });
  });
});

// -------------------------------------------------------------------------------------------------
describe('I31 — real-like corpus (test/fixtures/real-like)', () => {
  const notes: [string, NoteSpec, string?][] = [
    ['nota-xp-2024-03-08.pdf', NOTES.xp],
    ['nota-clear-2022-11-10.pdf', NOTES.clear],
    ['nota-btg-2024-05-14-senha-123.pdf', NOTES.btg, '123'],
    ['nota-inter-2024-03-07.pdf', NOTES.inter],
    ['nota-nu-2024-07-02-senha-012.pdf', NOTES.nu, '012'],
    ['nota-nu-2025-08-05.pdf', NOTES.nu2025],
  ];
  it.each(notes)('%s: every trade, ticker, broker, date and the "Líquido para" check', async (file, spec, pw) => {
    const r = await importFile({ data: corpus(file) }, { ...O, ...(pw ? { pdfPassword: pw } : {}) });
    expect(r.detection.presetId).toBe('nota-sinacor-pdf');
    const expected = spec.pages.flat().filter((t) => t.expect);
    expect(txs(r).map((t) => t.instrumentId)).toEqual(expected.map((t) => t.expect));
    expect(txs(r).map((t) => [t.type, t.quantity, t.price])).toEqual(expected.map((t) => [t.side === 'C' ? 'BUY' : 'SELL', t.qty, t.price]));
    const iso = spec.date.split('/').reverse().join('-');
    expect(new Set(txs(r).map((t) => t.date))).toEqual(new Set([iso]));
    expect(new Set(txs(r).map((t) => t.account))).toEqual(new Set([spec.broker]));
    expect(r.warnings.some((w) => w.code === 'NOTA_TOTALS_MISMATCH')).toBe(false);
    // Asked, never guessed.
    const asked = spec.pages.flat().filter((t) => !t.expect && !t.market.startsWith('OPCAO')).map((t) => t.spec);
    expect((r.unknownSecurities ?? []).map((u) => u.key)).toEqual(asked);
  });
  it('XP (2 pages, CONTINUA..., title on the broker line, TJ kerning, shuffled): costs, IRRF swing and day trade', async () => {
    const r = await importFile({ data: corpus('nota-xp-2024-03-08.pdf') }, O);
    const tot = noteTotals(NOTES.xp);
    expect(txs(r).reduce((a, t) => a + (t.fees ?? 0), 0)).toBeCloseTo(tot.costs, 6);
    expect(txs(r).find((t) => t.instrumentId === 'BVMF:BBSE3')!.taxes).toBeCloseTo(tot.irrf, 6);
    const dtSell = txs(r).find((t) => t.instrumentId === 'BVMF:PETR4' && t.type === 'SELL')!;
    expect(dtSell).toMatchObject({ taxes: 0.4, note: 'Nota 34567890 · PETROBRAS PN N2 · day trade' });
  });
  it('Clear: option skipped, its share of costs dropped; termo fee only on derivatives', async () => {
    const r = await importFile({ data: corpus('nota-clear-2022-11-10.pdf') }, O);
    expect(r.rows.filter((x) => x.issues.some((i) => i.code === 'UNSUPPORTED_ASSET'))).toHaveLength(1);
    const tot = noteTotals(NOTES.clear);
    const optionValue = 350;
    const spot = tot.sells + tot.buys - optionValue;
    expect(txs(r).reduce((a, t) => a + (t.fees ?? 0), 0)).toBeCloseTo(((tot.costs - 0.13) * spot) / (tot.sells + tot.buys), 6);
  });
  it('Inter: a credited cost ("C") reduces the costs', async () => {
    const r = await importFile({ data: corpus('nota-inter-2024-03-07.pdf') }, O);
    expect(txs(r).reduce((a, t) => a + (t.fees ?? 0), 0)).toBeCloseTo(noteTotals(NOTES.inter).costs, 6);
  });
  it('encrypted notes (RC4 and AES-128) ask for the password', async () => {
    expect((await importFile({ data: corpus('nota-btg-2024-05-14-senha-123.pdf') }, O)).needsPassword).toBe('required');
    expect((await importFile({ data: corpus('nota-nu-2024-07-02-senha-012.pdf') }, { ...O, pdfPassword: '999' })).needsPassword).toBe('incorrect');
  });

  it('Davivienda-style extract: summary first, balances, wrapped descriptions, page 2 header, footers', async () => {
    const r = await importFile({ data: corpus('extracto-davivienda-2024-03.pdf') }, O);
    expect(r.detection.presetId).toBe('extracto-co-pdf');
    expect(r.errors).toEqual([]);
    const exp = [...DAVIVIENDA_MOVES, ...DAVIVIENDA_MOVES_P2].filter((m) => m.expect).map((m) => m.expect!);
    expect(txs(r).map((t) => t.type)).toEqual(exp.map((e) => e.type));
    for (const [i, e] of exp.entries()) expect(txs(r)[i]).toMatchObject({ ...(e.instrumentId ? { instrumentId: e.instrumentId } : {}), ...(e.quantity ? { quantity: e.quantity } : {}), ...(e.amount ? { amount: e.amount } : {}) });
    expect(txs(r).find((t) => t.instrumentId === 'XBOG:ECOPETROL')).toMatchObject({ price: 2380, fees: 8497 });
    expect(r.rows.filter((x) => x.issues.some((i) => i.code === 'BALANCE_ROW'))).toHaveLength(2);
    expect(new Set(txs(r).map((t) => t.account))).toEqual(new Set(['Davivienda Corredores']));
  });
  it('Trii-style statement: Spanish month dates, "COP 2.390,00", holdings feed reconciliation', async () => {
    const r = await importFile({ data: corpus('extracto-trii-2024-03.pdf') }, O);
    expect(r.needsConfirmation).toBeUndefined();
    expect(txs(r).map((t) => [t.date, t.type, t.instrumentId, t.quantity, t.price, t.fees])).toEqual(
      TRII_MOVES.map((m) => [`2024-03-${m.date.slice(0, 2)}`, m.expect, `XBOG:${m.symbol}`, m.qty, m.price, m.fee]),
    );
    expect(r.reconciliation).toMatchObject({ asOf: '2024-03-31', positionDifferences: [] });
  });
  it('Excel-saved .xls: fragmented CFB, property streams, SST over CONTINUE, MULRK, formulas, merged title, hidden sheet', async () => {
    const bytes = corpus('movimientos-acciones-valores.xls');
    const wb = readCfbStream(bytes, ['Workbook'])!;
    // The SST really continues in CONTINUE records, and the Workbook chain is not contiguous.
    let continues = 0;
    for (let o = 0; o + 4 <= wb.length; ) {
      const type = wb[o]! | (wb[o + 1]! << 8);
      const len = wb[o + 2]! | (wb[o + 3]! << 8);
      if (type === 0x003c) continues++;
      o += 4 + len;
    }
    expect(continues).toBeGreaterThan(0);
    expect(readCfbStream(bytes, ['\x05SummaryInformation'])!.length).toBeGreaterThan(0);
    const tables = parseXls(bytes);
    expect(tables.map((t) => t.name)).toEqual(['Movimientos', 'Resumen 2', 'Hoja oculta']);
    const moves = xlsMoves();
    expect(tables[0]!.rows[3]![3]).toBe(moves[0]!.desc); // UTF-16 string with an em dash, from the SST
    const r = await importFile({ data: bytes, fileName: 'movimientos.xls' }, O);
    expect(r.errors).toEqual([]);
    expect(txs(r)).toHaveLength(60);
    expect(txs(r).map((t) => t.type)).toEqual(moves.map((m) => m.expect));
    expect(txs(r)[0]).toMatchObject({ date: '2024-01-02', instrumentId: 'XBOG:ECOPETROL', quantity: 10, price: 1000, amount: 10000 });
    expect(txs(r)[1]!.instrumentId).toBe('XBOG:PFCIBEST'); // PFBCOLOM renamed
  });
  it('Mac Excel (1904 date system) gives the same dates', async () => {
    const a = await importFile({ data: corpus('movimientos-acciones-valores.xls'), fileName: 'a.xls' }, O);
    const b = await importFile({ data: corpus('movimientos-mac-1904.xls'), fileName: 'b.xls' }, O);
    expect(b.transactions.map((t) => t.date)).toEqual(a.transactions.map((t) => t.date));
  });
  it('an .xls with an open password says so', async () => {
    const r = await importFile({ data: buildExcelXls({ filepass: true }), fileName: 'x.xls' }, O);
    expect(r.errors[0]!.code).toBe('XLS_ENCRYPTED');
  });
});

// -------------------------------------------------------------------------------------------------
describe('Beyond the review — forwarded e-mails (Sharesight-style inbox)', () => {
  const b64 = (b: Uint8Array) => Buffer.from(b).toString('base64').replace(/(.{76})/g, '$1\r\n');
  const eml = () => {
    const xp = corpus('nota-xp-2024-03-08.pdf');
    const nu = corpus('nota-nu-2024-07-02-senha-012.pdf');
    const csv = 'date,type,symbol,exchange,quantity,price,currency\r\n2024-03-11,BUY,AAPL,XNAS,3,170.5,USD\r\n';
    const qp = csv.replace(/=/g, '=3D');
    return [
      'From: =?UTF-8?Q?Nota_de_Corretagem_XP?= <notas@corretora.exemplo>',
      'To: importar+abc123@portafolio.exemplo',
      'Subject: =?UTF-8?B?Tm90YSBkZSBjb3JyZXRhZ2VtIC0gMDgvMDMvMjAyNA==?=',
      'Date: Fri, 08 Mar 2024 21:10:00 -0300',
      'MIME-Version: 1.0',
      'Content-Type: multipart/mixed; boundary="==OUTER=="',
      '',
      '--==OUTER==',
      'Content-Type: multipart/alternative; boundary="alt"',
      '',
      '--alt',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'Segue sua nota de corretagem.',
      '--alt',
      'Content-Type: text/html; charset=utf-8',
      '',
      '<p>Segue sua nota de corretagem.</p>',
      '--alt--',
      '--==OUTER==',
      'Content-Type: application/pdf',
      'Content-Transfer-Encoding: base64',
      "Content-Disposition: attachment; filename*=UTF-8''Nota%20XP%20N%C2%BA%2034567890.pdf",
      '',
      b64(xp),
      '--==OUTER==',
      'Content-Type: application/pdf; name="copia.pdf"',
      'Content-Transfer-Encoding: base64',
      '',
      b64(xp),
      '--==OUTER==',
      'Content-Type: application/octet-stream; name="=?ISO-8859-1?Q?nota_nu_jul=E7.pdf?="',
      'Content-Transfer-Encoding: base64',
      '',
      b64(nu),
      '--==OUTER==',
      'Content-Type: image/png; name="logo.png"',
      'Content-Transfer-Encoding: base64',
      '',
      'iVBORw0KGgo=',
      '--==OUTER==',
      'Content-Type: message/rfc822',
      '',
      'From: broker@us.exemplo',
      'Subject: Fwd: confirmation',
      'Content-Type: multipart/mixed; boundary="inner"',
      '',
      '--inner',
      'Content-Type: text/csv; name="confirm.csv"',
      'Content-Transfer-Encoding: quoted-printable',
      'Content-Disposition: attachment; filename="confirm.csv"',
      '',
      qp,
      '--inner--',
      '--==OUTER==--',
      '',
    ].join('\r\n');
  };
  it('imports every attachment once, tries the stored passwords, ignores logos', async () => {
    const r = await importEmail(eml(), { ...O, pdfPasswords: ['999', '012'] });
    expect(r.subject).toBe('Nota de corretagem - 08/03/2024');
    expect(r.from).toContain('Nota de Corretagem XP');
    expect(r.attachments.map((a) => a.fileName)).toEqual(['Nota XP Nº 34567890.pdf', 'copia.pdf', 'nota nu julç.pdf', 'confirm.csv']);
    expect(r.attachments[0]!.result.stats.imported).toBe(16);
    expect(r.attachments[1]!.result.stats).toMatchObject({ imported: 0, duplicates: 16 }); // same note attached twice
    expect(r.attachments[2]!.result.stats.imported).toBe(3); // opened with the 2nd stored password
    expect(r.attachments[3]!.result.transactions[0]).toMatchObject({ instrumentId: 'XNAS:AAPL', quantity: 3, price: 170.5 });
    expect(r.ignored).toEqual([{ fileName: 'logo.png', contentType: 'image/png' }]);
    expect(r.transactions).toHaveLength(16 + 3 + 1);
    expect(r.needsPassword).toEqual([]);
  });
  it('without the password, the note is reported as waiting for it', async () => {
    const r = await importEmail(eml(), O);
    expect(r.needsPassword).toEqual(['nota nu julç.pdf']);
  });
});
