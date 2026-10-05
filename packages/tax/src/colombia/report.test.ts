import { describe, expect, it } from 'vitest';
import type { MarketData, Transaction } from '@pm/core';
import { createSimpleMarketData } from '../testing/marketData';
import { ALL_INSTRUMENTS, I, tx } from '../testing/fixtures';
import { buildColombiaTaxReport } from './report';
import { colombiaAccountantCsv } from './csv';
import { colombiaConfig, COLOMBIA_TAX_YEARS } from './config';

const U = 'USD';
const C = 'COP';
const input = (transactions: Transaction[], market: MarketData) => ({ transactions, instruments: ALL_INSTRUMENTS, market });

describe('config', () => {
  it('has the UVT of each year', () => {
    expect(COLOMBIA_TAX_YEARS[2023]!.uvt).toBe(42_412);
    expect(COLOMBIA_TAX_YEARS[2024]!.uvt).toBe(47_065);
    expect(COLOMBIA_TAX_YEARS[2025]!.uvt).toBe(49_799);
    expect(COLOMBIA_TAX_YEARS[2026]!.uvt).toBe(52_374);
    expect(COLOMBIA_TAX_YEARS[2026]!.meta.uvt!.status).toBe('verified');
    expect(COLOMBIA_TAX_YEARS[2026]!.meta.gananciaOcasionalRate!.status).toBe('needs-verification');
  });
  it('rates changed with Ley 2277/2022', () => {
    expect(colombiaConfig(2022).gananciaOcasionalRate).toBe(0.1);
    expect(colombiaConfig(2022).art361MaxShareOfOutstanding).toBe(0.1);
    expect(colombiaConfig(2024).gananciaOcasionalRate).toBe(0.15);
    expect(colombiaConfig(2024).art361MaxShareOfOutstanding).toBe(0.03);
  });
  it('unknown years copy the latest values and flag them', () => {
    const c = colombiaConfig(2030);
    expect(c.year).toBe(2030);
    expect(c.uvt).toBe(52_374);
    expect(Object.values(c.meta).every((m) => m.status === 'needs-verification')).toBe(true);
  });
});

describe('patrimonio al 31-dic con activos en USD', () => {
  const market = createSimpleMarketData({
    prices: { [I.AAPL.id]: [['2024-12-31', 250]] },
    fx: { 'USD/COP': [['2023-03-01', 4800], ['2024-12-31', 4400]] },
  });
  const txs = [
    tx({ date: '2023-03-01', type: 'DEPOSIT', amount: 1500, currency: U }),
    tx({ date: '2023-03-01', type: 'BUY', instrumentId: I.AAPL.id, quantity: 10, price: 150, currency: U }),
  ];

  it('values foreign shares at the TRM of initial recognition (Art. 269 ET) and shows market at TRM Dec 31', () => {
    const r = buildColombiaTaxReport(input(txs, market), { year: 2024 });
    const row = r.patrimonio.rows.find((x) => x.symbol === 'AAPL')!;
    expect(row.fiscalValueCop).toBeCloseTo(7_200_000, 6);
    expect(row.marketValueCop).toBeCloseTo(11_000_000, 6);
    expect(row.trmDec31).toBe(4400);
    expect(row.abroad).toBe(true);
    expect(r.patrimonio.patrimonioBrutoCop).toBeCloseTo(7_200_000, 6);
    expect(r.patrimonio.foreignAssetsCop).toBeCloseTo(7_200_000, 6);
    expect(r.patrimonio.trmDec31.USD).toBe(4400);
  });

  it('year-end option converts the USD cost at the TRM of Dec 31', () => {
    const r = buildColombiaTaxReport(input(txs, market), { year: 2024, foreignValuation: 'year-end' });
    expect(r.patrimonio.patrimonioBrutoCop).toBeCloseTo(6_600_000, 6);
  });

  it('Formulario 160 threshold uses 2,000 UVT of the filing year', () => {
    const r = buildColombiaTaxReport(input(txs, market), { year: 2024 });
    expect(r.formulario160.filingYear).toBe(2025);
    expect(r.formulario160.uvtUsed).toBe(49_799);
    expect(r.formulario160.thresholdCop).toBe(99_598_000);
    expect(r.formulario160.required).toBe(false);
  });

  it('Formulario 160 required (and itemized) above the thresholds', () => {
    const big = [tx({ date: '2023-03-01', type: 'BUY', instrumentId: I.AAPL.id, quantity: 1000, price: 150, currency: U })];
    const r = buildColombiaTaxReport(input(big, market), { year: 2024 });
    expect(r.patrimonio.foreignAssetsCop).toBeCloseTo(720_000_000, 4);
    expect(r.formulario160.required).toBe(true);
    expect(r.formulario160.itemizedRequired).toBe(true); // > 3,580 x 49,799 = 178,280,420
    expect(r.issues.map((i) => i.code)).toContain('FOREIGN_CASH_NOT_RECORDED');
    expect(r.obligacionDeclarar.byPatrimonio).toBe(true); // > 4,500 x 47,065
  });

  it('for 2026 the filing-year UVT is unknown and the 2026 UVT is used as estimate', () => {
    const r = buildColombiaTaxReport(input(txs, market), { year: 2026 });
    expect(r.formulario160.uvtIsEstimate).toBe(true);
    expect(r.formulario160.uvtUsed).toBe(52_374);
    expect(r.issues.map((i) => i.code)).toContain('PARAMS_NEED_VERIFICATION');
  });
});

