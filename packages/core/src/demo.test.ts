import { describe, expect, it } from 'vitest';
import { createDemoData } from './demo';
import {
  allocation,
  externalFlows,
  ledgerDiagnostics,
  monthlyPerformance,
  performanceSummary,
  realizedGains,
  riskMetrics,
  validateTransactions,
  valuePortfolio,
} from './api';

describe('createDemoData', () => {
  const d = createDemoData();

  it('is clearly a demo portfolio for a Colombian investor', () => {
    expect(d.portfolio.name).toBe('Portafolio de ejemplo');
    expect(d.portfolio.baseCurrency).toBe('COP');
    expect(d.isDemo).toBe(true);
    const ids = d.instruments.map((i) => i.id);
    for (const id of ['XBOG:ECOPETROL', 'XBOG:PFCIBEST', 'XBOG:ISA', 'BVMF:PETR4', 'BVMF:ITUB4', 'BVMF:WEGE3', 'XNAS:AAPL', 'XNAS:MSFT', 'ARCX:VOO', 'XAMS:ASML', 'XMAD:IBE']) {
      expect(ids).toContain(id);
    }
  });

  it('is deterministic', () => {
    expect(createDemoData().transactions).toEqual(d.transactions);
    expect(createDemoData().prices).toEqual(d.prices);
  });

  it('has month-end series 2023-01..2026-09 within plausible FX ranges', () => {
    for (const s of d.fx) {
      expect(s.points[0]!.date).toBe('2023-01-31');
      expect(s.points[s.points.length - 1]!.date).toBe('2026-09-30');
    }
    const range = (b: string, q: string) => d.fx.find((s) => s.base === b && s.quote === q)!.points.map((p) => p.rate);
    expect(Math.min(...range('USD', 'COP'))).toBeGreaterThanOrEqual(3700);
    expect(Math.max(...range('USD', 'COP'))).toBeLessThanOrEqual(4400);
    expect(Math.min(...range('USD', 'BRL'))).toBeGreaterThanOrEqual(4.8);
    expect(Math.max(...range('USD', 'BRL'))).toBeLessThanOrEqual(5.8);
    expect(Math.min(...range('EUR', 'USD'))).toBeGreaterThanOrEqual(1.05);
    expect(Math.max(...range('EUR', 'USD'))).toBeLessThanOrEqual(1.15);
  });

  it('contains the required event types', () => {
    const types = new Set(d.transactions.map((t) => t.type));
    for (const t of ['DEPOSIT', 'BUY', 'SELL', 'DIVIDEND', 'SPLIT', 'FX_CONVERSION', 'WITHDRAWAL']) expect(types.has(t as never)).toBe(true);
    expect(d.transactions.some((t) => t.type === 'DIVIDEND' && (t.taxes ?? 0) > 0)).toBe(true);
  });

  it('is clean: valid, funded by explicit deposits, fully priced', () => {
    expect(validateTransactions(d.transactions, d.instruments, { today: '2026-10-05' })).toEqual({ errors: [], warnings: [] });
    expect(ledgerDiagnostics(d.input).filter((x) => x.severity !== 'info')).toEqual([]);
    expect(ledgerDiagnostics(d.input).filter((x) => x.code === 'MATURITY_REDEEMED')).toHaveLength(2);
    expect(externalFlows(d.input).some((f) => f.kind.startsWith('IMPLICIT'))).toBe(false);
    const v = valuePortfolio(d.input, d.asOf);
    expect(v.missingPrices).toEqual([]);
    expect(v.missingFx).toEqual([]);
    expect(v.holdings).toHaveLength(11);
    expect(v.totalMarketValueBase).toBeGreaterThan(200_000_000);
    expect(v.cash.every((c) => c.amount >= 0)).toBe(true);
    expect(realizedGains(d.input).length).toBeGreaterThan(0);
  });

  it('Bancolombia appears as Grupo Cibest (PFCIBEST)', () => {
    const c = d.instruments.find((i) => i.id === 'XBOG:PFCIBEST')!;
    expect(c.providerSymbols?.yahoo).toBe('PFCIBEST.CL');
    expect(d.instruments.some((i) => i.id.includes('PFBCOLOM'))).toBe(false);
  });

  it('includes CDTs valued by accrual and redeemed at maturity, plus IPC and IBR series', () => {
    const cdt = valuePortfolio(d.input, '2024-12-31').holdings.find((h) => h.instrumentId === 'MANUAL:CDT-2024')!;
    expect(cdt.priceSource).toBe('accrual');
    expect(cdt.marketValue).toBeCloseTo(10_000_000 * Math.pow(1.12, 320 / 365), 2);
    const red = realizedGains(d.input).find((r) => r.instrumentId === 'MANUAL:CDT-2024')!;
    // matures Sunday 2025-02-09 -> paid Monday 2025-02-10, net of the estimated 4 % retención
    expect(red.sellDate).toBe('2025-02-10');
    const gross = 10_000_000 * Math.pow(1.12, 360 / 365);
    expect(red.proceeds).toBeCloseTo(gross - 0.04 * (gross - 10_000_000), 2);
    expect(red.estimated).toBe(true);
    const rows = monthlyPerformance(d.input);
    expect(rows.every((r) => r.inflation !== undefined && r.realTwr !== undefined)).toBe(true);
    expect(rows.at(-1)!.indexReturns).toHaveProperty('IBR');
    const s = performanceSummary(d.input, 'SI', d.asOf);
    expect(s.realTwr).toBeLessThan(s.twr);
    expect(s.percentOfIndex).toHaveProperty('IBR');
  });

  it('opens the UI in a working state (monthly table, summary, risk, allocation)', () => {
    const rows = monthlyPerformance(d.input);
    expect(rows[0]!.month).toBe('2023-01');
    expect(rows[rows.length - 1]!.month).toBe('2026-09');
    expect(rows.every((r) => Number.isFinite(r.twr) && Math.abs(r.twr) < 0.25)).toBe(true);
    expect(rows[rows.length - 1]!.benchmarkReturns).toHaveProperty('XBOG:ICOLCAP');
    const s = performanceSummary(d.input, 'SI', d.asOf);
    expect(s.twr).toBeGreaterThan(-0.5);
    expect(s.twr).toBeLessThan(2);
    expect(s.mwr).toBeDefined();
    const risk = riskMetrics(rows, { riskFreeAnnual: 0.09 });
    expect(risk.volatility).toBeGreaterThan(0);
    const byCcy = allocation(valuePortfolio(d.input, d.asOf), d.instruments, 'currency');
    expect(byCcy.map((x) => x.key).sort()).toEqual(['BRL', 'COP', 'EUR', 'USD']);
  });
});
