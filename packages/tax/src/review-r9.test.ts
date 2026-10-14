/**
 * Round-9 review (reviews/tax-r9.md): T71, T72 and the core ↔ tax parity of corporate
 * reorganizations. The parity tests run the reviewer's scenarios (r9-corporate.ts, r9-corp2.ts)
 * through `@pm/core`'s ledger (computeHoldings / realizedGains) and through the tax ledgers
 * (common/corporate.ts rules) and assert the same quantities and cost basis, lot by lot where the
 * method is FIFO — so a future divergence between core and tax fails here.
 */
import { describe, expect, it } from 'vitest';
import { computeHoldings, realizedGains, type EngineInput, type Instrument, type Transaction } from '@pm/core';
import { ALL_INSTRUMENTS, tx } from './testing/fixtures';
import { createSimpleMarketData } from './testing/marketData';
import { buildColombiaTaxReport } from './colombia/report';
import { runBrazilB3Ledger } from './brazil/ledger';
import { brazilBensDireitos } from './brazil/bensDireitos';
import { brazilForeignAnnualReport } from './brazil/exterior';
import { brazilCryptoReport } from './brazil/crypto';
import { brazilProventosReport } from './brazil/proventos';
import { brazilIrpfmEstimate } from './brazil/irpfm';

const r2 = (n: number) => Math.round(n * 100) / 100;
const mk = (id: string, country: string, currency: string, assetClass: Instrument['assetClass'] = 'equity'): Instrument => {
  const [exchange, symbol] = id.split(':') as [string, string];
  return { id, symbol, name: symbol, exchange, currency, country, assetClass };
};
const portfolio = (baseCurrency: string, costMethod: 'FIFO' | 'AVERAGE') =>
  ({ id: 'p1', name: 'p', baseCurrency, costMethod, createdAt: '2020-01-01' }) as unknown as EngineInput['portfolio'];
const sym = (id: string) => id.split(':')[1]!;

