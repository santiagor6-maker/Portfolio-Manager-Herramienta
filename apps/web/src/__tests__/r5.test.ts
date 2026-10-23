/** Round 5 (reviews/web-r4.md): W40–W48. */
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import * as core from '@pm/core';
import type { Instrument, Transaction } from '@pm/core';
import { computeAnalysis, type Dataset } from '../services/analysis';
import { missingFxCurrencies } from '../services/fxCoverage';
import { conversionState } from '../hooks/useConversion';
import { formatMoney, formatPct } from '../lib/format';
import { describeIssue } from '../lib/diagnosticText';
import { localizeNumbers, tidyTaxIssues } from '../lib/taxText';
import { darfDueOn, redemptionsFromEngine, redemptionTransactions } from '../services/tax';
import { compactReportHtml, decodeShare, encodeShare } from '../lib/share';
import { encryptText } from '../lib/crypto';
import { downsample } from '../lib/chartMath';

const ISA: Instrument = { id: 'XBOG:ISA', symbol: 'ISA', name: 'ISA', exchange: 'XBOG', currency: 'COP', country: 'CO', assetClass: 'equity' };
const tx = (t: Partial<Transaction>): Transaction => ({ id: `t${Math.random()}`, portfolioId: 'p1', date: '2024-01-02', type: 'DEPOSIT', currency: 'COP', ...t }) as Transaction;

function dataset(reportingCurrency: string, fx: Dataset['fx']): Dataset {
  return {
    portfolios: [{ id: 'p1', name: 'CO', baseCurrency: 'COP', costMethod: 'FIFO', createdAt: '2024-01-01' }],
    transactions: [
      tx({ amount: 30_000_000 }),
      tx({ type: 'BUY', instrumentId: ISA.id, quantity: 1000, price: 20_000, amount: 20_000_000 }),
    ],
    instruments: [ISA],
    prices: [{ instrumentId: ISA.id, currency: 'COP', source: 't', points: [{ date: '2024-01-02', close: 20_000 }, { date: '2024-06-28', close: 22_000 }] }],
    fx,
    manualPrices: [],
    indexSeries: [],
    selectedPortfolioId: 'p1',
    reportingCurrency,
    asOf: '2024-07-01',
    benchmarks: [],
    riskFreeRate: 0.04,
    defaultCostMethod: 'FIFO',
  };
}
const USDCOP = { base: 'USD', quote: 'COP', source: 't', points: [{ date: '2023-12-01', rate: 4000 }] };
const USDBRL = { base: 'USD', quote: 'BRL', source: 't', points: [{ date: '2023-12-01', rate: 5 }] };

describe('W40: reporting currency without its FX series', () => {
  it('lists the currencies that cannot reach the reporting currency', () => {
    const m = core.createMarketData({ prices: [], fx: [USDCOP] });
    expect(missingFxCurrencies('BRL', dataset('BRL', []).transactions, [ISA], m, '2024-07-01', ['COP'])).toEqual(['COP']);
    expect(missingFxCurrencies('USD', dataset('USD', []).transactions, [ISA], m, '2024-07-01', ['COP'])).toEqual([]);
    expect(missingFxCurrencies('COP', dataset('COP', []).transactions, [ISA], m, '2024-07-01', ['COP'])).toEqual([]);
    // A series that starts after the first use is not enough (early months would be valued at 0).
    const late = core.createMarketData({ prices: [], fx: [USDCOP, { ...USDBRL, points: [{ date: '2024-05-01', rate: 5 }] }] });
    expect(missingFxCurrencies('BRL', dataset('BRL', []).transactions, [ISA], late, '2024-07-01', ['COP'])).toEqual(['COP']);
  });

  it('never shows zeros: KPIs, series and benchmark differences are "—", not R$ 0,00', () => {
    const a = computeAnalysis(dataset('BRL', [USDCOP]));
    expect(a.fxMissing).toEqual(['COP']);
    expect(a.summaries).toEqual({});
    expect(a.series).toEqual([]);
    expect(Number.isNaN(a.valuation!.totalMarketValueBase)).toBe(true);
    expect(formatMoney(a.valuation!.totalMarketValueBase, 'BRL', 'pt-BR')).toBe('—');
    expect(a.monthly.length).toBeGreaterThan(0);
    for (const r of a.monthly) {
      expect(Number.isNaN(r.endValueBase)).toBe(true);
      expect(formatPct(r.twr - 0.05, 'es-CO')).toBe('—'); // "Diferencia" vs. an index
    }
    expect(a.valuation!.holdings.every((h) => Number.isNaN(h.marketValueBase!))).toBe(true);
  });

  it('converts normally once the pair is cached', () => {
    const a = computeAnalysis(dataset('BRL', [USDCOP, USDBRL]));
    expect(a.fxMissing).toEqual([]);
    // 1000 ISA × 22.000 COP + 10 M cash = 32 M COP → ÷ 4000 × 5 = R$ 40.000
    expect(a.valuation!.totalMarketValueBase).toBeCloseTo(40_000, 6);
    expect(a.summaries.SI).toBeDefined();
  });

  it('is "converting" while the analysis is for another currency or the missing rate downloads', () => {
    expect(conversionState({ baseCurrency: 'COP', fxMissing: [] }, 'BRL', []).pending).toBe(true);
    expect(conversionState({ baseCurrency: 'BRL', fxMissing: ['COP'] }, 'BRL', ['BRL'])).toEqual({ target: 'BRL', pending: true, missing: ['COP'] });
    expect(conversionState({ baseCurrency: 'BRL', fxMissing: ['COP'] }, 'BRL', [])).toEqual({ target: 'BRL', pending: false, missing: ['COP'] });
    expect(conversionState({ baseCurrency: 'BRL', fxMissing: [] }, 'BRL', []).pending).toBe(false);
  });
});

