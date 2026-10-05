import { describe, expect, it } from 'vitest';
import { createSimpleMarketData } from '../testing/marketData';
import { ALL_INSTRUMENTS, I, tx } from '../testing/fixtures';
import type { Transaction } from '@pm/core';
import { brazilMonthlyApuracao } from './apuracao';
import { runBrazilB3Ledger } from './ledger';
import { brazilApuracaoCsv } from './csv';
import { classifyForBrazil } from './classify';

const market = createSimpleMarketData({});
const input = (transactions: Transaction[]) => ({ transactions, instruments: ALL_INSTRUMENTS, market });
const B = 'BRL';

describe('classifyForBrazil', () => {
  it('maps B3 asset classes and foreign listings', () => {
    expect(classifyForBrazil(I.PETR4)).toBe('ACAO');
    expect(classifyForBrazil(I.BOVA11)).toBe('ETF');
    expect(classifyForBrazil(I.HGLG11)).toBe('FII');
    expect(classifyForBrazil(I.AAPL34)).toBe('BDR');
    expect(classifyForBrazil(I.AAPL)).toBe('FOREIGN');
    expect(classifyForBrazil(I.PETR4, { 'BVMF:PETR4': 'OTHER' })).toBe('OTHER');
  });
});

describe('preço médio', () => {
  it('includes fees in the average and keeps it on partial sales', () => {
    const r = runBrazilB3Ledger(
      input([
        tx({ date: '2025-01-02', type: 'BUY', instrumentId: I.PETR4.id, quantity: 100, price: 10, fees: 5, currency: B }),
        tx({ date: '2025-01-10', type: 'BUY', instrumentId: I.PETR4.id, quantity: 100, price: 12, fees: 5, currency: B }),
        tx({ date: '2025-01-20', type: 'SELL', instrumentId: I.PETR4.id, quantity: 50, price: 13, fees: 0, currency: B }),
      ]),
    );
    const pos = r.positions[0]!;
    // (1000 + 5 + 1200 + 5) / 200 = 11.05
    expect(pos.averageCost).toBeCloseTo(11.05, 10);
    expect(pos.quantity).toBe(150);
    expect(pos.totalCost).toBeCloseTo(150 * 11.05, 8);
    expect(r.trades[0]!.result).toBeCloseTo(50 * 13 - 50 * 11.05, 8);
  });

  it('bonificação adds shares at the attributed cost', () => {
    const r = runBrazilB3Ledger(
      input([
        tx({ date: '2025-01-02', type: 'BUY', instrumentId: I.ITSA4.id, quantity: 100, price: 10, currency: B }),
        tx({ date: '2025-03-02', type: 'STOCK_DIVIDEND', instrumentId: I.ITSA4.id, ratio: 0.1, price: 15, currency: B }),
      ]),
    );
    const p = r.positions[0]!;
    expect(p.quantity).toBeCloseTo(110, 10);
    expect(p.totalCost).toBeCloseTo(1150, 10);
    expect(p.averageCost).toBeCloseTo(1150 / 110, 10);
  });

  it('bonificação without value warns and adds zero cost', () => {
    const r = runBrazilB3Ledger(
      input([
        tx({ date: '2025-01-02', type: 'BUY', instrumentId: I.ITSA4.id, quantity: 100, price: 10, currency: B }),
        tx({ date: '2025-03-02', type: 'STOCK_DIVIDEND', instrumentId: I.ITSA4.id, quantity: 10, currency: B }),
      ]),
    );
    expect(r.positions[0]!.totalCost).toBe(1000);
    expect(r.issues.map((i) => i.code)).toContain('BONIFICACAO_SEM_CUSTO');
  });

  it('split keeps total cost', () => {
    const r = runBrazilB3Ledger(
      input([
        tx({ date: '2025-01-02', type: 'BUY', instrumentId: I.PETR4.id, quantity: 100, price: 30, currency: B }),
        tx({ date: '2025-02-02', type: 'SPLIT', instrumentId: I.PETR4.id, ratio: 2, currency: B }),
      ]),
    );
    expect(r.positions[0]!.quantity).toBe(200);
    expect(r.positions[0]!.averageCost).toBe(15);
  });
});