describe('core ↔ tax parity of reorganizations (MERGER with cash → TICKER_CHANGE → SPINOFF)', () => {
  it('Colombia (FIFO, COP): every realized lot and every remaining lot match core to the cent', () => {
    const X = mk('XBOG:XAAA', 'CO', 'COP');
    const Y = mk('XBOG:YBBB', 'CO', 'COP');
    const Z = mk('XBOG:ZCCC', 'CO', 'COP');
    const W = mk('XBOG:WDDD', 'CO', 'COP');
    const instruments = [...ALL_INSTRUMENTS, X, Y, Z, W];
    const market = createSimpleMarketData({
      prices: { [Y.id]: [['2024-03-01', 40]], [Z.id]: [['2024-06-01', 42], ['2025-12-31', 50]], [W.id]: [['2024-09-01', 30], ['2025-12-31', 31]], [X.id]: [['2024-02-29', 19]] },
    });
    const transactions: Transaction[] = [
      tx({ id: 'b1', date: '2022-01-10', type: 'BUY', instrumentId: X.id, quantity: 1000, price: 10, currency: 'COP' }),
      tx({ id: 'b2', date: '2023-05-10', type: 'BUY', instrumentId: X.id, quantity: 500, price: 16, currency: 'COP' }),
      tx({ id: 'm1', date: '2024-03-01', type: 'SPLIT', subtype: 'MERGER', instrumentId: X.id, targetInstrumentId: Y.id, ratio: 0.5, amount: 3000, currency: 'COP' }),
      tx({ id: 'b3', date: '2024-03-01', type: 'BUY', instrumentId: Y.id, quantity: 100, price: 40, currency: 'COP' }),
      tx({ id: 'tc', date: '2024-06-01', type: 'SPLIT', subtype: 'TICKER_CHANGE', instrumentId: Y.id, targetInstrumentId: Z.id, ratio: 1, currency: 'COP' }),
      tx({ id: 'sp', date: '2024-09-01', type: 'SPLIT', subtype: 'SPINOFF', instrumentId: Z.id, targetInstrumentId: W.id, ratio: 0.25, costFraction: 0.2, currency: 'COP' }),
      tx({ id: 's1', date: '2025-03-10', type: 'SELL', instrumentId: Z.id, quantity: 600, price: 45, currency: 'COP' }),
      tx({ id: 's2', date: '2025-04-10', type: 'SELL', instrumentId: W.id, quantity: 100, price: 32, currency: 'COP' }),
    ];
    const engine = { portfolio: portfolio('COP', 'FIFO'), transactions, instruments, market };
    const core = realizedGains(engine, '2024-01-01', '2025-12-31').map((g) => [sym(g.instrumentId), g.sellDate, g.openDate, r2(g.quantity), r2(g.proceeds), r2(g.cost)]);
    const t24 = buildColombiaTaxReport({ transactions, instruments, market }, { year: 2024, realization: 'trade' });
    const t25 = buildColombiaTaxReport({ transactions, instruments, market }, { year: 2025, realization: 'trade' });
    const tax = [...t24.ventas.rows, ...t25.ventas.rows].map((s) => [s.symbol, s.sellDate, s.openDate, r2(s.quantity), r2(s.proceedsCop), r2(s.costCop)]);
    expect(tax).toEqual(core);
    expect(core).toHaveLength(5);

    const coreLots = computeHoldings(engine, '2025-12-31')
      .map((h) => [sym(h.instrumentId), r2(h.quantity), r2(h.costBasis), h.lots.map((l) => [l.openDate, r2(l.quantity), r2(l.unitCost * l.quantity)])])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    const taxLots = t25.patrimonio.rows
      .filter((r) => r.kind === 'inversion')
      .map((r) => [r.symbol, r2(r.quantity), r2(r.fiscalValueCop), (r.lots ?? []).map((l) => [l.openDate, r2(l.quantity), r2(l.costCop)])])
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    expect(taxLots).toEqual(coreLots);
  });

  it('B3 (preço médio, BRL, accounts, merger cash without target price): realized cost and positions match core', () => {
    const X = mk('BVMF:XAAA3', 'BR', 'BRL');
    const Y = mk('BVMF:YBBB3', 'BR', 'BRL');
    const Z = mk('BVMF:ZCCC3', 'BR', 'BRL');
    const W = mk('BVMF:WDDD3', 'BR', 'BRL');
    const instruments = [...ALL_INSTRUMENTS, X, Y, Z, W];
    const market = createSimpleMarketData({ prices: { [Z.id]: [['2024-06-01', 42], ['2025-12-31', 50]], [W.id]: [['2024-09-01', 30], ['2025-12-31', 31]] } });
    const transactions: Transaction[] = [
      tx({ id: 'B1', date: '2022-01-10', type: 'BUY', instrumentId: X.id, quantity: 1000, price: 10, account: 'XP', currency: 'BRL' }),
      tx({ id: 'B2', date: '2023-05-10', type: 'BUY', instrumentId: X.id, quantity: 500, price: 16, account: 'BTG', currency: 'BRL' }),
      tx({ id: 'M1', date: '2024-03-01', type: 'SPLIT', subtype: 'MERGER', instrumentId: X.id, targetInstrumentId: Y.id, ratio: 0.5, amount: 3000, currency: 'BRL' }),
      tx({ id: 'TC', date: '2024-06-01', type: 'SPLIT', subtype: 'TICKER_CHANGE', instrumentId: Y.id, targetInstrumentId: Z.id, ratio: 1, currency: 'BRL' }),
      tx({ id: 'SP', date: '2024-09-01', type: 'SPLIT', subtype: 'SPINOFF', instrumentId: Z.id, targetInstrumentId: W.id, ratio: 0.25, costFraction: 0.2, currency: 'BRL' }),
      tx({ id: 'S1', date: '2025-03-10', type: 'SELL', instrumentId: Z.id, quantity: 300, price: 45, account: 'BTG', currency: 'BRL' }),
      tx({ id: 'S2', date: '2025-04-10', type: 'SELL', instrumentId: W.id, quantity: 100, price: 32, account: 'XP', currency: 'BRL' }),
    ];
    const engine = { portfolio: portfolio('BRL', 'AVERAGE'), transactions, instruments, market };
    // Core reports one row per lot piece; preço médio aggregates per sale: compare per (asset, date).
    const agg = (rows: [string, string, number, number, number][]) => {
      const m = new Map<string, number[]>();
      for (const [s, d, q, p, c] of rows) {
        const v = m.get(`${s}|${d}`) ?? [0, 0, 0];
        m.set(`${s}|${d}`, [v[0]! + q, v[1]! + p, v[2]! + c]);
      }
      return [...m.entries()].map(([k, v]) => [k, ...v.map(r2)]).sort();
    };
    const core = agg(realizedGains(engine, '2024-01-01', '2025-12-31').map((g) => [sym(g.instrumentId), g.sellDate, g.quantity, g.proceeds, g.cost]));
    const led = runBrazilB3Ledger({ transactions, instruments, market });
    const tax = agg(led.trades.map((t) => [t.symbol, t.date, t.quantity, t.netProceeds, t.cost]));
    expect(tax).toEqual(core);
    const coreH = computeHoldings(engine, '2025-12-31').map((h) => [sym(h.instrumentId), r2(h.quantity), r2(h.costBasis)]).sort();
    // Tax separates the fraction of the spin-off ratio for the leilão (T71): position + fraction = core.
    const tot = new Map<string, [number, number]>();
    for (const x of [...led.positions.map((p) => [p.symbol, p.quantity, p.totalCost] as const), ...led.pendingFractions.map((f) => [f.symbol, f.quantity, f.cost] as const)]) {
      const v = tot.get(x[0]) ?? [0, 0];
      tot.set(x[0], [v[0] + x[1], v[1] + x[2]]);
    }
    const taxH = [...tot.entries()].map(([k, [q, c]]) => [k, r2(q), r2(c)]).sort();
    expect(taxH).toEqual(coreH);
    expect(led.pendingFractions.map((f) => [f.symbol, f.quantity])).toEqual([['WDDD3', 0.5]]);
  });

  it('B3 merger 1/3 on 1.000 (E1): core keeps 0,333 at R$ 10; tax separates it for the leilão — same total', () => {
    const A = mk('BVMF:AAAA3', 'BR', 'BRL');
    const B = mk('BVMF:BBBB3', 'BR', 'BRL');
    const instruments = [...ALL_INSTRUMENTS, A, B];
    const market = createSimpleMarketData({ prices: { [B.id]: [['2024-03-01', 30]] } });
    const transactions: Transaction[] = [
      tx({ date: '2023-01-10', type: 'BUY', instrumentId: A.id, quantity: 1000, price: 10, currency: 'BRL' }),
      tx({ date: '2024-03-01', type: 'SPLIT', subtype: 'MERGER', instrumentId: A.id, targetInstrumentId: B.id, ratio: 1 / 3, currency: 'BRL' }),
      tx({ date: '2024-03-05', type: 'SELL', instrumentId: B.id, quantity: 333, price: 31, currency: 'BRL' }),
    ];
    const engine = { portfolio: portfolio('BRL', 'AVERAGE'), transactions, instruments, market };
    const coreR = realizedGains(engine).map((g) => [r2(g.quantity), r2(g.cost)]);
    const led = runBrazilB3Ledger({ transactions, instruments, market });
    expect(led.trades.map((t) => [r2(t.quantity), r2(t.cost)])).toEqual(coreR);
    const coreH = computeHoldings(engine, '2024-12-31').map((h) => [h.instrumentId, Math.round(h.quantity * 1000) / 1000, r2(h.costBasis)]);
    const taxH = [...led.positions.map((p) => [p.instrumentId, p.quantity, p.totalCost]), ...led.pendingFractions.map((f) => [f.instrumentId, f.quantity, f.cost])].map(
      ([i, q, c]) => [i, Math.round((q as number) * 1000) / 1000, r2(c as number)],
    );
    expect(taxH).toEqual(coreH);
  });

  it('foreign merger with USD cash and ratio 2 (E2): cost in USD and in BRL match core', () => {
    const A = mk('XNYS:AAA', 'US', 'USD');
    const B = mk('XNYS:BBB', 'US', 'USD');
    const instruments = [...ALL_INSTRUMENTS, A, B];
    const market = createSimpleMarketData({ fx: { 'USD/BRL': [['2020-01-01', 5], ['2025-06-01', 6]] }, prices: { [B.id]: [['2025-06-01', 50]] } });
    const transactions: Transaction[] = [
      tx({ date: '2024-01-10', type: 'BUY', instrumentId: A.id, quantity: 100, price: 100, currency: 'USD' }),
      tx({ date: '2025-06-01', type: 'SPLIT', subtype: 'MERGER', instrumentId: A.id, targetInstrumentId: B.id, ratio: 2, amount: 1000, currency: 'USD' }),
    ];
    const engine = { portfolio: portfolio('BRL', 'AVERAGE'), transactions, instruments, market };
    const core = realizedGains(engine).map((g) => [r2(g.proceeds), r2(g.cost), r2(g.proceedsBase), r2(g.costBase)]);
    const f = brazilForeignAnnualReport({ transactions, instruments, market }, { year: 2025 });
    expect(f.sales.map((s) => [r2(s.proceedsFx), r2(s.costFx), r2(s.proceedsBrl), r2(s.costBrl)])).toEqual(core);
    const coreH = computeHoldings(engine, '2025-12-31').map((h) => [sym(h.instrumentId), h.quantity, r2(h.costBasis), r2(h.costBasisBase)]);
    expect(f.positions.map((p) => [p.symbol, p.quantity, r2(p.costFx), r2(p.costBrl)])).toEqual(coreH);
  });

  it('crypto MATIC → POL across custodies: total quantity and BRL cost match core', () => {
    const MATIC = mk('CCC:MATIC-USD', 'US', 'USD', 'crypto');
    const POL = mk('CCC:POL-USD', 'US', 'USD', 'crypto');
    const instruments = [...ALL_INSTRUMENTS, MATIC, POL];
    const market = createSimpleMarketData({ fx: { 'USD/BRL': [['2015-01-01', 5]] } });
    const transactions: Transaction[] = [
      tx({ date: '2024-01-10', type: 'BUY', instrumentId: MATIC.id, quantity: 1000, price: 1, currency: 'USD', account: 'Mercado Bitcoin' }),
      tx({ date: '2024-02-10', type: 'BUY', instrumentId: MATIC.id, quantity: 1000, price: 2, currency: 'USD', account: 'Binance' }),
      tx({ date: '2024-09-04', type: 'SPLIT', subtype: 'TICKER_CHANGE', instrumentId: MATIC.id, targetInstrumentId: POL.id, ratio: 1, currency: 'USD' }),
    ];
    const engine = { portfolio: portfolio('BRL', 'AVERAGE'), transactions, instruments, market };
    const coreH = computeHoldings(engine, '2025-12-31').map((h) => [sym(h.instrumentId), h.quantity, r2(h.costBasisBase)]);
    const br = brazilCryptoReport({ transactions, instruments, market }, { year: 2025 }).positions;
    const ext = brazilForeignAnnualReport({ transactions, instruments, market }, { year: 2025 }).positions;
    const tot = [...br.map((p) => [p.quantity, p.costBrl]), ...ext.map((p) => [p.quantity, p.costBrl])].reduce((a, [q, c]) => [a[0]! + q!, a[1]! + c!], [0, 0]);
    expect([['POL-USD', tot[0], r2(tot[1]!)]]).toEqual(coreH);
  });
});

