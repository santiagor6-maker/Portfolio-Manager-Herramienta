/**
 * Regression tests for the round-2 review (reviews/tax-r2.md): T12, T14, T20 (persisting) and
 * T22-T37. Scenarios R1..R11 and C1..C8 reproduce the reviewer's r2-*.ts scripts.
 */
import { describe, expect, it } from 'vitest';
import type { Instrument, Transaction } from '@pm/core';
import { ALL_INSTRUMENTS, I, tx } from './testing/fixtures';
import { createSimpleMarketData } from './testing/marketData';
import { parseLocaleNumber, snapRatio, transferBasisOf } from './common/basis';
import { colombiaHolidays, thirdFriday, usMarketHolidays } from './common/dates';
import { parseOfficialDocCsv } from './common/reconcile';
import { buildColombiaTaxReport } from './colombia/report';
import { colombiaTaxPack, formulario210Lines } from './colombia/taxPack';
import { reconcileColombia } from './colombia/reconcile';
import { brazilMonthlyApuracao } from './brazil/apuracao';
import { brazilProventosReport } from './brazil/proventos';
import { brazilForeignAnnualReport } from './brazil/exterior';
import { brazilBensDireitos } from './brazil/bensDireitos';
import { runBrazilB3Ledger, b3OptionExpiry } from './brazil/ledger';
import { classifyForBrazil, cryptoCustodyOf } from './brazil/classify';
import { brazilCryptoReport } from './brazil/crypto';
import { darfLateCharges } from './brazil/darf';
import { brazilIrpfmEstimate, irpfmRate } from './brazil/irpfm';
import { brazilComeCotasReport } from './brazil/comeCotas';
import { brazilTaxPack } from './brazil/taxPack';
import { informeFromRows, reconcileBrazil } from './brazil/reconcile';
import { reconcileUs1042S } from './us/withholding';

const mk = (id: string, assetClass: Instrument['assetClass'], name: string, country = 'BR', currency = 'BRL', isin?: string): Instrument => {
  const [exchange, symbol] = id.split(':') as [string, string];
  return { id, symbol, name, exchange, currency, country, assetClass, isin };
};
const OPT_A = mk('BVMF:PETRA350', 'other', 'PETR call jan');
const OPT_B = mk('BVMF:PETRB350', 'other', 'PETR call fev');
const OPT_C = mk('BVMF:PETRC300', 'other', 'PETR call mar');
const OPT_D = mk('BVMF:PETRD280', 'other', 'PETR call abr');
const OPT_EQ = mk('BVMF:PETRB420', 'equity', 'PETR call (importer typed equity)');
const WIN = mk('BVMF:WINV26', 'other', 'Mini Ibovespa out/26');
const ETH_BINANCE = mk('BINANCE:ETH', 'crypto', 'Ethereum (Binance)', 'KY', 'USD');
const BTC_MB = mk('MERCADOBITCOIN:BTC', 'crypto', 'Bitcoin (Mercado Bitcoin)');
const UST = mk('OTC:UST2030', 'bond', 'US Treasury 2030', 'US', 'USD');
const FUND = mk('MANUAL:FUNDOXP', 'fund', 'Fundo Multimercado XP');
const ITUB4 = mk('BVMF:ITUB4', 'equity', 'Itaú PN');
const PETR3 = mk('BVMF:PETR3', 'equity', 'Petrobras ON');
const INSTS = [...ALL_INSTRUMENTS, OPT_A, OPT_B, OPT_C, OPT_D, OPT_EQ, WIN, ETH_BINANCE, BTC_MB, UST, FUND, ITUB4, PETR3];
const brMarket = createSimpleMarketData({ fx: { 'USD/BRL': [['2015-01-01', 5]] } });
const br = (transactions: Transaction[], market = brMarket) => ({ transactions, instruments: INSTS, market });
const coFx = { 'USD/COP': [['2015-01-01', 3000], ['2019-03-15', 3100], ['2023-01-01', 4800], ['2024-06-01', 4000], ['2025-06-01', 4200], ['2025-12-31', 3900]] as [string, number][] };
const co = (transactions: Transaction[], prices: Record<string, [string, number][]> = {}) => ({
  transactions,
  instruments: INSTS,
  market: createSimpleMarketData({ fx: coFx, prices }),
});
const B = 'BRL';

