/**
 * Regression tests for the round-3 review (reviews/tax-r3.md): T35, T38-T46.
 * Scenarios A1..A12 reproduce the reviewer's r3-*.ts scripts.
 */
import { describe, expect, it } from 'vitest';
import { deflateRawSync } from 'node:zlib';
import type { Instrument, Transaction } from '@pm/core';
import { ALL_INSTRUMENTS, I, tx } from './testing/fixtures';
import { createSimpleMarketData } from './testing/marketData';
import { monthRange } from './common/dates';
import { crc32, toXlsx } from './common/xlsx';
import { readXlsx, unzip } from './common/xlsxRead';
import { officialDocRowsFromTable, parseOfficialDocCsv } from './common/reconcile';
import { brazilMonthlyApuracao } from './brazil/apuracao';
import { brazilProventosReport } from './brazil/proventos';
import { brazilForeignAnnualReport, irpfMonthlyTax } from './brazil/exterior';
import { b3OptionExpiry } from './brazil/ledger';
import { classifyForBrazil, cryptoCustodyForVenue, cryptoCustodyOf, routeCryptoByCustody } from './brazil/classify';
import { brazilCryptoReport } from './brazil/crypto';
import { darfLateCharges, SELIC_MONTHLY } from './brazil/darf';
import { brazilIrpfmEstimate } from './brazil/irpfm';
import { brazilTaxPack } from './brazil/taxPack';
import { informeFromB3Movimentacao, informeFromB3Posicao, reconcileBrazil } from './brazil/reconcile';
import { buildColombiaTaxReport } from './colombia/report';
import { exogenaFromRows, reconcileColombia } from './colombia/reconcile';

const mk = (id: string, assetClass: Instrument['assetClass'], name: string, country = 'BR', currency = 'BRL'): Instrument => {
  const [exchange, symbol] = id.split(':') as [string, string];
  return { id, symbol, name, exchange, currency, country, assetClass };
};
const PETRC = mk('BVMF:PETRC350', 'other', 'PETR call mar');
const WEEKLY = mk('BVMF:PETRC350W4', 'equity', 'PETR weekly call');
const ICF = mk('BVMF:ICFZ26', 'other', 'Café arábica Dez/26');
const BTC_YAHOO = mk('CCC:BTC-USD', 'crypto', 'Bitcoin USD', 'US', 'USD');
const INSTS = [...ALL_INSTRUMENTS, PETRC, WEEKLY, ICF, BTC_YAHOO];
const market = createSimpleMarketData({ fx: { 'USD/BRL': [['2015-01-01', 5]] } });
const br = (transactions: Transaction[]) => ({ transactions, instruments: INSTS, market });
const B = 'BRL';