describe('W41: Avisos describe validation issues in the user language', () => {
  const t = (k: string, o?: Record<string, unknown>) => {
    const dict: Record<string, string> = {
      'diag.vtext.OVERSELL': 'Venda de {{quantity}} {{symbol}} em {{date}} maior que a posição ({{held}}).',
      'tx.type.SELL': 'Venda',
      'diag.code.FUTURE_DATE': 'Data futura',
    };
    const s = dict[k];
    if (s === undefined) return String(o?.defaultValue ?? k);
    return s.replace(/\{\{(\w+)\}\}/g, (_m, n: string) => String(o?.[n] ?? ''));
  };
  const instruments = new Map<string, Instrument>([['BVMF:VALE3', { ...ISA, id: 'BVMF:VALE3', symbol: 'VALE3' }]]);
  it('OVERSELL from validateTransactions', () => {
    const s = describeIssue({ code: 'OVERSELL', message: 'SELL of 20 BVMF:VALE3 on 2023-01-02 exceeds holding of 0' }, { instruments, locale: 'pt-BR', t });
    expect(s).toBe('Venda de 20 VALE3 em 02/01/2023 maior que a posição (0).');
    expect(s).not.toMatch(/exceeds|holding/);
  });
  it('codes without a sentence use the localized label, never the English message', () => {
    expect(describeIssue({ code: 'FUTURE_DATE', message: 'Date 2030-01-01 is in the future' }, { instruments, locale: 'pt-BR', t })).toBe('Data futura');
  });
});

describe('W42: matured CDT without a recorded redemption', () => {
  const CDT: Instrument = {
    id: 'MANUAL:CDT1',
    symbol: 'CDT1',
    name: 'CDT Bancolombia',
    exchange: 'MANUAL',
    currency: 'COP',
    country: 'CO',
    assetClass: 'fixed_income',
    pricing: 'manual',
    accrual: { kind: 'fixed', annualRate: 0.12, dayCount: 'ACT/365', maturity: '2025-01-09' },
  };
  const base: Transaction[] = [
    tx({ amount: 10_000_000, account: 'Bancolombia' }),
    tx({ type: 'BUY', instrumentId: CDT.id, quantity: 1, price: 10_000_000, amount: 10_000_000, account: 'Bancolombia' }),
  ];
  const input = (txs: Transaction[]) => ({
    portfolio: { id: 'p1', name: 'p', baseCurrency: 'COP', costMethod: 'FIFO' as const, createdAt: '2024-01-01' },
    instruments: [CDT],
    market: core.createMarketData({ prices: [], fx: [] }),
    transactions: txs,
    options: { asOf: '2025-12-31' },
  });

  it('builds the estimated redemption (interest with 4 % retención + principal) from the engine', () => {
    const [r] = redemptionsFromEngine(core.createEngine(input(base)), base, 'p1', '2025-12-31');
    const gross = 10_000_000 * Math.pow(1.12, 373 / 365);
    expect(r).toMatchObject({ instrumentId: CDT.id, date: '2025-01-09', currency: 'COP', account: 'Bancolombia', quantity: 1, principal: 10_000_000 });
    expect(r!.interestGross).toBeCloseTo(gross - 10_000_000, 0);
    expect(r!.withholding).toBeCloseTo((gross - 10_000_000) * 0.04, 0);
    expect(redemptionsFromEngine(core.createEngine(input(base)), base, 'p1', '2024-12-31')).toEqual([]);
  });

  it('recording it replaces the automatic redemption: same cash, interest in income, no gain on the sale', () => {
    const auto = core.createEngine(input(base));
    const [r] = redemptionsFromEngine(auto, base, 'p1', '2025-12-31');
    const recorded = [...base, ...redemptionTransactions(r!, 'test').map((x, i) => ({ ...x, id: `r${i}` }) as Transaction)];
    const E = core.createEngine(input(recorded));
    expect(redemptionsFromEngine(E, recorded, 'p1', '2025-12-31')).toEqual([]);
    expect(E.diagnostics().filter((d) => d.severity === 'error')).toEqual([]);
    const cash = (e: typeof E) => e.valuation('2025-12-31').cash.reduce((s, c) => s + c.amount, 0);
    expect(Math.abs(cash(E) - cash(auto))).toBeLessThan(1);
    expect(E.income().some((i) => i.type === 'INTEREST' && i.instrumentId === CDT.id)).toBe(true);
    expect(E.realized().filter((x) => x.instrumentId === CDT.id).reduce((s, x) => s + x.gain, 0)).toBeCloseTo(0, 0);
  });
});

