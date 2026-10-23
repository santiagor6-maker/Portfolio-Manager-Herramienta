/**
 * End-to-end contract of a B3 bonificação between @pm/market-data and @pm/core.
 *
 * core defines STOCK_DIVIDEND `ratio` as NEW shares received per share held (0.10 for 10 %), and
 * every consumer derives the share/price factor as 1 + ratio (ledger stockDividend, C52 splitAdj,
 * trade-price observations, market.splitFactor, validate, importers, tax). The market-data mapper
 * must therefore emit 0.10 for ITUB4's 110:100, not the price factor 1.10, or an accepted
 * suggestion credits 2.10x the shares.
 */
import { describe, expect, it } from 'vitest';
import { applyCorporateActions, createMarketData, dates, valuePortfolio } from '@pm/core';
import type { CorporateAction, EngineInput, Instrument, Transaction } from '@pm/core';
import { classifySplit } from '../src/corporate';

const ITUB: Instrument = { id: 'BVMF:ITUB4', symbol: 'ITUB4', name: 'Itaú Unibanco PN', exchange: 'BVMF', currency: 'BRL', country: 'BR', assetClass: 'equity' };
const portfolio = { id: 'p', name: 'p', baseCurrency: 'BRL', costMethod: 'AVERAGE' as const, createdAt: '2025-01-01' };
const buy: Transaction = { id: 'b1', portfolioId: 'p', date: '2025-03-10', type: 'BUY', instrumentId: ITUB.id, quantity: 100, price: 33, currency: 'BRL' };

describe('ITUB4 110:100 bonificação: market-data mapper -> web suggestion -> core', () => {
  it('maps the Yahoo factor to new shares per share held and keeps the price factor apart', () => {
    const a = classifySplit('ITUB4.SA', { date: '2025-03-18', numerator: 110, denominator: 100 }, ITUB.id);
    expect(a).toMatchObject({ type: 'STOCK_DIVIDEND', ratio: 0.1, priceFactor: 1.1 });
    // no float noise (1.1 - 1 = 0.10000000000000009)
    expect(a.ratio).toBe(0.1);
    expect(classifySplit('ITUB4.SA', { date: '2025-12-22', numerator: 103, denominator: 100 }, ITUB.id).ratio).toBe(0.03);
    expect(classifySplit('ITUB4.SA', { date: '2018-11-21', numerator: 3, denominator: 2 }, ITUB.id).ratio).toBe(0.5);
  });

  it('accepted suggestion yields exactly 1.10x the shares and a 1.10 price adjustment', () => {
    const provider = classifySplit('ITUB4.SA', { date: '2025-03-18', numerator: 110, denominator: 100 }, ITUB.id);
    // web: services/marketData caches {...a, instrumentId}; db/repo adds id/updatedAt; hooks/useData strips them.
    const stored = { ...provider, instrumentId: ITUB.id, id: `${ITUB.id}|STOCK_DIVIDEND|2025-03-18`, updatedAt: 1 };
    const { id: _id, updatedAt: _u, ...action } = stored;
    const actions: CorporateAction[] = [action];

    const r = applyCorporateActions([buy], actions, [ITUB], { portfolioId: 'p' });
    expect(r.suggested).toHaveLength(1);
    // web: SuggestionsInbox.accept saves {...s.transaction, note}
    const accepted: Transaction = { ...r.suggested[0]!, id: 'sd1', note: 'Bonificação' };
    expect(accepted).toMatchObject({ type: 'STOCK_DIVIDEND', date: '2025-03-18', ratio: 0.1 });

    // As-traded closes (adjust 'none'): 33 before the ex-date, none yet on/after it (C52 path).
    const input: EngineInput = {
      portfolio,
      instruments: [ITUB],
      market: createMarketData({ prices: [{ instrumentId: ITUB.id, currency: 'BRL', source: 'yahoo', points: [{ date: '2025-03-14', close: 33 }] }] }),
      transactions: [buy, accepted],
      options: { asOf: '2025-03-19' },
    };
    const before = valuePortfolio(input, '2025-03-17').holdings.find((h) => h.instrumentId === ITUB.id)!;
    const after = valuePortfolio(input, '2025-03-19').holdings.find((h) => h.instrumentId === ITUB.id)!;
    expect(before.quantity).toBeCloseTo(100, 9);
    expect(after.quantity).toBeCloseTo(110, 9);
    expect(after.price).toBeCloseTo(30, 9); // 33 / 1.10 (C52 pre-event price division)
    expect(after.marketValue).toBeCloseTo(3300, 6);

    // Provider actions handed to core's market use the same factor (1 + ratio).
    const m = createMarketData({ corporateActions: actions });
    expect(m.splitFactor(ITUB.id, dates.isoToDay('2025-03-17'), dates.isoToDay('2025-03-18'))).toBeCloseTo(1.1, 12);
  });
});
