import type { Instrument, Transaction } from '@pm/core';
import { describe, expect, it } from 'vitest';
import {
  canonicalTemplateCsv,
  CANONICAL_COLUMNS,
  type CsvExportOptions,
  exportTransactionsCsv,
  importFile,
  importText,
  inspectFile,
  InstrumentResolver,
  suggestMappingFromHeaders,
  translateIssue,
} from '../src';
import { byLine, fixture, importFixture } from './helpers/load';

describe('de-duplication', () => {
  it('marks every row as duplicate when the same file is imported again', async () => {
    const first = await importFixture('ibkr-activity-statement.csv');
    const again = await importFixture('ibkr-activity-statement.csv', { existingTransactions: first.transactions, existingInstruments: first.instruments });
    expect(again.stats.imported).toBe(0);
    expect(again.stats.duplicates).toBe(first.stats.imported);
    expect(again.transactions).toEqual([]);
    expect(again.instruments).toEqual([]);
    expect(again.rows.filter((r) => r.status === 'duplicate').every((r) => r.issues.some((i) => i.code === 'DUPLICATE'))).toBe(true);
  });
  it('produces stable hashes and ids across runs', async () => {
    const a = await importFixture('b3-negociacao.xlsx');
    const b = await importFixture('b3-negociacao.xlsx');
    expect(a.transactions.map((t) => t.id)).toEqual(b.transactions.map((t) => t.id));
    expect(new Set(a.transactions.map((t) => t.importHash)).size).toBe(a.transactions.length);
  });
  it('keeps identical legitimate rows within one file and dedupes them on re-import', async () => {
    const csv = 'date,type,symbol,exchange,quantity,price,currency\n2024-01-02,BUY,PETR4,BVMF,100,38.5,BRL\n2024-01-02,BUY,PETR4,BVMF,100,38.5,BRL\n';
    // Identical rows in one file are a blocking choice: excluded until the user accepts them.
    const blocked = await importText(csv, { portfolioId: 'p1' });
    expect(blocked.stats).toMatchObject({ imported: 1, possibleDuplicates: 1 });
    expect(byLine(blocked, 3)).toMatchObject({ status: 'possible_duplicate', duplicateOf: { inFile: true, line: 2 } });
    const first = await importText(csv, { portfolioId: 'p1', acceptDuplicates: 'in-file' });
    expect(first.stats.imported).toBe(2);
    const second = await importText(csv, { portfolioId: 'p1', existingTransactions: first.transactions });
    expect(second.stats).toMatchObject({ imported: 0, duplicates: 2 });
    const third = await importText(csv + '2024-01-02,BUY,PETR4,BVMF,100,38.5,BRL\n', { portfolioId: 'p1', existingTransactions: first.transactions, acceptDuplicates: [4] });
    expect(third.stats).toMatchObject({ imported: 1, duplicates: 2 });
  });
  it('flags possible duplicates coming from another source (B3 Negociação vs Movimentação)', async () => {
    const neg = await importFixture('b3-negociacao.xlsx');
    const mov = await importFixture('b3-movimentacao.xlsx', { existingTransactions: neg.transactions, existingInstruments: neg.instruments });
    // Settlements (D+2 business days) of trades already imported from Negociação are skipped.
    const petr = byLine(mov, 2);
    expect(petr.status).toBe('skipped');
    expect(petr.issues.map((i) => i.code)).toContain('SETTLEMENT_MATCHED');
    expect(byLine(mov, 9).status).toBe('skipped'); // PETR4 sale settlement
    expect(mov.stats.matchedInstruments).toBeGreaterThan(0);
  });
});

