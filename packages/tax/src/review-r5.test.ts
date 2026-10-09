/**
 * Regression tests for the round-5 review (reviews/tax-r5.md): T52-T56.
 * Scenarios P1..P9 reproduce the reviewer's r5-*.ts scripts.
 */
import { describe, expect, it } from 'vitest';
import type { Instrument, Transaction } from '@pm/core';
import { ALL_INSTRUMENTS, tx } from './testing/fixtures';
import { createSimpleMarketData } from './testing/marketData';
import { brazilCryptoReport } from './brazil/crypto';
import { brazilForeignAnnualReport } from './brazil/exterior';
import { brazilBensDireitos } from './brazil/bensDireitos';
import { cryptoInTransitAt, routeCryptoByCustody } from './brazil/classify';

const BTC: Instrument = { id: 'CCC:BTC-USD', symbol: 'BTC-USD', name: 'Bitcoin USD', exchange: 'CCC', currency: 'USD', country: 'US', assetClass: 'crypto' };
const market = createSimpleMarketData({ fx: { 'USD/BRL': [['2015-01-01', 5]] } });
const inp = (transactions: Transaction[]) => ({ transactions, instruments: [...ALL_INSTRUMENTS, BTC], market });
const buy = (date: string, q: number, p: number, account?: string) => tx({ date, type: 'BUY', instrumentId: BTC.id, quantity: q, price: p, currency: 'USD', account });
const sell = (date: string, q: number, p: number, account?: string) => tx({ date, type: 'SELL', instrumentId: BTC.id, quantity: q, price: p, currency: 'USD', account });
const tout = (date: string, q: number, account?: string, extra: Partial<Transaction> = {}) =>
  tx({ date, type: 'TRANSFER_OUT', instrumentId: BTC.id, quantity: q, currency: 'USD', account, ...extra });
const tin = (date: string, q: number, account?: string) => tx({ date, type: 'TRANSFER_IN', instrumentId: BTC.id, quantity: q, currency: 'USD', account });
const run = (txs: Transaction[], year = 2026) => ({
  c: brazilCryptoReport(inp(txs), { year }),
  f: brazilForeignAnnualReport(inp(txs), { year }),
  b: brazilBensDireitos(inp(txs), { year }),
});
const units08 = (b: ReturnType<typeof brazilBensDireitos>) => b.items.filter((i) => i.grupo === '08').reduce((a, i) => a + (i.quantidade ?? 0), 0);

describe('T52 (alta) — a sale larger than one custody is split across custodies; no phantom units', () => {
  const base = [buy('2025-01-10', 0.5, 40_000, 'Mercado Bitcoin'), buy('2025-02-10', 0.5, 60_000, 'Binance')];
  it('P5b: 1.0 sold without account → 0.5 Brazil (GCAP, DARF withheld) + 0.5 abroad (Lei 14.754)', () => {
    const { c, f, b } = run([...base, sell('2026-03-10', 1, 90_000)]);
    expect(c.sales).toHaveLength(1);
    expect(c.sales[0]).toMatchObject({ quantity: 0.5, grossBrl: 225_000, costBrl: 100_000 });
    expect(c.months[0]).toMatchObject({ tax: 18_750, darfBlockedUnknownCustody: true });
    expect(f.sales[0]).toMatchObject({ quantity: 0.5, proceedsBrl: 225_000, costBrl: 150_000 });
    expect(f.totals.taxDueBrl).toBeCloseTo(11_250, 6);
    expect(units08(b)).toBe(0);
    expect(c.issues.map((i) => i.code)).toContain('CRYPTO_SALE_SPLIT_ACROSS_CUSTODY');
  });
  it('P5: 1.0 sold naming Binance (0.5) → Binance part confirmed abroad, remainder from Brazil (DARF withheld)', () => {
    const { c, f, b } = run([...base, sell('2026-03-10', 1, 90_000, 'Binance')]);
    expect(f.sales[0]!.quantity).toBe(0.5);
    expect(c.sales[0]!.quantity).toBe(0.5);
    expect(c.months[0]!.darfBlockedUnknownCustody).toBe(true);
    expect(units08(b)).toBe(0);
    expect(c.sales.length + f.sales.length).toBe(2);
  });
  it('every sold unit is taxed under some regime', () => {
    const r = routeCryptoByCustody(inp([...base, sell('2026-03-10', 1, 90_000)]));
    const sold = r.input.transactions.filter((t) => t.type === 'SELL').reduce((a, t) => a + (t.quantity ?? 0), 0);
    expect(sold).toBeCloseTo(1, 12);
  });
});