describe('apuração mensal — ações e isenção R$ 20 mil', () => {
  const txs = [
    tx({ date: '2025-01-15', type: 'BUY', instrumentId: I.PETR4.id, quantity: 1000, price: 10, currency: B }),
    // Feb: sales 15,000 <= 20,000 -> exempt gain 10,000
    tx({ date: '2025-02-10', type: 'SELL', instrumentId: I.PETR4.id, quantity: 500, price: 30, currency: B }),
    // Mar: sales 25,000 > 20,000 -> taxable gain 24,990 - 5,000 = 19,990
    tx({ date: '2025-03-12', type: 'SELL', instrumentId: I.PETR4.id, quantity: 500, price: 50, fees: 10, currency: B }),
  ];
  const r = brazilMonthlyApuracao(input(txs), { year: 2025, creditEstimatedIrrf: true });
  const m = (ym: string) => r.months.find((x) => x.month === ym)!;

  it('month under R$ 20k is exempt', () => {
    expect(m('2025-02').salesAcoesSwing).toBe(15000);
    expect(m('2025-02').exempt).toBe(true);
    expect(m('2025-02').exemptGain).toBeCloseTo(10000, 8);
    expect(m('2025-02').taxGross).toBe(0);
    expect(m('2025-02').darf).toBeUndefined();
  });

  it('month over R$ 20k pays 15% minus IRRF 0.005%', () => {
    const mar = m('2025-03');
    expect(mar.exempt).toBe(false);
    expect(mar.comum.base).toBeCloseTo(19990, 8);
    expect(mar.taxGross).toBeCloseTo(2998.5, 8);
    expect(mar.irrf.month).toBeCloseTo(1.25, 8); // 25,000 x 0.005%
    expect(mar.irrf.estimated).toBe(true);
    expect(mar.darf?.amount).toBe(2997.25);
    expect(mar.darf?.code).toBe('6015');
    expect(mar.darf?.dueDate).toBe('2025-04-30');
    expect(r.totals.exemptGain).toBeCloseTo(10000, 8);
  });

  it('uses the IRRF reported by the broker when present', () => {
    const t2 = txs.map((t) => (t.date === '2025-03-12' ? { ...t, taxes: 1.3 } : t));
    const r2 = brazilMonthlyApuracao(input(t2), { year: 2025 });
    const mar = r2.months.find((x) => x.month === '2025-03')!;
    expect(mar.irrf.month).toBeCloseTo(1.3, 8);
    expect(mar.irrf.estimated).toBe(false);
    expect(mar.darf?.amount).toBe(2997.2);
  });

  it('exactly R$ 20,000 of sales is still exempt', () => {
    const r3 = brazilMonthlyApuracao(
      input([
        tx({ date: '2025-01-15', type: 'BUY', instrumentId: I.VALE3.id, quantity: 400, price: 40, currency: B }),
        tx({ date: '2025-02-10', type: 'SELL', instrumentId: I.VALE3.id, quantity: 400, price: 50, currency: B }),
      ]),
      { year: 2025 },
    );
    const feb = r3.months.find((x) => x.month === '2025-02')!;
    expect(feb.exempt).toBe(true);
    expect(feb.exemptGain).toBe(4000);
    expect(feb.darf).toBeUndefined();
  });

  it('CSV for the accountant has one row per month', () => {
    const csv = brazilApuracaoCsv(r);
    const lines = csv.replace('﻿', '').trim().split('\r\n');
    expect(lines[0]).toContain('darf_vencimento');
    expect(lines.filter((l) => l.startsWith('2025-'))).toHaveLength(12);
    expect(csv).toContain('2997,25');
  });
});

