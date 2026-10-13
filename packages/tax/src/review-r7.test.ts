/**
 * Regression tests for the round-7 review (reviews/tax-r7.md): T61-T63.
 * Scenarios S1, S3, S4, S4c, S5 and Q5 reproduce the reviewer's r7-*.ts scripts.
 */
import { describe, expect, it } from 'vitest';
import type { Instrument, Transaction } from '@pm/core';
import { ALL_INSTRUMENTS, tx } from './testing/fixtures';
import { createSimpleMarketData } from './testing/marketData';
import { brazilCryptoReport } from './brazil/crypto';
import { brazilForeignAnnualReport } from './brazil/exterior';
import { brazilBensDireitos, type BensDireitosOptions } from './brazil/bensDireitos';
import { brazilMonthlyApuracao } from './brazil/apuracao';
import { accumulateDarfs } from './brazil/darf';

const BTC: Instrument = { id: 'CCC:BTC-USD', symbol: 'BTC-USD', name: 'Bitcoin USD', exchange: 'CCC', currency: 'USD', country: 'US', assetClass: 'crypto' };
const ETH: Instrument = { id: 'CCC:ETH-USD', symbol: 'ETH-USD', name: 'Ethereum USD', exchange: 'CCC', currency: 'USD', country: 'US', assetClass: 'crypto' };
const market = createSimpleMarketData({ fx: { 'USD/BRL': [['2015-01-01', 5]] } });
const inp = (transactions: Transaction[]) => ({ transactions, instruments: [...ALL_INSTRUMENTS, BTC, ETH], market });
const t = (type: Transaction['type'], date: string, q: number, account?: string, extra: Partial<Transaction> = {}, inst = BTC) =>
  tx({ date, type, instrumentId: inst.id, quantity: q, currency: 'USD', account, ...extra });
const darfTax = (date: string, amount: number, note: string) => tx({ date, type: 'TAX', amount, currency: 'BRL', note });
const codes = (issues: { code: string }[]) => issues.map((i) => i.code);

