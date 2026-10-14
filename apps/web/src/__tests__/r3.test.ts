import { describe, expect, it } from 'vitest';
import { toDataset, type RawData } from '../hooks/useData';
import { DEFAULT_SETTINGS } from '../db/repo';

const raw = (): RawData => ({
  portfolios: [
    { id: 'demo', name: 'Ejemplo', baseCurrency: 'COP', isDemo: true } as never,
    { id: 'real', name: 'Mío', baseCurrency: 'COP' } as never,
  ],
  transactions: [
    { id: 't1', portfolioId: 'real', date: '2026-01-05', type: 'BUY', instrumentId: 'XBOG:ISA', quantity: 10, price: 19000, currency: 'COP' } as never,
    { id: 't2', portfolioId: 'demo', date: '2025-01-05', type: 'BUY', instrumentId: 'XBOG:ISA', quantity: 5, price: 15000, currency: 'COP' } as never,
  ],
  instruments: [],
  prices: [{ instrumentId: 'XBOG:ISA', currency: 'COP', points: [{ date: '2026-09-30', close: 19349 }], source: 'demo', isDemo: true } as never],
  fx: [{ base: 'USD', quote: 'COP', points: [{ date: '2026-09-30', rate: 4000 }], source: 'demo', isDemo: true } as never],
  manual: [],
  indexSeries: [{ id: 'IBR', kind: 'annualRate', points: [], source: 'demo', isDemo: true } as never],
  corporateActions: [],
  dismissed: [],
});

describe('W31: sample market data never values a real portfolio', () => {
  it('drops every demo series when the scope is a real portfolio', () => {
    const ds = toDataset(raw(), { ...DEFAULT_SETTINGS, selectedPortfolioId: 'real' });
    expect(ds.prices).toHaveLength(0);
    expect(ds.fx).toHaveLength(0);
    expect(ds.indexSeries).toHaveLength(0);
  });
  it('keeps them for the sample, and flags real holdings priced only by it in a mixed view', () => {
    const ds = toDataset(raw(), { ...DEFAULT_SETTINGS, selectedPortfolioId: 'all' });
    expect(ds.prices).toHaveLength(1);
    expect(ds.demoPricedInstruments).toEqual(['XBOG:ISA']);
    const r = raw();
    r.prices.push({ instrumentId: 'XBOG:ISA', currency: 'COP', points: [{ date: '2026-10-10', close: 28500 }], source: 'yahoo' });
    expect(toDataset(r, { ...DEFAULT_SETTINGS, selectedPortfolioId: 'all' }).demoPricedInstruments).toEqual([]);
  });
});

describe('W33: imported account labels match the portfolio accounts', async () => {
  const { matchAccount } = await import('../services/importers');
  it('reuses the onboarding account for the same broker and cleans known names', () => {
    expect(matchAccount('XP INVESTIMENTOS CCTVM S/A', ['XP'])).toBe('XP');
    expect(matchAccount('NU INVEST CORRETORA DE VALORES S.A.', ['XP'])).toBe('Nu Invest');
    expect(matchAccount('U1234567', ['U7654321'])).toBe('U1234567');
    expect(matchAccount('Mi banco raro', [])).toBe('Mi banco raro');
    expect(matchAccount(undefined, ['XP'])).toBeUndefined();
  });
});

describe('W32: reference rates and benchmarks follow the reporting currency', async () => {
  const { computeAnalysis } = await import('../services/analysis');
  const { loadDemoData } = await import('../services/demo');
  const { BENCHMARK_IDS, BENCHMARKS, orderBenchmarks } = await import('../lib/benchmarks');
  const { groupManualPrices } = await import('../hooks/useData');
  const d = loadDemoData();
  const ds = (ccy: string) => ({
    portfolios: d.portfolios,
    transactions: d.transactions,
    instruments: [...d.instruments, ...BENCHMARKS.filter((b) => !d.instruments.some((i) => i.id === b.id))],
    prices: d.prices,
    fx: d.fx,
    manualPrices: groupManualPrices((d.manualPrices ?? []).map((m) => ({ ...m, updatedAt: 0 }))),
    indexSeries: d.indexSeries ?? [],
    selectedPortfolioId: 'all',
    reportingCurrency: ccy,
    asOf: '2026-10-05',
    benchmarks: orderBenchmarks(BENCHMARK_IDS, ccy),
    riskFreeRate: 0.04,
    defaultCostMethod: 'FIFO' as const,
  });
  it('BRL never uses the Colombian IBR; a missing CDI is reported as missing', () => {
    const brl = computeAnalysis(ds('BRL'));
    expect(brl.rateIndices).not.toContain('IBR');
    const loaded = new Set((d.indexSeries ?? []).map((s) => s.id));
    if (!loaded.has('CDI')) expect(brl.missingRateIndex).toBe('CDI');
    expect(brl.riskFree?.source).not.toBe('IBR');
    expect(orderBenchmarks(BENCHMARK_IDS, 'BRL')[0]).toBe('INDEX:^BVSP');
    expect(orderBenchmarks(BENCHMARK_IDS, 'COP')[0]).toBe('XBOG:ICOLCAP');
  });
  it('COP keeps COLCAP and the IBR', () => {
    const cop = computeAnalysis(ds('COP'));
    expect(cop.rateIndices).toEqual(['IBR']);
    expect(cop.missingRateIndex).toBeUndefined();
  });
});

describe('W35 / W36', async () => {
  const { browserLanguage } = await import('../services/onboarding');
  const { cleanTaxMessage } = await import('../lib/taxText');
  it('picks the browser language on first run', () => {
    expect(browserLanguage(['pt-BR', 'en-US'])).toBe('pt');
    expect(browserLanguage(['fr-FR', 'en-GB'])).toBe('en');
    expect(browserLanguage(['de-DE'])).toBe('es');
  });
  it('removes internal option names from tax messages', () => {
    expect(cleanTaxMessage('Alguns parâmetros de 2026 estão marcados para verificação (ver config.meta).')).toBe('Alguns parâmetros de 2026 estão marcados para verificação.');
    expect(cleanTaxMessage('Informe o país da conta em USD no exterior (opção foreignCashCountry) para a ficha Bens e Direitos.')).not.toContain('foreignCashCountry');
    expect(cleanTaxMessage('…o valor no campo de impostos da venda, ou ative creditEstimatedIrrf.')).not.toContain('creditEstimatedIrrf');
  });
});