describe('venta de acciones', () => {
  const market = createSimpleMarketData({
    fx: { 'USD/COP': [['2022-01-03', 4000], ['2024-01-02', 3900]] },
  });

  it('Art. 36-1: BVC shares are non-taxable when below 3% of outstanding shares', () => {
    const txs = [
      tx({ date: '2024-01-10', type: 'BUY', instrumentId: I.ECOPETROL.id, quantity: 1000, price: 2000, currency: C }),
      tx({ date: '2024-06-10', type: 'SELL', instrumentId: I.ECOPETROL.id, quantity: 1000, price: 2500, currency: C }),
    ];
    const r = buildColombiaTaxReport(input(txs, market), { year: 2024 });
    expect(r.ventas.rows[0]!.classification).toBe('no_gravada_art_36_1');
    expect(r.ventas.totals.noGravadaArt361.utilidadCop).toBe(500_000);
    expect(r.ventas.totals.gananciaOcasional.impuestoEstimadoCop).toBe(0);
    expect(r.issues.map((i) => i.code)).toContain('ART_36_1_ASSUMED');

    const r2 = buildColombiaTaxReport(input(txs, market), { year: 2024, outstandingShares: { [I.ECOPETROL.id]: 10_000 } });
    expect(r2.ventas.rows[0]!.classification).toBe('renta_ordinaria');
    expect(r2.ventas.totals.rentaOrdinaria.rentaLiquidaCop).toBe(500_000);
    expect(r2.issues.map((i) => i.code)).toContain('ART_36_1_LIMIT_EXCEEDED');
  });

  it('Art. 36-1 limit was 10% before Ley 2277 (2022)', () => {
    const txs = [
      tx({ date: '2022-01-10', type: 'BUY', instrumentId: I.ECOPETROL.id, quantity: 1000, price: 2000, currency: C }),
      tx({ date: '2022-06-10', type: 'SELL', instrumentId: I.ECOPETROL.id, quantity: 1000, price: 2500, currency: C }),
    ];
    const r = buildColombiaTaxReport(input(txs, market), { year: 2022, outstandingShares: { [I.ECOPETROL.id]: 10_000 } });
    expect(r.ventas.rows[0]!.classification).toBe('no_gravada_art_36_1');
  });

  it('2-year rule: >= 2 years is ganancia ocasional (15%), one day less is renta ordinaria', () => {
    const txs = [
      tx({ date: '2022-01-03', type: 'BUY', instrumentId: I.AAPL.id, quantity: 10, price: 170, currency: U }),
      tx({ date: '2024-01-02', type: 'SELL', instrumentId: I.AAPL.id, quantity: 5, price: 180, currency: U }),
      tx({ date: '2024-01-03', type: 'SELL', instrumentId: I.AAPL.id, quantity: 5, price: 180, currency: U }),
    ];
    const r = buildColombiaTaxReport(input(txs, market), { year: 2024 });
    const [a, b] = r.ventas.rows;
    expect(a!.classification).toBe('renta_ordinaria');
    expect(b!.classification).toBe('ganancia_ocasional');
    // proceeds 900 USD x 3,900 = 3,510,000; cost 850 USD x 4,000 = 3,400,000
    expect(b!.proceedsCop).toBeCloseTo(3_510_000, 6);
    expect(b!.costCop).toBeCloseTo(3_400_000, 6);
    const go = r.ventas.totals.gananciaOcasional;
    expect(go.gananciaGravableCop).toBeCloseTo(110_000, 6);
    expect(go.rate).toBe(0.15);
    expect(go.impuestoEstimadoCop).toBeCloseTo(16_500, 6);
    expect(r.ventas.totals.rentaOrdinaria.rentaLiquidaCop).toBeCloseTo(110_000, 6);
  });

  it('FIFO lots: a sale spanning two lots splits the holding period', () => {
    const txs = [
      tx({ date: '2022-01-03', type: 'BUY', instrumentId: I.PFBCOLOM.id, quantity: 100, price: 30000, currency: C }),
      tx({ date: '2023-12-01', type: 'BUY', instrumentId: I.PFBCOLOM.id, quantity: 100, price: 32000, currency: C }),
      tx({ date: '2024-03-01', type: 'SELL', instrumentId: I.PFBCOLOM.id, quantity: 150, price: 35000, fees: 15000, currency: C }),
    ];
    const r = buildColombiaTaxReport(input(txs, market), { year: 2024, outstandingShares: { [I.PFBCOLOM.id]: 1 } });
    expect(r.ventas.rows).toHaveLength(2);
    expect(r.ventas.rows[0]!.classification).toBe('ganancia_ocasional');
    expect(r.ventas.rows[0]!.quantity).toBe(100);
    expect(r.ventas.rows[0]!.proceedsCop).toBeCloseTo((150 * 35000 - 15000) * (100 / 150), 6);
    expect(r.ventas.rows[1]!.classification).toBe('renta_ordinaria');
    expect(r.patrimonio.rows.find((x) => x.symbol === 'PFBCOLOM')!.fiscalValueCop).toBe(50 * 32000);
  });
});

