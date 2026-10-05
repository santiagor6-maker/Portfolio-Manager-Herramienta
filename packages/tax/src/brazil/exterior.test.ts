import { describe, expect, it } from 'vitest';
import type { CurrencyCode, ISODate, Transaction } from '@pm/core';
import { createSimpleMarketData } from '../testing/marketData';
import { ALL_INSTRUMENTS, I, tx } from '../testing/fixtures';
import { brazilForeignAnnualReport, type PtaxProvider } from './exterior';
import { brazilProventosReport } from './proventos';
import { brazilBensDireitos } from './bensDireitos';
import { lastBrazilBusinessDayOfMonth } from '../common/dates';

const market = createSimpleMarketData({});
const input = (transactions: Transaction[]) => ({ transactions, instruments: ALL_INSTRUMENTS, market });
const U = 'USD';
const B = 'BRL';

/** PTAX table: date -> [compra, venda]. */
function ptaxTable(rows: Record<ISODate, [number, number]>): PtaxProvider {
  const pick = (date: ISODate, k: 0 | 1, _c: CurrencyCode) => {
    const keys = Object.keys(rows).filter((d) => d <= date).sort();
    const last = keys[keys.length - 1];
    return last ? rows[last]![k] : undefined;
  };
  return { buy: (c, d) => pick(d, 0, c), sell: (c, d) => pick(d, 1, c) };
}

describe('Lei 14.754/2023 — aplicações financeiras no exterior', () => {
  const ptax = ptaxTable({
    '2024-02-01': [5.0, 5.01],
    '2024-05-15': [5.09, 5.1],
    '2024-08-01': [5.49, 5.5],
    '2025-03-01': [5.0, 5.0],
    '2025-09-01': [5.0, 5.0],
    '2026-02-01': [5.2, 5.2],
  });
  const txs = [
    tx({ date: '2024-02-01', type: 'BUY', instrumentId: I.AAPL.id, quantity: 10, price: 150, currency: U }),
    tx({ date: '2024-05-15', type: 'DIVIDEND', instrumentId: I.AAPL.id, amount: 10, taxes: 3, currency: U }),
    tx({ date: '2024-08-01', type: 'SELL', instrumentId: I.AAPL.id, quantity: 10, price: 200, currency: U }),
    tx({ date: '2025-03-01', type: 'BUY', instrumentId: I.VOO.id, quantity: 10, price: 400, currency: U }),
    tx({ date: '2025-09-01', type: 'SELL', instrumentId: I.VOO.id, quantity: 5, price: 380, currency: U }),
    tx({ date: '2026-02-01', type: 'SELL', instrumentId: I.VOO.id, quantity: 5, price: 500, currency: U }),
  ];

  it('2024: gain with FX at PTAX compra/venda, dividend and foreign tax credit cap', () => {
    const r = brazilForeignAnnualReport(input(txs), { year: 2024, ptax });
    expect(r.regime).toBe('lei-14754');
    // cost 1500 USD x 5.00 (compra) = 7,500; proceeds 2000 x 5.50 (venda) = 11,000
    expect(r.sales[0]!.costBrl).toBeCloseTo(7500, 8);
    expect(r.sales[0]!.proceedsBrl).toBeCloseTo(11000, 8);
    expect(r.sales[0]!.gainBrl).toBeCloseTo(3500, 8);
    // dividend 10 USD x 5.10 (venda) = 51; tax 3 x 5.09 (compra) = 15.27; cap = 15% x 51 = 7.65
    const d = r.income[0]!;
    expect(d.grossBrl).toBeCloseTo(51, 8);
    expect(d.foreignTaxBrl).toBeCloseTo(15.27, 8);
    expect(d.creditCapBrl).toBeCloseTo(7.65, 8);
    expect(r.totals.netResultBrl).toBeCloseTo(3551, 8);
    expect(r.totals.taxGrossBrl).toBeCloseTo(532.65, 8);
    expect(r.totals.foreignTaxCreditBrl).toBeCloseTo(7.65, 8);
    expect(r.totals.taxDueBrl).toBeCloseTo(525, 8);
    expect(r.dueDateEstimate).toBe(lastBrazilBusinessDayOfMonth('2025-05'));
  });

  it('2025: loss carried forward; 2026: carryforward offsets the gain', () => {
    const r25 = brazilForeignAnnualReport(input(txs), { year: 2025, ptax });
    // 5 x 380 x 5 = 9,500 vs cost 5 x 400 x 5 = 10,000 -> loss 500
    expect(r25.totals.netResultBrl).toBeCloseTo(-500, 8);
    expect(r25.totals.taxDueBrl).toBe(0);
    expect(r25.totals.lossCarryOut).toBeCloseTo(500, 8);
    expect(r25.positions[0]!.quantity).toBe(5);
    expect(r25.positions[0]!.costBrl).toBeCloseTo(10000, 8);

    const r26 = brazilForeignAnnualReport(input(txs), { year: 2026, ptax });
    // 5 x 500 x 5.2 = 13,000 - 10,000 = 3,000; minus 500 carry = 2,500 x 15% = 375
    expect(r26.totals.lossCarryIn).toBeCloseTo(500, 8);
    expect(r26.totals.baseBrl).toBeCloseTo(2500, 8);
    expect(r26.totals.taxDueBrl).toBeCloseTo(375, 8);
    expect(r26.positions).toHaveLength(0);
    expect(r26.positionsPrevYear[0]!.costBrl).toBeCloseTo(10000, 8);
  });

  it('falls back to market FX when no PTAX provider is given', () => {
    const m = createSimpleMarketData({ fx: { 'USD/BRL': [['2024-01-01', 5]] } });
    const r = brazilForeignAnnualReport({ transactions: txs, instruments: ALL_INSTRUMENTS, market: m }, { year: 2024 });
    expect(r.sales[0]!.gainBrl).toBeCloseTo(2000 * 5 - 1500 * 5, 8);
    expect(r.issues.map((i) => i.code)).toContain('PTAX_FALLBACK');
  });

  it('pre-2024 years are flagged as a different regime', () => {
    const r = brazilForeignAnnualReport(input(txs), { year: 2023, ptax });
    expect(r.regime).toBe('pre-2024');
    expect(r.issues.map((i) => i.code)).toContain('PRE_LEI_14754');
  });
});

