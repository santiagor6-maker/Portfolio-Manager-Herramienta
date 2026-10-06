/**
 * Regression tests for the round-1 review (reviews/tax-r1.md), one block per gap T1..T21.
 * Scenarios S-CO and S-BR reproduce the reviewer's scripts.
 */
import { describe, expect, it } from 'vitest';
import type { Instrument, Transaction } from '@pm/core';
import { ALL_INSTRUMENTS, I, tx } from './testing/fixtures';
import { createSimpleMarketData } from './testing/marketData';
import { lastBrazilBusinessDayOfMonth } from './common/dates';
import { buildColombiaTaxReport, settlementDate } from './colombia/report';
import { art241TaxCop, colombiaConfig } from './colombia/config';
import { colombiaTaxPack } from './colombia/taxPack';
import { colombiaLotMilestones, simulateColombiaSale } from './colombia/simulate';
import { brazilMonthlyApuracao } from './brazil/apuracao';
import { brazilProventosReport } from './brazil/proventos';
import { brazilForeignAnnualReport } from './brazil/exterior';
import { brazilBensDireitos } from './brazil/bensDireitos';
import { runBrazilB3Ledger } from './brazil/ledger';
import { classifyForBrazil } from './brazil/classify';
import { brazilConfig } from './brazil/config';
import { darfLateCharges } from './brazil/darf';
import { brazilRendaFixaReport } from './brazil/rendaFixa';
import { brazilCryptoReport } from './brazil/crypto';
import { brazilTaxPack } from './brazil/taxPack';
import { simulateBrazilSale } from './brazil/simulate';
import { checkUsEstateTaxExposure, isUsSource } from './us/withholding';

const inst = (p: Partial<Instrument> & Pick<Instrument, 'id' | 'symbol' | 'exchange' | 'currency' | 'country' | 'assetClass'>): Instrument => ({
  name: p.symbol,
  ...p,
});
const PETR3 = inst({ id: 'BVMF:PETR3', symbol: 'PETR3', exchange: 'BVMF', currency: 'BRL', country: 'BR', assetClass: 'equity' });
const IMAB11 = inst({ id: 'BVMF:IMAB11', symbol: 'IMAB11', name: 'It Now IMA-B', exchange: 'BVMF', currency: 'BRL', country: 'BR', assetClass: 'etf' });
const BCOLOMBIA = inst({ id: 'XBOG:BCOLOMBIA', symbol: 'BCOLOMBIA', exchange: 'XBOG', currency: 'COP', country: 'CO', assetClass: 'equity' });
const PETRA250 = inst({ id: 'BVMF:PETRA250', symbol: 'PETRA250', exchange: 'BVMF', currency: 'BRL', country: 'BR', assetClass: 'other' });
const ITSA1 = inst({ id: 'BVMF:ITSA1', symbol: 'ITSA1', exchange: 'BVMF', currency: 'BRL', country: 'BR', assetClass: 'equity' });
const CDB = inst({ id: 'MANUAL:CDB1', symbol: 'CDB1', name: 'CDB Banco XP', exchange: 'MANUAL', currency: 'BRL', country: 'BR', assetClass: 'fixed_income' });
const CDB2 = inst({ id: 'MANUAL:CDB2', symbol: 'CDB2', name: 'CDB Banco Inter', exchange: 'MANUAL', currency: 'BRL', country: 'BR', assetClass: 'fixed_income' });
const LCI = inst({ id: 'MANUAL:LCI1', symbol: 'LCI1', name: 'LCI Banco Inter', exchange: 'MANUAL', currency: 'BRL', country: 'BR', assetClass: 'fixed_income' });
const BTC = inst({ id: 'MANUAL:BTC', symbol: 'BTC', exchange: 'MANUAL', currency: 'BRL', country: 'BR', assetClass: 'crypto' });
const INSTS = [...ALL_INSTRUMENTS, PETR3, IMAB11, BCOLOMBIA, PETRA250, ITSA1, CDB, CDB2, LCI, BTC];

const coFx = {
  'USD/COP': [
    ['2019-01-01', 3200],
    ['2020-01-01', 4000],
    ['2023-01-01', 4800],
    ['2024-06-01', 4000],
    ['2025-06-01', 4200],
    ['2025-12-31', 3900],
  ] as [string, number][],
};
const coMarket = createSimpleMarketData({ fx: coFx });
const brMarket = createSimpleMarketData({ fx: { 'USD/BRL': [['2020-01-01', 5]] } });
const co = (transactions: Transaction[], market = coMarket) => ({ transactions, instruments: INSTS, market });
const br = (transactions: Transaction[], market = brMarket) => ({ transactions, instruments: INSTS, market });
const B = 'BRL';