describe('W44: DARF amount follows the payment date', () => {
  it('recomputes multa and Selic for the chosen date', () => {
    const darf = { amount: 3_000, dueDate: '2026-04-30' };
    expect(darfDueOn(darf, '2026-04-30')).toMatchObject({ daysLate: 0, total: 3_000 });
    const may = darfDueOn(darf, '2026-05-20')!;
    expect(may.daysLate).toBe(20);
    expect(may.multa).toBeCloseTo(3_000 * 0.066, 2);
    expect(may.total).toBeCloseTo(3_000 + may.multa + 30, 2); // + 1 % in the payment month
    const late = darfDueOn(darf, '2026-10-20')!;
    expect(late.multa).toBeCloseTo(600, 2); // capped at 20 %
    expect(late.total).toBeGreaterThan(may.total);
    expect(darfDueOn(darf, '')).toBeUndefined();
  });
});

describe('W45: tax alerts', () => {
  it('formats plain decimals for the locale and leaves thousands groups, CNPJs and dates alone', () => {
    expect(localizeNumbers('0.05 BTC-USD saíram de exchange em 2025-03-01', 'pt-BR')).toBe('0,05 BTC-USD saíram de exchange em 01/03/2025');
    expect(localizeNumbers('retención registrada 250976 COP al 2025-12-31', 'es-CO')).toBe('retención registrada 250.976 COP al 31/12/2025');
    expect(localizeNumbers('Lei 14.754/2023, IN 1.888 e R$ 1.500,00; CNPJ 33.000.167/0001-01', 'pt-BR')).toBe('Lei 14.754/2023, IN 1.888 e R$ 1.500,00; CNPJ 33.000.167/0001-01');
    expect(localizeNumbers('1.25 units', 'en-US')).toBe('1.25 units');
  });
  it('keeps one line per message, warnings first', () => {
    const out = tidyTaxIssues(
      [
        { level: 'info', code: 'PTAX_FALLBACK', message: 'Sem PTAX' },
        { level: 'warning', code: 'TRANSFER_OUT_UNMATCHED', message: '0.05 BTC-USD saíram' },
        { level: 'warning', code: 'TRANSFER_OUT_UNMATCHED', message: '0.05 BTC-USD saíram' },
      ],
      'pt-BR',
    );
    expect(out.map((i) => i.text)).toEqual(['0,05 BTC-USD saíram', 'Sem PTAX']);
  });
});