describe('errors with line numbers', () => {
  it('reports malformed rows and keeps valid ones', async () => {
    const r = await importFixture('canonical-malformed.csv');
    expect(r.detection.presetId).toBe('portafolio-pro');
    expect(byLine(r, 2).status).toBe('ok'); // multi-line quoted note spans lines 2-3
    expect(byLine(r, 2).transaction!.note).toBe('nota con\nsalto de línea');
    const expected: [number, string][] = [
      [4, 'INVALID_DATE'], [5, 'UNKNOWN_TYPE'], [6, 'INVALID_NUMBER'], [7, 'MISSING_FIELD'], [8, 'INVALID_CURRENCY'], [9, 'MISSING_INSTRUMENT'],
    ];
    for (const [line, code] of expected) {
      const row = byLine(r, line);
      expect(row.status).toBe('error');
      expect(row.issues[0]).toMatchObject({ code, severity: 'error', line });
    }
    expect(r.errors.map((e) => e.line)).toEqual([4, 5, 6, 7, 8, 9]);
    expect(byLine(r, 10).transaction).toMatchObject({ type: 'DIVIDEND', amount: 312000, taxes: 31200 });
    expect(r.stats).toMatchObject({ imported: 2, errors: 6, totalRows: 8 });
  });
  it('translates issues to pt and en', async () => {
    const r = await importFixture('canonical-malformed.csv', { locale: 'pt' });
    expect(byLine(r, 4).issues[0]!.message).toBe('Data inválida: "2024-13-45".');
    expect(translateIssue(byLine(r, 4).issues[0]!, 'en').message).toBe('Invalid date: "2024-13-45".');
  });
  it('rejects legacy .xls, JSON backups and empty files', async () => {
    const xls = await importFile({ data: new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]) }, { portfolioId: 'p' });
    expect(xls.errors[0]!.code).toBe('FILE_XLS_LEGACY');
    const json = await importText('{"format":"portafolio-pro-backup","schemaVersion":1}', { portfolioId: 'p' });
    expect(json.errors[0]!.code).toBe('FILE_IS_BACKUP');
    const empty = await importText('   ', { portfolioId: 'p' });
    expect(empty.errors[0]!.code).toBe('FILE_UNSUPPORTED');
    const bad = await importFixture('ibkr-flex-trades.csv', { presetId: 'nope' });
    expect(bad.errors[0]!.code).toBe('UNKNOWN_PRESET');
  });
});