describe('T71 — fractional exchange ratio in a B3 merger: fraction separated for the leilão', () => {
  const A = mk('BVMF:AAAA3', 'BR', 'BRL');
  const B = mk('BVMF:BBBB3', 'BR', 'BRL');
  const instruments = [...ALL_INSTRUMENTS, A, B];
  const market = createSimpleMarketData({});
  const base: Transaction[] = [
    tx({ date: '2023-01-10', type: 'BUY', instrumentId: A.id, quantity: 1000, price: 10, currency: 'BRL' }),
    tx({ date: '2024-03-01', type: 'SPLIT', subtype: 'MERGER', instrumentId: A.id, targetInstrumentId: B.id, ratio: 1 / 3, currency: 'BRL' }),
  ];
  it('E1: 333 in the position, 0,333 pending with FRACAO_GRUPAMENTO on the new ticker; Bens e Direitos without fractions', () => {
    const led = runBrazilB3Ledger({ transactions: base, instruments, market });
    expect(led.positions.map((p) => [p.symbol, p.quantity, r2(p.totalCost)])).toEqual([['BBBB3', 333, 9_990]]);
    expect(led.pendingFractions.map((f) => [f.symbol, Math.round(f.quantity * 1000) / 1000, r2(f.cost)])).toEqual([['BBBB3', 0.333, 10]]);
    const w = led.issues.find((i) => i.code === 'FRACAO_GRUPAMENTO')!;
    expect(w.instrumentId).toBe(B.id);
    expect(w.message).toContain('leilão');
    const b = brazilBensDireitos({ transactions: base, instruments, market }, { year: 2024 });
    expect(b.items.find((i) => i.ticker === 'BBBB3')!.quantidade).toBe(333);
  });
  it('the leilão sale of the fraction is a taxable alienation with the fraction cost', () => {
    const led = runBrazilB3Ledger({
      transactions: [...base, tx({ date: '2024-04-10', type: 'SELL', instrumentId: B.id, quantity: 1 / 3, amount: 12, currency: 'BRL' })],
      instruments,
      market,
    });
    const t = led.trades.find((x) => x.date === '2024-04-10')!;
    expect(r2(t.cost)).toBe(10);
    expect(r2(t.result)).toBe(2);
    expect(led.pendingFractions).toHaveLength(0);
  });
});

