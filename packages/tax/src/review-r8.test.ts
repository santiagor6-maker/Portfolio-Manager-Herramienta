/**
 * Regression tests for the round-8 review (reviews/tax-r8.md): T64-T70.
 * Scenarios C1-C5 (r8-contract.ts) and D3-D8 (r8-darf*.ts) reproduce the reviewer's scripts.
 */
import { describe, expect, it } from 'vitest';
import type { Instrument, Transaction } from '@pm/core';
import { ALL_INSTRUMENTS, tx } from './testing/fixtures';
import { createSimpleMarketData } from './testing/marketData';
import { buildColombiaTaxReport } from './colombia/report';
import { brazilMonthlyApuracao } from './brazil/apuracao';
import { runBrazilB3Ledger } from './brazil/ledger';
import { brazilBensDireitos } from './brazil/bensDireitos';
import { brazilCryptoReport } from './brazil/crypto';
import { brazilForeignAnnualReport } from './brazil/exterior';
import { brazilProventosReport } from './brazil/proventos';
import { brazilRendaFixaReport } from './brazil/rendaFixa';
import { checkUsDividendWithholding } from './us/withholding';

const mk = (id: string, assetClass: Instrument['assetClass'], name: string, country: string, currency: string): Instrument => {
  const [exchange, symbol] = id.split(':') as [string, string];
  return { id, symbol, name, exchange, currency, country, assetClass };
};
const BCOL = mk('XBOG:BCOLOMBIA', 'equity', 'Bancolombia', 'CO', 'COP');
const CIBEST = mk('XBOG:CIBEST', 'equity', 'Grupo Cibest', 'CO', 'COP');
const BRML3 = mk('BVMF:BRML3', 'equity', 'BR Malls', 'BR', 'BRL');
const ALOS3 = mk('BVMF:ALOS3', 'equity', 'Allos', 'BR', 'BRL');
const GGBR4 = mk('BVMF:GGBR4', 'equity', 'Gerdau', 'BR', 'BRL');
const SPIN3 = mk('BVMF:SPIN3', 'equity', 'Spun-off Co', 'BR', 'BRL');
const CDT = mk('MANUAL:CDT-BANCO', 'fixed_income', 'CDT Banco 1 año', 'CO', 'COP');
const CDB = mk('MANUAL:CDB-X', 'fixed_income', 'CDB Banco X', 'BR', 'BRL');
const OLDUS = mk('XNYS:OLDCO', 'equity', 'Old Co', 'US', 'USD');
const NEWUS = mk('XNYS:NEWCO', 'equity', 'New Co', 'US', 'USD');
const MATIC = mk('CCC:MATIC-USD', 'crypto', 'Polygon', 'US', 'USD');
const POL = mk('CCC:POL-USD', 'crypto', 'POL', 'US', 'USD');
const ETH = mk('CCC:ETH-USD', 'crypto', 'Ethereum USD', 'US', 'USD');
const BTC = mk('CCC:BTC-USD', 'crypto', 'Bitcoin USD', 'US', 'USD');
const insts = [...ALL_INSTRUMENTS, BCOL, CIBEST, BRML3, ALOS3, GGBR4, SPIN3, CDT, CDB, OLDUS, NEWUS, MATIC, POL, ETH, BTC];
const market = createSimpleMarketData({ fx: { 'USD/COP': [['2015-01-01', 4000]], 'USD/BRL': [['2015-01-01', 5]] } });
const inp = (transactions: Transaction[], m = market) => ({ transactions, instruments: insts, market: m });
const t = (p: Partial<Transaction> & Pick<Transaction, 'date' | 'type'>) => tx({ currency: 'BRL', ...p });
const codes = (issues: { code: string }[]) => issues.map((i) => i.code);
const pay = (date: string, amount: number, note: string) => t({ date, type: 'TAX', amount, note });