describe('generic importer and mapping', () => {
  it('suggests mappings from es/pt/en headers', () => {
    const es = suggestMappingFromHeaders(['Fecha', 'Tipo de operación', 'Nemotécnico', 'Cantidad', 'Precio unitario', 'Valor bruto', 'Comisión', 'IVA', 'Retención en la fuente', 'GMF', 'Valor neto', 'Moneda']);
    expect(es.mapping.columns).toEqual({ date: 0, type: 1, symbol: 2, quantity: 3, price: 4, amount: 5, fees: [6, 7], taxes: [8, 9], netAmount: 10, currency: 11 });
    expect(es.missing).toEqual([]);
    const pt = suggestMappingFromHeaders(['Data do Negócio', 'C/V', 'Ativo', 'Quantidade', 'Preço', 'Corretagem', 'Emolumentos', 'IRRF']);
    expect(pt.mapping.columns).toMatchObject({ date: 0, type: 1, symbol: 2, quantity: 3, price: 4, fees: [5, 6], taxes: [7] });
    const en = suggestMappingFromHeaders(['Trade Date', 'Symbol', 'Action', 'Qty', 'Price', 'Commission', 'Net Amount', 'Currency', 'Exchange rate']);
    expect(en.mapping.columns).toMatchObject({ date: 0, symbol: 1, type: 2, quantity: 3, price: 4, fees: [5], netAmount: 6, currency: 7, fxRateToBase: 8 });
    expect(suggestMappingFromHeaders(['Col A', 'Col B']).missing).toEqual(['date', 'type', 'quantity']);
  });
  it('auto-imports an unknown but well-labelled Portuguese file with a warning', async () => {
    const r = await importFixture('generic-pt.csv');
    expect(r.detection).toMatchObject({ presetId: 'generic', presetConfidence: 'low', delimiter: ';', numberFormat: 'comma' });
    expect(r.warnings.some((w) => w.code === 'GENERIC_AUTO_MAPPING')).toBe(true);
    expect(byLine(r, 2).transaction).toMatchObject({ type: 'BUY', instrumentId: 'BVMF:BBAS3', quantity: 100, price: 38.5, fees: 4.9, note: 'Primeira compra' });
    expect(byLine(r, 4).issues[0]).toMatchObject({ code: 'MISSING_FIELD', params: { field: 'amount' } });
    expect(r.mappingSuggestion?.headers[0]).toBe('Data');
  });
  it('derives the gross amount from a net amount column', async () => {
    const r = await importFixture('generic-en-amount.csv');
    expect(byLine(r, 2).transaction).toMatchObject({ type: 'BUY', instrumentId: 'XNAS:MSFT', quantity: 10, price: 1228.5, amount: 12285, fees: 1 });
    expect(byLine(r, 3).transaction).toMatchObject({ type: 'SELL', amount: 6250 });
  });
  it('asks for a mapping when the layout is unknown, then imports with the user mapping', async () => {
    const r = await importFixture('unknown-layout.csv');
    expect(r.needsMapping).toBe(true);
    expect(r.errors[0]!.code).toBe('NEEDS_MAPPING');
    expect(r.mappingSuggestion!.headers).toEqual(['Col A', 'Col B', 'Col C']);
    const csv = 'Cuando;Que;Papel;Cuantos;A cuanto\n02/01/2024;C;ECOPETROL;100;2.450,5\n03/01/2024;V;ECOPETROL;50;2.500\n';
    const mapping = { headerRow: 0, columns: { date: 0, type: 1, symbol: 2, quantity: 3, price: 4 }, defaultCurrency: 'COP', defaultExchange: 'XBOG', typeValues: { C: 'BUY' as const, V: 'SELL' as const } };
    const ask = await importText(csv, { portfolioId: 'p1', mapping });
    expect(ask.dateFormatCandidates).toEqual(['DMY', 'MDY']); // 02/01 and 03/01 are ambiguous
    expect(ask.transactions).toEqual([]);
    const mapped = await importText(csv, { portfolioId: 'p1', mapping: { ...mapping, dateFormat: 'DMY' } });
    expect(mapped.errors).toEqual([]);
    expect(mapped.transactions).toHaveLength(2);
    expect(mapped.transactions[0]).toMatchObject({ date: '2024-01-02', type: 'BUY', instrumentId: 'XBOG:ECOPETROL', price: 2450.5, currency: 'COP' });
    expect(mapped.transactions[1]).toMatchObject({ type: 'SELL', price: 2500 });
  });
  it('reads HTML tables saved as .xls', async () => {
    const html = '<html><body><table><tr><th>Fecha</th><th>Operación</th><th>Especie</th><th>Cantidad</th><th>Precio</th></tr>' +
      '<tr><td>22/01/2024</td><td>Compra</td><td>ISA</td><td>10</td><td>17.500,00</td></tr></table></body></html>';
    const r = await importFile({ data: new TextEncoder().encode(html), fileName: 'extracto.xls' }, { portfolioId: 'p1' });
    expect(r.detection).toMatchObject({ fileKind: 'html', presetId: 'extracto-co' });
    expect(r.transactions[0]).toMatchObject({ instrumentId: 'XBOG:ISA', price: 17500, currency: 'COP' });
  });
  it('accepts Blob input (browser File)', async () => {
    const blob = new Blob([fixture('schwab-transactions.csv') as Uint8Array<ArrayBuffer>]);
    const r = await importFile({ data: blob }, { portfolioId: 'p1', account: 'Schwab', idFactory: (h, i) => `t${i}` });
    expect(r.detection.presetId).toBe('schwab');
    expect(r.transactions[0]).toMatchObject({ id: 't0', account: 'Schwab' });
  });
});