describe('T1 — Art. 153 ET: share losses are not deductible', () => {
  it('S-CO1: ganancia ocasional is not reduced by a loss on another share', () => {
    const r = buildColombiaTaxReport(
      co([
        tx({ date: '2021-01-10', type: 'BUY', instrumentId: I.AAPL.id, quantity: 100, price: 100, currency: 'USD' }),
        tx({ date: '2021-01-10', type: 'BUY', instrumentId: I.VOO.id, quantity: 100, price: 300, currency: 'USD' }),
        tx({ date: '2025-06-02', type: 'SELL', instrumentId: I.AAPL.id, quantity: 100, price: 300, currency: 'USD' }),
        tx({ date: '2025-06-02', type: 'SELL', instrumentId: I.VOO.id, quantity: 100, price: 150, currency: 'USD' }),
      ]),
      { year: 2025 },
    );
    const go = r.ventas.totals.gananciaOcasional;
    expect(go.gananciaGravableCop).toBeCloseTo(86_000_000, 2);
    expect(go.impuestoEstimadoCop).toBeCloseTo(12_900_000, 2);
    expect(go.perdidaNoDeducibleCop).toBeCloseTo(57_000_000, 2);
    expect(r.issues.map((i) => i.code)).toContain('ART_153_LOSS_NOT_DEDUCTIBLE');
  });

  it('S-CO1b: renta ordinaria from share sales is not reduced either', () => {
    const r = buildColombiaTaxReport(
      co([
        tx({ date: '2024-06-03', type: 'BUY', instrumentId: I.AAPL.id, quantity: 100, price: 100, currency: 'USD' }),
        tx({ date: '2024-06-03', type: 'BUY', instrumentId: I.VOO.id, quantity: 100, price: 300, currency: 'USD' }),
        tx({ date: '2025-06-02', type: 'SELL', instrumentId: I.AAPL.id, quantity: 100, price: 200, currency: 'USD' }),
        tx({ date: '2025-06-02', type: 'SELL', instrumentId: I.VOO.id, quantity: 100, price: 150, currency: 'USD' }),
      ]),
      { year: 2025 },
    );
    expect(r.ventas.totals.rentaOrdinaria.rentaLiquidaCop).toBeCloseTo(44_000_000, 2);
    expect(r.ventas.totals.rentaOrdinaria.perdidaNoDeducibleCop).toBeCloseTo(57_000_000, 2);
  });

  it('netting is allowed between lots of the same sale', () => {
    const r = buildColombiaTaxReport(
      co([
        tx({ date: '2024-07-01', type: 'BUY', instrumentId: I.ECOPETROL.id, quantity: 100, price: 2000, currency: 'COP' }),
        tx({ date: '2024-08-01', type: 'BUY', instrumentId: I.ECOPETROL.id, quantity: 100, price: 3000, currency: 'COP' }),
        tx({ date: '2025-03-03', type: 'SELL', instrumentId: I.ECOPETROL.id, quantity: 200, price: 2600, currency: 'COP' }),
      ]),
      { year: 2025, outstandingShares: { [I.ECOPETROL.id]: 1000 } },
    );
    // +60,000 and -40,000 in one sale -> +20,000
    expect(r.ventas.totals.rentaOrdinaria.rentaLiquidaCop).toBeCloseTo(20_000, 6);
    expect(r.ventas.totals.rentaOrdinaria.perdidaNoDeducibleCop).toBe(0);
  });
});

describe('T2 — BRL→USD remittance creates foreign cash (06-01)', () => {
  const ptax = { buy: () => 5.0, sell: () => 5.01 };
  const txs = [
    tx({ date: '2025-02-03', type: 'FX_CONVERSION', amount: 52_000, currency: B, toCurrency: 'USD', toAmount: 10_000 }),
    tx({ date: '2025-02-04', type: 'BUY', instrumentId: I.AAPL.id, quantity: 20, price: 230, currency: 'USD' }),
  ];
  it('S-BR6: USD 5,400 at cost R$ 28,080 and item 06-01 located in the US', () => {
    const r = brazilForeignAnnualReport(br(txs), { year: 2025, ptax });
    expect(r.cash).toEqual([{ currency: 'USD', units: 5400, cost: 28080 }]);
    const b = brazilBensDireitos(br(txs), { year: 2025, ptax });
    const cash = b.items.find((i) => i.grupo === '06' && i.codigo === '01')!;
    expect(cash.situacaoAtual).toBeCloseTo(28080, 6);
    expect(cash.localizacao).toBe('US');
  });
  it('buying abroad without a recorded remittance is flagged', () => {
    const r = brazilForeignAnnualReport(br([txs[1]!]), { year: 2025, ptax });
    expect(r.issues.map((i) => i.code)).toContain('FOREIGN_CASH_NOT_RECORDED');
  });
});

describe('T3 — DARF due date: 31/12 has no bank business', () => {
  it('last bank business day of December is the 30th', () => {
    expect(lastBrazilBusinessDayOfMonth('2025-12')).toBe('2025-12-30');
    expect(lastBrazilBusinessDayOfMonth('2026-12')).toBe('2026-12-30');
    expect(lastBrazilBusinessDayOfMonth('2027-12')).toBe('2027-12-30');
  });
  it('S-BR1: November 2026 DARF is due 30/12/2026', () => {
    const r = brazilMonthlyApuracao(
      br([
        tx({ date: '2026-01-05', type: 'BUY', instrumentId: I.PETR4.id, quantity: 2000, price: 30, currency: B }),
        tx({ date: '2026-11-10', type: 'SELL', instrumentId: I.PETR4.id, quantity: 2000, price: 40, currency: B }),
      ]),
      { year: 2026 },
    );
    expect(r.darfs[0]!.dueDate).toBe('2026-12-30');
  });
});