describe('T22 (alta) — crypto custodied abroad follows Lei 14.754, never DARF 4600', () => {
  const txs = [
    tx({ date: '2025-01-10', type: 'BUY', instrumentId: ETH_BINANCE.id, quantity: 20, price: 3000, currency: 'USD' }),
    tx({ date: '2026-03-10', type: 'SELL', instrumentId: ETH_BINANCE.id, quantity: 20, price: 4000, currency: 'USD' }),
  ];
  it('R10: Binance → no monthly GCAP, annual 15% in the foreign report', () => {
    expect(cryptoCustodyOf(ETH_BINANCE)).toBe('exterior');
    expect(classifyForBrazil(ETH_BINANCE)).toBe('FOREIGN');
    const c = brazilCryptoReport(br(txs), { year: 2026 });
    expect(c.months).toEqual([]);
    expect(c.issues.map((i) => i.code)).toContain('CRYPTO_ABROAD');
    const f = brazilForeignAnnualReport(br(txs), { year: 2026 });
    expect(f.sales).toHaveLength(1);
    expect(f.totals.taxDueBrl).toBeCloseTo(15_000, 6);
  });
  it('Bens e Direitos lists the foreign crypto under group 08 with its country', () => {
    const b = brazilBensDireitos(br([txs[0]!]), { year: 2025 });
    // round 4 (T50): location of the custodian; Binance has several entities → blank + warning
    expect(b.items.find((i) => i.ticker === 'ETH')).toMatchObject({ grupo: '08', codigo: '02', localizacao: '', situacaoAtual: 300_000 });
    expect(b.issues.map((i) => i.code)).toContain('CRYPTO_LOCATION_UNKNOWN');
  });
  it('Brazilian exchange → GCAP with DARF; explicit override wins', () => {
    expect(cryptoCustodyOf(BTC_MB)).toBe('brasil');
    const r = brazilCryptoReport(
      br([
        tx({ date: '2025-01-10', type: 'BUY', instrumentId: BTC_MB.id, quantity: 1, amount: 200_000, currency: B }),
        tx({ date: '2025-04-10', type: 'SELL', instrumentId: BTC_MB.id, quantity: 0.2, amount: 60_000, currency: B }),
      ]),
      { year: 2025 },
    );
    expect(r.months[0]!.darf?.code).toBe('4600');
    expect(classifyForBrazil(ETH_BINANCE, undefined, { [ETH_BINANCE.id]: 'brasil' })).toBe('CRYPTO');
  });
});

describe('T23 — short sale counts toward the R$ 20k of the month sold', () => {
  it('r2-short20k: R$ 60k short + R$ 15k regular sale → not exempt, tax R$ 450', () => {
    const r = brazilMonthlyApuracao(
      br([
        tx({ date: '2026-01-05', type: 'BUY', instrumentId: I.PETR4.id, quantity: 500, price: 24, currency: B }),
        tx({ date: '2026-03-02', type: 'SELL', instrumentId: I.VALE3.id, quantity: 1000, price: 60, currency: B }),
        tx({ date: '2026-03-10', type: 'SELL', instrumentId: I.PETR4.id, quantity: 500, price: 30, currency: B }),
      ]),
      { from: '2026-03', to: '2026-03' },
    );
    const m = r.months[0]!;
    expect(m.salesAcoesSwing).toBe(75_000);
    expect(m.exempt).toBe(false);
    expect(m.taxGross).toBeCloseTo(450, 6);
  });
  it('R2: the cover month does not count the sale again', () => {
    const r = brazilMonthlyApuracao(
      br([
        tx({ date: '2025-12-15', type: 'SELL', instrumentId: I.VALE3.id, quantity: 1000, price: 60, currency: B }),
        tx({ date: '2026-01-20', type: 'BUY', instrumentId: I.VALE3.id, quantity: 1000, price: 50, currency: B }),
      ]),
      { from: '2025-12', to: '2026-01' },
    );
    expect(r.months[0]!.salesAcoesSwing).toBe(60_000);
    expect(r.months[1]!.salesAcoesSwing).toBe(0);
    expect(r.months[1]!.taxGross).toBeCloseTo(1500, 6);
  });
});

