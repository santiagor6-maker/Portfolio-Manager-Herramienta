/**
 * Regression tests for the round-6 review (reviews/tax-r6.md): T57-T60.
 * Scenarios Q2b, Q4, Q4b, Q5, Q7, Q8 reproduce the reviewer's r6-*.ts scripts.
 */
import { describe, expect, it } from 'vitest';
import type { Instrument, Transaction } from '@pm/core';
import { ALL_INSTRUMENTS, tx } from './testing/fixtures';
import { createSimpleMarketData } from './testing/marketData';
import { brazilCryptoReport, type CryptoOptions } from './brazil/crypto';
import { brazilForeignAnnualReport } from './brazil/exterior';
import { brazilBensDireitos } from './brazil/bensDireitos';
import { cryptoInTransitAt, routeCryptoByCustody } from './brazil/classify';

const BTC: Instrument = { id: 'CCC:BTC-USD', symbol: 'BTC-USD', name: 'Bitcoin USD', exchange: 'CCC', currency: 'USD', country: 'US', assetClass: 'crypto' };
const ETH: Instrument = { id: 'CCC:ETH-USD', symbol: 'ETH-USD', name: 'Ethereum USD', exchange: 'CCC', currency: 'USD', country: 'US', assetClass: 'crypto' };
const market = createSimpleMarketData({ fx: { 'USD/BRL': [['2015-01-01', 5]] } });
const inp = (transactions: Transaction[]) => ({ transactions, instruments: [...ALL_INSTRUMENTS, BTC, ETH], market });
const mk =
  (type: Transaction['type'], inst = BTC) =>
  (date: string, q: number, account?: string, extra: Partial<Transaction> = {}) =>
    tx({ date, type, instrumentId: inst.id, quantity: q, currency: 'USD', account, ...extra });
const buy = (date: string, q: number, p: number, account?: string, inst = BTC) => mk('BUY', inst)(date, q, account, { price: p });
const sell = (date: string, q: number, p: number, account?: string, inst = BTC) => mk('SELL', inst)(date, q, account, { price: p });
const tout = mk('TRANSFER_OUT');
const tin = mk('TRANSFER_IN');
const codes = (issues: { level: string; code: string }[]) => issues.map((i) => `${i.level}:${i.code}`);
const run = (txs: Transaction[], o: Partial<CryptoOptions> = {}, year = 2026) => ({
  c: brazilCryptoReport(inp(txs), { year, ...o }),
  f: brazilForeignAnnualReport(inp(txs), { year, transferBasis: o.transferBasis, confirmedTransfers: o.confirmedTransfers, transferMaxLateDays: o.transferMaxLateDays }),
});

