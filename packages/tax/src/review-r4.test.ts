/**
 * Regression tests for the round-4 review (reviews/tax-r4.md): T47-T51.
 * Scenarios K1..K9 and r4-k1b reproduce the reviewer's r4-*.ts scripts.
 */
import { describe, expect, it } from 'vitest';
import type { Instrument, Transaction } from '@pm/core';
import { ALL_INSTRUMENTS, tx } from './testing/fixtures';
import { createSimpleMarketData } from './testing/marketData';
import { toXlsx } from './common/xlsx';
import { readXlsx } from './common/xlsxRead';
import { excelSerialToIso, officialDocRowsFromTable } from './common/reconcile';
import { brazilCryptoReport } from './brazil/crypto';
import { brazilForeignAnnualReport } from './brazil/exterior';
import { brazilBensDireitos } from './brazil/bensDireitos';
import { brazilTaxPack } from './brazil/taxPack';
import { cryptoCustodyForVenue, routeCryptoByCustody } from './brazil/classify';
import { informeFromB3Movimentacao, reconcileBrazil } from './brazil/reconcile';

const BTC: Instrument = { id: 'CCC:BTC-USD', symbol: 'BTC-USD', name: 'Bitcoin USD', exchange: 'CCC', currency: 'USD', country: 'US', assetClass: 'crypto' };
const market = createSimpleMarketData({ fx: { 'USD/BRL': [['2015-01-01', 5]] } });
const inp = (transactions: Transaction[]) => ({ transactions, instruments: [...ALL_INSTRUMENTS, BTC], market });
const buyMB = () => tx({ date: '2025-01-10', type: 'BUY', instrumentId: BTC.id, quantity: 1, price: 40_000, currency: 'USD', account: 'Mercado Bitcoin' });
const sell = (account?: string) => tx({ date: '2026-03-10', type: 'SELL', instrumentId: BTC.id, quantity: 1, price: 90_000, currency: 'USD', account });

describe('T47 (alta) — a sale consumes the custody where the units are', () => {
  it('K1: sale without account → GCAP at the Mercado Bitcoin cost, DARF 4600 R$ 37,500', () => {
    const c = brazilCryptoReport(inp([buyMB(), sell()]), { year: 2026 });
    expect(c.months[0]).toMatchObject({ salesBrl: 450_000, gainBrl: 250_000, tax: 37_500 });
    expect(c.months[0]!.darf?.amount).toBe(37_500);
    expect(c.issues.map((i) => i.code)).toContain('CRYPTO_OUTFLOW_ROUTED_TO_HOLDINGS');
    expect(brazilForeignAnnualReport(inp([buyMB(), sell()]), { year: 2026 }).totals.taxDueBrl).toBe(0);
  });
  it('r4-k1b: "MercadoBitcoin S.A." on the sale → same DARF; Bens e Direitos shows the BTC as sold', () => {
    const p = brazilTaxPack(inp([buyMB(), sell('MercadoBitcoin S.A.')]), { year: 2026 });
    expect(p.cripto.months[0]!.darf).toMatchObject({ code: '4600', amount: 37_500, dueDate: '2026-04-30' });
    const item = p.bensDireitos.items.find((i) => i.grupo === '08')!;
    expect(item).toMatchObject({ quantidade: 0, situacaoAtual: 0, situacaoAnterior: 200_000 });
  });
  it('units in two custodies and a sale without account → taxed as Brazil, DARF withheld, warning', () => {
    const txs = [
      buyMB(),
      tx({ date: '2025-06-01', type: 'BUY', instrumentId: BTC.id, quantity: 1, price: 60_000, currency: 'USD', account: 'Kraken' }),
      sell(),
    ];
    const c = brazilCryptoReport(inp(txs), { year: 2026 });
    expect(c.months[0]).toMatchObject({ tax: 37_500, darfBlockedUnknownCustody: true });
    expect(c.issues.map((i) => i.code)).toContain('CRYPTO_SALE_CUSTODY_AMBIGUOUS');
    const f = brazilForeignAnnualReport(inp(txs), { year: 2026 });
    expect(f.positions[0]).toMatchObject({ quantity: 1, costBrl: 300_000 }); // Kraken units remain
  });
  it('no sale is ever left out of every report', () => {
    for (const acct of [undefined, '', 'MercadoBitcoin S.A.', 'Corretora X']) {
      const c = brazilCryptoReport(inp([buyMB(), sell(acct)]), { year: 2026 });
      const f = brazilForeignAnnualReport(inp([buyMB(), sell(acct)]), { year: 2026 });
      expect(c.sales.length + f.sales.length, String(acct)).toBe(1);
    }
  });
});

