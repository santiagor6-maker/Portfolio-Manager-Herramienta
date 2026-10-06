import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  extractPdf,
  FlexError,
  fetchFlexStatement,
  flexXmlToTable,
  importFile,
  importFlexXml,
  listBrokerProfiles,
  listPresets,
  parseTradeLine,
  sinacorTicker,
  syncIbkrFlex,
} from '../src';
import { writePdf } from './helpers/pdf-writer';
import { byLine, fixture, importFixture } from './helpers/load';

const ws = (name: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'ibkr-flex-ws', name), 'utf8');

describe('I1 — PDF: nota de corretagem SINACOR', async () => {
  const r = await importFixture('nota-sinacor.pdf');
  it('detects the layout and reads trades from three notes', () => {
    expect(r.detection).toMatchObject({ fileKind: 'pdf', presetId: 'nota-sinacor-pdf', numberFormat: 'comma', dateFormat: 'DMY' });
    const t = r.transactions.map((x) => [x.date, x.type, x.instrumentId, x.quantity, x.price, x.amount]);
    expect(t).toEqual([
      ['2023-01-02', 'BUY', 'BVMF:PETR4', 100, 23.45, 2345],
      ['2023-01-02', 'BUY', 'BVMF:ITSA4', 37, 8.92, 330.04],
      ['2023-01-02', 'SELL', 'BVMF:VALE3', 20, 88.1, 1762],
      ['2023-03-15', 'SELL', 'BVMF:PETR4', 50, 25.1, 1255],
      ['2023-03-15', 'BUY', 'BVMF:HGLG11', 10, 160.5, 1605],
    ]);
  });
  it('allocates the Resumo Financeiro costs pro-rata and IRRF to sales', () => {
    const n1 = r.transactions.filter((t) => t.note === 'Nota 12345678');
    expect(n1.reduce((s, t) => s + (t.fees ?? 0), 0)).toBeCloseTo(6.58, 8); // 1,22 + 0,22 + 4,90 + 0,24
    expect(n1[0]!.fees).toBeCloseTo((6.58 * 2345) / 4437.04, 6);
    expect(n1.find((t) => t.type === 'SELL')!.taxes).toBe(0.09);
    expect(r.transactions.find((t) => t.note === 'Nota 87654321' && t.type === 'SELL')).toMatchObject({ taxes: 0.06, account: 'CLEAR CORRETORA - GRUPO XP' });
    expect(n1[0]!.account).toBe('XP INVESTIMENTOS CCTVM S/A');
  });
  it('skips options and asks for unknown securities (then accepts a securityMap answer)', async () => {
    const opt = r.rows.find((x) => x.issues.some((i) => i.code === 'UNSUPPORTED_ASSET'))!;
    expect(opt).toMatchObject({ status: 'skipped', sheet: 'pág. 1' });
    const unknown = r.rows.find((x) => x.issues.some((i) => i.code === 'UNKNOWN_SECURITY'))!;
    expect(unknown).toMatchObject({ status: 'error', sheet: 'pág. 3' });
    expect(unknown.issues[0]!.params).toEqual({ spec: 'MINERVA ON NM' });
    const mapped = await importFixture('nota-sinacor.pdf', { securityMap: { 'MINERVA ON NM': 'BEEF3' } });
    const beef = mapped.transactions.find((t) => t.instrumentId === 'BVMF:BEEF3')!;
    expect(beef).toMatchObject({ quantity: 200, fees: 0.6, account: 'RICO INVESTIMENTOS - GRUPO XP' });
    // The note's "Líquido para" was printed inconsistent on purpose → warning.
    expect(mapped.warnings.some((w) => w.code === 'NOTA_TOTALS_MISMATCH' && w.params?.nota === '99887766')).toBe(true);
    expect(mapped.warnings.some((w) => w.code === 'NOTA_TOTALS_MISMATCH' && w.params?.nota === '87654321')).toBe(false);
  });
  it('maps SINACOR specifications to tickers', () => {
    expect(sinacorTicker('PETROBRAS PN N2')).toBe('PETR4');
    expect(sinacorTicker('PETROBRAS ON N2')).toBe('PETR3');
    expect(sinacorTicker('ITAUUNIBANCO PN N1')).toBe('ITUB4');
    expect(sinacorTicker('TAESA UNT N2')).toBe('TAEE11');
    expect(sinacorTicker('FII CSHG LOG HGLG11 CI')).toBe('HGLG11');
    expect(sinacorTicker('BRASIL ON NM')).toBe('BBAS3');
    expect(sinacorTicker('EMPRESA DESCONHECIDA ON')).toBeUndefined();
    expect(parseTradeLine('1-BOVESPA  C  FRACIONARIO  ITAUSA PN N1  #  37  8,92  330,04  D', 0)).toMatchObject({ side: 'C', market: 'FRACIONARIO', spec: 'ITAUSA PN N1', quantity: 37, value: 330.04 });
  });
  it('re-importing the same PDF is fully de-duplicated', async () => {
    const again = await importFixture('nota-sinacor.pdf', { existingTransactions: r.transactions });
    expect(again.stats).toMatchObject({ imported: 0, duplicates: 5 });
  });
});