describe('dividendos e intereses', () => {
  const market = createSimpleMarketData({ fx: { 'USD/COP': [['2024-01-02', 3900]] } });
  const txs = [
    tx({ date: '2024-04-20', type: 'DIVIDEND', instrumentId: I.ECOPETROL.id, amount: 300_000, currency: C }),
    tx({ date: '2024-05-16', type: 'DIVIDEND', instrumentId: I.AAPL.id, amount: 100, taxes: 30, currency: U }),
    tx({ date: '2024-06-30', type: 'INTEREST', amount: 10, currency: U }),
  ];

  it('foreign dividend with US withholding as Art. 254 credit capped by the marginal rate', () => {
    const r = buildColombiaTaxReport(input(txs, market), { year: 2024, marginalRate: 0.28 });
    const ext = r.ingresos.dividends.find((d) => d.source === 'exterior')!;
    expect(ext.grossCop).toBeCloseTo(390_000, 6);
    expect(ext.withheldCop).toBeCloseTo(117_000, 6);
    expect(ext.foreignTaxCreditCapCop).toBeCloseTo(109_200, 6);
    expect(r.ingresos.totals.nationalDividendsCop).toBe(300_000);
    expect(r.ingresos.totals.foreignDividendsCop).toBeCloseTo(390_000, 6);
    expect(r.ingresos.totals.foreignDividendCreditCapCop).toBeCloseTo(109_200, 6);
    expect(r.ingresos.interest[0]!.source).toBe('exterior');
    expect(r.ingresos.interest[0]!.grossCop).toBeCloseTo(39_000, 6);
  });

  it('without marginal rate the credit cap is left to the accountant', () => {
    const r = buildColombiaTaxReport(input(txs, market), { year: 2024 });
    expect(r.ingresos.totals.foreignDividendCreditCapCop).toBeUndefined();
    expect(r.ingresos.totals.foreignDividendTaxPaidCop).toBeCloseTo(117_000, 6);
  });
});