describe('T64 (alta) — MERGER / TICKER_CHANGE move lots, cost and dates to the target', () => {
  it('C1 Colombia BCOLOMBIA → CIBEST: sale with original cost and date (Art. 36-1); patrimonio only CIBEST', () => {
    const txs = [
      t({ date: '2023-01-10', type: 'BUY', instrumentId: BCOL.id, quantity: 1000, price: 30_000, currency: 'COP' }),
      t({ date: '2025-05-20', type: 'SPLIT', subtype: 'TICKER_CHANGE', instrumentId: BCOL.id, targetInstrumentId: CIBEST.id, ratio: 1, currency: 'COP' }),
      t({ date: '2025-09-10', type: 'SELL', instrumentId: CIBEST.id, quantity: 500, price: 40_000, currency: 'COP' }),
    ];
    const r = buildColombiaTaxReport(inp(txs), { year: 2025 });
    expect(r.ventas.rows).toHaveLength(1);
    expect(r.ventas.rows[0]).toMatchObject({ symbol: 'CIBEST', quantity: 500, openDate: '2023-01-10', costCop: 15_000_000, classification: 'no_gravada_art_36_1' });
    const inv = r.patrimonio.rows.filter((x) => x.kind === 'inversion');
    expect(inv.map((x) => [x.symbol, x.quantity, x.fiscalValueCop])).toEqual([['CIBEST', 500, 15_000_000]]);
    expect(codes(r.issues)).not.toContain('OVERSELL');
    expect(codes(r.issues)).toContain('CORPORATE_ACTION_APPLIED');
  });
  it('Colombia: FIFO lots keep their own dates after the change', () => {
    const txs = [
      t({ date: '2022-01-10', type: 'BUY', instrumentId: BCOL.id, quantity: 100, price: 30_000, currency: 'COP' }),
      t({ date: '2025-01-10', type: 'BUY', instrumentId: BCOL.id, quantity: 100, price: 35_000, currency: 'COP' }),
      t({ date: '2025-05-20', type: 'SPLIT', subtype: 'TICKER_CHANGE', instrumentId: BCOL.id, targetInstrumentId: CIBEST.id, ratio: 2, currency: 'COP' }),
      t({ date: '2025-09-10', type: 'SELL', instrumentId: CIBEST.id, quantity: 300, price: 20_000, currency: 'COP' }),
    ];
    const rows = buildColombiaTaxReport(inp(txs), { year: 2025 }).ventas.rows;
    expect(rows.map((r) => [r.openDate, r.quantity, r.costCop])).toEqual([
      ['2022-01-10', 200, 3_000_000],
      ['2025-01-10', 100, 1_750_000],
    ]);
  });
  it('Colombia: merger cash is a partial disposal (quantity 0, cost carved by value)', () => {
    const m = createSimpleMarketData({ fx: { 'USD/COP': [['2015-01-01', 4000]] }, prices: { [CIBEST.id]: [['2025-05-20', 45_000]] } });
    const txs = [
      t({ date: '2023-01-10', type: 'BUY', instrumentId: BCOL.id, quantity: 1000, price: 30_000, currency: 'COP' }),
      t({ date: '2025-05-20', type: 'SPLIT', subtype: 'MERGER', instrumentId: BCOL.id, targetInstrumentId: CIBEST.id, ratio: 1, amount: 5_000_000, currency: 'COP' }),
    ];
    const r = buildColombiaTaxReport(inp(txs, m), { year: 2025 });
    const f = 5_000_000 / (5_000_000 + 45_000_000);
    expect(r.ventas.rows[0]).toMatchObject({ quantity: 0, proceedsCop: 5_000_000 });
    expect(r.ventas.rows[0]!.costCop).toBeCloseTo(30_000_000 * f, 2);
    expect(r.patrimonio.rows.find((x) => x.symbol === 'CIBEST')!.fiscalValueCop).toBeCloseTo(30_000_000 * (1 - f), 2);
  });
  it('C2 B3 BRML3 → ALOS3 (1/3): sale gives −R$ 5.000 (compensable), no short; Bens e Direitos moves the line', () => {
    const txs = [
      t({ date: '2022-01-10', type: 'BUY', instrumentId: BRML3.id, quantity: 3000, price: 10 }),
      t({ date: '2023-01-02', type: 'SPLIT', subtype: 'MERGER', instrumentId: BRML3.id, targetInstrumentId: ALOS3.id, ratio: 1 / 3 }),
      t({ date: '2026-03-10', type: 'SELL', instrumentId: ALOS3.id, quantity: 1000, price: 25 }),
    ];
    const a = brazilMonthlyApuracao(inp(txs), { from: '2026-03', to: '2026-03' });
    expect(a.months[0]!.results.acoes).toBeCloseTo(-5_000, 6);
    expect(a.openShorts).toHaveLength(0);
    const b23 = brazilBensDireitos(inp(txs), { year: 2023 });
    expect(b23.items.find((i) => i.ticker === 'BRML3')).toMatchObject({ situacaoAnterior: 30_000, situacaoAtual: 0 });
    expect(b23.items.find((i) => i.ticker === 'ALOS3')).toMatchObject({ quantidade: 1000, situacaoAtual: 30_000 });
    const b26 = brazilBensDireitos(inp(txs), { year: 2026 });
    expect(b26.items.some((i) => i.ticker === 'BRML3')).toBe(false);
  });
  it('B3 merger with cash: alienation of the cash part, cost carved by value (core C38)', () => {
    const m = createSimpleMarketData({ prices: { [ALOS3.id]: [['2023-01-02', 57]] } });
    const txs = [
      t({ date: '2022-01-10', type: 'BUY', instrumentId: BRML3.id, quantity: 3000, price: 10 }),
      t({ date: '2023-01-02', type: 'SPLIT', subtype: 'MERGER', instrumentId: BRML3.id, targetInstrumentId: ALOS3.id, ratio: 1 / 3, amount: 3_000 }),
    ];
    const cashTrade = runBrazilB3Ledger(inp(txs, m)).trades.find((x) => x.instrumentId === BRML3.id)!;
    expect(cashTrade).toMatchObject({ quantity: 0, netProceeds: 3_000 });
    expect(cashTrade.cost).toBeCloseTo(1_500, 6); // 3000 / (3000 + 1000 x 57) x 30000
    const b = brazilBensDireitos(inp(txs, m), { year: 2023 });
    expect(b.items.find((i) => i.ticker === 'ALOS3')!.situacaoAtual).toBeCloseTo(28_500, 6);
  });
  it('foreign stock (Lei 14.754): ticker change carries cost in USD and BRL', () => {
    const txs = [
      t({ date: '2024-02-10', type: 'BUY', instrumentId: OLDUS.id, quantity: 10, price: 100, currency: 'USD' }),
      t({ date: '2025-03-01', type: 'SPLIT', subtype: 'TICKER_CHANGE', instrumentId: OLDUS.id, targetInstrumentId: NEWUS.id, ratio: 1, currency: 'USD' }),
      t({ date: '2025-06-10', type: 'SELL', instrumentId: NEWUS.id, quantity: 10, price: 150, currency: 'USD' }),
    ];
    const f = brazilForeignAnnualReport(inp(txs), { year: 2025 });
    expect(f.sales[0]).toMatchObject({ instrumentId: NEWUS.id, costFx: 1_000, costBrl: 5_000 });
    expect(f.positions).toHaveLength(0);
  });
  it('crypto MATIC → POL: units, cost and custody move (no cost-pending sale, Bens without MATIC)', () => {
    const txs = [
      t({ date: '2024-01-10', type: 'BUY', instrumentId: MATIC.id, quantity: 1000, price: 1, currency: 'USD', account: 'Mercado Bitcoin' }),
      t({ date: '2024-09-04', type: 'SPLIT', subtype: 'TICKER_CHANGE', instrumentId: MATIC.id, targetInstrumentId: POL.id, ratio: 1, currency: 'USD' }),
      t({ date: '2026-03-10', type: 'SELL', instrumentId: POL.id, quantity: 1000, price: 9, currency: 'USD', account: 'Mercado Bitcoin' }),
    ];
    const c = brazilCryptoReport(inp(txs), { year: 2026 });
    expect(c.sales[0]).toMatchObject({ instrumentId: POL.id, costBrl: 5_000, gainBrl: 40_000 });
    expect(c.sales[0]!.pendingCost).toBeUndefined();
    expect(c.months[0]!.darf?.amount).toBe(6_000);
    const b = brazilBensDireitos(inp(txs), { year: 2024 });
    const c08 = b.items.filter((i) => i.grupo === '08');
    expect(c08.find((i) => i.ticker === 'POL-USD')).toMatchObject({ quantidade: 1000, situacaoAtual: 5_000, localizacao: 'Brasil' });
    expect(c08.find((i) => i.ticker === 'MATIC-USD')?.situacaoAtual ?? 0).toBe(0);
  });
  it('a restructuring without target is not applied and is flagged as an error', () => {
    const r = brazilMonthlyApuracao(
      inp([t({ date: '2022-01-10', type: 'BUY', instrumentId: BRML3.id, quantity: 3000, price: 10 }), t({ date: '2023-01-02', type: 'SPLIT', subtype: 'MERGER', instrumentId: BRML3.id, ratio: 1 / 3 })]),
      { from: '2023-01', to: '2023-01' },
    );
    expect(r.issues.find((i) => i.code === 'CORPORATE_ACTION_NO_TARGET')!.level).toBe('error');
  });
});