describe('T4 — short sales / oversell never create phantom gains', () => {
  it('S-BR4: short sale covered later in the month → +R$ 5,000, tax R$ 750, no position left', () => {
    const txs = [
      tx({ date: '2026-03-02', type: 'SELL', instrumentId: I.VALE3.id, quantity: 1000, price: 60, currency: B }),
      tx({ date: '2026-03-20', type: 'BUY', instrumentId: I.VALE3.id, quantity: 1000, price: 55, currency: B }),
    ];
    const r = brazilMonthlyApuracao(br(txs), { from: '2026-03', to: '2026-03' });
    expect(r.months[0]!.results.acoes).toBeCloseTo(5000, 6);
    expect(r.months[0]!.taxGross).toBeCloseTo(750, 6);
    expect(r.darfs[0]!.amount).toBe(750);
    expect(runBrazilB3Ledger(br(txs)).positions).toEqual([]);
    expect(r.openShorts).toEqual([]);
  });
  it('a sell with no purchase history produces no DARF and an error', () => {
    const r = brazilMonthlyApuracao(br([tx({ date: '2026-03-02', type: 'SELL', instrumentId: I.VALE3.id, quantity: 1000, price: 60, currency: B })]), {
      year: 2026,
    });
    expect(r.darfs).toHaveLength(0);
    expect(r.openShorts[0]!.quantity).toBe(1000);
    expect(r.issues.some((i) => i.code === 'SHORT_OR_MISSING_HISTORY' && i.level === 'error')).toBe(true);
  });
  it('Colombia: oversold quantity is "pendiente_costo", not a zero-cost gain', () => {
    const r = buildColombiaTaxReport(co([tx({ date: '2025-06-02', type: 'SELL', instrumentId: I.AAPL.id, quantity: 10, price: 200, currency: 'USD' })]), {
      year: 2025,
    });
    expect(r.ventas.rows[0]!.classification).toBe('pendiente_costo');
    expect(r.ventas.totals.gananciaOcasional.impuestoEstimadoCop).toBe(0);
    expect(r.ventas.totals.rentaOrdinaria.rentaLiquidaCop).toBe(0);
    expect(r.ventas.totals.pendienteCosto.count).toBe(1);
  });
  it('Brazil abroad: oversell does not create a gain', () => {
    const r = brazilForeignAnnualReport(br([tx({ date: '2025-06-02', type: 'SELL', instrumentId: I.AAPL.id, quantity: 10, price: 200, currency: 'USD' })]), {
      year: 2025,
    });
    expect(r.sales).toHaveLength(0);
    expect(r.totals.taxDueBrl).toBe(0);
    expect(r.issues.map((i) => i.code)).toContain('OVERSELL');
  });
});

describe('T5 — Lei 15.270 threshold per paying company', () => {
  it('S-BR2: PETR3 + PETR4 dividends add up for the R$ 50k limit', () => {
    const r = brazilProventosReport(
      br([
        tx({ date: '2026-03-20', type: 'DIVIDEND', instrumentId: I.PETR4.id, amount: 30_000, currency: B }),
        tx({ date: '2026-03-20', type: 'DIVIDEND', instrumentId: PETR3.id, amount: 30_000, currency: B }),
      ]),
      { year: 2026 },
    );
    expect(r.rows.map((x) => x.expectedIrrf)).toEqual([3000, 3000]);
    expect(r.issues.map((i) => i.code)).toContain('DIVIDEND_IRRF_LEI_15270');
  });
  it('issuer override groups different tickers', () => {
    const r = brazilProventosReport(
      br([
        tx({ date: '2026-03-20', type: 'DIVIDEND', instrumentId: I.ITSA4.id, amount: 30_000, currency: B }),
        tx({ date: '2026-03-20', type: 'DIVIDEND', instrumentId: I.VALE3.id, amount: 30_000, currency: B }),
      ]),
      { year: 2026, issuers: { [I.ITSA4.id]: 'X', [I.VALE3.id]: 'X' } },
    );
    expect(r.rows[0]!.expectedIrrf).toBe(3000);
  });
});

describe('T6 — Lei 15.270 transition (profits up to 2025 approved by 31/12/2025)', () => {
  it('S-BR3: note "ref. 2025" → no expected IRRF, info only', () => {
    const r = brazilProventosReport(
      br([tx({ date: '2026-02-15', type: 'DIVIDEND', instrumentId: I.VALE3.id, amount: 80_000, currency: B, note: 'Dividendos ref. 2025, aprovados em 12/2025' })]),
      { year: 2026 },
    );
    expect(r.rows[0]!.expectedIrrf).toBe(0);
    expect(r.rows[0]!.lei15270Transition).toBe(true);
    expect(r.issues.every((i) => i.level === 'info')).toBe(true);
  });
  it('explicit list of transition dividends; undetermined cases are info, not warning', () => {
    const t1 = tx({ date: '2026-02-15', type: 'DIVIDEND', instrumentId: I.VALE3.id, amount: 80_000, currency: B });
    expect(brazilProventosReport(br([t1]), { year: 2026, preLei15270Dividends: [t1.id] }).rows[0]!.expectedIrrf).toBe(0);
    const r = brazilProventosReport(br([t1]), { year: 2026 });
    expect(r.issues.filter((i) => i.level === 'warning')).toHaveLength(0);
    expect(r.issues.map((i) => i.code)).toContain('DIVIDEND_IRRF_LEI_15270_CHECK');
  });
});

describe('T7 — fixed-income ETF is taxed at source', () => {
  it('S-BR5: IMAB11 sale generates no DARF and is declared as 07-08', () => {
    expect(classifyForBrazil(IMAB11)).toBe('ETF_RF');
    const txs = [
      tx({ date: '2026-01-05', type: 'BUY', instrumentId: IMAB11.id, quantity: 1000, price: 100, currency: B }),
      tx({ date: '2026-06-05', type: 'SELL', instrumentId: IMAB11.id, quantity: 500, price: 110, currency: B }),
    ];
    const r = brazilMonthlyApuracao(br(txs), { year: 2026 });
    expect(r.darfs).toHaveLength(0);
    expect(r.etfRendaFixaTrades).toHaveLength(1);
    expect(r.issues.map((i) => i.code)).toContain('ETF_RF_WITHHELD_AT_SOURCE');
    const b = brazilBensDireitos(br(txs), { year: 2026 });
    expect(b.items.find((i) => i.ticker === 'IMAB11')).toMatchObject({ grupo: '07', codigo: '08' });
  });
});