describe('T38 (alta) — crypto regime by custody (account/broker), not by quote currency', () => {
  const at = (account: string) => [
    tx({ date: '2025-01-10', type: 'BUY', instrumentId: BTC_YAHOO.id, quantity: 1, price: 50_000, currency: 'USD', account }),
    tx({ date: '2026-03-10', type: 'SELL', instrumentId: BTC_YAHOO.id, quantity: 1, price: 90_000, currency: 'USD', account }),
  ];
  it('A7: BTC-USD held at Mercado Bitcoin → GCAP, DARF 4600 R$ 30,000 due 30/04/2026', () => {
    expect(cryptoCustodyOf(BTC_YAHOO)).toBe('desconhecida'); // currency is not a custody signal
    const c = brazilCryptoReport(br(at('Mercado Bitcoin')), { year: 2026 });
    expect(c.months[0]).toMatchObject({ month: '2026-03', tax: 30_000 });
    expect(c.months[0]!.darf).toMatchObject({ code: '4600', amount: 30_000, dueDate: '2026-04-30' });
    const f = brazilForeignAnnualReport(br(at('Mercado Bitcoin')), { year: 2026 });
    expect(f.totals.taxDueBrl).toBe(0);
  });
  it('account at a foreign exchange → Lei 14.754; accountCustody can override (Binance Brasil)', () => {
    expect(cryptoCustodyForVenue('Binance')).toBe('exterior');
    expect(cryptoCustodyForVenue('Binance BR')).toBe('brasil');
    const f = brazilForeignAnnualReport(br(at('Coinbase')), { year: 2026 });
    expect(f.totals.taxDueBrl).toBeCloseTo(30_000, 6);
    expect(brazilCryptoReport(br(at('Coinbase')), { year: 2026 }).months).toEqual([]);
    const c = brazilCryptoReport(br(at('Binance')), { year: 2026, accountCustody: { Binance: 'brasil' } });
    expect(c.months[0]!.darf?.code).toBe('4600');
  });
  it('no account and no known venue → desconhecida: tax shown, DARF withheld', () => {
    const c = brazilCryptoReport(br(at('')), { year: 2026 });
    expect(c.months[0]!.darfBlockedUnknownCustody).toBe(true);
    expect(c.issues.map((i) => i.code)).toContain('CRYPTO_CUSTODY_UNKNOWN');
  });
  it('the same asset at Brazilian and foreign venues is split by custody', () => {
    const txs = [
      tx({ date: '2025-01-10', type: 'BUY', instrumentId: BTC_YAHOO.id, quantity: 1, price: 50_000, currency: 'USD', account: 'Mercado Bitcoin' }),
      tx({ date: '2025-01-10', type: 'BUY', instrumentId: BTC_YAHOO.id, quantity: 1, price: 50_000, currency: 'USD', account: 'Kraken' }),
      tx({ date: '2026-03-10', type: 'SELL', instrumentId: BTC_YAHOO.id, quantity: 1, price: 90_000, currency: 'USD', account: 'Mercado Bitcoin' }),
    ];
    const routed = routeCryptoByCustody(br(txs));
    expect(routed.custody[`${BTC_YAHOO.id}#brasil`]).toBe('brasil');
    expect(routed.custody[`${BTC_YAHOO.id}#exterior`]).toBe('exterior');
    expect(routed.issues.map((i) => i.code)).toContain('CRYPTO_SPLIT_BY_CUSTODY');
    expect(brazilCryptoReport(br(txs), { year: 2026 }).months[0]!.darf?.amount).toBe(30_000);
    const f = brazilForeignAnnualReport(br(txs), { year: 2026 });
    expect(f.positions[0]).toMatchObject({ quantity: 1, costBrl: 250_000 });
    expect(f.sales).toHaveLength(0);
  });
});

describe('T39 — option expiry per series and year', () => {
  it('A3: PETRC350 written in 2025 and again in 2026 expires both times', () => {
    const r = brazilMonthlyApuracao(
      br([
        tx({ date: '2025-02-03', type: 'SELL', instrumentId: PETRC.id, quantity: 1000, price: 1, currency: B }),
        tx({ date: '2026-02-02', type: 'SELL', instrumentId: PETRC.id, quantity: 1000, price: 2, currency: B }),
      ]),
      { from: '2025-01', to: '2026-04' },
    );
    expect(r.months.filter((m) => m.results.opcoes !== 0).map((m) => [m.month, m.results.opcoes])).toEqual([
      ['2025-03', 1000],
      ['2026-03', 2000],
    ]);
    expect(r.openShorts).toEqual([]);
  });
});

describe('T40 — weekly options', () => {
  it('A4: PETRC350W4 typed equity is an option expiring on the 4th Friday of March', () => {
    expect(classifyForBrazil(WEEKLY)).toBe('OPCAO');
    expect(b3OptionExpiry('PETRC350W4', '2026-02-02')).toBe('2026-03-27');
    expect(b3OptionExpiry('PETRC350W1', '2026-02-02')).toBe('2026-03-06');
    expect(b3OptionExpiry('PETRC350W5', '2026-02-02')).toBe('2026-03-27'); // no 5th Friday → last
    const r = brazilMonthlyApuracao(br([tx({ date: '2026-03-02', type: 'SELL', instrumentId: WEEKLY.id, quantity: 1000, price: 0.5, currency: B })]), {
      from: '2026-03',
      to: '2026-03',
    });
    expect(r.months[0]!.results.opcoes).toBeCloseTo(500, 6);
  });
});

describe('T35 — Selic table without gaps', () => {
  it('every month from 2024-01 to 2026-09 is present (incl. 2026-01)', () => {
    for (const m of monthRange('2024-01', '2026-09')) expect(SELIC_MONTHLY[m], m).toBeGreaterThan(0);
    const c = darfLateCharges(1000, '2025-12-30', '2026-03-10');
    expect(c.missingSelicMonths).toEqual([]);
    expect(c.jurosRate).toBeCloseTo(0.0116 + 0.01 + 0.01, 10);
  });
});

describe('T41 — US-format numbers in official CSVs', () => {
  it('A12: "1,234.56" with comma separator and dot decimal', () => {
    const rows = parseOfficialDocCsv('tipo,ticker,valor\nDIVIDENDO,PETR4,"1,234.56"\nDIVIDENDO,VALE3,1234.56\n', ',', '.');
    expect(rows.map((r) => r.valor)).toEqual([1234.56, 1234.56]);
    expect(parseOfficialDocCsv('tipo;valor\nX;-1.234,50\n')[0]!.valor).toBe(-1234.5);
  });
});