describe('T53 — robust transfer matching', () => {
  it('P1: one OUT split into two INs (Binance 0.5 + Ledger 0.5) → Binance sale cost R$ 100k', () => {
    const { f } = run([buy('2025-01-10', 1, 40_000, 'Mercado Bitcoin'), tout('2025-06-01', 1, 'Mercado Bitcoin'), tin('2025-06-01', 0.5, 'Binance'), tin('2025-06-01', 0.5, 'Ledger'), sell('2026-03-10', 0.5, 90_000, 'Binance')]);
    expect(f.sales[0]).toMatchObject({ costBrl: 100_000, gainBrl: 125_000 });
    expect(f.totals.taxDueBrl).toBeCloseTo(18_750, 6);
  });
  it('many-to-one: two OUTs of 0.5 arrive as one IN of 1.0', () => {
    const { f } = run([
      buy('2025-01-10', 0.5, 40_000, 'Mercado Bitcoin'),
      buy('2025-01-11', 0.5, 40_000, 'Foxbit'),
      tout('2025-06-01', 0.5, 'Mercado Bitcoin'),
      tout('2025-06-01', 0.5, 'Foxbit'),
      tin('2025-06-02', 1, 'Binance'),
      sell('2026-03-10', 1, 90_000, 'Binance'),
    ]);
    expect(f.sales[0]!.costBrl).toBeCloseTo(200_000, 6);
  });
  it('P3: IN listed before OUT on the same day → cost R$ 200k', () => {
    const { f } = run([buy('2025-01-10', 1, 40_000, 'Mercado Bitcoin'), tin('2025-06-01', 1, 'Binance'), tout('2025-06-01', 1, 'Mercado Bitcoin'), sell('2026-03-10', 1, 90_000, 'Binance')]);
    expect(f.sales[0]!.costBrl).toBeCloseTo(200_000, 6);
  });
  it('P2/P7: network fee (0.1% and 3%) → full source cost carried, fee flagged when > 2%', () => {
    const p2 = run([buy('2025-01-10', 1, 40_000, 'Mercado Bitcoin'), tout('2025-06-01', 1, 'Mercado Bitcoin', { fees: 20 }), tin('2025-06-01', 0.999, 'Binance'), sell('2026-03-10', 0.999, 90_000, 'Binance')]);
    expect(p2.f.sales[0]!.costBrl).toBeCloseTo(200_000, 6);
    const p7 = run([buy('2025-01-10', 1, 40_000, 'Mercado Bitcoin'), tout('2025-06-01', 1, 'Mercado Bitcoin'), tin('2025-06-03', 0.97, 'Binance'), sell('2026-03-10', 0.97, 90_000, 'Binance')]);
    expect(p7.f.sales[0]!.costBrl).toBeCloseTo(200_000, 6);
    expect(p7.f.issues.map((i) => i.code)).toContain('TRANSFER_FEE_ASSUMED');
  });
  it('P8: IN 11 days after the OUT → still matched (window configurable)', () => {
    const { f } = run([buy('2025-01-10', 1, 40_000, 'Mercado Bitcoin'), tout('2025-06-01', 1, 'Mercado Bitcoin'), tin('2025-06-12', 1, 'Binance'), sell('2026-03-10', 1, 90_000, 'Binance')]);
    expect(f.sales[0]!.costBrl).toBeCloseTo(200_000, 6);
    const r = routeCryptoByCustody(inp([buy('2025-01-10', 1, 40_000, 'Mercado Bitcoin'), tout('2025-06-01', 1, 'Mercado Bitcoin'), tin('2025-06-12', 1, 'Binance')]), { transferWindowDays: 5 });
    expect(r.issues.map((i) => i.code)).toContain('TRANSFER_MATCHED_LATE');
  });
  it('an IN with no OUT and no value is never silently cost 0: flagged', () => {
    const r = routeCryptoByCustody(inp([tin('2025-06-01', 1, 'Binance')]));
    expect(r.issues.find((i) => i.code === 'TRANSFER_COST_UNKNOWN')!.message).toContain('ZERO');
  });
});

