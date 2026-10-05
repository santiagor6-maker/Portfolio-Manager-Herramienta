import { describe, expect, it } from 'vitest';
import {
  computeCash,
  computeHoldings,
  externalFlows,
  incomeEvents,
  ledgerDiagnostics,
  realizedGains,
  valuePortfolio,
} from './api';
import { engine, inst, prices, sum, tx } from './__fixtures__/helpers';
import type { CostMethod } from './types';

const PETR4 = inst('BVMF:PETR4', 'BRL', { country: 'BR' });

/**
 * Brazilian preço médio example (base BRL):
 *   BUY 100 @ 30 + 10 fees  -> 3010 (30.10/u)
 *   BUY 200 @ 33 + 20 fees  -> 6620 (33.10/u)    average = 9630/300 = 32.10
 *   SELL 150 @ 35 - 15 fees -> net 5235
 *     FIFO   : cost 100*30.10 + 50*33.10 = 4665 -> gain 570
 *     AVERAGE: cost 150*32.10           = 4815 -> gain 420
 *     LIFO   : cost 150*33.10           = 4965 -> gain 270
 *   BUY 50 @ 36 + 5 fees -> 1805; new average = (4815 + 1805) / 200 = 33.10
 */
function brazil(method: CostMethod) {
  return engine({
    base: 'BRL',
    costMethod: method,
    instruments: [PETR4],
    prices: [prices(PETR4.id, 'BRL', { '2024-01-02': 30, '2024-06-28': 38 })],
    transactions: [
      tx({ date: '2024-01-10', type: 'BUY', instrumentId: PETR4.id, quantity: 100, price: 30, fees: 10, currency: 'BRL' }),
      tx({ date: '2024-02-10', type: 'BUY', instrumentId: PETR4.id, quantity: 200, price: 33, fees: 20, currency: 'BRL' }),
      tx({ date: '2024-03-10', type: 'SELL', instrumentId: PETR4.id, quantity: 150, price: 35, fees: 15, currency: 'BRL' }),
      tx({ date: '2024-04-10', type: 'BUY', instrumentId: PETR4.id, quantity: 50, price: 36, fees: 5, currency: 'BRL' }),
    ],
  });
}

describe('cost methods (preço médio vs FIFO vs LIFO)', () => {
  it('FIFO realized gains per lot', () => {
    const r = realizedGains(brazil('FIFO'));
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ openDate: '2024-01-10', quantity: 100, holdingDays: 60 });
    expect(r[0]!.proceeds).toBeCloseTo(3490, 9);
    expect(r[0]!.cost).toBeCloseTo(3010, 9);
    expect(r[1]!.proceeds).toBeCloseTo(1745, 9);
    expect(r[1]!.cost).toBeCloseTo(1655, 9);
    expect(sum(r.map((x) => x.gain))).toBeCloseTo(570, 9);
    expect(sum(r.map((x) => x.gainBase))).toBeCloseTo(570, 9);
  });

  it('AVERAGE (preço médio) realized gain and re-averaging after a new buy', () => {
    const input = brazil('AVERAGE');
    const r = realizedGains(input);
    expect(sum(r.map((x) => x.gain))).toBeCloseTo(420, 9);
    const before = computeHoldings(input, '2024-03-31')[0]!;
    expect(before.quantity).toBe(150);
    expect(before.costBasis / before.quantity).toBeCloseTo(32.1, 12);
    const after = computeHoldings(input, '2024-06-30')[0]!;
    expect(after.quantity).toBe(200);
    expect(after.costBasis).toBeCloseTo(6620, 9);
    expect(after.costBasis / after.quantity).toBeCloseTo(33.1, 12);
    for (const l of after.lots) expect(l.unitCost).toBeCloseTo(33.1, 12);
  });

  it('LIFO realized gain', () => {
    const r = realizedGains(brazil('LIFO'));
    expect(r).toHaveLength(1);
    expect(r[0]!.gain).toBeCloseTo(270, 9);
    const h = computeHoldings(brazil('LIFO'), '2024-03-31')[0]!;
    expect(h.costBasis).toBeCloseTo(4665, 9);
  });

  it('FIFO remaining lots', () => {
    const h = computeHoldings(brazil('FIFO'), '2024-03-31')[0]!;
    expect(h.lots).toHaveLength(1);
    expect(h.lots[0]).toMatchObject({ openDate: '2024-02-10', quantity: 150 });
    expect(h.costBasis).toBeCloseTo(4965, 9);
  });

  it('cash: buys debit amount+fees, sells credit net; implicit deposits cover shortfalls', () => {
    const input = brazil('FIFO');
    // Without deposits, each buy is funded by an implicit deposit for the shortfall.
    const flows = externalFlows(input);
    expect(flows.map((f) => f.kind)).toEqual(['IMPLICIT_DEPOSIT', 'IMPLICIT_DEPOSIT']);
    expect(flows[0]!.amount).toBeCloseTo(3010, 9);
    expect(flows[1]!.amount).toBeCloseTo(6620, 9);
    // The April buy (1805) is paid from the 5235 of sale proceeds -> cash 3430.
    expect(computeCash(input, '2024-06-30')).toEqual([expect.objectContaining({ currency: 'BRL', amount: 3430 })]);
  });

  it('implicitCashFlows=false lets cash go negative and reports it', () => {
    const input = { ...brazil('FIFO'), options: { implicitCashFlows: false } };
    expect(externalFlows(input)).toHaveLength(0);
    const cash = computeCash(input, '2024-02-28');
    expect(cash[0]!.amount).toBeCloseTo(-9630, 9);
    expect(ledgerDiagnostics(input).some((d) => d.code === 'NEGATIVE_CASH')).toBe(true);
  });

  it("sellProceeds='withdraw' books sale proceeds as an implicit withdrawal", () => {
    const input = { ...brazil('FIFO'), options: { sellProceeds: 'withdraw' as const } };
    const flows = externalFlows(input);
    expect(flows.map((f) => f.kind)).toEqual(['IMPLICIT_DEPOSIT', 'IMPLICIT_DEPOSIT', 'IMPLICIT_WITHDRAWAL', 'IMPLICIT_DEPOSIT']);
    expect(flows[2]!.amount).toBeCloseTo(-5235, 9);
    expect(computeCash(input, '2024-06-30')).toEqual([]);
  });
});