describe('diferencia en cambio y GMF', () => {
  const market = createSimpleMarketData({
    fx: { 'USD/COP': [['2024-02-01', 4000], ['2024-06-03', 4200], ['2024-07-01', 4300], ['2024-12-31', 4400]] },
  });
  const txs = [
    tx({ date: '2024-02-01', type: 'DEPOSIT', amount: 1000, currency: U }),
    tx({ date: '2024-06-03', type: 'FX_CONVERSION', amount: 500, currency: U, toCurrency: C, toAmount: 2_100_000 }),
    tx({ date: '2024-07-01', type: 'BUY', instrumentId: I.AAPL.id, quantity: 2, price: 200, currency: U }),
    tx({ date: '2024-08-01', type: 'WITHDRAWAL', amount: 2_000_000, currency: C }),
  ];

  it('realizes FX on conversion and on purchases paid with USD', () => {
    const r = buildColombiaTaxReport(input(txs, market), { year: 2024 });
    const fx = r.diferenciaEnCambio;
    expect(fx.rows).toHaveLength(2);
    expect(fx.rows[0]!.gainCop).toBeCloseTo(100_000, 6); // 2,100,000 - 500 x 4,000
    expect(fx.rows[1]!.gainCop).toBeCloseTo(120_000, 6); // 400 x (4,300 - 4,000)
    expect(fx.netCop).toBeCloseTo(220_000, 6);
    const cash = r.patrimonio.rows.find((x) => x.kind === 'efectivo' && x.currency === U)!;
    expect(cash.quantity).toBeCloseTo(100, 8);
    expect(cash.fiscalValueCop).toBeCloseTo(400_000, 6);
    expect(cash.marketValueCop).toBeCloseTo(440_000, 6);
    const cop = r.patrimonio.rows.find((x) => x.kind === 'efectivo' && x.currency === C)!;
    expect(cop.fiscalValueCop).toBeCloseTo(100_000, 6);
    expect(r.patrimonio.rows.find((x) => x.symbol === 'AAPL')!.fiscalValueCop).toBeCloseTo(1_720_000, 6);
  });

  it('estimates GMF 4x1000 on withdrawals (informational)', () => {
    const r = buildColombiaTaxReport(input(txs, market), { year: 2024 });
    expect(r.gmf.withdrawalsCop).toBe(2_000_000);
    expect(r.gmf.estimatedGmfCop).toBeCloseTo(8_000, 8);
    expect(r.gmf.exemptMonthlyCop).toBe(350 * 47_065);
  });

  it('reports missing TRM as an error', () => {
    const r = buildColombiaTaxReport(input(txs, createSimpleMarketData({})), { year: 2024 });
    expect(r.issues.some((i) => i.code === 'MISSING_TRM' && i.level === 'error')).toBe(true);
  });
});

describe('CSV para tu contador', () => {
  it('contains the key sections with ; separator and decimal comma', () => {
    const market = createSimpleMarketData({ fx: { 'USD/COP': [['2022-01-03', 4000], ['2024-01-02', 3900]] } });
    const r = buildColombiaTaxReport(
      input(
        [
          tx({ date: '2022-01-03', type: 'BUY', instrumentId: I.AAPL.id, quantity: 10, price: 170, currency: U }),
          tx({ date: '2024-01-03', type: 'SELL', instrumentId: I.AAPL.id, quantity: 5, price: 180, currency: U }),
          tx({ date: '2024-05-16', type: 'DIVIDEND', instrumentId: I.AAPL.id, amount: 100, taxes: 30, currency: U }),
        ],
        market,
      ),
      { year: 2024 },
    );
    const csv = colombiaAccountantCsv(r);
    expect(csv.startsWith('﻿')).toBe(true);
    const lines = csv.slice(1).trim().split('\r\n');
    expect(lines[0]).toBe('seccion;concepto;detalle;fecha;moneda_origen;valor_origen;trm;valor_cop;referencia_legal;nota');
    const sections = new Set(lines.slice(1).map((l) => l.split(';')[0]));
    for (const s of ['PATRIMONIO', 'FORMULARIO_160', 'INGRESOS', 'VENTAS', 'GANANCIA_OCASIONAL', 'DIFERENCIA_EN_CAMBIO', 'GMF', 'SUPUESTO']) {
      expect(sections.has(s)).toBe(true);
    }
    const go = lines.find((l) => l.startsWith('GANANCIA_OCASIONAL;Ganancia ocasional gravable'))!;
    expect(go.split(';')[7]).toBe('110000,00');
  });
});