describe('day trade', () => {
  it('same-day buy+sell at the same broker is day trade at 20% with 1% IRRF', () => {
    const txs = [
      tx({ date: '2025-04-01', type: 'BUY', instrumentId: I.VALE3.id, quantity: 100, price: 50, currency: B, account: 'XP' }),
      tx({ date: '2025-05-05', type: 'BUY', instrumentId: I.VALE3.id, quantity: 100, price: 60, currency: B, account: 'XP' }),
      tx({ date: '2025-05-05', type: 'SELL', instrumentId: I.VALE3.id, quantity: 100, price: 62, currency: B, account: 'XP' }),
    ];
    const r = brazilMonthlyApuracao(input(txs), { year: 2025, creditEstimatedIrrf: true });
    const may = r.months.find((x) => x.month === '2025-05')!;
    expect(may.results.dayTrade).toBeCloseTo(200, 8);
    expect(may.dayTrade.tax).toBeCloseTo(40, 8);
    expect(may.irrf.month).toBeCloseTo(2, 8);
    expect(may.darf?.amount).toBe(38);
    expect(may.darf?.dueDate).toBe('2025-06-30');
    // preço médio of the carried position is untouched by the day trade
    const led = runBrazilB3Ledger(input(txs));
    expect(led.positions[0]!.quantity).toBe(100);
    expect(led.positions[0]!.averageCost).toBe(50);
  });

  it('partial day trade: matched quantity is day trade, the rest is swing vs preço médio', () => {
    const txs = [
      tx({ date: '2025-04-01', type: 'BUY', instrumentId: I.VALE3.id, quantity: 100, price: 50, currency: B }),
      tx({ date: '2025-05-05', type: 'BUY', instrumentId: I.VALE3.id, quantity: 50, price: 60, currency: B }),
      tx({ date: '2025-05-05', type: 'SELL', instrumentId: I.VALE3.id, quantity: 80, price: 65, currency: B }),
    ];
    const led = runBrazilB3Ledger(input(txs));
    const dt = led.trades.find((t) => t.kind === 'daytrade')!;
    const sw = led.trades.find((t) => t.kind === 'swing')!;
    expect(dt.quantity).toBe(50);
    expect(dt.result).toBeCloseTo(250, 8);
    expect(sw.quantity).toBeCloseTo(30, 8);
    expect(sw.result).toBeCloseTo(450, 8);
    expect(led.positions[0]!.quantity).toBeCloseTo(70, 8);
    expect(led.positions[0]!.averageCost).toBeCloseTo(50, 8);
    const may = brazilMonthlyApuracao(input(txs), { year: 2025 }).months.find((m) => m.month === '2025-05')!;
    expect(may.salesAcoesSwing).toBeCloseTo(1950, 8);
    expect(may.exempt).toBe(true);
    expect(may.dayTrade.tax).toBeCloseTo(50, 8);
  });

  it('buy and sell on the same day at different brokers is not day trade', () => {
    const led = runBrazilB3Ledger(
      input([
        tx({ date: '2025-04-01', type: 'BUY', instrumentId: I.VALE3.id, quantity: 100, price: 50, currency: B, account: 'XP' }),
        tx({ date: '2025-05-05', type: 'BUY', instrumentId: I.VALE3.id, quantity: 100, price: 60, currency: B, account: 'Clear' }),
        tx({ date: '2025-05-05', type: 'SELL', instrumentId: I.VALE3.id, quantity: 100, price: 62, currency: B, account: 'XP' }),
      ]),
    );
    expect(led.trades.every((t) => t.kind === 'swing')).toBe(true);
    // avg after buy = (5000 + 6000) / 200 = 55; result = 6200 - 5500
    expect(led.trades[0]!.result).toBeCloseTo(700, 8);
  });

  it('day-trade losses do not offset swing gains', () => {
    const r = brazilMonthlyApuracao(
      input([
        tx({ date: '2025-01-02', type: 'BUY', instrumentId: I.BOVA11.id, quantity: 100, price: 100, currency: B }),
        tx({ date: '2025-01-10', type: 'BUY', instrumentId: I.VALE3.id, quantity: 100, price: 60, currency: B }),
        tx({ date: '2025-01-10', type: 'SELL', instrumentId: I.VALE3.id, quantity: 100, price: 55, currency: B }),
        tx({ date: '2025-01-20', type: 'SELL', instrumentId: I.BOVA11.id, quantity: 100, price: 110, currency: B }),
      ]),
      { from: '2025-01', to: '2025-01' },
    );
    const jan = r.months[0]!;
    expect(jan.dayTrade.lossCarryOut).toBeCloseTo(500, 8);
    expect(jan.comum.base).toBeCloseTo(1000, 8);
    expect(jan.comum.tax).toBeCloseTo(150, 8);
  });
});