describe('corporate actions', () => {
  const AAPL = inst('XNAS:AAPL', 'USD');
  const base = [
    tx({ date: '2020-01-10', type: 'DEPOSIT', amount: 5000, currency: 'USD' }),
    tx({ date: '2020-01-10', type: 'BUY', instrumentId: AAPL.id, quantity: 10, price: 400, fees: 0, currency: 'USD' }),
  ];

  it('split adjusts quantity and unit cost, then sells use split-adjusted cost', () => {
    const input = engine({
      base: 'USD',
      instruments: [AAPL],
      transactions: [
        ...base,
        tx({ date: '2020-08-31', type: 'SPLIT', instrumentId: AAPL.id, ratio: 4, currency: 'USD' }),
        tx({ date: '2020-09-15', type: 'SELL', instrumentId: AAPL.id, quantity: 20, price: 120, currency: 'USD' }),
      ],
    });
    const h = computeHoldings(input, '2020-08-31')[0]!;
    expect(h.quantity).toBe(40);
    expect(h.lots[0]!.unitCost).toBeCloseTo(100, 12);
    expect(h.costBasis).toBeCloseTo(4000, 9);
    const r = realizedGains(input);
    expect(r[0]!.cost).toBeCloseTo(2000, 9);
    expect(r[0]!.gain).toBeCloseTo(400, 9);
    expect(r[0]!.openDate).toBe('2020-01-10');
  });

  it('reverse split 1-for-3 keeps cost and avoids quantity drift', () => {
    const input = engine({
      base: 'USD',
      instruments: [AAPL],
      transactions: [
        ...base,
        tx({ date: '2020-03-01', type: 'SPLIT', instrumentId: AAPL.id, ratio: 1 / 3, currency: 'USD' }),
        tx({ date: '2020-03-02', type: 'SPLIT', instrumentId: AAPL.id, ratio: 3, currency: 'USD' }),
        tx({ date: '2020-03-03', type: 'SELL', instrumentId: AAPL.id, quantity: 10, price: 500, currency: 'USD' }),
      ],
    });
    expect(computeHoldings(input, '2020-03-01')[0]!.quantity).toBeCloseTo(3.333333333, 9);
    expect(computeHoldings(input, '2020-03-02')[0]!.quantity).toBe(10);
    expect(computeHoldings(input, '2020-03-03')).toHaveLength(0);
    expect(ledgerDiagnostics(input).filter((d) => d.code === 'OVERSELL')).toHaveLength(0);
  });

  it('stock dividend by ratio adds shares at zero additional cost', () => {
    const input = engine({
      base: 'USD',
      instruments: [AAPL],
      transactions: [...base, tx({ date: '2020-05-01', type: 'STOCK_DIVIDEND', instrumentId: AAPL.id, ratio: 0.1, currency: 'USD' })],
    });
    const h = computeHoldings(input, '2020-05-01')[0]!;
    expect(h.quantity).toBe(11);
    expect(h.costBasis).toBeCloseTo(4000, 9);
  });

  it('stock dividend by quantity with attributed cost (bonificação)', () => {
    const input = engine({
      base: 'USD',
      instruments: [AAPL],
      transactions: [...base, tx({ date: '2020-05-01', type: 'STOCK_DIVIDEND', instrumentId: AAPL.id, quantity: 1, amount: 50, currency: 'USD' })],
    });
    const h = computeHoldings(input, '2020-05-01')[0]!;
    expect(h.quantity).toBe(11);
    expect(h.costBasis).toBeCloseTo(4050, 9);
  });

  it('return of capital reduces cost basis and credits cash; excess becomes realized gain', () => {
    const input = engine({
      base: 'USD',
      instruments: [AAPL],
      transactions: [
        ...base,
        tx({ date: '2020-06-01', type: 'RETURN_OF_CAPITAL', instrumentId: AAPL.id, amount: 1000, currency: 'USD' }),
        tx({ date: '2020-07-01', type: 'RETURN_OF_CAPITAL', instrumentId: AAPL.id, amount: 3500, currency: 'USD' }),
      ],
    });
    const h1 = computeHoldings(input, '2020-06-01')[0]!;
    expect(h1.costBasis).toBeCloseTo(3000, 9);
    expect(computeCash(input, '2020-06-01')[0]!.amount).toBeCloseTo(2000, 9);
    const h2 = computeHoldings(input, '2020-07-01')[0]!;
    expect(h2.costBasis).toBeCloseTo(0, 9);
    const r = realizedGains(input);
    expect(r).toHaveLength(1);
    expect(r[0]!.gain).toBeCloseTo(500, 9);
  });
});

