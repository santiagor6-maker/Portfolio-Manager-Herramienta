import { describe, expect, it } from 'vitest';
import { listPresets } from '../src';
import { byLine, importFixture } from './helpers/load';

const tx = (r: Awaited<ReturnType<typeof importFixture>>, line: number) => byLine(r, line).transaction!;

describe('Interactive Brokers — Activity Statement', async () => {
  const r = await importFixture('ibkr-activity-statement.csv');
  it('detects the preset', () => {
    expect(r.detection).toMatchObject({ presetId: 'ibkr-activity', fileKind: 'csv', delimiter: ',', numberFormat: 'dot' });
    expect(r.errors).toEqual([]);
  });
  it('imports trades with exchange from Financial Instrument Information', () => {
    expect(tx(r, 19)).toMatchObject({ type: 'BUY', instrumentId: 'XNAS:AAPL', quantity: 10, price: 125.07, amount: 1250.7, fees: 1, currency: 'USD' });
    expect(tx(r, 21)).toMatchObject({ type: 'SELL', instrumentId: 'XNAS:AAPL', quantity: 4, amount: 737, fees: 1.01 });
    expect(tx(r, 16)).toMatchObject({ type: 'BUY', instrumentId: 'XETR:SAP', currency: 'EUR', fees: 3 });
    expect(byLine(r, 20).status).toBe('skipped'); // ClosedLot
    const voo = r.instruments.find((i) => i.id === 'ARCX:VOO')!;
    expect(voo).toMatchObject({ assetClass: 'etf', isin: 'US9229083632', providerSymbols: { yahoo: 'VOO' } });
    expect(r.instruments.find((i) => i.id === 'XETR:SAP')).toMatchObject({ currency: 'EUR', providerSymbols: { yahoo: 'SAP.DE' } });
  });
  it('maps forex trades to FX_CONVERSION (thousands-separated quantity)', () => {
    expect(tx(r, 26)).toMatchObject({ type: 'FX_CONVERSION', currency: 'USD', amount: 1071.2, toCurrency: 'EUR', toAmount: 1000, fees: 2 });
  });
  it('skips options with a warning and parses splits', () => {
    expect(byLine(r, 29)).toMatchObject({ status: 'skipped' });
    expect(byLine(r, 29).issues[0]!.code).toBe('UNSUPPORTED_ASSET');
    expect(tx(r, 31)).toMatchObject({ type: 'SPLIT', instrumentId: 'XNAS:AAPL', ratio: 2 });
    expect(byLine(r, 32).issues[0]!.code).toBe('SKIPPED_MOVEMENT');
  });
  it('merges withholding into dividends and nets reversals', () => {
    expect(tx(r, 39)).toMatchObject({ type: 'DIVIDEND', instrumentId: 'XNAS:AAPL', amount: 2.3, taxes: 0.69 });
    expect(tx(r, 40)).toMatchObject({ type: 'DIVIDEND', instrumentId: 'ARCX:VOO', amount: 7.437, taxes: 2.23 });
    expect(byLine(r, 41).status).toBe('skipped');
    expect(tx(r, 44)).toMatchObject({ currency: 'EUR', amount: 6.15, taxes: 1.62 });
    expect(byLine(r, 48).issues[0]!.code).toBe('WITHHOLDING_MERGED');
  });
  it('imports cash movements', () => {
    expect(tx(r, 35)).toMatchObject({ type: 'DEPOSIT', amount: 5000 });
    expect(tx(r, 36)).toMatchObject({ type: 'WITHDRAWAL', amount: 500 });
    expect(tx(r, 54)).toMatchObject({ type: 'INTEREST', amount: 3.12 });
    expect(tx(r, 57)).toMatchObject({ type: 'FEE', amount: 10 });
    expect(tx(r, 58)).toMatchObject({ type: 'FEE', amount: -10 });
    expect(r.stats).toMatchObject({ imported: 14, errors: 0 });
    expect(r.transactions.every((t) => t.source === 'import:ibkr-activity' && t.portfolioId === 'p1')).toBe(true);
  });
});