describe('T42 — XLSX keeps DIRPF codes as text', () => {
  it('group "03" and code "01" are inline strings in the Bens e Direitos sheet', async () => {
    const p = brazilTaxPack(br([tx({ date: '2025-03-01', type: 'BUY', instrumentId: I.PETR4.id, quantity: 100, price: 30, currency: B })]), { year: 2025 });
    const sheets = await readXlsx(p.xlsx);
    const bens = sheets.find((s) => s.name === 'bens-e-direitos')!;
    expect(bens.rows[1]!.slice(0, 2)).toEqual(['03', '01']);
  });
});

describe('T43 — IRPFM redutor', () => {
  const prov = brazilProventosReport(
    br([
      ...Array.from({ length: 12 }, (_, i) => tx({ date: `2026-${String(i + 1).padStart(2, '0')}-15`, type: 'DIVIDEND', instrumentId: I.VALE3.id, amount: 45_000, currency: B })),
      ...Array.from({ length: 12 }, (_, i) => tx({ date: `2026-${String(i + 1).padStart(2, '0')}-16`, type: 'DIVIDEND', instrumentId: I.PETR4.id, amount: 45_000, currency: B })),
    ]),
    { year: 2026 },
  );
  it('A9: without issuer rates → range [0, 86,400]', () => {
    const e = brazilIrpfmEstimate({ year: 2026, proventos: prov });
    expect(e.rate).toBeCloseTo(0.08, 10);
    expect(e.irpfmGross).toBeCloseTo(86_400, 6);
    expect(e.irpfmDueRange.max).toBeCloseTo(86_400, 6);
    expect(e.irpfmDueRange.min).toBeCloseTo(0, 6);
  });
  it('companies at 34% effective → redutor eliminates IRPFM; at 30% → half', () => {
    const full = brazilIrpfmEstimate({ year: 2026, proventos: prov, issuerEffectiveRates: { 'BVMF:VALE': 0.34, 'BVMF:PETR': 0.34 } });
    expect(full.redutor).toBeCloseTo(86_400, 6);
    expect(full.irpfmDue).toBeCloseTo(0, 6);
    const part = brazilIrpfmEstimate({ year: 2026, proventos: prov, issuerEffectiveRates: { 'BVMF:VALE': 0.3, 'BVMF:PETR': 0.3 } });
    expect(part.irpfmDue).toBeCloseTo(43_200, 6);
    const bank = brazilIrpfmEstimate({ year: 2026, proventos: prov, issuerEffectiveRates: { 'BVMF:VALE': 0.34, 'BVMF:PETR': 0.34 }, issuerLimits: { 'BVMF:VALE': 0.4, 'BVMF:PETR': 0.4 } });
    expect(bank.irpfmDue).toBeCloseTo(64_800, 6); // 34% + 8% exceeds the 40% limit by 2%
  });
  it('transition dividends are excluded from the base by default', () => {
    const p2 = brazilProventosReport(
      br([tx({ date: '2026-02-15', type: 'DIVIDEND', instrumentId: I.VALE3.id, amount: 900_000, currency: B, note: 'Dividendos ref. 2025' })]),
      { year: 2026 },
    );
    expect(brazilIrpfmEstimate({ year: 2026, proventos: p2 }).base).toBe(0);
    expect(brazilIrpfmEstimate({ year: 2026, proventos: p2, includeTransitionDividends: true }).base).toBe(900_000);
  });
});

/** Builds a deflate-compressed ZIP (as Excel does) to exercise the reader's inflate path. */
function deflatedZip(files: Record<string, string>): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let off = 0;
  for (const [name, text] of Object.entries(files)) {
    const raw = enc.encode(text);
    const comp = new Uint8Array(deflateRawSync(raw));
    const n = enc.encode(name);
    const lh = new Uint8Array(30 + n.length);
    const lv = new DataView(lh.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, 8, true);
    lv.setUint32(14, crc32(raw), true);
    lv.setUint32(18, comp.length, true);
    lv.setUint32(22, raw.length, true);
    lv.setUint16(26, n.length, true);
    lh.set(n, 30);
    const ch = new Uint8Array(46 + n.length);
    const cv = new DataView(ch.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, 8, true);
    cv.setUint32(16, crc32(raw), true);
    cv.setUint32(20, comp.length, true);
    cv.setUint32(24, raw.length, true);
    cv.setUint16(28, n.length, true);
    cv.setUint32(42, off, true);
    ch.set(n, 46);
    parts.push(lh, comp);
    central.push(ch);
    off += lh.length + comp.length;
  }
  const cs = central.reduce((a, c) => a + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, central.length, true);
  ev.setUint16(10, central.length, true);
  ev.setUint32(12, cs, true);
  ev.setUint32(16, off, true);
  const all = [...parts, ...central, end];
  const out = new Uint8Array(all.reduce((a, c) => a + c.length, 0));
  let p = 0;
  for (const c of all) {
    out.set(c, p);
    p += c.length;
  }
  return out;
}