describe('T24 — option expiry and exercise', () => {
  it('expiry from the series letter: third Friday', () => {
    expect(thirdFriday(2026, 2)).toBe('2026-02-20');
    expect(b3OptionExpiry('PETRB350', '2026-02-02')).toBe('2026-02-20');
    expect(b3OptionExpiry('PETRA350', '2026-02-02')).toBe('2027-01-15');
    expect(b3OptionExpiry('PETRM300', '2026-02-02')).toBe('2027-01-15'); // put series M = January
    expect(b3OptionExpiry('PETRN300', '2026-02-02')).toBe('2026-02-20'); // put series N = February
  });
  it('written option expiring worthless: premium taxed at expiry (15%)', () => {
    const r = brazilMonthlyApuracao(br([tx({ date: '2026-02-02', type: 'SELL', instrumentId: OPT_B.id, quantity: 1000, price: 1, currency: B })]), {
      from: '2026-02',
      to: '2026-04',
    });
    const feb = r.months[0]!;
    expect(feb.results.opcoes).toBeCloseTo(1000, 6);
    expect(feb.taxGross).toBeCloseTo(150, 6);
    expect(r.openShorts).toEqual([]);
    expect(r.issues.map((i) => i.code)).toContain('OPCAO_VENCIDA');
  });
  it('R3: series A sold in February is still open (expires Jan/2027) → info, no error', () => {
    const r = brazilMonthlyApuracao(br([tx({ date: '2026-02-02', type: 'SELL', instrumentId: OPT_A.id, quantity: 1000, price: 1, currency: B })]), {
      from: '2026-02',
      to: '2026-04',
    });
    expect(r.issues.some((i) => i.level === 'error')).toBe(false);
    expect(r.issues.map((i) => i.code)).toContain('OPCAO_LANCADA_EM_ABERTO');
  });
  it('bought option expiring worthless: premium is a loss', () => {
    const r = brazilMonthlyApuracao(br([tx({ date: '2026-02-10', type: 'BUY', instrumentId: OPT_C.id, quantity: 1000, price: 0.5, currency: B })]), {
      from: '2026-03',
      to: '2026-03',
    });
    expect(r.months[0]!.results.opcoes).toBeCloseTo(-500, 6);
    expect(r.lossesAtEnd.comum).toBeCloseTo(500, 6);
  });
  it('exercise of a bought call: premium added to the cost of the shares', () => {
    const led = runBrazilB3Ledger(
      br([
        tx({ date: '2026-03-02', type: 'BUY', instrumentId: OPT_D.id, quantity: 100, price: 2, currency: B }),
        tx({ date: '2026-04-17', type: 'TRANSFER_OUT', instrumentId: OPT_D.id, quantity: 100, currency: B, note: 'exercício' }),
        tx({ date: '2026-04-17', type: 'BUY', instrumentId: I.PETR4.id, quantity: 100, price: 28, currency: B }),
      ]),
    );
    const petr = led.positions.find((p) => p.symbol === 'PETR4')!;
    expect(petr.totalCost).toBeCloseTo(3000, 6);
    expect(led.positions.find((p) => p.symbol === 'PETRD280')).toBeUndefined();
    expect(led.trades.filter((t) => t.expired)).toHaveLength(0);
  });
  it('assignment of a written call: premium added to the sale value of the shares', () => {
    const led = runBrazilB3Ledger(
      br([
        tx({ date: '2026-01-05', type: 'BUY', instrumentId: I.PETR4.id, quantity: 100, price: 25, currency: B }),
        tx({ date: '2026-03-02', type: 'SELL', instrumentId: OPT_D.id, quantity: 100, price: 1, currency: B }),
        tx({ date: '2026-04-17', type: 'TRANSFER_IN', instrumentId: OPT_D.id, quantity: 100, currency: B, note: 'exercício (atribuição)' }),
        tx({ date: '2026-04-17', type: 'SELL', instrumentId: I.PETR4.id, quantity: 100, price: 28, currency: B }),
      ]),
    );
    const sale = led.trades.find((t) => t.symbol === 'PETR4')!;
    expect(sale.netProceeds).toBeCloseTo(2900, 6);
    expect(sale.result).toBeCloseTo(400, 6);
    expect(led.openShorts).toEqual([]);
  });
});

describe('T25 — option tickers win over assetClass', () => {
  it('R4: PETRB420 typed as equity is an option: taxed 15% with no exemption', () => {
    expect(classifyForBrazil(OPT_EQ)).toBe('OPCAO');
    const r = brazilMonthlyApuracao(
      br([
        tx({ date: '2026-02-02', type: 'BUY', instrumentId: OPT_EQ.id, quantity: 10000, price: 0.5, currency: B }),
        tx({ date: '2026-02-10', type: 'SELL', instrumentId: OPT_EQ.id, quantity: 10000, price: 1.5, currency: B }),
      ]),
      { from: '2026-02', to: '2026-02' },
    );
    expect(r.months[0]!.taxGross).toBeCloseTo(1500, 6);
    expect(classifyForBrazil(I.PETR4)).toBe('ACAO');
  });
});