describe('inspectFile', () => {
  it('returns tables, preset scores and suggestions for the wizard', async () => {
    const info = await inspectFile({ data: fixture('etoro-account-statement.xlsx') });
    expect(info.kind).toBe('xlsx');
    expect(info.tables.map((t) => t.name)).toEqual(['Account Summary', 'Closed Positions', 'Account Activity']);
    expect(info.best).toMatchObject({ presetId: 'etoro', table: 'Account Activity' });
    const csv = await inspectFile({ data: fixture('extracto-davivienda-latin1.csv') });
    expect(csv).toMatchObject({ kind: 'csv', encoding: 'windows-1252', delimiter: ';' });
    expect(csv.tables[0]!.suggestion.headerRow).toBe(4); // index in non-blank rows (file line 6)
    expect(csv.tables[0]!.suggestion.headers[2]).toBe('Especie');
  });
});

describe('instrument resolution', () => {
  const existing: Instrument[] = [
    { id: 'XNYS:EC', symbol: 'EC', name: 'Ecopetrol ADR', exchange: 'XNYS', currency: 'USD', country: 'CO', assetClass: 'equity', isin: 'US2791581091' },
    { id: 'XNAS:ZZZ', symbol: 'ZZZ', name: 'Custom', exchange: 'XNAS', currency: 'USD', country: 'US', assetClass: 'equity' },
  ];
  it('reuses existing instruments by ISIN, id or unique symbol', () => {
    const r = new InstrumentResolver(existing);
    expect(r.resolve({ isin: 'US2791581091', name: 'ECOPETROL SA' })!).toMatchObject({ isNew: false, instrument: { id: 'XNYS:EC' } });
    expect(r.resolve({ symbol: 'ZZZ', currency: 'USD' })!).toMatchObject({ isNew: false, instrument: { id: 'XNAS:ZZZ' } });
    expect(r.newInstruments()).toEqual([]);
  });
  it('infers markets for BVC, B3, US, Europe and yahoo-suffixed symbols', () => {
    const r = new InstrumentResolver([], { defaultUsExchange: 'XNYS' });
    expect(r.resolve({ symbol: 'ECOPETROL' })!.instrument).toMatchObject({ id: 'XBOG:ECOPETROL', currency: 'COP', providerSymbols: { yahoo: 'ECOPETROL.CL' } });
    expect(r.resolve({ symbol: 'ICOLCAP' })!.instrument.assetClass).toBe('etf');
    expect(r.resolve({ symbol: 'PETR4' })!.instrument).toMatchObject({ id: 'BVMF:PETR4', currency: 'BRL' });
    expect(r.resolve({ symbol: 'AAPL34' })!.instrument.exchange).toBe('BVMF'); // BDR
    expect(r.resolve({ symbol: 'MSFT' })!.instrument.id).toBe('XNAS:MSFT');
    expect(r.resolve({ symbol: 'SPY' })!.instrument).toMatchObject({ id: 'ARCX:SPY', assetClass: 'etf' });
    const guessed = r.resolve({ symbol: 'ABCD', currency: 'USD' })!;
    expect(guessed.instrument.id).toBe('XNYS:ABCD');
    expect(guessed.notes[0]!.code).toBe('EXCHANGE_GUESSED');
    expect(r.resolve({ symbol: 'ITX.MC' })!.instrument).toMatchObject({ id: 'XMAD:ITX', currency: 'EUR', providerSymbols: { yahoo: 'ITX.MC' } });
    expect(r.resolve({ isin: 'BRVALEACNOR0' })!.instrument.id).toBe('BVMF:VALE3');
    expect(r.resolve({ symbol: 'VOD', exchange: 'LSE' })!.instrument).toMatchObject({ id: 'XLON:VOD', currency: 'GBP' });
    expect(r.resolve({ symbol: 'CEMEXCPO', currency: 'MXN' })!.instrument).toMatchObject({ id: 'XMEX:CEMEXCPO', providerSymbols: { yahoo: 'CEMEXCPO.MX' } });
    expect(r.resolve({ name: 'CDT Bancolombia 360 días', currency: 'COP' })!.instrument).toMatchObject({ exchange: 'MANUAL', assetClass: 'fixed_income', pricing: 'manual' });
  });
});