describe('T8 — Colombia: dividend withholding, Art. 254-1 and Art. 241 estimate', () => {
  const txs = [
    tx({ date: '2024-01-10', type: 'BUY', instrumentId: I.ECOPETROL.id, quantity: 1_000_000, price: 2000, currency: 'COP' }),
    tx({ date: '2025-04-10', type: 'DIVIDEND', instrumentId: I.ECOPETROL.id, amount: 300_000_000, currency: 'COP' }),
  ];
  it('S-CO2: expected withholding 15% over 1,090 UVT and 19% discount', () => {
    const r = buildColombiaTaxReport(co(txs), { year: 2025 });
    const t = r.ingresos.totals;
    expect(t.nationalDividendExpectedWithholdingCop).toBeCloseTo(36_857_863.5, 1);
    expect(t.descuentoArt2541Cop).toBeCloseTo((300_000_000 - 1090 * 49_799) * 0.19, 1);
    expect(r.issues.map((i) => i.code)).toContain('CO_DIVIDEND_WITHHOLDING_MISMATCH');
  });
  it('withholding is cumulative per company in the year', () => {
    const r = buildColombiaTaxReport(
      co([
        tx({ date: '2025-04-10', type: 'DIVIDEND', instrumentId: I.ECOPETROL.id, amount: 50_000_000, currency: 'COP' }),
        tx({ date: '2025-10-10', type: 'DIVIDEND', instrumentId: I.ECOPETROL.id, amount: 50_000_000, currency: 'COP', taxes: 6_857_863.5 }),
      ]),
      { year: 2025 },
    );
    const [d1, d2] = r.ingresos.dividends;
    expect(d1!.expectedWithholdingCop).toBe(0);
    expect(d2!.expectedWithholdingCop).toBeCloseTo((100_000_000 - 54_280_910) * 0.15, 1);
    expect(r.issues.map((i) => i.code)).not.toContain('CO_DIVIDEND_WITHHOLDING_MISMATCH');
  });
  it('Art. 241 table and incremental estimate', () => {
    expect(art241TaxCop(1000, 1).taxCop).toBe(0);
    expect(art241TaxCop(1700, 1).taxCop).toBeCloseTo(115.9, 6);
    expect(art241TaxCop(5000, 1).taxCop).toBeCloseTo(788 + 900 * 0.33, 6);
    expect(art241TaxCop(40000, 1).marginalRate).toBe(0.39);
    const r = buildColombiaTaxReport(co(txs), { year: 2025, otherCedulaGeneralIncomeCop: 0 });
    const ie = r.impuestoEstimado!;
    expect(ie.impuestoCedulaGeneralIncrementalCop).toBeCloseTo(art241TaxCop(300_000_000, 49_799).taxCop, 2);
    expect(ie.marginalRate).toBe(0.33);
    expect(ie.saldoEstimadoCop).toBeCloseTo(ie.impuestoCedulaGeneralIncrementalCop - ie.descuentoArt2541Cop, 2);
  });
});

describe('T9 — TRANSFER_IN keeps the original date and cost', () => {
  it('S-CO3 (structured note): AAPL bought in 2019 stays ganancia ocasional with its original cost', () => {
    const r = buildColombiaTaxReport(
      co([
        tx({ date: '2024-09-01', type: 'TRANSFER_IN', instrumentId: I.AAPL.id, quantity: 10, price: 220, currency: 'USD', note: 'traslado [costo: 2019-03-15 @ 50]' }),
        tx({ date: '2025-06-02', type: 'SELL', instrumentId: I.AAPL.id, quantity: 10, price: 200, currency: 'USD' }),
      ]),
      { year: 2025 },
    );
    const row = r.ventas.rows[0]!;
    expect(row.classification).toBe('ganancia_ocasional');
    expect(row.openDate).toBe('2019-03-15');
    expect(row.costCop).toBeCloseTo(500 * 3200, 6);
  });
  it('S-CO3 free-text note is only a proposal (round 2, T29); options map and acceptNoteProposals apply it', () => {
    const t1 = tx({ date: '2024-09-01', type: 'TRANSFER_IN', instrumentId: I.AAPL.id, quantity: 10, price: 220, currency: 'USD', note: 'bought 2019 at 50' });
    const sell = tx({ date: '2025-06-02', type: 'SELL', instrumentId: I.AAPL.id, quantity: 10, price: 200, currency: 'USD' });
    const r = buildColombiaTaxReport(co([t1, sell]), { year: 2025 });
    expect(r.ventas.rows[0]!.classification).toBe('renta_ordinaria');
    expect(r.issues.map((i) => i.code)).toContain('TRANSFER_BASIS_PROPOSED');
    const ra = buildColombiaTaxReport(co([t1, sell]), { year: 2025, acceptNoteProposals: true });
    expect(ra.ventas.rows[0]!.classification).toBe('ganancia_ocasional');
    expect(ra.issues.map((i) => i.code)).toContain('TRANSFER_BASIS_APPROXIMATE');
    const plain = tx({ date: '2024-09-01', type: 'TRANSFER_IN', instrumentId: I.AAPL.id, quantity: 10, price: 220, currency: 'USD' });
    const r2 = buildColombiaTaxReport(co([plain, sell]), { year: 2025, transferBasis: { [plain.id]: { openDate: '2019-03-15', unitCost: 50 } } });
    expect(r2.ventas.rows[0]!.costCop).toBeCloseTo(500 * 3200, 6);
    const r3 = buildColombiaTaxReport(co([plain, sell]), { year: 2025 });
    expect(r3.issues.map((i) => i.code)).toContain('TRANSFER_COST_UNKNOWN');
  });
  it('Brazil B3: custody transfer keeps the original preço médio', () => {
    const t1 = tx({ date: '2025-03-01', type: 'TRANSFER_IN', instrumentId: I.PETR4.id, quantity: 100, price: 40, currency: B });
    const led = runBrazilB3Ledger(br([t1]), { transferBasis: { [t1.id]: { openDate: '2020-01-01', unitCost: 10 } } });
    expect(led.positions[0]!.averageCost).toBe(10);
    expect(runBrazilB3Ledger(br([t1])).issues.map((i) => i.code)).toContain('TRANSFER_COST_UNKNOWN');
  });
});