describe('T26 — DARF payments must match the receita code', () => {
  it('R7: a DARF 4600 payment does not settle a 6015 DARF', () => {
    const r = brazilMonthlyApuracao(
      br([
        tx({ date: '2026-01-05', type: 'BUY', instrumentId: I.PETR4.id, quantity: 2000, price: 30, currency: B }),
        tx({ date: '2026-03-10', type: 'SELL', instrumentId: I.PETR4.id, quantity: 2000, price: 35, currency: B }),
        tx({ date: '2026-04-20', type: 'TAX', amount: 1500, currency: B, note: 'DARF 4600 cripto 2026-03' }),
      ]),
      { year: 2026, asOf: '2026-10-06' },
    );
    expect(r.darfs[0]!.status).toBe('vencida');
    const ok = brazilMonthlyApuracao(
      br([
        tx({ date: '2026-01-05', type: 'BUY', instrumentId: I.PETR4.id, quantity: 2000, price: 30, currency: B }),
        tx({ date: '2026-03-10', type: 'SELL', instrumentId: I.PETR4.id, quantity: 2000, price: 35, currency: B }),
        tx({ date: '2026-04-20', type: 'TAX', amount: 1500, currency: B, note: 'DARF 6015 2026-03' }),
      ]),
      { year: 2026, asOf: '2026-10-06' },
    );
    expect(ok.darfs[0]!.status).toBe('paga');
  });
});

describe('T27 — Art. 153 only for shares (and ETFs by default)', () => {
  it('C3: a bond loss offsets a share gain in renta ordinaria', () => {
    const r = buildColombiaTaxReport(
      co([
        tx({ date: '2024-06-03', type: 'BUY', instrumentId: UST.id, quantity: 100, price: 1000, currency: 'USD' }),
        tx({ date: '2024-06-03', type: 'BUY', instrumentId: I.AAPL.id, quantity: 100, price: 100, currency: 'USD' }),
        tx({ date: '2025-06-02', type: 'SELL', instrumentId: UST.id, quantity: 100, price: 900, currency: 'USD' }),
        tx({ date: '2025-06-02', type: 'SELL', instrumentId: I.AAPL.id, quantity: 100, price: 200, currency: 'USD' }),
      ]),
      { year: 2025 },
    );
    expect(r.ventas.totals.rentaOrdinaria.rentaLiquidaCop).toBeCloseTo(22_000_000, 2);
    expect(r.ventas.totals.rentaOrdinaria.perdidaNoDeducibleCop).toBe(0);
    const strict = buildColombiaTaxReport(
      co([
        tx({ date: '2024-06-03', type: 'BUY', instrumentId: UST.id, quantity: 100, price: 1000, currency: 'USD' }),
        tx({ date: '2025-06-02', type: 'SELL', instrumentId: UST.id, quantity: 100, price: 900, currency: 'USD' }),
      ]),
      { year: 2025, art153AssetClasses: ['equity', 'etf', 'bond'] },
    );
    expect(strict.ventas.totals.rentaOrdinaria.perdidaNoDeducibleCop).toBeGreaterThan(0);
  });
});

describe('T28 — Formulario 210: Art. 36-1 sales in ingresos brutos, costos and INCRNGO', () => {
  it('C2: < 2 years → rentas no laborales 250M / INCRNGO 50M / costos 200M', () => {
    const p = colombiaTaxPack(
      co([
        tx({ date: '2024-01-10', type: 'BUY', instrumentId: I.ECOPETROL.id, quantity: 100_000, price: 2000, currency: 'COP' }),
        tx({ date: '2025-05-10', type: 'SELL', instrumentId: I.ECOPETROL.id, quantity: 100_000, price: 2500, currency: 'COP' }),
      ]),
      { year: 2025 },
    );
    const nl = p.formulario210.filter((l) => l.seccion === 'Rentas no laborales').map((l) => l.valorCop);
    expect(nl).toEqual([250_000_000, 50_000_000, 200_000_000]);
  });
  it('>= 2 years → ganancias ocasionales: ingresos, costos and no gravadas (casillas 112-114)', () => {
    const r = buildColombiaTaxReport(
      co([
        tx({ date: '2022-01-10', type: 'BUY', instrumentId: I.ECOPETROL.id, quantity: 100_000, price: 2000, currency: 'COP' }),
        tx({ date: '2025-05-10', type: 'SELL', instrumentId: I.ECOPETROL.id, quantity: 100_000, price: 2500, currency: 'COP' }),
      ]),
      { year: 2025 },
    );
    const go = formulario210Lines(r).filter((l) => l.seccion === 'Ganancias ocasionales');
    expect(go.map((l) => [l.casilla, l.valorCop])).toEqual([
      [112, 250_000_000],
      [113, 200_000_000],
      [114, 50_000_000],
      [115, 0],
    ]);
  });
});