describe('canonical CSV', () => {
  const instruments: Instrument[] = [
    { id: 'XBOG:ECOPETROL', symbol: 'ECOPETROL', name: 'Ecopetrol S.A.', exchange: 'XBOG', currency: 'COP', country: 'CO', assetClass: 'equity' },
    { id: 'BVMF:PETR4', symbol: 'PETR4', name: 'Petrobras PN', exchange: 'BVMF', currency: 'BRL', country: 'BR', assetClass: 'equity', isin: 'BRPETRACNPR6' },
  ];
  const txs: Transaction[] = [
    { id: 'a', portfolioId: 'p1', date: '2024-01-02', type: 'DEPOSIT', currency: 'COP', amount: 10_000_000, account: 'Trii' },
    { id: 'b', portfolioId: 'p1', date: '2024-01-03', type: 'BUY', instrumentId: 'XBOG:ECOPETROL', quantity: 1000, price: 2450.5, amount: 2_450_500, fees: 7351.5, currency: 'COP', account: 'Trii', note: 'Primera, "grande"' },
    { id: 'c', portfolioId: 'p1', date: '2024-02-01', type: 'BUY', instrumentId: 'BVMF:PETR4', quantity: 100, price: 38.5, amount: 3850, fees: 1.15, currency: 'BRL', fxRateToBase: 812.33 },
    { id: 'd', portfolioId: 'p1', date: '2024-03-01', type: 'SPLIT', instrumentId: 'BVMF:PETR4', ratio: 2, currency: 'BRL' },
    { id: 'e', portfolioId: 'p1', date: '2024-04-20', type: 'DIVIDEND', instrumentId: 'XBOG:ECOPETROL', amount: 312000, taxes: 31200, currency: 'COP' },
    { id: 'f', portfolioId: 'p1', date: '2024-05-02', type: 'FX_CONVERSION', currency: 'COP', amount: 4_000_000, toCurrency: 'USD', toAmount: 1000, fees: 12000 },
    { id: 'g', portfolioId: 'p1', date: '2024-05-03', type: 'TAX', currency: 'COP', amount: 16000, note: 'GMF' },
  ];
  const strip = (t: Transaction) => {
    const { id: _id, importHash: _h, source: _s, ...rest } = t;
    return rest;
  };
  it.each<[string, CsvExportOptions]>([
    ['comma / dot', {}],
    ['semicolon / decimal comma (Excel es)', { delimiter: ';', bom: true }],
  ])('round-trips through export → import (%s)', async (_label, opts) => {
    const csv = exportTransactionsCsv(txs, instruments, opts);
    expect(csv.split('\n')[0]!.replace('﻿', '')).toBe(CANONICAL_COLUMNS.map((c) => c.column).join(opts.delimiter ?? ','));
    const r = await importText(csv, { portfolioId: 'p1', existingInstruments: instruments });
    expect(r.detection.presetId).toBe('portafolio-pro');
    expect(r.errors).toEqual([]);
    expect(r.transactions.map(strip)).toEqual(txs.map(strip));
    expect(r.instruments).toEqual([]);
  });
  it('the downloadable template imports cleanly', async () => {
    const r = await importText(canonicalTemplateCsv(), { portfolioId: 'p1' });
    expect(r.errors).toEqual([]);
    expect(r.stats.imported).toBe(6);
    expect(r.instruments.map((i) => i.id).sort()).toEqual(['BVMF:PETR4', 'XBOG:ECOPETROL', 'XNAS:AAPL']);
  });
  it('accepts a hand-edited template with Spanish types and DD/MM dates', async () => {
    const csv = 'date;type;symbol;exchange;quantity;price;currency;fees\n15/01/2024;compra;ECOPETROL;BVC;100;2.450,00;COP;1.500\n20/01/2024;venta;ECOPETROL;BVC;50;2.600,00;COP;800\n';
    const r = await importText(csv, { portfolioId: 'p1' });
    expect(r.detection.presetId).toBe('portafolio-pro');
    expect(r.transactions[0]).toMatchObject({ date: '2024-01-15', type: 'BUY', instrumentId: 'XBOG:ECOPETROL', price: 2450, fees: 1500 });
  });
});