describe('T57 — an IN without matching OUT never yields an issued DARF on an unconfirmed cost', () => {
  it('Q4: deposit without price, then sale → tax shown (cost pending), DARF withheld', () => {
    const { c } = run([tin('2025-05-01', 1, 'Mercado Bitcoin'), sell('2026-03-10', 1, 90_000, 'Mercado Bitcoin')]);
    expect(c.months[0]).toMatchObject({ salesBrl: 450_000, tax: 67_500, darfBlockedUnknownCustody: true, darfHeldAmount: 67_500 });
    expect(c.months[0]!.darf).toBeUndefined();
    expect(c.sales[0]).toMatchObject({ costBrl: 0, provisionalCost: true, held: true });
    const unk = c.issues.find((i) => i.code === 'TRANSFER_COST_UNKNOWN')!;
    expect(unk.message).toContain('PENDENTE');
    expect(unk.message).toContain('DARF retido');
    expect(codes(c.issues)).toContain('warning:CRYPTO_SALE_COST_PROVISIONAL');
  });
  it('Q4b: deposit WITH price → value used only as provisional cost, DARF withheld', () => {
    const { c } = run([tin('2025-05-01', 1, 'Mercado Bitcoin', { price: 60_000 }), sell('2026-03-10', 1, 90_000, 'Mercado Bitcoin')]);
    expect(c.sales[0]).toMatchObject({ costBrl: 300_000, gainBrl: 150_000, provisionalCost: true });
    expect(c.months[0]).toMatchObject({ tax: 22_500, darfHeldAmount: 22_500, darfBlockedUnknownCustody: true });
    expect(c.months[0]!.darf).toBeUndefined();
    expect(c.issues.find((i) => i.code === 'TRANSFER_COST_UNKNOWN')!.message).toContain('PROVISÓRIO');
  });
  it('confirming the cost (transferBasis) releases the DARF with the confirmed cost', () => {
    const d = tin('2025-05-01', 1, 'Mercado Bitcoin', { price: 60_000 });
    const { c } = run([d, sell('2026-03-10', 1, 90_000, 'Mercado Bitcoin')], { transferBasis: { [d.id]: { openDate: '2020-01-10', unitCost: 10_000 } } });
    expect(c.sales[0]).toMatchObject({ costBrl: 50_000, gainBrl: 400_000 });
    expect(c.sales[0]!.provisionalCost).toBeUndefined();
    expect(c.months[0]!.darf?.amount).toBe(60_000);
    expect(c.months[0]!.darfHeldAmount).toBeUndefined();
    expect(codes(c.issues)).not.toContain('warning:TRANSFER_COST_UNKNOWN');
  });
  it('a structured note "[custo: …]" also confirms the deposit cost', () => {
    const { c } = run([tin('2025-05-01', 1, 'Mercado Bitcoin', { note: '[custo: 2020-01-10 @ 10000]' }), sell('2026-03-10', 1, 90_000, 'Mercado Bitcoin')]);
    expect(c.sales[0]!.costBrl).toBeCloseTo(50_000, 6);
    expect(c.months[0]!.darf?.amount).toBe(60_000);
  });
  it('provisional units keep the flag through a later transfer and a partial sale', () => {
    const { c } = run([
      buy('2025-01-10', 1, 40_000, 'Mercado Bitcoin'),
      tin('2025-05-01', 1, 'Foxbit'),
      tout('2025-06-01', 1, 'Foxbit'),
      tin('2025-06-02', 1, 'Mercado Bitcoin'),
      sell('2026-03-10', 0.5, 90_000, 'Mercado Bitcoin'),
    ]);
    // MB holds 1 confirmed + 1 provisional (average cost): the sale draws on both → provisional.
    expect(c.sales[0]!.provisionalCost).toBe(true);
    expect(c.months[0]!.darf).toBeUndefined();
  });
});