describe('T29 — transfer-cost parser', () => {
  it('R5: locale-aware numbers; free text is only a proposal; percentages rejected', () => {
    expect(parseLocaleNumber('1,000.50')).toBe(1000.5);
    expect(parseLocaleNumber('1.000,50')).toBe(1000.5);
    expect(parseLocaleNumber('50,25')).toBe(50.25);
    expect(parseLocaleNumber('1,2,3')).toBeUndefined();
    const t = (note: string) => transferBasisOf(tx({ date: '2025-01-01', type: 'TRANSFER_IN', currency: 'USD', note }));
    expect(t('[cost: 2019-03-15 @ 1,000.50]')).toEqual({ openDate: '2019-03-15', unitCost: 1000.5, fxRate: undefined });
    expect(t('bought in 2019 at 1,000.50')).toMatchObject({ unitCost: 1000.5, proposal: true });
    expect(t('Compra en 2024 a 30 por ciento')).toBeUndefined();
  });
});

describe('T30 — rounded grupamento ratios', () => {
  it('R1: 300 shares with ratio 0.3333 → 100 shares, no fraction', () => {
    expect(snapRatio(0.3333)).toBeCloseTo(1 / 3, 12);
    expect(snapRatio(0.1)).toBe(0.1);
    const l = runBrazilB3Ledger(
      br([
        tx({ date: '2025-01-02', type: 'BUY', instrumentId: I.ITSA4.id, quantity: 300, price: 10, currency: B }),
        tx({ date: '2025-02-02', type: 'SPLIT', instrumentId: I.ITSA4.id, ratio: 0.3333, currency: B }),
      ]),
    );
    expect(l.positions[0]).toMatchObject({ quantity: 100, totalCost: 3000 });
    expect(l.issues).toEqual([]);
  });
});

describe('T31 — JCP credited in 2025 and paid in 2026 keeps 15%', () => {
  it('R8: note "JCP declarado em 12/2025"', () => {
    const r = brazilProventosReport(
      br([tx({ date: '2026-03-15', type: 'DIVIDEND', instrumentId: ITUB4.id, amount: 1000, taxes: 150, currency: B, note: 'JCP declarado em 12/2025' })]),
      { year: 2026 },
    );
    expect(r.rows[0]!.expectedIrrf).toBeCloseTo(150, 6);
    expect(r.issues).toEqual([]);
    const r2 = brazilProventosReport(br([tx({ id: 'jcp1', date: '2026-03-15', type: 'DIVIDEND', instrumentId: ITUB4.id, amount: 1000, taxes: 150, currency: B, note: 'JCP' })]), {
      year: 2026,
      jcpCreditDates: { jcp1: '2025-12-20' },
    });
    expect(r2.rows[0]!.expectedIrrf).toBeCloseTo(150, 6);
  });
});

describe('T32 — IRPFM (Lei 15.270/2025)', () => {
  it('rate grows linearly from 0% at R$ 600k to 10% at R$ 1.2M', () => {
    const p = { lowerLimit: 600_000, upperLimit: 1_200_000, maxRate: 0.1 };
    expect(irpfmRate(600_000, p)).toBe(0);
    expect(irpfmRate(900_000, p)).toBeCloseTo(0.05, 12);
    expect(irpfmRate(2_000_000, p)).toBe(0.1);
  });
  it('estimate with dividends from the portfolio and other income, minus taxes already paid', () => {
    const proventos = brazilProventosReport(br([tx({ date: '2026-03-20', type: 'DIVIDEND', instrumentId: I.VALE3.id, amount: 1_000_000, taxes: 100_000, currency: B })]), {
      year: 2026,
    });
    const e = brazilIrpfmEstimate({ year: 2026, proventos, otherIncome: 500_000, otherTaxPaid: 30_000 });
    expect(e.base).toBe(1_500_000);
    expect(e.rate).toBe(0.1);
    expect(e.irpfmGross).toBe(150_000);
    expect(e.creditsTotal).toBe(130_000);
    expect(e.irpfmDue).toBe(20_000);
    expect(brazilIrpfmEstimate({ year: 2025, otherIncome: 2_000_000 }).applicable).toBe(false);
  });
});