describe('T65 — SPINOFF splits the cost and creates the new shares', () => {
  const c3 = [
    t({ date: '2024-01-10', type: 'BUY', instrumentId: GGBR4.id, quantity: 1000, price: 20 }),
    t({ date: '2025-06-01', type: 'SPLIT', subtype: 'SPINOFF', instrumentId: GGBR4.id, targetInstrumentId: SPIN3.id, ratio: 1, costFraction: 0.1 }),
  ];
  it('C3: Bens e Direitos GGBR4 R$ 18.000 and SPIN3 x1000 R$ 2.000', () => {
    const b = brazilBensDireitos(inp(c3), { year: 2025 });
    expect(b.items.find((i) => i.ticker === 'GGBR4')).toMatchObject({ quantidade: 1000, situacaoAtual: 18_000 });
    expect(b.items.find((i) => i.ticker === 'SPIN3')).toMatchObject({ quantidade: 1000, situacaoAtual: 2_000 });
  });
  it('a later SPIN3 sale uses the allocated cost (not a short sale)', () => {
    const a = brazilMonthlyApuracao(inp([...c3, t({ date: '2026-02-10', type: 'SELL', instrumentId: SPIN3.id, quantity: 1000, price: 3 })]), { from: '2026-02', to: '2026-02' });
    expect(a.months[0]!.results.acoes).toBeCloseTo(1_000, 6);
    expect(a.openShorts).toHaveLength(0);
  });
  it('Colombia: spin-off lots keep the parent dates; missing costFraction is warned', () => {
    const txs = [
      t({ date: '2020-03-10', type: 'BUY', instrumentId: BCOL.id, quantity: 100, price: 30_000, currency: 'COP' }),
      t({ date: '2025-06-01', type: 'SPLIT', subtype: 'SPINOFF', instrumentId: BCOL.id, targetInstrumentId: CIBEST.id, ratio: 0.5, costFraction: 0.2, currency: 'COP' }),
      t({ date: '2025-09-01', type: 'SELL', instrumentId: CIBEST.id, quantity: 50, price: 20_000, currency: 'COP' }),
    ];
    const r = buildColombiaTaxReport(inp(txs), { year: 2025 });
    expect(r.ventas.rows[0]).toMatchObject({ openDate: '2020-03-10', quantity: 50, costCop: 600_000 });
    expect(r.patrimonio.rows.find((x) => x.symbol === 'BCOLOMBIA')!.fiscalValueCop).toBeCloseTo(2_400_000, 6);
    const w = buildColombiaTaxReport(inp([txs[0]!, { ...txs[1]!, costFraction: undefined }]), { year: 2025 });
    expect(codes(w.issues)).toContain('SPINOFF_COST_FRACTION_MISSING');
  });
});