describe('T58 — late pairing is capped; beyond the cap it is only proposed and the IN value is kept', () => {
  const q5 = () => [buy('2024-06-10', 1, 40_000, 'Mercado Bitcoin'), tout('2025-01-15', 1, 'Mercado Bitcoin'), tin('2025-12-01', 1, 'Binance', { price: 100_000 }), sell('2026-03-10', 1, 90_000, 'Binance')];
  it('Q5: 320 days apart → not paired; proposal; IN value (provisional) used as cost', () => {
    const txs = q5();
    const { f } = run(txs);
    expect(f.sales[0]!.costBrl).toBeCloseTo(500_000, 6);
    expect(f.sales[0]!.provisionalCost).toBe(true);
    expect(codes(f.issues)).toContain('warning:TRANSFER_MATCH_PROPOSED');
    expect(codes(f.issues)).not.toContain('warning:TRANSFER_MATCHED_LATE');
    const r = routeCryptoByCustody(inp(txs));
    expect(r.issues.find((i) => i.code === 'TRANSFER_MATCH_PROPOSED')!.message).toContain('2025-01-15');
    // The OUT stays in transit until the user decides.
    expect(cryptoInTransitAt(r, '2025-12-31').reduce((a, x) => a + x.units, 0)).toBeCloseTo(1, 9);
  });
  it('Q5 confirmed by the user (confirmedTransfers) → origin cost carried, no proposal, not provisional', () => {
    const txs = q5();
    const { f } = run(txs, { confirmedTransfers: { [txs[2]!.id]: txs[1]!.id } });
    expect(f.sales[0]!.costBrl).toBeCloseTo(200_000, 6);
    expect(f.sales[0]!.provisionalCost).toBeUndefined();
    expect(codes(f.issues)).not.toContain('warning:TRANSFER_MATCH_PROPOSED');
    expect(codes(f.issues)).not.toContain('warning:TRANSFER_COST_UNKNOWN');
  });
  it('between the preferred window and the cap: paired, warning level, mentions the IN own value', () => {
    const txs = [buy('2025-01-10', 1, 40_000, 'Mercado Bitcoin'), tout('2025-03-01', 1, 'Mercado Bitcoin'), tin('2025-05-01', 1, 'Binance', { price: 100_000 })];
    const r = routeCryptoByCustody(inp(txs));
    const late = r.issues.find((i) => i.code === 'TRANSFER_MATCHED_LATE')!;
    expect(late.level).toBe('warning');
    expect(late.message).toContain('100000.00');
    expect(r.transferBasis[txs[2]!.id]!.totalCost).toBeCloseTo(40_000, 6);
  });
  it('the cap is configurable (transferMaxLateDays)', () => {
    const txs = [buy('2025-01-10', 1, 40_000, 'Mercado Bitcoin'), tout('2025-03-01', 1, 'Mercado Bitcoin'), tin('2025-05-01', 1, 'Binance', { price: 100_000 })];
    const r = routeCryptoByCustody(inp(txs), { transferMaxLateDays: 45 });
    expect(codes(r.issues)).toContain('warning:TRANSFER_MATCH_PROPOSED');
    expect(r.transferBasis[txs[2]!.id]!.totalCost).toBeCloseTo(100_000, 6);
    expect(r.transit[0]!.consumptions).toHaveLength(0);
  });
  it('an inferred arrival beyond the cap carries the origin cost only provisionally (DARF withheld)', () => {
    const { c } = run([buy('2025-01-10', 1, 40_000, 'Mercado Bitcoin'), tout('2025-06-01', 1, 'Mercado Bitcoin'), sell('2026-03-10', 1, 90_000, 'Foxbit')]);
    expect(c.sales[0]).toMatchObject({ costBrl: 200_000, provisionalCost: true });
    expect(c.months[0]!.darf).toBeUndefined();
    expect(c.months[0]!.darfHeldAmount).toBe(37_500);
  });
});

describe('T59 — only the unconfirmed part of the month is withheld', () => {
  it('Q2b: confirmed ETH sale → DARF 750 ready; ambiguous BTC part → 2,700 withheld', () => {
    const { c } = run([
      buy('2025-01-10', 0.06, 40_000, 'Mercado Bitcoin'),
      buy('2025-02-10', 0.06, 40_000, 'Binance'),
      sell('2026-03-10', 0.12, 100_000),
      buy('2025-01-10', 1, 1_000, 'Mercado Bitcoin', ETH),
      sell('2026-03-15', 1, 2_000, 'Mercado Bitcoin', ETH),
    ]);
    const m = c.months[0]!;
    expect(m).toMatchObject({ salesBrl: 40_000, exempt: false, tax: 3_450, darfBlockedUnknownCustody: true, darfHeldAmount: 2_700 });
    expect(m.darf?.amount).toBe(750);
    expect(m.darf?.sicalc).toBeDefined();
    expect(c.sales.find((s) => s.instrumentId === ETH.id)!.held).toBeUndefined();
    expect(c.sales.find((s) => s.instrumentId.startsWith(BTC.id))!.held).toBe(true);
    expect(codes(c.issues)).toContain('info:CRYPTO_DARF_PARTIAL');
    // The exemption is only exceeded thanks to the unconfirmed part: said explicitly.
    expect(codes(c.issues)).toContain('warning:CRYPTO_EXEMPTION_DEPENDS_ON_UNCONFIRMED');
  });
  it('a month with only confirmed sales issues the full DARF, nothing withheld', () => {
    const { c } = run([buy('2025-01-10', 1, 40_000, 'Mercado Bitcoin'), sell('2026-03-10', 1, 90_000, 'Mercado Bitcoin')]);
    expect(c.months[0]).toMatchObject({ tax: 37_500 });
    expect(c.months[0]!.darf?.amount).toBe(37_500);
    expect(c.months[0]!.darfHeldAmount).toBeUndefined();
    expect(c.months[0]!.darfBlockedUnknownCustody).toBeUndefined();
  });
  it('the tax pack CSV shows the DARF amount and the withheld amount', async () => {
    const { brazilTaxPack } = await import('./brazil/taxPack');
    const p = brazilTaxPack(inp([tin('2025-05-01', 1, 'Mercado Bitcoin'), sell('2026-03-10', 1, 90_000, 'Mercado Bitcoin')]), { year: 2026 });
    const csv = p.files['brasil-2026-cripto.csv']!;
    expect(csv).toContain('valor_retido');
    expect(csv).toMatch(/67500/);
  });
});