describe('Interactive Brokers — Flex Query', async () => {
  const trades = await importFixture('ibkr-flex-trades.csv');
  const cash = await importFixture('ibkr-flex-cash.csv');
  it('imports trades with compact dates and listing exchanges', () => {
    expect(trades.detection.presetId).toBe('ibkr-flex');
    expect(tx(trades, 2)).toMatchObject({ date: '2023-01-10', type: 'BUY', instrumentId: 'XNAS:MSFT', quantity: 8, fees: 1 });
    expect(tx(trades, 4)).toMatchObject({ instrumentId: 'XAMS:ASML', currency: 'EUR' });
    expect(tx(trades, 5)).toMatchObject({ type: 'SELL', quantity: 3 });
    expect(tx(trades, 6)).toMatchObject({ type: 'FX_CONVERSION', currency: 'USD', toCurrency: 'EUR', toAmount: 1200, fees: 2 });
    expect(byLine(trades, 7).status).toBe('skipped');
  });
  it('imports cash transactions and merges withholding', () => {
    expect(tx(cash, 2)).toMatchObject({ type: 'DIVIDEND', instrumentId: 'XNYS:KO', amount: 9.2, taxes: 2.76, date: '2023-04-03' });
    expect(tx(cash, 4)).toMatchObject({ type: 'DEPOSIT', amount: 3000 });
    expect(tx(cash, 5)).toMatchObject({ type: 'INTEREST', amount: 1.5 });
    expect(tx(cash, 6)).toMatchObject({ type: 'FEE', amount: 1.5 });
  });
});

describe('B3 — Negociação (xlsx)', async () => {
  const r = await importFixture('b3-negociacao.xlsx');
  it('reads trades, strips the fractional F and skips options', () => {
    expect(r.detection).toMatchObject({ presetId: 'b3-negociacao', fileKind: 'xlsx', sheet: 'Negociação' });
    expect(tx(r, 2)).toMatchObject({ date: '2023-01-02', type: 'BUY', instrumentId: 'BVMF:PETR4', quantity: 100, price: 23.45, currency: 'BRL', account: 'XP INVESTIMENTOS CCTVM S/A' });
    expect(tx(r, 3)).toMatchObject({ instrumentId: 'BVMF:ITSA4', quantity: 37 });
    expect(tx(r, 4)).toMatchObject({ date: '2023-03-10', instrumentId: 'BVMF:HGLG11' }); // Date cell
    expect(tx(r, 5)).toMatchObject({ type: 'SELL', quantity: 50 });
    expect(byLine(r, 6).status).toBe('skipped');
    expect(tx(r, 7)).toMatchObject({ instrumentId: 'BVMF:BOVA11', price: 112.4, amount: 337.2 }); // "R$ 112,40" text cells
    expect(r.warnings.some((w) => w.code === 'B3_NO_FEES')).toBe(true);
  });
  it('infers asset classes and Yahoo symbols', () => {
    expect(r.instruments.find((i) => i.id === 'BVMF:HGLG11')).toMatchObject({ assetClass: 'reit', providerSymbols: { yahoo: 'HGLG11.SA' } });
    expect(r.instruments.find((i) => i.id === 'BVMF:BOVA11')!.assetClass).toBe('etf');
    expect(r.instruments.find((i) => i.id === 'BVMF:PETR4')).toMatchObject({ assetClass: 'equity', country: 'BR', currency: 'BRL' });
  });
});