describe('I1 — PDF: CDT certificates (Colombia)', () => {
  it('fixed-rate CDT → fixed_income instrument with accrual spec + BUY', async () => {
    const r = await importFixture('cdt-bancolombia.pdf');
    expect(r.detection.presetId).toBe('cdt-pdf');
    expect(r.instruments).toEqual([
      expect.objectContaining({
        id: 'MANUAL:CDT-BANCOLOMBIA-7001234567', assetClass: 'fixed_income', currency: 'COP', pricing: 'manual',
        accrual: { kind: 'fixed', annualRate: 0.1125, dayCount: 'ACT/365', issueDate: '2024-01-15', maturity: '2025-01-09' },
      }),
    ]);
    expect(r.transactions[0]).toMatchObject({ date: '2024-01-15', type: 'BUY', quantity: 1, price: 10_000_000, amount: 10_000_000, currency: 'COP' });
  });
  it('IPC-indexed CDT with term only → computed maturity', async () => {
    const r = await importFixture('cdt-davivienda-ipc.pdf');
    expect(r.instruments[0]!.accrual).toEqual({ kind: 'indexed', index: 'IPC_CO', spread: 0.045, dayCount: 'ACT/365', issueDate: '2024-03-01', maturity: '2025-08-23' });
    expect(r.transactions[0]).toMatchObject({ amount: 25_000_000, note: 'CDT BANCO DAVIVIENDA S.A. · No. CDT-889900 · intereses: Trimestral' });
  });
});

describe('I1 — PDF: Colombian brokerage statement (table rebuilt by text position)', () => {
  it('reads a 2-page Trii statement with a repeated header', async () => {
    const r = await importFixture('extracto-trii.pdf');
    expect(r.detection.presetId).toBe('extracto-co-pdf');
    expect(r.errors).toEqual([]);
    expect(r.transactions.map((t) => [t.date, t.type, t.instrumentId ?? '', t.quantity ?? '', t.amount, t.fees ?? 0, t.account])).toEqual([
      ['2024-01-02', 'DEPOSIT', '', '', 3_000_000, 0, 'Trii'],
      ['2024-01-15', 'BUY', 'XBOG:ECOPETROL', 500, 1_225_000, 3675, 'Trii'],
      ['2024-01-16', 'BUY', 'XBOG:CIBEST', 20, 770_000, 2310, 'Trii'],
      ['2024-02-20', 'SELL', 'XBOG:ECOPETROL', 200, 520_000, 1560, 'Trii'],
      ['2024-03-28', 'DIVIDEND', 'XBOG:ECOPETROL', '', 91_000, 0, 'Trii'],
    ]);
  });
  it('unknown PDFs and broken PDFs fail with clear messages', async () => {
    const other = writePdf([[[40, 800, 'Factura de servicios públicos'], [40, 780, 'Total a pagar: $ 120.000']]]);
    const r = await importFile({ data: other, fileName: 'factura.pdf' }, { portfolioId: 'p' });
    expect(r.errors[0]!.code).toBe('FILE_PDF_UNSUPPORTED');
    const broken = new TextEncoder().encode('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\nNota de Corretagem\n');
    const b = await importFile({ data: broken, fileName: 'nota.pdf' }, { portfolioId: 'p' });
    expect(b.detection.fileKind).toBe('pdf');
    expect(b.errors[0]!.code).toBe('PDF_READ_ERROR');
  });
  it('exposes positioned lines for custom parsers', async () => {
    const doc = await extractPdf(fixture('extracto-trii.pdf'));
    expect(doc.pageCount).toBe(2);
    expect(doc.lines.find((l) => l.text.startsWith('Fecha'))!.cells).toEqual(['Fecha', 'Operación', 'Especie', 'Cantidad', 'Precio', 'Valor bruto', 'Comisión', 'Valor neto']);
  });
});