describe('T60 — no warning noise when nothing is ambiguous', () => {
  it('Q7: two OUTs (MB 0.5 + Kraken 0.5) into one IN → no TRANSFER_PAIR_AMBIGUOUS, cost 250k', () => {
    const { c } = run([
      buy('2025-01-10', 0.5, 40_000, 'Mercado Bitcoin'),
      buy('2025-02-10', 0.5, 60_000, 'Kraken'),
      tout('2025-03-01', 0.5, 'Mercado Bitcoin'),
      tout('2025-03-01', 0.5, 'Kraken'),
      tin('2025-03-02', 1, 'Ledger'),
      sell('2026-03-10', 1, 90_000, 'Ledger'),
    ]);
    expect(c.sales[0]!.costBrl).toBeCloseTo(250_000, 6);
    expect(codes(c.issues)).not.toContain('warning:TRANSFER_PAIR_AMBIGUOUS');
    expect(codes(c.issues)).not.toContain('warning:TRANSFER_COST_UNKNOWN');
  });
  it('Q8: arrival in two parts (0.92 + 0.08) → cost 200k, no TRANSFER_COST_UNKNOWN, no fee assumed', () => {
    const txs = [
      buy('2025-01-10', 1, 40_000, 'Mercado Bitcoin'),
      tout('2025-06-01', 1, 'Mercado Bitcoin'),
      tin('2025-06-01', 0.92, 'Binance'),
      tin('2025-06-02', 0.08, 'Binance'),
      sell('2026-03-10', 1, 90_000, 'Binance'),
    ];
    const { f, c } = run(txs);
    expect(f.sales[0]!.costBrl).toBeCloseTo(200_000, 6);
    const all = [...codes(f.issues), ...codes(c.issues)];
    expect(all.some((x) => x.endsWith(':TRANSFER_COST_UNKNOWN'))).toBe(false);
    expect(all.some((x) => x.endsWith(':TRANSFER_FEE_ASSUMED'))).toBe(false);
    expect(all.some((x) => x.endsWith(':TRANSFER_PAIR_AMBIGUOUS'))).toBe(false);
  });
  it('a real ambiguity (same custody, same quantity, different cost, one left over) is still warned', () => {
    const r = routeCryptoByCustody(
      inp([
        buy('2025-01-10', 1, 40_000, 'Mercado Bitcoin'),
        tout('2025-03-01', 1, 'Mercado Bitcoin'),
        buy('2025-03-02', 1, 60_000, 'Mercado Bitcoin'),
        tout('2025-03-02', 1, 'Mercado Bitcoin'),
        tin('2025-03-03', 1, 'Ledger'),
      ]),
    );
    expect(codes(r.issues)).toContain('warning:TRANSFER_PAIR_AMBIGUOUS');
  });
  it('an orphan deposit without price into a foreign venue is flagged once, not twice', () => {
    const { f } = run([tin('2025-05-01', 1, 'Binance'), sell('2026-03-10', 1, 90_000, 'Binance')]);
    expect(f.issues.filter((i) => i.code === 'TRANSFER_COST_UNKNOWN')).toHaveLength(1);
  });
  it('Bens e Direitos still reports the late OUT in transit when it is only proposed', () => {
    const b = brazilBensDireitos(
      inp([buy('2024-06-10', 1, 40_000, 'Mercado Bitcoin'), tout('2025-01-15', 1, 'Mercado Bitcoin'), tin('2025-12-01', 1, 'Binance', { price: 100_000 })]),
      { year: 2025 },
    );
    expect(b.items.some((i) => i.grupo === '08' && /TRÂNSITO/.test(i.discriminacao))).toBe(true);
  });
});