describe('T61 — DARF 4600 (crypto) with the same machinery as the 6015', () => {
  it('r7-s1: R$ 3,75 in March and in April → no DARF below R$ 10, amounts accumulated', () => {
    const c = brazilCryptoReport(
      inp([
        t('BUY', '2025-01-10', 100, 'Mercado Bitcoin', { price: 727.9 }, ETH),
        t('SELL', '2026-03-10', 50, 'Mercado Bitcoin', { price: 728 }, ETH),
        t('SELL', '2026-04-10', 50, 'Mercado Bitcoin', { price: 728 }, ETH),
      ]),
      { year: 2026 },
    );
    expect(c.months.map((m) => m.tax)).toEqual([3.75, 3.75]);
    expect(c.months.every((m) => m.darf === undefined)).toBe(true);
    expect(c.months.map((m) => m.darfCarriedForward)).toEqual([3.75, 7.5]);
    expect(codes(c.issues)).toContain('DARF_BELOW_MINIMUM');
  });
  it('the accumulated amount is paid in the month it reaches R$ 10, listing the months it covers', () => {
    const c = brazilCryptoReport(
      inp([
        t('BUY', '2025-01-10', 100, 'Mercado Bitcoin', { price: 727.9 }, ETH),
        t('SELL', '2026-03-10', 50, 'Mercado Bitcoin', { price: 727.98 }, ETH), // gain 20 → tax 3
        t('SELL', '2026-05-10', 50, 'Mercado Bitcoin', { price: 727.98 + 0.32 }, ETH), // gain 100 → tax 15
      ]),
      { year: 2026 },
    );
    expect(c.months[0]!.darf).toBeUndefined();
    const may = c.months.find((m) => m.month === '2026-05')!;
    expect(may.darf).toMatchObject({ code: '4600', amount: 18, includesMonths: ['2026-03', '2026-05'], dueDate: '2026-06-30', status: 'pendente' });
  });
  it('accumulateDarfs is shared (same rule as the 6015 apuração)', () => {
    const r = accumulateDarfs('4600', [
      { month: '2026-01', amount: 4 },
      { month: '2026-02', amount: 0 },
      { month: '2026-03', amount: 7 },
    ]);
    expect(r.darfs).toHaveLength(1);
    expect(r.darfs[0]).toMatchObject({ month: '2026-03', amount: 11, includesMonths: ['2026-01', '2026-03'] });
  });
  const s3 = (extra: Transaction[] = []) => [t('BUY', '2025-01-10', 1, 'Mercado Bitcoin', { price: 4_000 }), t('SELL', '2026-03-10', 1, 'Mercado Bitcoin', { price: 8_000 }), ...extra];
  it('S3: DARF 4600 paid late (only the principal) → paga_parcial (round 9, T68), multa/juros, Sicalc with payment date, DARF_UNDERPAID', () => {
    const c = brazilCryptoReport(inp(s3([darfTax('2026-06-10', 3_000, 'DARF 4600 2026-03')])), { year: 2026 });
    const d = c.months[0]!.darf!;
    expect(d.amount).toBe(3_000);
    // The late payment covers principal + charges pro rata: part of the principal is still owed.
    expect(d.status).toBe('paga_parcial');
    expect(d.balance!).toBeGreaterThan(0);
    expect(d.late!.daysLate).toBe(41);
    expect(d.late!.multaRate).toBeCloseTo(0.0033 * 41, 6);
    expect(d.late!.juros).toBeGreaterThan(0);
    expect(d.sicalc.dataPagamento).toBe('10/06/2026');
    expect(c.issues.find((i) => i.code === 'DARF_UNDERPAID')!.message).toContain('4600');
  });
  it('paid on time and in full → paga, no warning', () => {
    const c = brazilCryptoReport(inp(s3([darfTax('2026-04-20', 3_000, 'DARF 4600 2026-03')])), { year: 2026 });
    expect(c.months[0]!.darf!.status).toBe('paga');
    expect(codes(c.issues)).not.toContain('DARF_UNDERPAID');
  });
  it('unpaid after the due date (asOf) → vencida with late charges up to asOf', () => {
    const c = brazilCryptoReport(inp(s3()), { year: 2026, asOf: '2026-07-15' });
    expect(c.months[0]!.darf!.status).toBe('vencida');
    expect(c.months[0]!.darf!.late!.multa).toBe(600); // capped at 20%
  });
  it('explicit payments option works too, and an uncoded payment stays with the 6015', () => {
    const paid = brazilCryptoReport(inp(s3()), { year: 2026, payments: [{ date: '2026-04-28', amount: 3_000, code: '4600', month: '2026-03' }] });
    expect(paid.months[0]!.darf!.status).toBe('paga');
    const uncoded = brazilCryptoReport(inp(s3([darfTax('2026-04-20', 3_000, 'DARF 2026-03')])), { year: 2026 });
    expect(uncoded.months[0]!.darf!.status).toBe('pendente');
  });
  it('a 4600 payment does not settle the B3 DARF 6015 of the same month', () => {
    const txs = [
      tx({ date: '2026-03-02', type: 'BUY', instrumentId: 'BVMF:PETR4', quantity: 1000, price: 30, currency: 'BRL' }),
      tx({ date: '2026-03-20', type: 'SELL', instrumentId: 'BVMF:PETR4', quantity: 1000, price: 40, currency: 'BRL', taxes: 0 }),
      darfTax('2026-04-20', 1_500, 'DARF 4600 2026-03'),
    ];
    const a = brazilMonthlyApuracao(inp(txs), { year: 2026 });
    const d = a.darfs.find((x) => x.month === '2026-03')!;
    expect(d.code).toBe('6015');
    expect(d.status).toBe('pendente');
  });
  it('pre-2024 regime: GCAP 4600 of foreign assets also gets DARFs with payment status', () => {
    const f = brazilForeignAnnualReport(
      inp([
        tx({ date: '2022-05-10', type: 'BUY', instrumentId: 'XNAS:AAPL', quantity: 100, price: 100, currency: 'USD' }),
        tx({ date: '2023-03-10', type: 'SELL', instrumentId: 'XNAS:AAPL', quantity: 100, price: 150, currency: 'USD' }),
      ]),
      { year: 2023, payments: [{ date: '2023-04-20', amount: 3_750, code: '4600', month: '2023-03' }] },
    );
    const d = f.gcapPre2024!.darfs.find((x) => x.code === '4600')!;
    expect(d).toMatchObject({ month: '2023-03', amount: 3_750, status: 'paga' });
  });
  it('the tax pack crypto CSV carries status, months covered and carried amount', async () => {
    const { brazilTaxPack } = await import('./brazil/taxPack');
    const p = brazilTaxPack(inp(s3([darfTax('2026-06-10', 3_000, 'DARF 4600 2026-03')])), { year: 2026 });
    const csv = p.files['brasil-2026-cripto.csv']!;
    expect(csv).toContain('darf_status');
    expect(csv).toContain('paga_parcial');
    expect(csv).toContain('acumulado_abaixo_minimo');
  });
});