describe('loss carryforward', () => {
  it('ETF loss in one month offsets a later gain (no exemption for ETFs)', () => {
    const r = brazilMonthlyApuracao(
      input([
        tx({ date: '2025-01-10', type: 'BUY', instrumentId: I.BOVA11.id, quantity: 1000, price: 100, currency: B }),
        tx({ date: '2025-02-10', type: 'SELL', instrumentId: I.BOVA11.id, quantity: 500, price: 90, currency: B }),
        tx({ date: '2025-03-10', type: 'SELL', instrumentId: I.BOVA11.id, quantity: 500, price: 120, currency: B }),
      ]),
      { year: 2025, creditEstimatedIrrf: true },
    );
    const feb = r.months.find((m) => m.month === '2025-02')!;
    const mar = r.months.find((m) => m.month === '2025-03')!;
    expect(feb.comum.lossCarryOut).toBeCloseTo(5000, 8);
    expect(feb.irrf.month).toBeCloseTo(2.25, 8);
    expect(feb.irrf.carryOut).toBeCloseTo(2.25, 8);
    expect(mar.comum.lossUsed).toBeCloseTo(5000, 8);
    expect(mar.comum.base).toBeCloseTo(5000, 8);
    expect(mar.taxGross).toBeCloseTo(750, 8);
    expect(mar.irrf.used).toBeCloseTo(5.25, 8);
    expect(mar.darf?.amount).toBe(744.75);
  });

  it('loss on shares in an exempt month is carried and offsets a later taxable month', () => {
    const r = brazilMonthlyApuracao(
      input([
        tx({ date: '2025-01-10', type: 'BUY', instrumentId: I.PETR4.id, quantity: 2000, price: 20, currency: B }),
        // Feb: sell 500 @ 16 = 8,000 (exempt month) loss 2,000
        tx({ date: '2025-02-10', type: 'SELL', instrumentId: I.PETR4.id, quantity: 500, price: 16, currency: B }),
        // Mar: sell 1,500 @ 30 = 45,000 gain 15,000 - 2,000 carry = 13,000
        tx({ date: '2025-03-10', type: 'SELL', instrumentId: I.PETR4.id, quantity: 1500, price: 30, currency: B }),
      ]),
      { year: 2025 },
    );
    const mar = r.months.find((m) => m.month === '2025-03')!;
    expect(r.months.find((m) => m.month === '2025-02')!.comum.lossCarryOut).toBeCloseTo(2000, 8);
    expect(mar.comum.base).toBeCloseTo(13000, 8);
    expect(mar.taxGross).toBeCloseTo(1950, 8);
  });

  it('carries losses across years and accepts initial losses', () => {
    const r = brazilMonthlyApuracao(
      input([
        tx({ date: '2025-11-10', type: 'BUY', instrumentId: I.BOVA11.id, quantity: 100, price: 100, currency: B }),
        tx({ date: '2025-12-10', type: 'SELL', instrumentId: I.BOVA11.id, quantity: 50, price: 80, currency: B }),
        tx({ date: '2026-01-10', type: 'SELL', instrumentId: I.BOVA11.id, quantity: 50, price: 140, currency: B }),
      ]),
      { year: 2026, initialLosses: { comum: 300 } },
    );
    const jan = r.months[0]!;
    expect(jan.month).toBe('2026-01');
    expect(jan.comum.lossCarryIn).toBeCloseTo(1300, 8);
    expect(jan.comum.base).toBeCloseTo(700, 8);
    expect(r.months).toHaveLength(12);
  });
});