describe('T10 — fxRateToBase is the amount effectively paid', () => {
  it('S-BR7: USD deposit at 5.20 costs R$ 52,000', () => {
    const r = brazilForeignAnnualReport(br([tx({ date: '2025-02-03', type: 'DEPOSIT', amount: 10_000, currency: 'USD', fxRateToBase: 5.2 })]), {
      year: 2025,
      ptax: { buy: () => 5.0, sell: () => 5.01 },
    });
    expect(r.cash[0]!.cost).toBeCloseTo(52_000, 6);
  });
});

describe('T11 — DARF: late charges, Sicalc data, payment status', () => {
  it('multa 0.33%/day capped at 20% and juros Selic + 1%', () => {
    const c = darfLateCharges(1000, '2026-04-30', '2026-06-15', { '2026-05': 0.011 });
    expect(c.daysLate).toBe(46);
    expect(c.multa).toBeCloseTo(151.8, 6);
    expect(c.juros).toBeCloseTo(21, 6);
    expect(c.total).toBeCloseTo(1172.8, 6);
    expect(darfLateCharges(1000, '2026-04-30', '2026-09-30', { '2026-05': 0.01, '2026-06': 0.01, '2026-07': 0.01, '2026-08': 0.01 }).multaRate).toBe(0.2);
    expect(darfLateCharges(1000, '2026-12-30', '2027-03-15').missingSelicMonths).toEqual(['2027-01', '2027-02']);
    // built-in Selic table (T35, round 2)
    expect(darfLateCharges(1000, '2025-03-31', '2025-06-10').jurosRate).toBeCloseTo(0.0106 + 0.0114 + 0.01, 10);
  });
  const sale = [
    tx({ date: '2026-01-05', type: 'BUY', instrumentId: I.PETR4.id, quantity: 2000, price: 30, currency: B }),
    tx({ date: '2026-03-10', type: 'SELL', instrumentId: I.PETR4.id, quantity: 2000, price: 40, currency: B }),
  ];
  it('payment recorded as TAX with "DARF 6015" is matched; late payment computes charges', () => {
    const r = brazilMonthlyApuracao(
      br([...sale, tx({ date: '2026-06-15', type: 'TAX', amount: 3600, currency: B, note: 'DARF 6015 2026-03' })]),
      { year: 2026, selicMonthly: { '2026-05': 0.011 } },
    );
    const d = r.darfs[0]!;
    expect(d.amount).toBe(3000);
    expect(d.status).toBe('paga_em_atraso');
    expect(d.late!.total).toBeCloseTo(3000 + 455.4 + 63, 6);
    expect(d.sicalc).toMatchObject({ codigoReceita: '6015', periodoApuracao: '31/03/2026', vencimento: '30/04/2026', valorPrincipal: 3000 });
  });
  it('unpaid DARF after the due date is "vencida" with charges as of a date', () => {
    const r = brazilMonthlyApuracao(br(sale), { year: 2026, asOf: '2026-05-10' });
    const d = r.darfs[0]!;
    expect(d.status).toBe('vencida');
    expect(d.late!.multa).toBeCloseTo(99, 6);
    expect(d.late!.juros).toBeCloseTo(30, 6);
    expect(r.totals.darfOpen).toBeCloseTo(3129, 6);
  });
  it('on-time payment', () => {
    const r = brazilMonthlyApuracao(br([...sale, tx({ date: '2026-04-28', type: 'TAX', amount: 3000, currency: B, note: 'DARF' })]), { year: 2026 });
    expect(r.darfs[0]!.status).toBe('paga');
  });
});