describe('T72 — estimated JCP withholding is never credited', () => {
  const ITSA = 'BVMF:ITSA4';
  const market = createSimpleMarketData({});
  const prov = brazilProventosReport(
    {
      transactions: [
        tx({ date: '2026-05-20', type: 'DIVIDEND', subtype: 'JCP', instrumentId: ITSA, amount: 825, amountIsNet: true, currency: 'BRL' }),
        tx({ date: '2026-06-20', type: 'DIVIDEND', subtype: 'JCP', instrumentId: ITSA, amount: 1000, taxes: 175, currency: 'BRL' }),
      ],
      instruments: ALL_INSTRUMENTS,
      market,
    },
    { year: 2026 },
  );
  it('r9-net: totals separate certified (jcpIrrf) from estimated (jcpIrrfEstimated)', () => {
    expect(prov.totals.jcpGross).toBeCloseTo(2_000, 6);
    expect(prov.totals.jcpIrrf).toBeCloseTo(175, 6);
    expect(prov.totals.jcpIrrfEstimated).toBeCloseTo(175, 6);
  });
  it('IRPFM credits only the certified IRRF; the estimate is listed as not applied', () => {
    const e = brazilIrpfmEstimate({ year: 2026, proventos: prov });
    expect(e.credits.find((c) => c.label === 'IRRF sobre JCP')!.value).toBeCloseTo(175, 6);
    expect(e.creditsTotal).toBeCloseTo(175, 6);
    expect(e.estimatedCreditsNotApplied).toEqual([{ label: 'IRRF sobre JCP estimado (JCP registrado líquido)', value: expect.closeTo(175, 6) }]);
  });
});