describe('FII', () => {
  it('FII gains pay 20% even below R$ 20k and use a separate loss pool', () => {
    const r = brazilMonthlyApuracao(
      input([
        tx({ date: '2025-01-10', type: 'BUY', instrumentId: I.HGLG11.id, quantity: 200, price: 160, currency: B }),
        tx({ date: '2025-01-10', type: 'BUY', instrumentId: I.PETR4.id, quantity: 1000, price: 30, currency: B }),
        // Feb: shares loss (exempt month) 1,000 — must not offset FII
        tx({ date: '2025-02-10', type: 'SELL', instrumentId: I.PETR4.id, quantity: 500, price: 28, currency: B }),
        // Mar: FII gain 100 x 10 = 1,000 -> 200
        tx({ date: '2025-03-10', type: 'SELL', instrumentId: I.HGLG11.id, quantity: 100, price: 170, currency: B }),
      ]),
      { year: 2025 },
    );
    const mar = r.months.find((m) => m.month === '2025-03')!;
    expect(mar.results.fii).toBeCloseTo(1000, 8);
    expect(mar.fii.tax).toBeCloseTo(200, 8);
    expect(mar.irrf.month).toBe(0); // 17,000 x 0.005% = 0.85 <= R$ 1 dispensa
    expect(mar.darf?.amount).toBe(200);
    expect(mar.comum.lossCarryOut).toBeCloseTo(1000, 8);
    expect(r.lossesAtEnd).toEqual({ comum: 1000, dayTrade: 0, fii: 0 });
  });

  it('FII loss offsets only later FII gains', () => {
    const r = brazilMonthlyApuracao(
      input([
        tx({ date: '2025-01-10', type: 'BUY', instrumentId: I.HGLG11.id, quantity: 200, price: 160, currency: B }),
        tx({ date: '2025-02-10', type: 'SELL', instrumentId: I.HGLG11.id, quantity: 100, price: 150, currency: B }),
        tx({ date: '2025-03-10', type: 'SELL', instrumentId: I.HGLG11.id, quantity: 100, price: 180, currency: B }),
      ]),
      { year: 2025 },
    );
    const mar = r.months.find((m) => m.month === '2025-03')!;
    expect(mar.fii.lossUsed).toBeCloseTo(1000, 8);
    expect(mar.fii.base).toBeCloseTo(1000, 8);
    expect(mar.fii.tax).toBeCloseTo(200, 8);
  });
});

describe('BDR and DARF minimum', () => {
  it('BDR sales below R$ 20k are taxed (no exemption)', () => {
    const r = brazilMonthlyApuracao(
      input([
        tx({ date: '2025-01-10', type: 'BUY', instrumentId: I.AAPL34.id, quantity: 100, price: 50, currency: B }),
        tx({ date: '2025-02-10', type: 'SELL', instrumentId: I.AAPL34.id, quantity: 100, price: 60, currency: B }),
      ]),
      { year: 2025 },
    );
    const feb = r.months.find((m) => m.month === '2025-02')!;
    expect(feb.results.bdr).toBe(1000);
    expect(feb.comum.tax).toBe(150);
    expect(feb.darf?.amount).toBe(150);
  });

  it('tax below R$ 10 rolls over until the accumulated amount reaches R$ 10', () => {
    const r = brazilMonthlyApuracao(
      input([
        tx({ date: '2025-01-10', type: 'BUY', instrumentId: I.BOVA11.id, quantity: 10, price: 100, currency: B }),
        tx({ date: '2025-02-10', type: 'SELL', instrumentId: I.BOVA11.id, quantity: 5, price: 108, currency: B }),
        tx({ date: '2025-03-10', type: 'SELL', instrumentId: I.BOVA11.id, quantity: 5, price: 108, currency: B }),
      ]),
      { year: 2025 },
    );
    const feb = r.months.find((m) => m.month === '2025-02')!;
    const mar = r.months.find((m) => m.month === '2025-03')!;
    expect(feb.taxAfterIrrf).toBeCloseTo(6, 8);
    expect(feb.darf).toBeUndefined();
    expect(feb.pendingOut).toBeCloseTo(6, 8);
    expect(mar.darf?.amount).toBe(12);
    expect(mar.darf?.includesMonths).toEqual(['2025-02', '2025-03']);
    expect(r.darfs).toHaveLength(1);
  });
});