describe('proventos B3', () => {
  const txs = [
    tx({ date: '2025-03-10', type: 'DIVIDEND', instrumentId: I.PETR4.id, amount: 500, currency: B }),
    tx({ date: '2025-06-10', type: 'DIVIDEND', instrumentId: I.ITSA4.id, amount: 1000, taxes: 150, currency: B, note: 'JCP' }),
    tx({ date: '2025-06-15', type: 'DIVIDEND', instrumentId: I.VALE3.id, amount: 200, taxes: 30, currency: B }),
    tx({ date: '2025-07-15', type: 'DIVIDEND', instrumentId: I.HGLG11.id, amount: 110, currency: B }),
    tx({ date: '2025-07-20', type: 'DIVIDEND', instrumentId: I.AAPL.id, amount: 10, taxes: 3, currency: 'USD' }),
  ];

  it('classifies dividends, JCP (by note or 15% withholding) and FII income', () => {
    const r = brazilProventosReport(input(txs), { year: 2025 });
    expect(r.rows.map((x) => x.type)).toEqual(['DIVIDENDO', 'JCP', 'JCP', 'RENDIMENTO_FII']);
    expect(r.totals).toMatchObject({ dividendos: 500, jcpGross: 1200, jcpIrrf: 180, rendimentosFii: 110 });
    expect(r.rows[1]!.dirpf?.linha).toBe('10');
    expect(r.rows[3]!.dirpf?.linha).toBe('26');
    expect(r.issues.filter((i) => i.code === 'IRRF_MISMATCH')).toHaveLength(0);
  });

  it('2026: JCP at 17.5% (LC 224/2025) and dividends above R$ 50k/month per payer at 10% (Lei 15.270/2025)', () => {
    const r = brazilProventosReport(
      input([
        tx({ date: '2026-03-10', type: 'DIVIDEND', instrumentId: I.ITSA4.id, amount: 1000, taxes: 150, currency: B, note: 'JCP' }),
        tx({ date: '2026-04-10', type: 'DIVIDEND', instrumentId: I.PETR4.id, amount: 30000, currency: B }),
        tx({ date: '2026-04-20', type: 'DIVIDEND', instrumentId: I.PETR4.id, amount: 30000, taxes: 6000, currency: B }),
      ]),
      { year: 2026 },
    );
    expect(r.rows[0]!.expectedIrrf).toBeCloseTo(175, 8);
    expect(r.issues.some((i) => i.code === 'IRRF_MISMATCH' && i.transactionId === r.rows[0]!.transactionId)).toBe(true);
    expect(r.rows[1]!.expectedIrrf).toBeCloseTo(3000, 8);
    expect(r.issues.map((i) => i.code)).toContain('DIVIDEND_IRRF_LEI_15270');
  });
});

describe('Bens e Direitos', () => {
  it('lists B3 and foreign positions at cost for 31/12 of both years', () => {
    const ptax = { buy: () => 5, sell: () => 5 };
    const r = brazilBensDireitos(
      input([
        tx({ date: '2024-05-02', type: 'BUY', instrumentId: I.PETR4.id, quantity: 100, price: 30, fees: 4.9, currency: B }),
        tx({ date: '2025-05-02', type: 'BUY', instrumentId: I.HGLG11.id, quantity: 10, price: 160, currency: B }),
        tx({ date: '2025-05-02', type: 'BUY', instrumentId: I.BOVA11.id, quantity: 10, price: 120, currency: B }),
        tx({ date: '2025-06-02', type: 'DEPOSIT', amount: 2000, currency: 'USD' }),
        tx({ date: '2025-06-03', type: 'BUY', instrumentId: I.AAPL.id, quantity: 5, price: 200, currency: 'USD' }),
      ]),
      { year: 2025, ptax },
    );
    const by = (t?: string) => r.items.find((i) => i.ticker === t)!;
    expect(by('PETR4')).toMatchObject({ grupo: '03', codigo: '01', situacaoAnterior: 3004.9, situacaoAtual: 3004.9, cnpj: '' });
    expect(by('HGLG11')).toMatchObject({ grupo: '07', codigo: '03', situacaoAnterior: 0, situacaoAtual: 1600 });
    expect(by('BOVA11')).toMatchObject({ grupo: '07', codigo: '09' });
    expect(by('AAPL')).toMatchObject({ grupo: '03', codigo: '01', localizacao: 'US', situacaoAtual: 5000 });
    const cash = r.items.find((i) => i.grupo === '06')!;
    expect(cash.situacaoAtual).toBeCloseTo(5000, 8); // 1000 USD left x 5
    expect(r.totalAtual).toBeCloseTo(3004.9 + 1600 + 1200 + 5000 + 5000, 6);
    expect(by('PETR4').discriminacao).toContain('preço médio R$ 30,05');
  });
});