describe('cash ledger and income', () => {
  const VOO = inst('ARCX:VOO', 'USD');
  const input = engine({
    base: 'COP',
    instruments: [VOO],
    fx: [
      { base: 'USD', quote: 'COP', source: 't', points: [{ date: '2024-01-01', rate: 4000 }, { date: '2024-03-01', rate: 4200 }] },
    ],
    prices: [prices(VOO.id, 'USD', { '2024-01-01': 400 })],
    transactions: [
      tx({ date: '2024-01-05', type: 'DEPOSIT', amount: 10_000_000, currency: 'COP' }),
      tx({ date: '2024-01-06', type: 'FX_CONVERSION', amount: 8_000_000, currency: 'COP', toCurrency: 'USD', toAmount: 1990, fees: 5_000 }),
      tx({ date: '2024-01-07', type: 'BUY', instrumentId: VOO.id, quantity: 4, price: 400, fees: 1, currency: 'USD' }),
      tx({ date: '2024-03-28', type: 'DIVIDEND', instrumentId: VOO.id, amount: 6, taxes: 1.8, currency: 'USD' }),
      tx({ date: '2024-03-29', type: 'INTEREST', amount: 10_000, taxes: 700, currency: 'COP' }),
      tx({ date: '2024-03-30', type: 'FEE', amount: 20_000, currency: 'COP' }),
      tx({ date: '2024-03-31', type: 'WITHDRAWAL', amount: 1_000_000, currency: 'COP' }),
    ],
  });

  it('multi-currency balances', () => {
    const cash = computeCash(input, '2024-03-31');
    const cop = cash.find((c) => c.currency === 'COP')!;
    const usd = cash.find((c) => c.currency === 'USD')!;
    // COP: 10M - 8M - 5k + (10k - 700) - 20k - 1M
    expect(cop.amount).toBeCloseTo(10_000_000 - 8_005_000 + 9_300 - 20_000 - 1_000_000, 6);
    // USD: 1990 - 1601 + 4.2
    expect(usd.amount).toBeCloseTo(393.2, 9);
    expect(usd.amountBase).toBeCloseTo(393.2 * 4200, 6);
  });

  it('income events net of withholding, in base at the payment date FX', () => {
    const ev = incomeEvents(input);
    expect(ev).toHaveLength(2);
    expect(ev[0]).toMatchObject({ type: 'DIVIDEND', gross: 6, taxes: 1.8, currency: 'USD' });
    expect(ev[0]!.net).toBeCloseTo(4.2, 12);
    expect(ev[0]!.netBase).toBeCloseTo(4.2 * 4200, 6);
    expect(ev[1]).toMatchObject({ type: 'INTEREST', net: 9300, netBase: 9300 });
    expect(incomeEvents(input, '2024-03-29')).toHaveLength(1);
  });

  it('external flows are only deposits and withdrawals (no implicit flows needed)', () => {
    const f = externalFlows(input);
    expect(f.map((x) => [x.kind, x.amount])).toEqual([
      ['DEPOSIT', 10_000_000],
      ['WITHDRAWAL', -1_000_000],
    ]);
  });

  it('base-currency cost uses market FX on trade date, or fxRateToBase when given', () => {
    expect(computeHoldings(input, '2024-01-31')[0]!.costBasisBase).toBeCloseTo(1601 * 4000, 6);
    const withRate = {
      ...input,
      transactions: input.transactions.map((t) => (t.type === 'BUY' ? { ...t, fxRateToBase: 4020 } : t)),
    };
    expect(computeHoldings(withRate, '2024-01-31')[0]!.costBasisBase).toBeCloseTo(1601 * 4020, 6);
    // When reporting in another currency, fxRateToBase (relative to the portfolio base) is ignored.
    const usdView = { ...withRate, baseCurrency: 'USD' };
    expect(computeHoldings(usdView, '2024-01-31')[0]!.costBasisBase).toBeCloseTo(1601, 9);
  });

  it('intra-day order: deposits before buys before sells before withdrawals', () => {
    const X = inst('X', 'USD');
    const sameDay = engine({
      base: 'USD',
      instruments: [X],
      options: { implicitCashFlows: false },
      transactions: [
        tx({ date: '2024-01-02', type: 'WITHDRAWAL', amount: 50, currency: 'USD' }),
        tx({ date: '2024-01-02', type: 'SELL', instrumentId: 'X', quantity: 1, price: 50, currency: 'USD' }),
        tx({ date: '2024-01-02', type: 'BUY', instrumentId: 'X', quantity: 2, price: 50, currency: 'USD' }),
        tx({ date: '2024-01-02', type: 'DEPOSIT', amount: 100, currency: 'USD' }),
      ],
    });
    expect(ledgerDiagnostics(sameDay)).toHaveLength(0);
    expect(computeHoldings(sameDay, '2024-01-02')[0]!.quantity).toBe(1);
    expect(computeCash(sameDay, '2024-01-02')).toHaveLength(0);
  });

  it('transfer in creates lots at the given price and counts as a flow at market value', () => {
    const t = engine({
      base: 'USD',
      instruments: [VOO],
      prices: [prices(VOO.id, 'USD', { '2024-01-01': 400 })],
      transactions: [tx({ date: '2024-01-10', type: 'TRANSFER_IN', instrumentId: VOO.id, quantity: 5, price: 300, currency: 'USD' })],
    });
    const h = computeHoldings(t, '2024-01-10')[0]!;
    expect(h.costBasis).toBe(1500);
    expect(externalFlows(t)[0]).toMatchObject({ kind: 'TRANSFER_IN', amount: 2000 });
    expect(valuePortfolio(t, '2024-01-10').totalMarketValueBase).toBe(2000);
  });

  it('oversell is capped and reported', () => {
    const t = engine({
      base: 'USD',
      instruments: [VOO],
      transactions: [
        tx({ date: '2024-01-10', type: 'BUY', instrumentId: VOO.id, quantity: 1, price: 300, currency: 'USD' }),
        tx({ date: '2024-01-11', type: 'SELL', instrumentId: VOO.id, quantity: 2, price: 310, currency: 'USD' }),
      ],
    });
    expect(computeHoldings(t, '2024-02-01')).toHaveLength(0);
    expect(realizedGains(t)[0]).toMatchObject({ quantity: 1, proceeds: 310, cost: 300 });
    expect(ledgerDiagnostics(t).map((d) => d.code)).toContain('OVERSELL');
  });

  it('fractional quantities close cleanly (no floating drift)', () => {
    const t = engine({
      base: 'USD',
      instruments: [VOO],
      transactions: [
        tx({ date: '2024-01-10', type: 'BUY', instrumentId: VOO.id, quantity: 0.1, price: 300, currency: 'USD' }),
        tx({ date: '2024-01-10', type: 'BUY', instrumentId: VOO.id, quantity: 0.2, price: 300, currency: 'USD' }),
        tx({ date: '2024-01-11', type: 'SELL', instrumentId: VOO.id, quantity: 0.3, price: 310, currency: 'USD' }),
      ],
    });
    expect(computeHoldings(t, '2024-02-01')).toHaveLength(0);
    expect(ledgerDiagnostics(t)).toHaveLength(0);
  });
});