describe('T66 — JCP by subtype', () => {
  it('C4: subtype JCP without taxes/note → JCP (linha 10), expected IRRF 175, JCP_IRRF_MISSING', () => {
    const r = brazilProventosReport(inp([t({ date: '2026-05-20', type: 'DIVIDEND', subtype: 'JCP', instrumentId: 'BVMF:ITSA4', amount: 1000 })]), { year: 2026 });
    expect(r.rows[0]).toMatchObject({ type: 'JCP', expectedIrrf: 175, dirpf: { linha: '10' } });
    expect(codes(r.issues)).toContain('JCP_IRRF_MISSING');
  });
  it('subtype ORDINARY wins over the withholding-rate heuristic', () => {
    const r = brazilProventosReport(inp([t({ date: '2026-05-20', type: 'DIVIDEND', subtype: 'ORDINARY', instrumentId: 'BVMF:ITSA4', amount: 1000, taxes: 150 })]), { year: 2026 });
    expect(r.rows[0]!.type).toBe('DIVIDENDO');
  });
  it('net JCP (amountIsNet) is grossed up at the JCP rate, IRRF marked estimated', () => {
    const r = brazilProventosReport(inp([t({ date: '2026-05-20', type: 'DIVIDEND', subtype: 'JCP', instrumentId: 'BVMF:ITSA4', amount: 825, amountIsNet: true })]), { year: 2026 });
    expect(r.rows[0]!.gross).toBeCloseTo(1_000, 6);
    expect(r.rows[0]!.irrf).toBeCloseTo(175, 6);
    expect(r.rows[0]!.irrfEstimated).toBe(true);
    expect(codes(r.issues)).toContain('INCOME_RECORDED_NET');
  });
});