describe('T33 — brazilTaxPack forwards every option', () => {
  it('preLei15270Dividends and cryptoCustody reach the reports', () => {
    const d = tx({ date: '2026-03-20', type: 'DIVIDEND', instrumentId: I.VALE3.id, amount: 80_000, currency: B });
    const p = brazilTaxPack(br([d]), { year: 2026, preLei15270Dividends: [d.id] });
    expect(p.proventos.rows[0]!.expectedIrrf).toBe(0);
    expect(Object.keys(p.files)).toHaveLength(9);
  });
});

describe('T34 — CNPJ: larger table and import from the informe', () => {
  it('ITSA4 from the table; FII CNPJ learnt from the informe', () => {
    const txs = [
      tx({ date: '2025-03-01', type: 'BUY', instrumentId: I.ITSA4.id, quantity: 10, price: 10, currency: B }),
      tx({ date: '2025-03-01', type: 'BUY', instrumentId: I.HGLG11.id, quantity: 10, price: 160, currency: B }),
    ];
    const pack = brazilTaxPack(br(txs), { year: 2025 });
    expect(pack.bensDireitos.items.find((i) => i.ticker === 'ITSA4')!.cnpj).toBe('61.532.644/0001-15');
    const rec = reconcileBrazil(pack, {
      informes: [{ fonte: { cnpj: '02.332.886/0001-04', nome: 'XP' }, ano: 2025, itens: [], posicoes: [{ ticker: 'HGLG11', quantidade: 10, cnpjEmpresa: '11.728.688/0001-47' }] }],
    });
    expect(rec.cnpjByIssuer.HGLG).toBe('11.728.688/0001-47');
    const b = brazilBensDireitos(br(txs), { year: 2025, cnpjByIssuer: rec.cnpjByIssuer });
    expect(b.items.find((i) => i.ticker === 'HGLG11')!.cnpj).toBe('');
    const b2 = brazilBensDireitos(br(txs), { year: 2025, cnpjByIssuer: { [I.HGLG11.id]: '11.728.688/0001-47' } });
    expect(b2.items.find((i) => i.ticker === 'HGLG11')!.cnpj).toBe('11.728.688/0001-47');
  });
});

describe('T35 — built-in Selic table', () => {
  it('R6b: only months after the table are missing', () => {
    const c = darfLateCharges(1000, '2026-02-27', '2026-12-10');
    expect(c.missingSelicMonths).toEqual(['2026-10', '2026-11']);
    const full = darfLateCharges(1000, '2025-02-28', '2025-05-15');
    expect(full.jurosRate).toBeCloseTo(0.0096 + 0.0106 + 0.01, 10);
    expect(full.total).toBeDefined();
  });
});