describe('B3 — Movimentação (xlsx)', async () => {
  const r = await importFixture('b3-movimentacao.xlsx');
  it('maps settlements, proventos and corporate actions', () => {
    expect(r.detection.presetId).toBe('b3-movimentacao');
    expect(tx(r, 2)).toMatchObject({ type: 'BUY', instrumentId: 'BVMF:PETR4', quantity: 100, amount: 2345 });
    expect(tx(r, 5)).toMatchObject({ type: 'DIVIDEND', instrumentId: 'BVMF:HGLG11', amount: 11 });
    expect(tx(r, 6)).toMatchObject({ type: 'DIVIDEND', instrumentId: 'BVMF:ITSA4', amount: 0.55 });
    expect(byLine(r, 6).issues.map((i) => i.code)).toContain('NET_AMOUNT');
    expect(tx(r, 7)).toMatchObject({ type: 'DIVIDEND', amount: 189 });
    expect(byLine(r, 8).status).toBe('skipped'); // "Dividendo - Transferido" mirror
    expect(tx(r, 9)).toMatchObject({ type: 'SELL', quantity: 50 });
  });
  it('infers split and bonus ratios from the running position', () => {
    expect(tx(r, 10)).toMatchObject({ type: 'SPLIT', instrumentId: 'BVMF:ITSA4', ratio: 2 });
    expect(tx(r, 11)).toMatchObject({ type: 'STOCK_DIVIDEND', quantity: 7, price: 18.97 });
    expect(tx(r, 11).ratio).toBeCloseTo(7 / 74, 8);
    expect(byLine(r, 16)).toMatchObject({ status: 'error' });
    expect(byLine(r, 16).issues[0]!.code).toBe('SPLIT_RATIO_UNKNOWN');
  });
  it('treats Tesouro Direto as a manual fixed-income instrument and skips non-flows', () => {
    expect(tx(r, 13)).toMatchObject({ type: 'BUY', instrumentId: 'MANUAL:TESOURO-IPCA-2035', quantity: 0.5 });
    expect(r.instruments.find((i) => i.id === 'MANUAL:TESOURO-IPCA-2035')).toMatchObject({ assetClass: 'fixed_income', pricing: 'manual' });
    for (const line of [12, 14, 15, 17, 18]) expect(byLine(r, line).status).toBe('skipped');
    expect(r.warnings.some((w) => w.code === 'B3_SETTLEMENT_DATE')).toBe(true);
  });
  it('uses existing transactions to infer ratios when the position started earlier', async () => {
    const prior = await importFixture('b3-negociacao.xlsx');
    const bbasBuy = { ...prior.transactions[0]!, id: 'x', instrumentId: 'BVMF:BBAS3', quantity: 50, date: '2023-01-01', importHash: 'manual' };
    const again = await importFixture('b3-movimentacao.xlsx', { existingTransactions: [bbasBuy] });
    expect(byLine(again, 16).transaction).toMatchObject({ type: 'SPLIT', ratio: 3 });
  });
});

describe('Nota de corretagem (Latin-1, ;, comma decimals)', async () => {
  const r = await importFixture('nota-corretagem-latin1.csv');
  it('decodes Windows-1252 and allocates note costs', () => {
    expect(r.detection).toMatchObject({ presetId: 'nota-corretagem', encoding: 'windows-1252', delimiter: ';', numberFormat: 'comma' });
    const a = tx(r, 2);
    const b = tx(r, 3);
    expect(a).toMatchObject({ type: 'BUY', instrumentId: 'BVMF:PETR4', amount: 2345 });
    expect(a.fees! + b.fees!).toBeCloseTo(5.85, 6);
    expect(a.fees!).toBeCloseTo((5.85 * 2345) / 4107, 6);
    expect(tx(r, 4)).toMatchObject({ type: 'SELL', fees: 5.51, taxes: 0.06 });
    expect(tx(r, 5)).toMatchObject({ account: 'Clear', fees: 0.54 });
  });
});

describe('Charles Schwab', async () => {
  const r = await importFixture('schwab-transactions.csv');
  it('skips the title line, parses $ amounts and MM/DD dates', () => {
    expect(r.detection).toMatchObject({ presetId: 'schwab', dateFormat: 'MDY' });
    expect(tx(r, 3)).toMatchObject({ type: 'DEPOSIT', amount: 10000, date: '2023-01-03' });
    expect(tx(r, 4)).toMatchObject({ type: 'BUY', instrumentId: 'XNAS:NVDA', quantity: 20, price: 148.59, amount: 2971.8 });
    expect(tx(r, 8)).toMatchObject({ instrumentId: 'XNYS:BRK.B' });
    expect(r.instruments.find((i) => i.id === 'XNYS:BRK.B')!.providerSymbols!.yahoo).toBe('BRK-B');
    expect(tx(r, 10)).toMatchObject({ type: 'SELL', quantity: 4, fees: 0.03 });
    expect(tx(r, 12)).toMatchObject({ type: 'WITHDRAWAL', amount: 2000 });
    expect(byLine(r, 17).status).toBe('skipped');
  });
  it('uses the "as of" date and merges NRA withholding', () => {
    expect(tx(r, 6)).toMatchObject({ type: 'DIVIDEND', date: '2023-02-15', amount: 2.3, taxes: 0.69 });
    expect(byLine(r, 7).status).toBe('skipped');
  });
  it('handles reinvestments, options, ADR fees and splits', () => {
    expect(tx(r, 13)).toMatchObject({ type: 'BUY', instrumentId: 'ARCX:SCHD', quantity: 0.4123 });
    expect(tx(r, 13).amount).toBeCloseTo(28.92, 2);
    expect(tx(r, 14)).toMatchObject({ type: 'DIVIDEND', amount: 28.92 });
    expect(byLine(r, 11).issues[0]!.code).toBe('UNSUPPORTED_ASSET');
    expect(tx(r, 15)).toMatchObject({ type: 'FEE', amount: 0.4, instrumentId: 'XNYS:TSM' });
    expect(tx(r, 16)).toMatchObject({ type: 'SPLIT', instrumentId: 'XNAS:NVDA', ratio: 10 });
  });
});