describe('T67 — amountIsNet is honoured', () => {
  const cdt = (extra: Partial<Transaction>) => [
    t({ date: '2025-01-10', type: 'BUY', instrumentId: CDT.id, quantity: 1, price: 100_000_000, currency: 'COP' }),
    t({ date: '2025-12-10', type: 'INTEREST', instrumentId: CDT.id, amount: 9_600_000, amountIsNet: true, currency: 'COP', ...extra }),
  ];
  it('C5: net CDT interest → gross 10.000.000, estimated 400.000 NOT credited, warning', () => {
    const r = buildColombiaTaxReport(inp(cdt({})), { year: 2025 });
    const i = r.ingresos.interest[0]!;
    expect(i.grossCop).toBeCloseTo(10_000_000, 2);
    expect(i.withheldCop).toBe(0);
    expect(i.withholdingEstimatedCop).toBeCloseTo(400_000, 2);
    expect(r.issues.find((x) => x.code === 'INCOME_RECORDED_NET')!.level).toBe('warning');
  });
  it('net with certified taxes → gross = amount + taxes', () => {
    const i = buildColombiaTaxReport(inp(cdt({ taxes: 400_000 })), { year: 2025 }).ingresos.interest[0]!;
    expect(i.grossCop).toBe(10_000_000);
    expect(i.withheldCop).toBe(400_000);
  });
  it('ambiguous case (foreign dividend net, no taxes) → warning, recorded value kept', () => {
    const r = buildColombiaTaxReport(inp([t({ date: '2025-06-10', type: 'DIVIDEND', instrumentId: 'XNAS:AAPL', amount: 70, amountIsNet: true, currency: 'USD' })]), { year: 2025 });
    expect(r.ingresos.dividends[0]!.grossLocal).toBe(70);
    expect(r.issues.find((x) => x.code === 'INCOME_RECORDED_NET')!.message).toContain('certificado');
  });
  it('Brazil: net CDB coupon → gross by the regressive table, IR estimated', () => {
    const r = brazilRendaFixaReport(
      inp([
        t({ date: '2026-01-05', type: 'BUY', instrumentId: CDB.id, quantity: 1, price: 10_000 }),
        t({ date: '2026-07-24', type: 'INTEREST', instrumentId: CDB.id, amount: 800, amountIsNet: true }),
      ]),
      { year: 2026 },
    );
    const row = r.rows.find((x) => x.type === 'cupom')!;
    expect(row.gross).toBeCloseTo(1_000, 6); // 200 days → 20%
    expect(row.irrfEstimated).toBeCloseTo(200, 6);
    expect(codes(r.issues)).toContain('INCOME_RECORDED_NET');
  });
  it('US withholding check: net dividend with taxes is compared on the gross', () => {
    const rows = checkUsDividendWithholding(inp([t({ date: '2025-06-10', type: 'DIVIDEND', instrumentId: 'XNAS:AAPL', amount: 85, taxes: 15, amountIsNet: true, currency: 'USD' })]), 'BR');
    expect(rows[0]!.gross).toBe(100);
    expect(rows[0]!.actualRate).toBeCloseTo(0.15, 6);
  });
});