describe('T36 — reconciliation with official documents', () => {
  it('Brazil: informe de rendimentos and pré-preenchida', () => {
    const txs = [
      tx({ date: '2025-01-05', type: 'BUY', instrumentId: I.PETR4.id, quantity: 2000, price: 30, currency: B }),
      tx({ date: '2025-03-10', type: 'SELL', instrumentId: I.PETR4.id, quantity: 1000, price: 40, currency: B, taxes: 2 }),
      tx({ date: '2025-05-20', type: 'DIVIDEND', instrumentId: I.PETR4.id, amount: 500, currency: B }),
    ];
    const pack = brazilTaxPack(br(txs), { year: 2025 });
    const csv = 'tipo;ticker;cnpj;valor;irrf;quantidade\nDIVIDENDO;PETR4;33.000.167/0001-01;500;;\nDIVIDENDO;PETR3;33.000.167/0001-01;120;;\nPOSICAO;PETR4;33.000.167/0001-01;;;1000\n';
    const informe = informeFromRows(parseOfficialDocCsv(csv), { cnpj: '02.332.886/0001-04', nome: 'XP' }, 2025);
    const rec = reconcileBrazil(pack, {
      informes: [informe],
      prePreenchida: { ano: 2025, darfsPagos: [{ codigo: '6015', periodo: '2025-03', valor: 1498 }], irrfRendaVariavel: 2 },
    });
    const by = (area: string) => rec.lines.filter((l) => l.area === area);
    // PETR3 + PETR4 group under PETR: 500 vs 620 → different
    expect(by('proventos')[0]).toMatchObject({ key: 'DIVIDENDO|PETR', ours: 500, theirs: 620, status: 'diferente' });
    expect(by('posicoes_31_12')[0]).toMatchObject({ status: 'ok' });
    expect(by('darfs')[0]).toMatchObject({ status: 'ok' });
    expect(by('irrf_bolsa')[0]).toMatchObject({ status: 'ok' });
    expect(rec.issues.map((i) => i.code)).toContain('RECONCILIATION_DIFFERENCES');
  });
  it('Colombia: exógena and Deceval', () => {
    const r = buildColombiaTaxReport(
      co([
        tx({ date: '2024-01-10', type: 'BUY', instrumentId: I.ECOPETROL.id, quantity: 1000, price: 2000, currency: 'COP' }),
        tx({ date: '2025-04-10', type: 'DIVIDEND', instrumentId: I.ECOPETROL.id, amount: 300_000, currency: 'COP' }),
        tx({ date: '2025-05-10', type: 'SELL', instrumentId: I.ECOPETROL.id, quantity: 400, price: 2500, currency: 'COP' }),
      ]),
      { year: 2025 },
    );
    const rec = reconcileColombia(r, {
      exogena: [
        { nitInformante: '899999068', nombreInformante: 'Ecopetrol', concepto: 'dividendos', valor: 300_000 },
        { nitInformante: '800000000', nombreInformante: 'Comisionista', concepto: 'enajenacion', valor: 1_200_000 },
      ],
      certificados: [{ tipo: 'deceval', emisor: 'ECOPETROL', valor: 0, cantidad: 600 }],
    });
    expect(rec.lines.find((l) => l.key === 'dividendos')!.status).toBe('ok');
    expect(rec.lines.find((l) => l.key === 'enajenacion')).toMatchObject({ ours: 1_000_000, theirs: 1_200_000, status: 'diferente' });
    expect(rec.lines.find((l) => l.area === 'deceval_31_dic')!.status).toBe('ok');
  });
  it('US: 1042-S', () => {
    const rec = reconcileUs1042S(
      { transactions: [tx({ date: '2025-05-10', type: 'DIVIDEND', instrumentId: I.AAPL.id, amount: 100, taxes: 30, currency: 'USD' })], instruments: INSTS },
      'CO',
      2025,
      [{ year: 2025, incomeCode: '06', grossIncome: 100, taxRate: 0.3, taxWithheld: 30 }],
    );
    expect(rec.ok).toBe(true);
    expect(rec.rateMismatch).toBeUndefined();
  });
});

describe('T37 / T14 — XLSX, document model, Formulario 210 casillas and subcédulas', () => {
  it('XLSX is a ZIP with one sheet per table; document has sections', () => {
    const p = colombiaTaxPack(co([tx({ date: '2023-03-01', type: 'BUY', instrumentId: I.AAPL.id, quantity: 10, price: 150, currency: 'USD' })]), { year: 2025 });
    expect(p.xlsx[0]).toBe(0x50); // 'P'
    expect(p.xlsx[1]).toBe(0x4b); // 'K'
    const text = new TextDecoder().decode(p.xlsx);
    expect(text).toContain('Formulario 210');
    expect(text).toContain('xl/worksheets/sheet7.xml');
    expect(p.document.sections[0]!.heading).toBe('Resumen');
    expect(p.formulario210.find((l) => l.concepto === 'Total patrimonio bruto')!.casilla).toBe(29);
    const bp = brazilTaxPack(br([]), { year: 2025 });
    expect(new TextDecoder().decode(bp.xlsx)).toContain('bens-e-direitos');
    expect(bp.document.country).toBe('BR');
  });
  it('dividends split into 1a and 2a subcédula', () => {
    const d = tx({ date: '2025-04-10', type: 'DIVIDEND', instrumentId: I.ECOPETROL.id, amount: 1_000_000, currency: 'COP' });
    const r = buildColombiaTaxReport(co([d]), { year: 2025, dividendosGravados: { [d.id]: 0.4 } });
    const lines = formulario210Lines(r).filter((l) => l.seccion === 'Dividendos y participaciones');
    expect(lines[0]!.valorCop).toBeCloseTo(600_000, 6);
    expect(lines[1]!.valorCop).toBeCloseTo(400_000, 6);
  });
});