describe('DEGIRO', async () => {
  const en = await importFixture('degiro-transactions-en.csv');
  const es = await importFixture('degiro-transacciones-es.csv');
  const acc = await importFixture('degiro-account-en.csv');
  it('imports English transactions, converting EUR fees to the trade currency', () => {
    expect(en.detection.presetId).toBe('degiro-transactions');
    expect(tx(en, 2)).toMatchObject({ date: '2023-01-05', type: 'BUY', instrumentId: 'XNAS:AAPL', quantity: 10, price: 125.07, currency: 'USD', amount: 1250.7 });
    expect(tx(en, 2).fees).toBeCloseTo(0.5 * 1.0668, 8);
    expect(tx(en, 3)).toMatchObject({ currency: 'EUR', fees: 2, instrumentId: 'XAMS:IE00B3RBWM25' });
    expect(byLine(en, 3).issues.map((i) => i.code)).toContain('SYMBOL_FROM_ISIN');
    expect(tx(en, 4)).toMatchObject({ instrumentId: 'XNYS:EC' }); // Ecopetrol ADR
  });
  it('keeps partial fills of the same order as distinct transactions', () => {
    expect(tx(en, 5).type).toBe('SELL');
    expect(tx(en, 6).type).toBe('SELL');
    expect(tx(en, 5).importHash).not.toBe(tx(en, 6).importHash);
  });
  it('imports Spanish transactions with comma decimals', () => {
    expect(es.detection).toMatchObject({ presetId: 'degiro-transactions', numberFormat: 'comma' });
    expect(tx(es, 2)).toMatchObject({ instrumentId: 'XNAS:MSFT', price: 228.85, amount: 1144.25 });
    expect(tx(es, 3)).toMatchObject({ instrumentId: 'XMAD:SAN', quantity: 1500, price: 3.412, fees: 3.9 });
  });
  it('imports the account statement (dividends with tax, cash flows) and skips trade lines', () => {
    expect(acc.detection.presetId).toBe('degiro-account');
    expect(tx(acc, 2)).toMatchObject({ type: 'DEPOSIT', amount: 2000, currency: 'EUR' });
    for (const line of [3, 4, 5, 6, 11]) expect(byLine(acc, line).status).toBe('skipped');
    expect(tx(acc, 7)).toMatchObject({ type: 'DIVIDEND', instrumentId: 'XNAS:AAPL', amount: 2.3, taxes: 0.35, currency: 'USD' });
    expect(tx(acc, 9)).toMatchObject({ type: 'INTEREST', amount: 0.12 });
    expect(tx(acc, 10)).toMatchObject({ type: 'WITHDRAWAL', amount: 300 });
    expect(tx(acc, 12)).toMatchObject({ type: 'FEE', amount: 2.5 });
  });
});

describe('Trading 212', async () => {
  const r = await importFixture('trading212-history.csv');
  it('imports buys with converted fees and GBX prices', () => {
    expect(r.detection.presetId).toBe('trading212');
    expect(tx(r, 3)).toMatchObject({ type: 'BUY', instrumentId: 'XNAS:AAPL', quantity: 2.5, price: 125.07, currency: 'USD' });
    expect(tx(r, 3).fees).toBeCloseTo(0.44 * 1.06714, 6);
    expect(tx(r, 4)).toMatchObject({ instrumentId: 'XLON:VUSA', currency: 'GBP', price: 61.505 });
    expect(byLine(r, 4).issues.map((i) => i.code)).toContain('GBX_CONVERTED');
  });
  it('imports dividends (gross = net + withholding), FX, splits and cash', () => {
    const div = tx(r, 5);
    expect(div).toMatchObject({ type: 'DIVIDEND', currency: 'EUR', instrumentId: 'XNAS:AAPL' });
    expect(div.taxes).toBeCloseTo(0.09 / 1.07, 6);
    expect(div.amount).toBeCloseTo(0.45 + 0.09 / 1.07, 6);
    expect(tx(r, 2)).toMatchObject({ type: 'DEPOSIT', amount: 1000 });
    expect(tx(r, 6)).toMatchObject({ type: 'INTEREST', amount: 0.52 });
    expect(tx(r, 7)).toMatchObject({ type: 'FX_CONVERSION', currency: 'EUR', amount: 100, toCurrency: 'USD', toAmount: 107.35, fees: 0.15 });
    expect(byLine(r, 8).status).toBe('skipped');
    expect(tx(r, 9)).toMatchObject({ type: 'SPLIT', ratio: 4 });
    expect(tx(r, 10)).toMatchObject({ type: 'SELL', quantity: 4 });
    expect(tx(r, 11)).toMatchObject({ type: 'WITHDRAWAL', amount: 200 });
    expect(byLine(r, 12).status).toBe('skipped');
  });
});