describe('T68 — several payments per DARF, partial / over / unmatched', () => {
  const eth = [
    t({ date: '2026-03-01', type: 'BUY', instrumentId: ETH.id, quantity: 10, price: 1000, currency: 'USD', account: 'Mercado Bitcoin' }),
    t({ date: '2026-03-10', type: 'SELL', instrumentId: ETH.id, quantity: 10, price: 1400, currency: 'USD', account: 'Mercado Bitcoin' }),
  ]; // gain 20.000 → tax 3.000
  const cr = (extra: Transaction[]) => brazilCryptoReport(inp([...eth, ...extra]), { year: 2026, asOf: '2026-10-13' });
  it('D3: 1.000 + 2.000 → paga, summed, no false DARF_UNDERPAID', () => {
    const c = cr([pay('2026-04-20', 1_000, 'DARF 4600 2026-03'), pay('2026-04-28', 2_000, 'DARF 4600 2026-03')]);
    expect(c.months[0]!.darf).toMatchObject({ status: 'paga', paidTotal: 3_000 });
    expect(c.months[0]!.darf!.payments).toHaveLength(2);
    expect(codes(c.issues)).not.toContain('DARF_UNDERPAID');
  });
  it('D4a: early 2.500 of 3.000 → paga_parcial with the balance (with charges up to asOf)', () => {
    const d = cr([pay('2026-04-10', 2_500, 'DARF 4600 2026-03')]);
    expect(d.months[0]!.darf!.status).toBe('paga_parcial');
    expect(d.months[0]!.darf!.balance!).toBeGreaterThan(500);
    expect(codes(d.issues)).toContain('DARF_UNDERPAID');
  });
  it('D4b: 3.500 for 3.000 → paga + DARF_OVERPAID (PER/DCOMP)', () => {
    const d = cr([pay('2026-04-10', 3_500, 'DARF 4600 2026-03')]);
    expect(d.months[0]!.darf).toMatchObject({ status: 'paga', overpaid: 500 });
    expect(d.issues.find((i) => i.code === 'DARF_OVERPAID')!.message).toContain('PER/DCOMP');
  });
  it('principal partly on time + complementary DARF with charges → paga_em_atraso', () => {
    // 2.000 on time; 1.000 + multa (41 days, 13,53%) + juros (Selic May 1,07% + 1%) paid 10/06.
    const d = cr([pay('2026-04-20', 2_000, 'DARF 4600 2026-03'), pay('2026-06-10', 1_000 * (1 + 0.1353 + 0.0207), 'DARF 4600 2026-03')]);
    expect(d.months[0]!.darf!.status).toBe('paga_em_atraso');
    expect(d.months[0]!.darf!.late!.multa).toBeCloseTo(135.3, 1);
    expect(codes(d.issues)).not.toContain('DARF_UNDERPAID');
  });
  it('a payment that matches no DARF is reported', () => {
    const d = cr([pay('2026-08-20', 500, 'DARF 4600 2026-07')]);
    expect(codes(d.issues)).toContain('DARF_PAYMENT_UNMATCHED');
  });
  it('the 6015 apuração sums payments too', () => {
    const a = brazilMonthlyApuracao(
      inp([
        t({ date: '2026-03-01', type: 'BUY', instrumentId: 'BVMF:PETR4', quantity: 1000, price: 30 }),
        t({ date: '2026-03-10', type: 'SELL', instrumentId: 'BVMF:PETR4', quantity: 1000, price: 50, taxes: 0 }),
        pay('2026-04-20', 1_500, 'DARF 6015 2026-03'),
        pay('2026-04-25', 1_500, 'DARF 6015 2026-03'),
      ]),
      { year: 2026, asOf: '2026-10-13' },
    );
    expect(a.darfs[0]).toMatchObject({ amount: 3_000, status: 'paga', paidTotal: 3_000 });
  });
});