describe('T12 — options, subscription rights, fixed income, crypto', () => {
  it('options: no exemption, 15%; covered call (sell to open) taxed at buy-back', () => {
    expect(classifyForBrazil(PETRA250)).toBe('OPCAO');
    expect(classifyForBrazil(ITSA1)).toBe('DIREITO');
    const r = brazilMonthlyApuracao(
      br([
        tx({ date: '2025-02-03', type: 'BUY', instrumentId: PETRA250.id, quantity: 1000, price: 1, currency: B }),
        tx({ date: '2025-02-20', type: 'SELL', instrumentId: PETRA250.id, quantity: 1000, price: 1.5, currency: B }),
        tx({ date: '2025-03-03', type: 'SELL', instrumentId: PETRA250.id, quantity: 1000, price: 0.8, currency: B }),
        tx({ date: '2025-03-17', type: 'BUY', instrumentId: PETRA250.id, quantity: 1000, price: 0.3, currency: B }),
      ]),
      { year: 2025 },
    );
    const feb = r.months.find((m) => m.month === '2025-02')!;
    const mar = r.months.find((m) => m.month === '2025-03')!;
    expect(feb.results.opcoes).toBeCloseTo(500, 6);
    expect(feb.comum.tax).toBeCloseTo(75, 6);
    expect(mar.results.opcoes).toBeCloseTo(500, 6);
    expect(mar.comum.tax).toBeCloseTo(75, 6);
  });
  it('fixed income: regressive IR checked, LCI exempt, IOF before 30 days', () => {
    const r = brazilRendaFixaReport(
      br([
        tx({ date: '2025-01-02', type: 'BUY', instrumentId: CDB.id, quantity: 1, amount: 1000, currency: B }),
        tx({ date: '2025-12-01', type: 'SELL', instrumentId: CDB.id, quantity: 1, amount: 1100, taxes: 20, currency: B }),
        tx({ date: '2025-01-02', type: 'BUY', instrumentId: LCI.id, quantity: 1, amount: 1000, currency: B }),
        tx({ date: '2025-06-01', type: 'SELL', instrumentId: LCI.id, quantity: 1, amount: 1050, currency: B }),
        tx({ date: '2025-03-01', type: 'BUY', instrumentId: CDB2.id, quantity: 1, amount: 1000, currency: B }),
        tx({ date: '2025-03-11', type: 'SELL', instrumentId: CDB2.id, quantity: 1, amount: 1010, currency: B }),
      ]),
      { year: 2025 },
    );
    const cdb = r.rows.find((x) => x.instrumentId === CDB.id)!;
    expect(cdb.holdingDays).toBe(333);
    expect(cdb.irRate).toBe(0.2);
    expect(cdb.expectedIrrf).toBeCloseTo(20, 6);
    expect(r.rows.find((x) => x.instrumentId === LCI.id)!.exempt).toBe(true);
    const short = r.rows.find((x) => x.instrumentId === CDB2.id)!;
    expect(short.iof).toBeCloseTo(6.6, 6);
    expect(short.expectedIrrf).toBeCloseTo(3.4 * 0.225, 6);
    expect(r.totals.rendimentosIsentos).toBeCloseTo(50, 6);
  });
  it('crypto: R$ 35k monthly exemption, 15% GCAP, DARF 4600', () => {
    const txs = [
      tx({ date: '2025-01-10', type: 'BUY', instrumentId: BTC.id, quantity: 1, amount: 200_000, currency: B }),
      tx({ date: '2025-03-10', type: 'SELL', instrumentId: BTC.id, quantity: 0.1, amount: 30_000, currency: B }),
      tx({ date: '2025-04-10', type: 'SELL', instrumentId: BTC.id, quantity: 0.2, amount: 60_000, currency: B }),
    ];
    // round 2 (T22): custody unknown (MANUAL) → tax shown, DARF withheld until confirmed
    const unknown = brazilCryptoReport(br(txs), { year: 2025 });
    expect(unknown.months[1]).toMatchObject({ tax: 3000, darfBlockedUnknownCustody: true });
    expect(unknown.months[1]!.darf).toBeUndefined();
    const r = brazilCryptoReport(br(txs), { year: 2025, cryptoCustody: { [BTC.id]: 'brasil' } });
    expect(r.months[0]).toMatchObject({ month: '2025-03', exempt: true, tax: 0 });
    expect(r.months[1]).toMatchObject({ month: '2025-04', exempt: false, tax: 3000 });
    expect(r.months[1]!.darf).toMatchObject({ code: '4600', dueDate: '2025-05-30' });
    expect(r.positions[0]!.costBrl).toBeCloseTo(140_000, 6);
  });
});

describe('T13 — Bens e Direitos for foreign assets', () => {
  it('per-asset result, income and foreign tax; cash location; CNPJ table', () => {
    const ptax = { buy: () => 5, sell: () => 5 };
    const b = brazilBensDireitos(
      br([
        tx({ date: '2025-01-09', type: 'FX_CONVERSION', amount: 5000, currency: B, toCurrency: 'USD', toAmount: 1000 }),
        tx({ date: '2025-01-10', type: 'BUY', instrumentId: I.AAPL.id, quantity: 10, price: 100, currency: 'USD' }),
        tx({ date: '2025-05-10', type: 'DIVIDEND', instrumentId: I.AAPL.id, amount: 10, taxes: 3, currency: 'USD' }),
        tx({ date: '2025-08-01', type: 'SELL', instrumentId: I.AAPL.id, quantity: 5, price: 120, currency: 'USD' }),
        tx({ date: '2025-08-01', type: 'BUY', instrumentId: I.PETR4.id, quantity: 10, price: 30, currency: B }),
      ]),
      { year: 2025, ptax, cnpjByIssuer: {} },
    );
    const aapl = b.items.find((i) => i.ticker === 'AAPL')!;
    expect(aapl.exterior).toEqual({ lucroPrejuizoBrl: 500, rendimentosBrl: 50, impostoPagoExteriorBrl: 15 });
    expect(aapl.situacaoAtual).toBeCloseTo(2500, 6);
    expect(b.items.find((i) => i.grupo === '06')!.localizacao).toBe('US');
    expect(b.items.find((i) => i.ticker === 'PETR4')!.cnpj).toBe('33.000.167/0001-01');
  });
});