describe('eToro (xlsx, multi-sheet)', async () => {
  const r = await importFixture('etoro-account-statement.xlsx');
  it('finds the Account Activity sheet and maps positions', () => {
    expect(r.detection).toMatchObject({ presetId: 'etoro', sheet: 'Account Activity' });
    expect(tx(r, 3)).toMatchObject({ type: 'BUY', instrumentId: 'XNAS:AAPL', quantity: 2, price: 125, amount: 250 });
    expect(tx(r, 4)).toMatchObject({ instrumentId: 'CRYPTO:BTC' });
    expect(r.instruments.find((i) => i.id === 'CRYPTO:BTC')).toMatchObject({ assetClass: 'crypto', providerSymbols: { yahoo: 'BTC-USD' } });
    expect(byLine(r, 5).issues[0]!.code).toBe('UNSUPPORTED_ASSET');
    expect(tx(r, 7)).toMatchObject({ instrumentId: 'XETR:SAP', currency: 'USD' });
    expect(byLine(r, 7).issues.map((i) => i.code)).toContain('CURRENCY_MISMATCH');
    expect(tx(r, 8)).toMatchObject({ type: 'SELL', amount: 370 });
    expect(tx(r, 9)).toMatchObject({ type: 'FEE', amount: 5 });
    expect(tx(r, 10)).toMatchObject({ type: 'WITHDRAWAL', amount: 500 });
  });
});

describe('Extracto colombiano (Latin-1, ;, comma decimals, preamble)', async () => {
  const r = await importFixture('extracto-davivienda-latin1.csv');
  it('detects the Colombian preset and parses COP amounts', () => {
    expect(r.detection).toMatchObject({ presetId: 'extracto-co', encoding: 'windows-1252', delimiter: ';', numberFormat: 'comma', dateFormat: 'DMY' });
    expect(r.warnings.some((w) => w.code === 'ENCODING_LATIN1')).toBe(true);
    expect(tx(r, 7)).toMatchObject({ type: 'DEPOSIT', amount: 5_000_000, currency: 'COP' });
    expect(tx(r, 8)).toMatchObject({ type: 'BUY', instrumentId: 'XBOG:ECOPETROL', quantity: 1000, price: 2450, amount: 2_450_000, fees: 8746.5 });
    expect(tx(r, 10)).toMatchObject({ type: 'SELL', quantity: 400 });
    expect(tx(r, 11)).toMatchObject({ type: 'DIVIDEND', amount: 187_200, taxes: 18_720 });
    expect(tx(r, 12)).toMatchObject({ type: 'TAX', amount: 4000 });
    expect(tx(r, 13)).toMatchObject({ type: 'WITHDRAWAL', amount: 1_000_000 });
    expect(byLine(r, 15).status).toBe('skipped');
    expect(r.instruments.find((i) => i.id === 'XBOG:PFBCOLOM')).toMatchObject({ currency: 'COP', country: 'CO', providerSymbols: { yahoo: 'PFBCOLOM.CL' } });
  });
});

describe('preset catalog', () => {
  it('lists every preset with Spanish help', () => {
    const list = listPresets();
    expect(list.map((p) => p.id)).toEqual(
      expect.arrayContaining(['portafolio-pro', 'ibkr-activity', 'ibkr-flex', 'b3-negociacao', 'b3-movimentacao', 'nota-corretagem', 'schwab', 'degiro-transactions', 'degiro-account', 'trading212', 'etoro', 'extracto-co', 'generic']),
    );
    for (const p of list) expect(p.exportHelp.length).toBeGreaterThan(20);
  });
});