describe('T69 — accumulated DARFs: payment by covered month, carry older than a year', () => {
  const sell = (date: string, q: number) => t({ date, type: 'SELL', instrumentId: ETH.id, quantity: q, price: 728, currency: 'USD', account: 'Mercado Bitcoin' });
  const buy = (date: string, q: number) => t({ date, type: 'BUY', instrumentId: ETH.id, quantity: q, price: 727.9, currency: 'USD', account: 'Mercado Bitcoin' });
  it('D5: DARF of May covering Mar/Apr paid with the note "2026-03" → paga', () => {
    const c = brazilCryptoReport(
      inp([buy('2026-03-01', 100), sell('2026-03-10', 50), sell('2026-04-10', 50), buy('2026-05-01', 100), sell('2026-05-10', 100), pay('2026-06-20', 15, 'DARF 4600 2026-03')]),
      { year: 2026, asOf: '2026-10-13' },
    );
    expect(c.months.find((m) => m.month === '2026-05')!.darf).toMatchObject({ amount: 15, status: 'paga', includesMonths: ['2026-03', '2026-04', '2026-05'] });
  });
  it('D6c: R$ 7,50 carried from 2024 (no sales in 2025) is paid with January 2026', () => {
    const c = brazilCryptoReport(inp([buy('2024-11-01', 150), sell('2024-11-10', 50), sell('2024-12-10', 50), sell('2026-01-10', 50)]), { year: 2026 });
    expect(c.months[0]!.darf).toMatchObject({ amount: 11.25, includesMonths: ['2024-11', '2024-12', '2026-01'] });
  });
});

describe('T70 — "mantido" transit + later real deposit is not counted twice', () => {
  const out = t({ id: 'oX', date: '2025-01-15', type: 'TRANSFER_OUT', instrumentId: BTC.id, quantity: 1, currency: 'USD', account: 'Mercado Bitcoin' });
  const base = [t({ date: '2024-06-10', type: 'BUY', instrumentId: BTC.id, quantity: 1, price: 40_000, currency: 'USD', account: 'Mercado Bitcoin' }), out];
  const dep = t({ id: 'iX', date: '2026-04-01', type: 'TRANSFER_IN', instrumentId: BTC.id, quantity: 1, currency: 'USD', account: 'Binance' });
  it('D8 mantido: the deposit takes the origin cost (provisional), the transit line closes', () => {
    const b = brazilBensDireitos(inp([...base, dep]), { year: 2026, transitResolution: { oX: 'mantido' } });
    const c08 = b.items.filter((i) => i.grupo === '08');
    expect(c08.reduce((a, i) => a + (i.quantidade ?? 0), 0)).toBe(1);
    expect(c08.reduce((a, i) => a + i.situacaoAtual, 0)).toBeCloseTo(200_000, 6);
    expect(c08.find((i) => !i.emTransito)!.costStatus).toBe('provisorio');
    expect(codes(b.issues)).toContain('TRANSFER_MATCH_APPLIED_MANTIDO');
  });
  it('D8 alienado: the OUT is no longer proposed nor reported unmatched', () => {
    const b = brazilBensDireitos(inp([...base, dep]), { year: 2026, transitResolution: { oX: 'alienado' } });
    expect(codes(b.issues)).not.toContain('TRANSFER_MATCH_PROPOSED');
    expect(codes(b.issues)).not.toContain('TRANSFER_OUT_UNMATCHED');
  });
});