describe('T44 — official documents: net JCP, XLSX reader, B3 and DIAN exports', () => {
  it('readXlsx round-trips our own workbook (stored) and reads deflated sheets with shared strings', async () => {
    const x = toXlsx([{ name: 'Posição', rows: [['Produto', 'Quantidade'], ['PETR4 - PETROBRAS', 100], ['Código', '03']] }]);
    const back = await readXlsx(x);
    expect(back[0]).toEqual({ name: 'Posição', rows: [['Produto', 'Quantidade'], ['PETR4 - PETROBRAS', 100], ['Código', '03']] });
    const z = deflatedZip({
      'xl/workbook.xml': '<workbook xmlns:r="r"><sheets><sheet name="Exógena" sheetId="1" r:id="rId1"/></sheets></workbook>',
      'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Type="t" Target="worksheets/sheet1.xml"/></Relationships>',
      'xl/sharedStrings.xml': '<sst><si><t>Concepto</t></si><si><t>Valor reportado</t></si><si><t>Dividendos y participaciones</t></si><si><t>NIT del informante</t></si></sst>',
      'xl/worksheets/sheet1.xml':
        '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>3</v></c><c r="B1" t="s"><v>0</v></c><c r="C1" t="s"><v>1</v></c></row>' +
        '<row r="2"><c r="A2" t="str"><v>899999068</v></c><c r="B2" t="s"><v>2</v></c><c r="C2"><v>300000</v></c></row></sheetData></worksheet>',
    });
    expect((await unzip(z)).size).toBe(4);
    const sheets = await readXlsx(z);
    const ex = exogenaFromRows(officialDocRowsFromTable(sheets[0]!.rows));
    expect(ex).toEqual([{ nitInformante: '899999068', nombreInformante: '', concepto: 'dividendos', valor: 300_000, retencion: undefined, detalle: undefined }]);
    const co = buildColombiaTaxReport(
      { transactions: [tx({ date: '2025-04-10', type: 'DIVIDEND', instrumentId: I.ECOPETROL.id, amount: 300_000, currency: 'COP' })], instruments: INSTS, market },
      { year: 2025 },
    );
    expect(reconcileColombia(co, { exogena: ex }).lines[0]!.status).toBe('ok');
  });
  it('B3 Movimentação (JCP net of IRRF) and Posição reconcile with the pack', () => {
    const txs = [
      tx({ date: '2026-01-05', type: 'BUY', instrumentId: I.PETR4.id, quantity: 100, price: 30, currency: B }),
      tx({ date: '2026-03-20', type: 'DIVIDEND', instrumentId: I.PETR4.id, amount: 500, currency: B }),
      tx({ date: '2026-05-20', type: 'DIVIDEND', instrumentId: I.ITSA4.id, amount: 1000, taxes: 175, currency: B, note: 'JCP' }),
    ];
    const pack = brazilTaxPack(br(txs), { year: 2026 });
    const mov = officialDocRowsFromTable([
      ['Entrada/Saída', 'Data', 'Movimentação', 'Produto', 'Instituição', 'Quantidade', 'Preço unitário', 'Valor da Operação'],
      ['Credito', '20/05/2026', 'Juros Sobre Capital Próprio', 'ITSA4 - ITAUSA S.A.', 'XP INVESTIMENTOS', 100, '8,25', '825,00'],
      ['Credito', '20/03/2026', 'Dividendo', 'PETR4 - PETROLEO BRASILEIRO S.A. PETROBRAS', 'XP INVESTIMENTOS', 100, 5, 500],
      ['Credito', '20/03/2025', 'Dividendo', 'PETR4 - PETROLEO BRASILEIRO S.A. PETROBRAS', 'XP INVESTIMENTOS', 100, 5, 999],
    ]);
    const pos = officialDocRowsFromTable([
      ['Produto', 'Instituição', 'Conta', 'Código de Negociação', 'CNPJ da Empresa', 'Tipo', 'Quantidade'],
      ['PETR4 - PETROLEO BRASILEIRO S.A. PETROBRAS', 'XP', '123', 'PETR4', '33.000.167/0001-01', 'PN', 100],
    ]);
    const rec = reconcileBrazil(pack, { informes: [informeFromB3Movimentacao(mov, 2026), informeFromB3Posicao([{ name: 'Acoes', rows: pos }], 2026)] });
    const jcp = rec.lines.find((l) => l.key === 'JCP|ITSA')!;
    expect(jcp).toMatchObject({ ours: 825, theirs: 825, status: 'ok', note: 'Documento em valor líquido (bruto − IRRF)' });
    expect(rec.lines.find((l) => l.key === 'DIVIDENDO|PETR')).toMatchObject({ status: 'ok', theirs: 500 });
    expect(rec.lines.find((l) => l.area === 'posicoes_31_12')).toMatchObject({ key: 'PETR4', status: 'ok' });
    expect(rec.cnpjByIssuer.PETR).toBe('33.000.167/0001-01');
  });
});