describe('T48 — transfers between custodians carry the cost basis', () => {
  const transfer = (to: string) => [
    buyMB(),
    tx({ date: '2025-06-01', type: 'TRANSFER_OUT', instrumentId: BTC.id, quantity: 1, currency: 'USD', account: 'Mercado Bitcoin' }),
    tx({ date: '2025-06-02', type: 'TRANSFER_IN', instrumentId: BTC.id, quantity: 0.9995, currency: 'USD', account: to }),
    tx({ date: '2026-03-10', type: 'SELL', instrumentId: BTC.id, quantity: 0.9995, price: 90_000, currency: 'USD', account: to }),
  ];
  it('K3: Mercado Bitcoin → Binance → sale abroad: Lei 14.754 on gain over the R$ 200k cost', () => {
    const f = brazilForeignAnnualReport(inp(transfer('Binance')), { year: 2026 });
    expect(f.sales[0]!.costBrl).toBeCloseTo(200_000, 6);
    expect(f.sales[0]!.gainBrl).toBeCloseTo(0.9995 * 450_000 - 200_000, 6);
    expect(f.issues.map((i) => i.code)).not.toContain('TRANSFER_COST_UNKNOWN');
    expect(brazilCryptoReport(inp(transfer('Binance')), { year: 2026 }).months).toEqual([]);
  });
  it('K4: Mercado Bitcoin → Ledger → sale from the Ledger: cost carried, DARF withheld (custody unknown)', () => {
    const c = brazilCryptoReport(inp(transfer('Ledger Nano')), { year: 2026 });
    expect(c.sales[0]!.costBrl).toBeCloseTo(200_000, 6);
    expect(c.months[0]).toMatchObject({ darfBlockedUnknownCustody: true });
    expect(c.months[0]!.tax).toBeCloseTo((0.9995 * 450_000 - 200_000) * 0.15, 6);
  });
  it('transfer pairs carry cost; round 5 (T53): late arrivals still match, flagged', () => {
    const r = routeCryptoByCustody(inp(transfer('Binance')));
    expect(Object.values(r.transferBasis)[0]).toMatchObject({ totalCost: 40_000, fxRate: 5 });
    const far = [
      buyMB(),
      tx({ date: '2025-06-01', type: 'TRANSFER_OUT', instrumentId: BTC.id, quantity: 1, currency: 'USD', account: 'Mercado Bitcoin' }),
      tx({ date: '2025-07-15', type: 'TRANSFER_IN', instrumentId: BTC.id, quantity: 1, currency: 'USD', account: 'Binance' }),
    ];
    const rf = routeCryptoByCustody(inp(far));
    expect(Object.values(rf.transferBasis)[0]).toMatchObject({ totalCost: 40_000 });
    expect(rf.issues.map((i) => i.code)).toContain('TRANSFER_MATCHED_LATE');
  });
});

describe('T49 — fuzzy venue names', () => {
  it('K5: legal suffixes, product names and Brazilian entities', () => {
    expect(cryptoCustodyForVenue('MercadoBitcoin S.A.')).toBe('brasil');
    expect(cryptoCustodyForVenue('mercado-bitcoin')).toBe('brasil');
    expect(cryptoCustodyForVenue('Coinbase Pro')).toBe('exterior');
    expect(cryptoCustodyForVenue('OKX Brasil')).toBe('brasil');
    expect(cryptoCustodyForVenue('Bitso')).toBe('brasil');
    expect(cryptoCustodyForVenue('Binance.com')).toBe('exterior');
    expect(cryptoCustodyForVenue('Ledger Nano X')).toBe('desconhecida');
    expect(cryptoCustodyForVenue('Corretora X')).toBeUndefined();
    expect(cryptoCustodyForVenue('Minha Binance', { 'Minha Binance': 'brasil' })).toBe('brasil');
  });
});

describe('T50 — Bens e Direitos location from the custodian', () => {
  it('K6: BTC (quote country US) at Binance → blank location + warning; at Coinbase → US', () => {
    const b = brazilBensDireitos(inp([tx({ date: '2025-06-01', type: 'BUY', instrumentId: BTC.id, quantity: 1, price: 60_000, currency: 'USD', account: 'Binance' })]), {
      year: 2025,
    });
    expect(b.items[0]).toMatchObject({ grupo: '08', localizacao: '' });
    expect(b.issues.map((i) => i.code)).toContain('CRYPTO_LOCATION_UNKNOWN');
    const k = brazilBensDireitos(inp([tx({ date: '2025-06-01', type: 'BUY', instrumentId: BTC.id, quantity: 1, price: 60_000, currency: 'USD', account: 'Kraken' })]), {
      year: 2025,
    });
    expect(k.items[0]!.localizacao).toBe('US');
  });
});

describe('T51 — Excel serial dates and no silently dropped rows', () => {
  it('K9: B3 Movimentação with dates saved as Excel serial numbers', async () => {
    expect(excelSerialToIso(46101)).toBe('2026-03-20');
    const x = toXlsx([
      {
        name: 'Movimentação',
        rows: [
          ['Entrada/Saída', 'Data', 'Movimentação', 'Produto', 'Instituição', 'Quantidade', 'Preço unitário', 'Valor da Operação'],
          ['Credito', 46101, 'Dividendo', 'PETR4 - PETROLEO BRASILEIRO S.A. PETROBRAS', 'XP', 100, 5, 500],
          ['Credito', '', 'Dividendo', 'VALE3 - VALE S.A.', 'XP', 100, 3, 300],
          ['Credito', '20/04/2026', 'Transferência - Liquidação', 'PETR4 - PETROBRAS', 'XP', 100, 30, 3000],
        ],
      },
    ]);
    const rows = officialDocRowsFromTable((await readXlsx(x))[0]!.rows);
    expect(rows[0]!.periodo).toBe('2026-03-20');
    const inf = informeFromB3Movimentacao(rows, 2026);
    expect(inf.itens).toEqual([{ tipo: 'DIVIDENDO', ticker: 'PETR4', valor: 500, liquido: false }]);
    expect(inf.issues!.map((i) => i.code)).toEqual(['IMPORT_ROWS_WITHOUT_DATE', 'IMPORT_ROWS_IGNORED']);
    const pack = brazilTaxPack(inp([]), { year: 2026 });
    expect(reconcileBrazil(pack, { informes: [inf] }).issues.map((i) => i.code)).toContain('IMPORT_ROWS_WITHOUT_DATE');
  });
});