describe('I2 — IBKR Flex Web Service sync (recorded responses)', () => {
  const mockFetch = (responses: string[]) => {
    const calls: string[] = [];
    const fetch = async (url: string) => {
      calls.push(url);
      const body = responses.shift();
      if (body === undefined) throw new Error('unexpected call');
      return { ok: true, status: 200, text: async () => body };
    };
    return { fetch, calls };
  };
  it('SendRequest → GetStatement (retrying while in progress) → transactions', async () => {
    const { fetch, calls } = mockFetch([ws('send-request.xml'), ws('in-progress.xml'), ws('statement.xml')]);
    const sleeps: number[] = [];
    const r = await syncIbkrFlex({ token: 'tok123', queryId: '987654', fetch, delayMs: 5, sleep: async (ms) => void sleeps.push(ms) }, { portfolioId: 'p1' });
    expect(calls).toEqual([
      'https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/SendRequest?t=tok123&q=987654&v=3',
      'https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/GetStatement?t=tok123&q=8123456789&v=3',
      'https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService/GetStatement?t=tok123&q=8123456789&v=3',
    ]);
    expect(sleeps).toEqual([5]);
    const t = r.transactions.map((x) => [x.date, x.type, x.instrumentId ?? x.toCurrency, x.quantity ?? x.amount]);
    expect(t).toEqual([
      ['2024-01-03', 'BUY', 'XNAS:AAPL', 10],
      ['2024-03-15', 'BUY', 'XETR:SAP', 5],
      ['2024-03-14', 'FX_CONVERSION', 'USD', 1000],
      ['2024-03-14', 'FEE', undefined, 2],
      ['2024-06-20', 'SELL', 'XNAS:AAPL', 4],
      ['2024-05-16', 'DIVIDEND', 'XNAS:AAPL', 2.4],
      ['2024-01-02', 'DEPOSIT', undefined, 5000],
      ['2024-02-01', 'TRANSFER_IN', 'XNAS:MSFT', 20],
    ]);
    expect(r.transactions.find((x) => x.type === 'DIVIDEND')!.taxes).toBe(0.72);
    expect(r.transactions.every((x) => x.account === 'Interactive Brokers' && x.source === 'import:ibkr-flex')).toBe(true);
    expect(r.reconciliation).toMatchObject({ asOf: '2024-06-28', positionDifferences: [] });
  });
  it('the next sync only brings new transactions (exact de-duplication by TransactionID)', async () => {
    const first = await importFlexXml(ws('statement.xml'), { portfolioId: 'p1' });
    const second = await importFlexXml(ws('statement.xml'), { portfolioId: 'p1', existingTransactions: first.transactions });
    expect(second.stats).toMatchObject({ imported: 0, duplicates: 7 });
  });
  it('maps Flex error codes to clear errors (no retry on expired token)', async () => {
    const { fetch } = mockFetch([ws('token-expired.xml')]);
    await expect(fetchFlexStatement({ token: 't', queryId: 'q', fetch })).rejects.toMatchObject({ name: 'FlexError', code: '1012', message: expect.stringMatching(/expiró/) });
    const busy = mockFetch([ws('send-request.xml'), ...Array(3).fill(ws('in-progress.xml'))]);
    await expect(fetchFlexStatement({ token: 't', queryId: 'q', fetch: busy.fetch, maxAttempts: 3, sleep: async () => {} })).rejects.toBeInstanceOf(FlexError);
  });
  it('converts XML sections to the Flex CSV column names', () => {
    const table = flexXmlToTable(ws('statement.xml'));
    expect(table.rows[0]).toEqual(expect.arrayContaining(['ClientAccountID', 'CurrencyPrimary', 'AssetClass', 'Buy/Sell', 'TradePrice']));
  });
});

describe('catalog of formats and broker profiles', () => {
  it('lists PDF parsers and LatAm broker profiles', () => {
    const ids = listPresets().map((p) => p.id);
    expect(ids).toEqual(expect.arrayContaining(['nota-sinacor-pdf', 'cdt-pdf', 'extracto-co-pdf', 'fidelity', 'b3-posicao']));
    const profiles = listBrokerProfiles().map((p) => p.id);
    expect(profiles).toEqual(expect.arrayContaining(['xp', 'btg', 'rico', 'clear', 'nu-invest', 'inter', 'avenue', 'hapi', 'trii', 'tyba', 'davivienda-corredores', 'acciones-valores', 'tesouro-direto', 'fidelity']));
  });
  it('a broker profile sets the account and market defaults for generic files', async () => {
    const r = await importFile({ data: 'Data;Ativo;Operação;Quantidade;Preço\n05/01/2023;BBAS3;Compra;100;38,50\n' }, { portfolioId: 'p', brokerProfile: 'xp' });
    expect(r.transactions[0]).toMatchObject({ account: 'XP', currency: 'BRL', instrumentId: 'BVMF:BBAS3' });
  });
});

describe('Fidelity', async () => {
  const r = await importFixture('fidelity-history.csv');
  it('parses sentences, skips disclaimers and money-market sweeps', () => {
    expect(r.detection).toMatchObject({ presetId: 'fidelity', dateFormat: 'MDY' });
    expect(byLine(r, 5).transaction).toMatchObject({ type: 'BUY', instrumentId: 'XNAS:AAPL', quantity: 10, price: 175.1 });
    expect(byLine(r, 7).transaction).toMatchObject({ type: 'DIVIDEND', amount: 2.4 });
    expect(byLine(r, 8).transaction).toMatchObject({ type: 'TAX', amount: 0.72 });
    expect(byLine(r, 10).transaction).toMatchObject({ type: 'SELL', quantity: 4, fees: 0.03 });
    expect(byLine(r, 11).transaction).toMatchObject({ type: 'INTEREST', amount: 3.21 });
    expect(byLine(r, 11).transaction!.instrumentId).toBeUndefined();
    expect(r.stats.errors).toBe(0);
  });
});