describe('W46: shorter share links', () => {
  const html = `<div class="rp" data-testid="report">\n  <section>\n    <h2>Resumen</h2>\n  </section>\n  <!-- x -->\n  <td style="">1</td>\n</div>`;
  it('compacts the report HTML', () => {
    expect(compactReportHtml(html)).toBe('<div class="rp"><section><h2>Resumen</h2></section><td>1</td></div>');
  });
  it('encrypts the compressed bytes directly (e2) and still opens old e1 links', async () => {
    const p = { v: 1 as const, t: 'Informe', h: '<table><tr><td>$ 1.234</td></tr></table>'.repeat(200), g: '2026-10-13T12:00:00Z', lang: 'es' };
    const plain = await encodeShare(p);
    const enc = await encodeShare(p, 'clave');
    expect(enc.startsWith('e2.')).toBe(true);
    // salt + iv + GCM tag ≈ 44 bytes → ≈ 60 base64 chars over the plain link (e1 was ≈ 1.8×).
    expect(enc.length - plain.length).toBeLessThan(70);
    expect(await decodeShare(`#${enc}`, 'clave')).toEqual(p);
    await expect(decodeShare(`#${enc}`, 'otra')).rejects.toThrow('wrong_passphrase');
    const packed = plain.slice(3);
    const e1 = await encryptText(packed, 'vieja', 1000);
    const old = `e1.${btoa(JSON.stringify(e1)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}`;
    // e1 links used 250k iterations stored in the file: decoding honours the stored count.
    expect((await decodeShare(old, 'vieja')).t).toBe('Informe');
  });
  it('downsamples the report chart keeping both ends', () => {
    const pts = Array.from({ length: 1000 }, (_, i) => i);
    const d = downsample(pts, 160);
    expect(d).toHaveLength(160);
    expect(d[0]).toBe(0);
    expect(d[159]).toBe(999);
    expect(downsample([1, 2, 3], 160)).toEqual([1, 2, 3]);
  });
});

describe('W43: brokerage-note names and CNPJ', () => {
  it('detects note-style names', async () => {
    const { isNoteName } = await import('../lib/noteNames');
    expect(isNoteName('SID NACIONAL ON', 'CSNA3')).toBe(true);
    expect(isNoteName('TRAN PAULIST PN N1', 'TRPL4')).toBe(true);
    expect(isNoteName('ITAUUNIBANCO PN EJ N1', 'ITUB4')).toBe(true);
    expect(isNoteName('CSNA3', 'CSNA3')).toBe(true);
    expect(isNoteName('Companhia Siderúrgica Nacional', 'CSNA3')).toBe(false);
    expect(isNoteName('ECOPETROL', 'EC')).toBe(false);
  });

  it('renames stored note names from the catalog at startup, never the user’s own names', async () => {
    const schema = await import('../db/schema');
    const db = schema.resetDbInstance('r5-names');
    const { repairNoteNames } = await import('../lib/noteNames');
    const b3 = { exchange: 'BVMF', currency: 'BRL', country: 'BR', assetClass: 'equity' as const };
    await db.instruments.bulkPut([
      { ...b3, id: 'BVMF:CSNA3', symbol: 'CSNA3', name: 'SID NACIONAL ON' },
      { ...b3, id: 'BVMF:ITUB4', symbol: 'ITUB4', name: 'ITAUUNIBANCO PN EJ N1' },
      { ...b3, id: 'BVMF:PETR4', symbol: 'PETR4', name: 'Minha Petrobras' },
    ]);
    expect(await repairNoteNames()).toBe(2);
    expect((await db.instruments.get('BVMF:CSNA3'))!.name).toBe('Companhia Siderúrgica Nacional ON');
    expect((await db.instruments.get('BVMF:ITUB4'))!.name).toBe('Itaú Unibanco PN');
    expect((await db.instruments.get('BVMF:PETR4'))!.name).toBe('Minha Petrobras');
    await db.delete();
  });

  it('fills the CNPJ of common issuers in Bens e Direitos', async () => {
    const { brazilTaxPack } = await import('@pm/tax');
    const { B3_CNPJ_EXTRA } = await import('../lib/b3Cnpj');
    const csna: Instrument = { id: 'BVMF:CSNA3', symbol: 'CSNA3', name: 'CSN ON', exchange: 'BVMF', currency: 'BRL', country: 'BR', assetClass: 'equity' };
    const input = {
      transactions: [tx({ portfolioId: 'p', date: '2025-03-03', type: 'BUY', instrumentId: csna.id, quantity: 100, price: 10, amount: 1000, currency: 'BRL' })],
      instruments: [csna],
      market: core.createMarketData({ prices: [], fx: [] }),
    };
    const pack = brazilTaxPack(input, { year: 2025, asOf: '2026-01-10', cnpjByIssuer: B3_CNPJ_EXTRA });
    expect(pack.bensDireitos.items.find((i) => i.ticker === 'CSNA3')?.cnpj).toBe('33.042.730/0001-04');
  });
});