describe('T45 — carnê-leão before 2024', () => {
  it('foreign dividends: monthly progressive table with credit for the US withholding', () => {
    expect(irpfMonthlyTax(50_000, '2023-06')).toBeCloseTo(50_000 * 0.275 - 884.96, 6);
    expect(irpfMonthlyTax(2_000, '2023-06')).toBe(0);
    expect(irpfMonthlyTax(2_000, '2023-03')).toBeCloseTo(2_000 * 0.075 - 142.8, 6);
    const r = brazilForeignAnnualReport(
      br([
        tx({ date: '2022-01-10', type: 'BUY', instrumentId: I.AAPL.id, quantity: 50, price: 150, currency: 'USD' }),
        tx({ date: '2023-06-10', type: 'DIVIDEND', instrumentId: I.AAPL.id, amount: 10_000, taxes: 300, currency: 'USD' }),
      ]),
      { year: 2023 },
    );
    const cl = r.gcapPre2024!.carneLeao[0]!;
    expect(cl.incomeBrl).toBeCloseTo(50_000, 6);
    expect(cl.foreignTaxCreditBrl).toBeCloseTo(1500, 6);
    expect(cl.taxDue).toBeCloseTo(50_000 * 0.275 - 884.96 - 1500, 6);
    expect(cl).toMatchObject({ darfCode: '0190', dueDate: '2023-07-31' });
  });
  it('IN SRF 118/2000: assets bought with foreign-origin income → gain in USD x PTAX of the sale', () => {
    const ptax = { buy: (_c: string, d: string) => (d < '2023-01-01' ? 5 : 4), sell: (_c: string, d: string) => (d < '2023-01-01' ? 5 : 4) };
    const txs = [
      tx({ date: '2022-01-10', type: 'BUY', instrumentId: I.AAPL.id, quantity: 100, price: 150, currency: 'USD' }),
      tx({ date: '2023-05-10', type: 'SELL', instrumentId: I.AAPL.id, quantity: 100, price: 200, currency: 'USD' }),
    ];
    const normal = brazilForeignAnnualReport(br(txs), { year: 2023, ptax });
    expect(normal.gcapPre2024!.months[0]!.gainBrl).toBeCloseTo(20_000 * 4 - 15_000 * 5, 6);
    const origin = brazilForeignAnnualReport(br(txs), { year: 2023, ptax, foreignOriginInstruments: [I.AAPL.id] });
    expect(origin.gcapPre2024!.months[0]!.gainBrl).toBeCloseTo(5_000 * 4, 6);
  });
});

describe('T46 — futures quoted in USD (ICF coffee)', () => {
  it('day trade of 1 ICF: 10 points x 100 sacas x USD/BRL 5 = R$ 5,000 → 20%', () => {
    const r = brazilMonthlyApuracao(
      br([
        tx({ date: '2026-10-01', type: 'BUY', instrumentId: ICF.id, quantity: 1, price: 300, currency: B }),
        tx({ date: '2026-10-01', type: 'SELL', instrumentId: ICF.id, quantity: 1, price: 310, currency: B }),
      ]),
      { from: '2026-10', to: '2026-10' },
    );
    expect(r.months[0]!.results.dayTrade).toBeCloseTo(5000, 6);
    expect(r.months[0]!.dayTrade.tax).toBeCloseTo(1000, 6);
  });
});