describe('T20 — componente inflacionario per year and holiday calendars', () => {
  it('componente inflacionario of AG 2024 (50.88%) applied by default', () => {
    const r = buildColombiaTaxReport(co([tx({ date: '2024-05-05', type: 'INTEREST', amount: 1_000_000, currency: 'COP' })]), { year: 2024 });
    expect(r.ingresos.totals.componenteInflacionarioCop).toBeCloseTo(508_800, 6);
  });
  it('Colombian (Ley Emiliani) and NYSE holidays', () => {
    const co26 = colombiaHolidays(2026);
    expect(co26.has('2026-01-12')).toBe(true); // Reyes moved to Monday
    expect(co26.has('2026-04-03')).toBe(true); // Viernes Santo
    const us26 = usMarketHolidays(2026);
    expect(us26.has('2026-11-26')).toBe(true); // Thanksgiving
    expect(us26.has('2026-07-03')).toBe(true); // Independence Day observed
  });
});

describe('T12 — futures, share lending, come-cotas, pre-2024 foreign regime', () => {
  it('mini-índice day trade: 1,000 points x R$ 0.20 = R$ 200 → 20%', () => {
    expect(classifyForBrazil(WIN)).toBe('FUTURO');
    const r = brazilMonthlyApuracao(
      br([
        tx({ date: '2026-10-01', type: 'BUY', instrumentId: WIN.id, quantity: 1, price: 120_000, currency: B }),
        tx({ date: '2026-10-01', type: 'SELL', instrumentId: WIN.id, quantity: 1, price: 121_000, currency: B }),
      ]),
      { from: '2026-10', to: '2026-10' },
    );
    expect(r.months[0]!.results.dayTrade).toBeCloseTo(200, 6);
    expect(r.months[0]!.dayTrade.tax).toBeCloseTo(40, 6);
  });
  it('aluguel de ações: lender remuneration withheld at source (regressive table)', () => {
    const r = brazilProventosReport(
      br([tx({ date: '2025-06-10', type: 'INTEREST', instrumentId: I.PETR4.id, amount: 100, taxes: 22.5, currency: B, note: 'aluguel BTC 30 dias' })]),
      { year: 2025 },
    );
    expect(r.rows[0]).toMatchObject({ type: 'ALUGUEL', expectedIrrf: 22.5 });
    expect(r.rows[0]!.dirpf?.linha).toBe('06');
  });
  it('come-cotas of an open-ended fund in May and November', () => {
    const market = createSimpleMarketData({ prices: { [FUND.id]: [['2025-01-02', 1], ['2025-05-30', 1.05], ['2025-11-28', 1.1]] } });
    const r = brazilComeCotasReport(br([tx({ date: '2025-01-02', type: 'BUY', instrumentId: FUND.id, quantity: 1000, price: 1, currency: B })], market), { year: 2025 });
    expect(r.rows).toHaveLength(2);
    expect(r.rows[0]).toMatchObject({ date: '2025-05-30' });
    expect(r.rows[0]!.tax).toBeCloseTo(7.5, 6);
    expect(r.rows[1]!.base).toBeCloseTo(1042.5, 6);
  });
  it('pre-2024 foreign sales: GCAP with R$ 35k monthly exemption', () => {
    const r = brazilForeignAnnualReport(
      br([
        tx({ date: '2023-01-10', type: 'BUY', instrumentId: I.AAPL.id, quantity: 100, price: 100, currency: 'USD' }),
        tx({ date: '2023-03-10', type: 'SELL', instrumentId: I.AAPL.id, quantity: 50, price: 120, currency: 'USD' }),
        tx({ date: '2023-06-10', type: 'SELL', instrumentId: I.AAPL.id, quantity: 50, price: 160, currency: 'USD' }),
      ]),
      { year: 2023 },
    );
    const g = r.gcapPre2024!;
    expect(g.months[0]).toMatchObject({ month: '2023-03', exempt: true, tax: 0 });
    expect(g.months[1]).toMatchObject({ month: '2023-06', exempt: false });
    expect(g.months[1]!.tax).toBeCloseTo(50 * 60 * 5 * 0.15, 6);
  });
});