describe('T14 — tax packs', () => {
  it('Colombia: Formulario 210 lines, F160 by country, CSV files', () => {
    const market = createSimpleMarketData({ fx: coFx, prices: {} });
    const pack = colombiaTaxPack(
      co(
        [
          tx({ date: '2023-03-01', type: 'BUY', instrumentId: I.AAPL.id, quantity: 10, price: 150, currency: 'USD' }),
          tx({ date: '2023-03-01', type: 'BUY', instrumentId: I.VOO.id, quantity: 10, price: 350, currency: 'USD' }),
        ],
        market,
      ),
      { year: 2024 },
    );
    expect(Object.keys(pack.files)).toEqual(['colombia-2024-para-contador.csv', 'colombia-2024-formulario-210.csv', 'colombia-2024-formulario-160.csv']);
    expect(pack.formulario210.find((l) => l.concepto === 'Total patrimonio bruto')!.valorCop).toBeCloseTo(5000 * 4800, 4);
    expect(pack.formulario160.lines).toEqual([{ level: 'pais', country: 'US', description: 'Activos en US', valueCop: 5000 * 4800 }]);
    expect(pack.formulario210Meta.status).toBe('needs-verification');
  });
  it('Colombia: itemized F160 above 3,580 UVT', () => {
    const r = buildColombiaTaxReport(co([tx({ date: '2023-03-01', type: 'BUY', instrumentId: I.AAPL.id, quantity: 1000, price: 150, currency: 'USD' })]), {
      year: 2024,
    });
    expect(r.formulario160.lines[0]).toMatchObject({ level: 'activo', country: 'US' });
  });
  it('Brazil: one CSV per report', () => {
    const pack = brazilTaxPack(br([tx({ date: '2025-01-05', type: 'BUY', instrumentId: I.PETR4.id, quantity: 10, price: 30, currency: B })]), { year: 2025 });
    expect(Object.keys(pack.files)).toHaveLength(9);
    expect(pack.files['brasil-2025-bens-e-direitos.csv']).toContain('PETR4');
  });
});

describe('T15 — simulation', () => {
  it('Brazil: selling now breaks the R$ 20k exemption', () => {
    const input = br([
      tx({ date: '2026-01-05', type: 'BUY', instrumentId: I.PETR4.id, quantity: 1000, price: 10, currency: B }),
      tx({ date: '2026-03-05', type: 'SELL', instrumentId: I.PETR4.id, quantity: 500, price: 30, currency: B }),
    ]);
    const s = simulateBrazilSale(input, { instrumentId: I.PETR4.id, quantity: 300, price: 30, date: '2026-03-25' });
    expect(s.headroomBefore).toBe(5000);
    expect(s.exemptBefore).toBe(true);
    expect(s.exemptAfter).toBe(false);
    expect(s.result).toBeCloseTo(6000, 6);
    expect(s.deltaTax).toBeCloseTo(2400, 6);
  });
  it('Colombia: a loss sale has no tax benefit (Art. 153) and lots turn GO after 2 years', () => {
    const market = createSimpleMarketData({ fx: { 'USD/COP': [['2022-01-03', 4000], ['2024-06-01', 3900]] } });
    const input = co([tx({ date: '2022-01-03', type: 'BUY', instrumentId: I.AAPL.id, quantity: 10, price: 170, currency: 'USD' })], market);
    const s = simulateColombiaSale(input, { instrumentId: I.AAPL.id, quantity: 10, price: 150, date: '2024-06-03', currency: 'USD' });
    expect(s.nonDeductibleLossCop).toBeCloseTo(950_000, 4);
    expect(s.deltaGananciaOcasionalTaxCop).toBe(0);
    const m = colombiaLotMilestones(
      co([tx({ date: '2024-01-10', type: 'BUY', instrumentId: I.AAPL.id, quantity: 10, price: 170, currency: 'USD' })], market),
      '2025-01-10',
    );
    expect(m[0]).toMatchObject({ gananciaOcasionalFrom: '2026-01-10', daysRemaining: 365 });
  });
});

describe('T16 — consignaciones > 1,400 UVT', () => {
  it('S-CO5: deposits of 80M COP in 2025 trigger the filing flag', () => {
    const r = buildColombiaTaxReport(
      co([
        tx({ date: '2025-01-02', type: 'DEPOSIT', amount: 80_000_000, currency: 'COP' }),
        tx({ date: '2025-01-03', type: 'WITHDRAWAL', amount: 79_000_000, currency: 'COP' }),
      ]),
      { year: 2025 },
    );
    expect(r.obligacionDeclarar.consignacionesCop).toBe(80_000_000);
    expect(r.obligacionDeclarar.byConsignaciones).toBe(true);
  });
});

describe('T17 — Art. 36-1 limit per company (all share classes)', () => {
  const mk = (q: number) => [
    tx({ date: '2024-01-10', type: 'BUY', instrumentId: BCOLOMBIA.id, quantity: q, price: 30000, currency: 'COP' }),
    tx({ date: '2024-01-10', type: 'BUY', instrumentId: I.PFBCOLOM.id, quantity: q, price: 30000, currency: 'COP' }),
    tx({ date: '2024-06-10', type: 'SELL', instrumentId: BCOLOMBIA.id, quantity: q, price: 35000, currency: 'COP' }),
    tx({ date: '2024-06-10', type: 'SELL', instrumentId: I.PFBCOLOM.id, quantity: q, price: 35000, currency: 'COP' }),
  ];
  it('2,000 + 2,000 of 100,000 = 4% > 3% → taxable; 1,000 + 1,000 = 2% → exempt', () => {
    const out = { 'XBOG:BANCOLOMBIA': 100_000 };
    const r = buildColombiaTaxReport(co(mk(2000)), { year: 2024, outstandingShares: out });
    expect(r.ventas.rows.every((x) => x.classification === 'renta_ordinaria')).toBe(true);
    const r2 = buildColombiaTaxReport(co(mk(1000)), { year: 2024, outstandingShares: out });
    expect(r2.ventas.rows.every((x) => x.classification === 'no_gravada_art_36_1')).toBe(true);
  });
});