describe('T54 — same-day transfers pair by custody; OUTs before INs', () => {
  it('P4: MB→Ledger and Kraken→Binance the same day → Ledger R$ 200k (BR, DARF withheld), Binance R$ 300k', () => {
    const { c, f } = run([
      buy('2025-01-10', 1, 40_000, 'Mercado Bitcoin'),
      buy('2025-02-10', 1, 60_000, 'Kraken'),
      tout('2025-06-01', 1, 'Mercado Bitcoin'),
      tout('2025-06-01', 1, 'Kraken'),
      tin('2025-06-01', 1, 'Binance'),
      tin('2025-06-01', 1, 'Ledger'),
      sell('2026-03-10', 1, 90_000, 'Ledger'),
      sell('2026-03-10', 1, 90_000, 'Binance'),
    ]);
    expect(c.sales[0]!.costBrl).toBeCloseTo(200_000, 6);
    expect(c.months[0]).toMatchObject({ tax: 37_500, darfBlockedUnknownCustody: true });
    expect(f.sales[0]!.costBrl).toBeCloseTo(300_000, 6);
    expect(f.totals.taxDueBrl).toBeCloseTo(22_500, 6);
  });
});

describe('T55 — units in transit at 31/12 stay in Bens e Direitos', () => {
  it('P9: OUT 30-dec-2025 from Mercado Bitcoin, IN 2-jan-2026 at Binance → 2025 shows 1 BTC at R$ 200k in transit', () => {
    const txs = [buy('2025-01-10', 1, 40_000, 'Mercado Bitcoin'), tout('2025-12-30', 1, 'Mercado Bitcoin'), tin('2026-01-02', 1, 'Binance')];
    const b25 = brazilBensDireitos(inp(txs), { year: 2025 });
    const transit = b25.items.find((i) => i.emTransito)!;
    expect(transit).toMatchObject({ grupo: '08', localizacao: 'Brasil', quantidade: 1, situacaoAtual: 200_000 });
    expect(transit.discriminacao).toContain('EM TRÂNSITO');
    const r = routeCryptoByCustody(inp(txs));
    expect(cryptoInTransitAt(r, '2025-12-31')[0]!.units).toBe(1);
    expect(cryptoInTransitAt(r, '2026-01-02')).toEqual([]);
    const b26 = brazilBensDireitos(inp(txs), { year: 2026 });
    expect(b26.items.find((i) => i.emTransito)).toMatchObject({ situacaoAnterior: 200_000, situacaoAtual: 0 });
    expect(units08(b26)).toBe(1);
  });
});

describe('T56 — sale without recorded units: "custo pendente", counted in the month', () => {
  it('pending-cost sale counts toward the R$ 35k limit and withholds the DARF', () => {
    const { c } = run([
      buy('2025-01-10', 0.1, 40_000, 'Mercado Bitcoin'),
      sell('2026-03-10', 0.1, 90_000, 'Mercado Bitcoin'), // R$ 45,000 with gain
      tx({ date: '2026-03-12', type: 'SELL', instrumentId: BTC.id, quantity: 0.02, price: 90_000, currency: 'USD', account: 'Foxbit' }), // no units anywhere
    ]);
    const pending = c.sales.find((s) => s.pendingCost)!;
    expect(pending).toMatchObject({ grossBrl: 9_000, gainBrl: 0 });
    expect(c.months[0]).toMatchObject({ salesBrl: 54_000, exempt: false, pendingCost: true, darfBlockedUnknownCustody: true });
    expect(c.issues.map((i) => i.code)).toContain('CRYPTO_SALE_COST_PENDING');
  });
  it('P6: orphan OUT then sale from Ledger → arrival inferred, cost carried (not phantom, not zero)', () => {
    const { c } = run([buy('2025-01-10', 1, 40_000, 'Mercado Bitcoin'), tout('2025-06-01', 1, 'Mercado Bitcoin'), sell('2026-03-10', 1, 90_000, 'Ledger')]);
    expect(c.sales[0]).toMatchObject({ costBrl: 200_000, gainBrl: 250_000 });
    expect(c.issues.map((i) => i.code)).toContain('TRANSFER_IN_INFERRED');
  });
});
