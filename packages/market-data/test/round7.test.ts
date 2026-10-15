/** Round 7 (review R6): M38 redaction, M41 ambiguity / listing notices, split-basis flag for core C52. */
import { describe, expect, it } from 'vitest';
import { HttpError, MarketDataError, sanitizeUrl, toErrorBody } from '../src/index';
import { createTestService, json, NOW, presplitOnly } from './helpers';

describe('M38 URLs in errors never carry credentials', () => {
  it('HttpError and MarketDataError messages / details are sanitized at the source', () => {
    const e = new HttpError(429, 'https://financialmodelingprep.com/stable/x?symbol=AAPL&apikey=FMP-KEY-123456', 'limit for apikey=FMP-KEY-123456');
    expect(e.message).not.toContain('FMP-KEY-123456');
    expect(e.url).toContain('apikey=***');
    expect(e.message).toContain('symbol=AAPL');
    const m = new MarketDataError('UPSTREAM_ERROR', 'eodhd: https://eodhd.com/api/eod/AAPL.US?api_token=EOD-KEY-654321&fmt=json', {
      fallbacks: [{ source: 'stooq', error: 'https://stooq.com/q/d/l/?s=aapl.us&apikey=STQ-KEY-111111' }],
    });
    const body = JSON.stringify(toErrorBody(m));
    for (const k of ['EOD-KEY-654321', 'STQ-KEY-111111']) expect(body).not.toContain(k);
    expect(sanitizeUrl('https://brapi.dev/api/quote/PETR4?range=1y&token=BRAPI-XYZ-999')).toBe('https://brapi.dev/api/quote/PETR4?range=1y&token=***');
  });

  it('configured keys are scrubbed whatever parameter name carried them', async () => {
    const { service } = createTestService(
      { failingHosts: ['query2.finance.yahoo.com', 'query1.finance.yahoo.com'], routes: (u) => (u.host === 'api.twelvedata.com' ? json({ status: 'error', code: 500, message: `bad request ${u.toString()}` }) : undefined) },
      { keys: { twelvedata: 'TWELVE-SECRET-777' } },
    );
    const err = await service.history({ symbol: 'AAPL', from: '2025-01-01', to: '2025-03-31' }).catch((e: unknown) => e);
    expect(JSON.stringify(toErrorBody(err))).not.toContain('TWELVE-SECRET-777');
  });
});

describe('split basis of the returned closes (core C52 must not adjust twice)', () => {
  it('Yahoo default (adjust=none): closes as traded, no splitAdjusted flag; adjust=splits / total are flagged', async () => {
    const { service } = createTestService({ routes: presplitOnly });
    const raw = await service.history({ symbol: 'NVDA', from: '2024-01-02', to: '2024-01-31' });
    expect(raw.series.splitAdjusted).toBeUndefined();
    expect(raw.series.points[0]!.close).toBeGreaterThan(400); // pre 10:1 split, as traded
    const adj = await service.history({ symbol: 'NVDA', from: '2024-01-02', to: '2024-01-31', adjust: 'splits' });
    expect(adj.series.splitAdjusted).toBe(true);
    expect(adj.series.points[0]!.close).toBeLessThan(100);
    expect((await service.history({ symbol: 'NVDA', from: '2024-01-02', to: '2024-01-31', adjust: 'total' })).series.splitAdjusted).toBe(true);
  });

  it('a split-adjusted backup (stooq) that could not be un-adjusted is flagged', async () => {
    const { service } = createTestService({ failingHosts: ['query2.finance.yahoo.com', 'query1.finance.yahoo.com'] });
    const h = await service.history({ symbol: 'AAPL', from: '2025-01-01', to: '2025-01-31' });
    expect(h.series.source).toBe('stooq');
    expect(h.series.splitAdjusted).toBe(true);
  });
});

function usQuote(symbol: string): unknown {
  const t = Math.floor(NOW.getTime() / 1000) - 3600;
  return { chart: { result: [{ meta: { symbol, currency: 'USD', exchangeName: 'NYQ', instrumentType: 'EQUITY', regularMarketPrice: 15, regularMarketTime: t, exchangeTimezoneName: 'America/New_York', gmtoffset: -14400 }, timestamp: [t], indicators: { quote: [{ close: [15] }] } }], error: null } };
}

describe('M41 ambiguity hint and listing notices', () => {
  it('ETB / BVC bare stay US but the response lists the BVC listing as an alternative', async () => {
    const routes = (u: URL) => {
      const sym = decodeURIComponent(u.pathname.split('/').pop() ?? '');
      return (sym === 'ETB' || sym === 'BVC') && u.searchParams.get('range') === '1d' ? json(usQuote(sym)) : undefined;
    };
    const { service } = createTestService({ routes });
    for (const sym of ['ETB', 'BVC']) {
      const q = await service.quote(sym);
      expect(q.providerSymbol).toBe(sym);
      expect(q.alternatives).toEqual([expect.objectContaining({ instrumentId: `XBOG:${sym}`, exchange: 'XBOG', currency: 'COP' })]);
    }
    const plain = await service.quote('AAPL');
    expect(plain.alternatives).toBeUndefined();
  });

  it('TEF: no US listing any more -> Madrid, with the NYSE ADS delisting notice; XNYS:TEF explains and suggests', async () => {
    const { service } = createTestService();
    const r = await service.resolveListed('TEF');
    expect(r.target.instrumentId).toBe('XMAD:TEF');
    const err = (await service.history({ symbol: 'XNYS:TEF', from: '2026-02-01', to: '2026-03-31' }).catch((e: unknown) => e)) as MarketDataError;
    expect(err.code).toBe('NOT_FOUND');
    expect(err.details).toMatchObject({ suggest: 'XMAD:TEF', listingNotice: { instrumentId: 'XNYS:TEF', approximate: true } });
  });
});