describe('T62 — Bens e Direitos marks provisional / pending crypto cost on the line itself', () => {
  const bens = (txs: Transaction[], year: number, o: Partial<BensDireitosOptions> = {}) => brazilBensDireitos(inp(txs), { year, ...o });
  it('S4: deposit with value → "custo provisório — confirmar", costStatus provisorio (both years while held)', () => {
    const txs = [t('TRANSFER_IN', '2025-05-01', 1, 'Mercado Bitcoin', { price: 60_000 }), t('SELL', '2026-03-10', 0.5, 'Mercado Bitcoin', { price: 90_000 })];
    const b25 = bens(txs, 2025).items.find((i) => i.grupo === '08')!;
    expect(b25).toMatchObject({ situacaoAtual: 300_000, costStatus: 'provisorio' });
    expect(b25.discriminacao).toContain('custo provisório — confirmar');
    const r26 = bens(txs, 2026);
    const b26 = r26.items.find((i) => i.grupo === '08')!;
    expect(b26).toMatchObject({ situacaoAnterior: 300_000, situacaoAtual: 150_000, costStatus: 'provisorio' });
    expect(codes(r26.issues)).toContain('BENS_COST_NOT_CONFIRMED');
  });
  it('S5: deposit without value → "custo pendente", costStatus pendente', () => {
    const b = bens([t('TRANSFER_IN', '2025-05-01', 1, 'Mercado Bitcoin')], 2025).items.find((i) => i.grupo === '08')!;
    expect(b).toMatchObject({ situacaoAtual: 0, costStatus: 'pendente' });
    expect(b.discriminacao).toContain('custo pendente');
  });
  it('S4c: once confirmed ([custo] note) the line is clean', () => {
    const b = bens([t('TRANSFER_IN', '2025-05-01', 1, 'Mercado Bitcoin', { price: 60_000, note: '[custo: 2021-01-10 @ 20000]' })], 2025).items.find((i) => i.grupo === '08')!;
    expect(b.situacaoAtual).toBeCloseTo(100_000, 6);
    expect(b.costStatus).toBeUndefined();
    expect(b.discriminacao).not.toContain('provisório');
  });
  it('a confirmed purchase in the same custody is not marked', () => {
    const b = bens([t('BUY', '2025-01-10', 1, 'Mercado Bitcoin', { price: 40_000 })], 2025).items.find((i) => i.grupo === '08')!;
    expect(b.costStatus).toBeUndefined();
  });
  it('foreign custody (Lei 14.754 line) is marked too', () => {
    const b = bens([t('TRANSFER_IN', '2025-05-01', 1, 'Kraken', { price: 60_000 })], 2025).items.find((i) => i.grupo === '08')!;
    expect(b.costStatus).toBe('provisorio');
    expect(b.discriminacao).toContain('custo provisório');
  });
});

describe('T63 — an unconfirmed "em trânsito" line is not carried year after year', () => {
  const q5 = [t('BUY', '2024-06-10', 1, 'Mercado Bitcoin', { price: 40_000 }), t('TRANSFER_OUT', '2025-01-15', 1, 'Mercado Bitcoin')];
  const transit = (r: ReturnType<typeof brazilBensDireitos>) => r.items.filter((i) => i.emTransito);
  it('within the window: kept, but flagged as without confirmed arrival (beyond transferMaxLateDays)', () => {
    const r = brazilBensDireitos(inp(q5), { year: 2025 });
    const it25 = transit(r)[0]!;
    expect(it25).toMatchObject({ situacaoAtual: 200_000, quantidade: 1 });
    expect(it25.discriminacao).toContain('SEM ENTRADA CONFIRMADA');
  });
  it('Q5 2026: after 12 months it is EXCLUDED (atual 0), with an error asking for a decision', () => {
    const r = brazilBensDireitos(inp(q5), { year: 2026 });
    const it26 = transit(r)[0]!;
    expect(it26).toMatchObject({ situacaoAnterior: 200_000, situacaoAtual: 0, quantidade: 0, transitoExcluido: true });
    expect(it26.discriminacao).toContain('EXCLUÍDO');
    const e = r.issues.find((i) => i.code === 'CRYPTO_TRANSIT_STALE')!;
    expect(e.level).toBe('error');
    expect(e.message).toContain('transitResolution');
  });
  it('2027: not carried at all any more', () => {
    expect(transit(brazilBensDireitos(inp(q5), { year: 2027 }))).toHaveLength(0);
  });
  it('the window is configurable (transitMaxMonths)', () => {
    const r = brazilBensDireitos(inp(q5), { year: 2025, transitMaxMonths: 6 });
    expect(transit(r)).toHaveLength(0);
    expect(codes(r.issues)).toContain('CRYPTO_TRANSIT_STALE');
  });
  it('decision "mantido": still owned, kept without time limit', () => {
    const r = brazilBensDireitos(inp(q5), { year: 2026, transitResolution: { [q5[1]!.id]: 'mantido' } });
    expect(transit(r)[0]).toMatchObject({ situacaoAtual: 200_000 });
    expect(codes(r.issues)).not.toContain('CRYPTO_TRANSIT_STALE');
  });
  it('decision "alienado": out of Bens e Direitos from the OUT date, with a reminder to register a sale', () => {
    const r = brazilBensDireitos(inp(q5), { year: 2025, transitResolution: { [q5[1]!.id]: 'alienado' } });
    expect(transit(r)).toHaveLength(0);
    expect(r.issues.find((i) => i.code === 'CRYPTO_TRANSIT_DISPOSED')!.message).toContain('SELL');
  });
});
