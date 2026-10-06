/** C11 — restructurings (spin-off, merger, ticker change) and provider corporate actions. */
import { describe, expect, it } from 'vitest';
import { applyCorporateActions, computeCash, computeHoldings, incomeEvents, positionPerformance, validateTransactions } from './api';
import { engine, inst, prices, tx } from './__fixtures__/helpers';
import type { CorporateAction } from './types';

const P = inst('XBOG:PARENT', 'COP');
const C = inst('XBOG:CHILD', 'COP');
const buy = tx({ date: '2024-01-02', type: 'BUY', instrumentId: P.id, quantity: 10, price: 100, currency: 'COP' });

describe('restructurings via SPLIT subtypes', () => {
  it('spin-off: child gets ratio x shares and costFraction of the cost, open dates kept', () => {
    const input = engine({
      base: 'COP',
      instruments: [P, C],
      prices: [prices(P.id, 'COP', { '2024-01-02': 100, '2024-03-01': 80 }), prices(C.id, 'COP', { '2024-03-01': 40 })],
      transactions: [buy, tx({ date: '2024-03-01', type: 'SPLIT', subtype: 'SPINOFF', instrumentId: P.id, targetInstrumentId: C.id, ratio: 0.5, costFraction: 0.2, currency: 'COP' })],
      options: { asOf: '2024-03-31' },
    });
    const h = computeHoldings(input, '2024-03-01');
    const parent = h.find((x) => x.instrumentId === P.id)!;
    const child = h.find((x) => x.instrumentId === C.id)!;
    expect(parent.quantity).toBe(10);
    expect(parent.costBasis).toBeCloseTo(800, 9);
    expect(child.quantity).toBe(5);
    expect(child.costBasis).toBeCloseTo(200, 9);
    expect(child.lots[0]!.openDate).toBe('2024-01-02');
    // Value continuity: 10*80 + 5*40 = 1000; parent position TWR ignores the value handed over.
    const pp = positionPerformance(input, 'SI', '2024-03-01');
    expect(pp.find((x) => x.instrumentId === P.id)!.twr).toBeCloseTo(0, 12);
  });

  it('merger with cash: lots move to the target at the ratio, cash reduces cost', () => {
    const input = engine({
      base: 'COP',
      instruments: [P, C],
      transactions: [buy, tx({ date: '2024-03-01', type: 'SPLIT', subtype: 'MERGER', instrumentId: P.id, targetInstrumentId: C.id, ratio: 1.5, amount: 100, currency: 'COP' })],
    });
    const h = computeHoldings(input, '2024-03-01');
    expect(h.map((x) => x.instrumentId)).toEqual([C.id]);
    expect(h[0]!.quantity).toBe(15);
    expect(h[0]!.costBasis).toBeCloseTo(900, 9);
    expect(computeCash(input, '2024-03-01')[0]!.amount).toBeCloseTo(100, 9);
  });

  it('ticker change (PFBCOLOM -> PFCIBEST) keeps lots and cost', () => {
    const OLD = inst('XBOG:PFBCOLOM', 'COP');
    const NEW = inst('XBOG:PFCIBEST', 'COP');
    const input = engine({
      base: 'COP',
      instruments: [OLD, NEW],
      transactions: [
        tx({ date: '2024-01-02', type: 'BUY', instrumentId: OLD.id, quantity: 100, price: 30_000, currency: 'COP' }),
        tx({ date: '2025-05-20', type: 'SPLIT', subtype: 'TICKER_CHANGE', instrumentId: OLD.id, targetInstrumentId: NEW.id, currency: 'COP' }),
      ],
    });
    const h = computeHoldings(input, '2025-06-01');
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ instrumentId: NEW.id, quantity: 100, costBasis: 3_000_000 });
    expect(h[0]!.lots[0]!.openDate).toBe('2024-01-02');
    const v = validateTransactions(input.transactions, input.instruments, { today: '2026-01-01' });
    expect(v.errors).toEqual([]);
  });

  it('validation requires a target for restructurings', () => {
    const v = validateTransactions([buy, tx({ date: '2024-03-01', type: 'SPLIT', subtype: 'SPINOFF', instrumentId: P.id, currency: 'COP' })], [P], { today: '2026-01-01' });
    expect(v.errors.map((e) => e.code)).toContain('MISSING_TARGET');
  });

  it('JCP subtype is kept on income events', () => {
    const input = engine({
      base: 'BRL',
      instruments: [inst('BVMF:ITUB4', 'BRL')],
      transactions: [
        tx({ date: '2024-01-02', type: 'BUY', instrumentId: 'BVMF:ITUB4', quantity: 100, price: 30, currency: 'BRL' }),
        tx({ date: '2024-02-01', type: 'DIVIDEND', subtype: 'JCP', instrumentId: 'BVMF:ITUB4', amount: 20, taxes: 3, currency: 'BRL' }),
      ],
    });
    expect(incomeEvents(input)[0]).toMatchObject({ subtype: 'JCP', net: 17 });
  });
});