describe('T18 — grupamento fractions', () => {
  it('S-BR10: 1:10 on 1,005 shares → 100 shares, fraction flagged and its auction sale accepted', () => {
    const base = [
      tx({ date: '2025-01-02', type: 'BUY', instrumentId: I.ITSA4.id, quantity: 1005, price: 10, currency: B }),
      tx({ date: '2025-02-02', type: 'SPLIT', instrumentId: I.ITSA4.id, ratio: 0.1, currency: B }),
    ];
    const led = runBrazilB3Ledger(br(base));
    expect(led.positions[0]!.quantity).toBeCloseTo(100, 9);
    expect(led.positions[0]!.totalCost).toBeCloseTo(10000, 6);
    expect(led.issues.map((i) => i.code)).toContain('FRACAO_GRUPAMENTO');
    const led2 = runBrazilB3Ledger(br([...base, tx({ date: '2025-03-10', type: 'SELL', instrumentId: I.ITSA4.id, quantity: 0.5, price: 120, currency: B })]));
    expect(led2.trades[0]!.result).toBeCloseTo(10, 6);
    expect(led2.positions[0]!.quantity).toBeCloseTo(100, 9);
  });
});

describe('T19 — US source by issuer/ISIN and estate tax', () => {
  it('ADRs and Irish UCITS ETFs are not US-source', () => {
    const adr = inst({ id: 'XNYS:PBR', symbol: 'PBR', exchange: 'XNYS', currency: 'USD', country: 'BR', assetClass: 'equity', isin: 'US71654V4086' });
    const cspx = inst({ id: 'XLON:CSPX', symbol: 'CSPX', exchange: 'XLON', currency: 'USD', country: 'US', assetClass: 'etf', isin: 'IE00B5BMR087' });
    const aapl = { ...I.AAPL, isin: 'US0378331005' };
    expect(isUsSource(adr)).toBe(false);
    expect(isUsSource(cspx)).toBe(false);
    expect(isUsSource(aapl)).toBe(true);
  });
  it('US estate tax: > US$ 60k of US-situs assets is flagged', () => {
    const market = createSimpleMarketData({ prices: { [I.AAPL.id]: [['2025-01-01', 250]] } });
    const c = checkUsEstateTaxExposure(
      { transactions: [tx({ date: '2024-01-01', type: 'BUY', instrumentId: I.AAPL.id, quantity: 300, price: 150, currency: 'USD' })], instruments: INSTS, market },
      'CO',
      '2025-06-30',
    );
    expect(c.usSitusUsd).toBe(75_000);
    expect(c.exceeds).toBe(true);
    expect(c.treatyCountry).toBe(false);
  });
});

describe('T20 — Colombia realization date, componente inflacionario, GMF', () => {
  const txs = [
    tx({ date: '2024-01-10', type: 'BUY', instrumentId: I.ECOPETROL.id, quantity: 1000, price: 2000, currency: 'COP' }),
    tx({ date: '2025-12-31', type: 'SELL', instrumentId: I.ECOPETROL.id, quantity: 1000, price: 2500, currency: 'COP' }),
  ];
  it('a sale on 31-dec settling T+2 is realized the next year (Art. 27 ET)', () => {
    // round 2 (T20): holidays count — 1-Jan (CO/US) and Reyes moved to 12-Jan don't affect 2-Jan/5-Jan
    expect(settlementDate(I.ECOPETROL, '2025-12-31')).toBe('2026-01-05');
    expect(settlementDate(I.AAPL, '2025-12-31')).toBe('2026-01-02');
    expect(buildColombiaTaxReport(co(txs), { year: 2025 }).ventas.rows).toHaveLength(0);
    const r26 = buildColombiaTaxReport(co(txs), { year: 2026 });
    expect(r26.ventas.rows[0]!.realizationDate).toBe('2026-01-05');
    expect(buildColombiaTaxReport(co(txs), { year: 2025, realization: 'trade' }).ventas.rows).toHaveLength(1);
  });
  it('componente inflacionario when the decree % is configured', () => {
    const r = buildColombiaTaxReport(co([tx({ date: '2025-05-05', type: 'INTEREST', amount: 1_000_000, currency: 'COP' })]), {
      year: 2025,
      config: { ...colombiaConfig(2025), componenteInflacionario: 0.5 },
    });
    expect(r.ingresos.totals.componenteInflacionarioCop).toBe(500_000);
  });
  it('GMF estimate only counts COP withdrawals', () => {
    const r = buildColombiaTaxReport(
      co([
        tx({ date: '2025-01-02', type: 'DEPOSIT', amount: 1000, currency: 'USD' }),
        tx({ date: '2025-07-02', type: 'WITHDRAWAL', amount: 1000, currency: 'USD' }),
      ]),
      { year: 2025 },
    );
    expect(r.gmf.withdrawalsCop).toBe(0);
  });
});

describe('T21 — JCP 2028 flagged; estimated dedo-duro not credited by default', () => {
  it('2027/2028 parameters exist and are marked for verification', () => {
    expect(brazilConfig(2028).jcpRate).toBe(0.175);
    expect(brazilConfig(2028).meta.jcpRate!.status).toBe('needs-verification');
    expect(brazilConfig(2027).year).toBe(2027);
  });
  it('estimated IRRF is shown but not deducted unless creditEstimatedIrrf', () => {
    const txs = [
      tx({ date: '2026-01-05', type: 'BUY', instrumentId: I.VALE3.id, quantity: 1000, price: 55, currency: B }),
      tx({ date: '2026-03-02', type: 'SELL', instrumentId: I.VALE3.id, quantity: 1000, price: 60, currency: B }),
    ];
    const r = brazilMonthlyApuracao(br(txs), { from: '2026-03', to: '2026-03' });
    expect(r.months[0]!.irrf.estimate).toBeCloseTo(3, 6);
    expect(r.months[0]!.irrf.used).toBe(0);
    expect(r.darfs[0]!.amount).toBe(750);
    expect(r.issues.map((i) => i.code)).toContain('IRRF_ESTIMATE_NOT_CREDITED');
    expect(brazilMonthlyApuracao(br(txs), { from: '2026-03', to: '2026-03', creditEstimatedIrrf: true }).darfs[0]!.amount).toBe(747);
  });
});