describe('applyCorporateActions', () => {
  const A = inst('XNAS:AAPL', 'USD');
  const V = inst('XLON:VUSA', 'GBP');
  const txs = [
    tx({ date: '2024-01-02', type: 'BUY', instrumentId: A.id, quantity: 10, price: 180, currency: 'USD' }),
    tx({ date: '2024-01-02', type: 'BUY', instrumentId: V.id, quantity: 20, price: 80, currency: 'GBP' }),
    tx({ date: '2024-02-16', type: 'DIVIDEND', instrumentId: A.id, amount: 2.4, currency: 'USD' }),
  ];
  const actions: CorporateAction[] = [
    { instrumentId: A.id, date: '2024-02-09', type: 'DIVIDEND', amountPerShare: 0.24, payDate: '2024-02-15' }, // already recorded
    { instrumentId: A.id, date: '2024-05-10', exDate: '2024-05-10', payDate: '2024-05-16', type: 'DIVIDEND', amountPerShare: 0.25 },
    { instrumentId: V.id, date: '2024-03-14', type: 'DIVIDEND', amountPerShare: 0.3, currency: 'USD', payDate: '2024-03-27' },
    { instrumentId: A.id, date: '2024-06-10', type: 'SPLIT', ratio: 4 },
    { instrumentId: A.id, date: '2024-08-12', type: 'DIVIDEND', amountPerShare: 0.25 }, // after the suggested split: 40 shares
    { instrumentId: 'XNAS:MSFT', date: '2024-05-15', type: 'DIVIDEND', amountPerShare: 0.75 }, // no position
    { instrumentId: A.id, date: '2024-09-01', type: 'DIVIDEND', amountPerShare: 9, reviewRequired: true },
  ];
  const r = applyCorporateActions(txs, actions, [A, V]);

  it('suggests only new events, sized by the units held before the ex-date', () => {
    expect(r.suggested.map((t) => [t.type, t.instrumentId, t.date, t.amount ?? t.ratio, t.currency])).toEqual([
      ['DIVIDEND', A.id, '2024-05-16', 2.5, 'USD'],
      ['DIVIDEND', V.id, '2024-03-27', 6, 'USD'],
      ['SPLIT', A.id, '2024-06-10', 4, 'USD'],
      ['DIVIDEND', A.id, '2024-08-12', 10, 'USD'],
    ].sort((a, b) => ((a[2] as string) < (b[2] as string) ? -1 : 1)));
    expect(r.suggested.every((t) => t.importHash && t.source?.startsWith('corporate-action'))).toBe(true);
  });

  it('reports skipped and review-required actions', () => {
    expect(r.skipped.map((s) => s.reason).sort()).toEqual(['ALREADY_RECORDED', 'NO_POSITION']);
    expect(r.review).toHaveLength(1);
  });

  it('is idempotent once the suggestions are recorded', () => {
    const again = applyCorporateActions([...txs, ...r.suggested], actions, [A, V]);
    expect(again.suggested).toEqual([]);
  });
});
