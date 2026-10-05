/**
 * Opt-in live test against the real providers. Skipped unless LIVE=1:
 *   LIVE=1 npx vitest run packages/market-data/test/live.test.ts
 * Hits Yahoo Finance and datos.gov.co (and tries BCB/ECB, which fall back to Yahoo if blocked).
 */
import { describe, expect, it } from 'vitest';
import { addDays, CATALOG, MarketDataService, todayISO, toMonthEnd, type YahooChartResult, dateInZone } from '../src/index';

const LIVE = process.env.LIVE === '1';
const T = 120_000;

describe.skipIf(!LIVE)('LIVE providers', () => {
  const service = new MarketDataService();
  const today = todayISO();
  const from = addDays(today, -400);
  const report: string[] = [];
  const log = (s: string) => {
    report.push(s);
    console.log(s);
  };

  const groups: Record<string, string[]> = {
    BVC: ['ECOPETROL.CL', 'PFCIBEST.CL', 'CIBEST.CL', 'ISA.CL', 'GRUPOSURA.CL', 'NUTRESA.CL', 'ICOLCAP.CL'],
    B3: ['PETR4.SA', 'VALE3.SA', 'ITUB4.SA', 'WEGE3.SA', 'HGLG11.SA', 'MXRF11.SA', 'BOVA11.SA', 'IVVB11.SA'],
    EU: ['IBE.MC', 'SAN.MC', 'SAP.DE', 'MC.PA', 'ASML.AS', 'ENEL.MI', 'NESN.SW', 'VOD.L', 'SHEL.L', 'CSPX.L', 'IWDA.AS', 'VWCE.DE'],
    US: ['AAPL', 'MSFT', 'VOO', 'SPY', 'QQQ', 'VT', 'EC', 'CIB', 'URTH'],
    INDEX: ['^GSPC', '^BVSP', '^STOXX50E'],
  };

  for (const [group, symbols] of Object.entries(groups)) {
    it(
      `${group}: monthly history for ${symbols.length} symbols`,
      async () => {
        const results = await Promise.all(
          symbols.map(async (s) => {
            try {
              const h = await service.history({ symbol: s, from, interval: '1mo' });
              const last = h.series.points.at(-1);
              return { s, ok: h.series.points.length >= 10, line: `${s.padEnd(13)} ${h.instrument.id.padEnd(18)} ${h.series.currency} ${h.series.points.length} month-ends, last ${last?.date} ${last?.close}, actions ${h.actions.length}` };
            } catch (e) {
              return { s, ok: false, line: `${s.padEnd(13)} ERROR ${(e as Error).message}` };
            }
          }),
        );
        for (const r of results) log(`[${group}] ${r.ok ? 'OK ' : 'BAD'} ${r.line}`);
        expect(results.filter((r) => !r.ok).map((r) => r.s)).toEqual([]);
      },
      T,
    );
  }

  it(
    'GBp/USD on London: VOD.L normalized to GBP, CSPX.L stays USD',
    async () => {
      const [vod, cspx] = await Promise.all([service.quote('VOD.L'), service.quote('CSPX.L')]);
      log(`[LSE] VOD.L ${vod.price} ${vod.currency}; CSPX.L ${cspx.price} ${cspx.currency}`);
      expect(vod.currency).toBe('GBP');
      expect(vod.price).toBeLessThan(10);
      expect(cspx.currency).toBe('USD');
    },
    T,
  );

  it(
    'FX: TRM official, other pairs with source + fallbacks, TRM vs Yahoo within 3%',
    async () => {
      const pairs: [string, string, 'auto' | 'yahoo'][] = [
        ['USD', 'COP', 'auto'],
        ['USD', 'COP', 'yahoo'],
        ['USD', 'BRL', 'auto'],
        ['EUR', 'USD', 'auto'],
        ['EUR', 'COP', 'auto'],
        ['BRL', 'COP', 'auto'],
        ['USD', 'MXN', 'auto'],
        ['GBP', 'USD', 'auto'],
        ['USD', 'CLP', 'auto'],
        ['USD', 'PEN', 'auto'],
        ['CHF', 'USD', 'auto'],
      ];
      const out: Record<string, { rate: number; source: string }> = {};
      for (const [b, q, src] of pairs) {
        try {
          const r = await service.fxSeries({ base: b, quote: q, from, interval: '1mo', source: src });
          const last = r.series.points.at(-1)!;
          out[`${b}${q}:${src}`] = { rate: last.rate, source: String(r.series.source) };
          log(`[FX] ${b}/${q} (${src}) source=${r.series.source} ${r.series.points.length} month-ends, last ${last.date} ${last.rate}${r.fallbacks ? ` fallbacks=${r.fallbacks.map((f) => f.source).join(',')}` : ''}`);
        } catch (e) {
          log(`[FX] ${b}/${q} (${src}) ERROR ${(e as Error).message}`);
        }
      }
      expect(out['USDCOP:auto']?.source).toBe('banrep-trm');
      const trm = out['USDCOP:auto']!.rate;
      const y = out['USDCOP:yahoo']!.rate;
      expect(Math.abs(trm / y - 1)).toBeLessThan(0.03);
      for (const k of ['USDBRL:auto', 'EURUSD:auto', 'EURCOP:auto']) expect(out[k], k).toBeDefined();
    },
    T,
  );

  it(
    'TRM weekend fill on live data',
    async () => {
      const r = await service.fxSeries({ base: 'USD', quote: 'COP', from: addDays(today, -21), to: today });
      const days = r.series.points.map((p) => p.date);
      expect(days.length).toBeGreaterThanOrEqual(21);
      const weekend = r.series.points.filter((p) => [0, 6].includes(new Date(`${p.date}T00:00:00Z`).getUTCDay()));
      log(`[TRM] ${days.length} calendar days incl. ${weekend.length} weekend days, last ${days.at(-1)} ${r.series.points.at(-1)!.rate}`);
      expect(weekend.length).toBeGreaterThanOrEqual(4);
    },
    T,
  );

  it(
    'month-end from daily vs Yahoo 1mo bars (alignment check)',
    async () => {
      for (const sym of ['PETR4.SA', 'ECOPETROL.CL', 'AAPL']) {
        const start = addDays(today, -730);
        const daily = await service.history({ symbol: sym, from: start, adjust: 'splits' });
        const me = toMonthEnd(daily.series.points);
        const raw: YahooChartResult = await service.yahoo.chart(sym, { range: '2y', interval: '1mo' });
        const off = raw.meta.gmtoffset ?? 0;
        const bars = (raw.timestamp ?? []).map((t, i) => ({ date: dateInZone(t, raw.meta.exchangeTimezoneName, off), close: raw.indicators?.quote?.[0]?.close?.[i] }));
        let same = 0;
        let diff = 0;
        let labelledFirst = 0;
        for (const m of me.slice(0, -1)) {
          const bar = bars.find((b) => b.date.slice(0, 7) === m.date.slice(0, 7));
          if (!bar || bar.close == null) continue;
          if (bar.date.endsWith('-01')) labelledFirst++;
          if (Math.abs(bar.close / m.close - 1) < 0.001) same++;
          else diff++;
        }
        log(`[1mo vs daily] ${sym}: ${same} months equal, ${diff} differ, ${labelledFirst} bars labelled on day 01 (our month-end dates are the real last trading day), bars total ${bars.length}`);
        expect(same + diff).toBeGreaterThan(10);
      }
    },
    T,
  );

  it(
    'search + quote for the whole curated catalog',
    async () => {
      const s = await service.search('ecopetrol');
      log(`[search] ecopetrol -> ${s.results.slice(0, 5).map((r) => `${r.id}(${r.origin})`).join(', ')}`);
      expect(s.results[0]?.id).toBe('XBOG:ECOPETROL');
      const ids = CATALOG.instruments.map((i) => i.id);
      const qs = await service.quotes(ids);
      const failed = qs.map((q, i) => (q.ok ? null : `${ids[i]}: ${q.error.message}`)).filter(Boolean);
      const stale = qs.map((q, i) => (q.ok && q.data.stale ? `${ids[i]} (${q.data.date})` : null)).filter(Boolean);
      log(`[catalog] ${ids.length - failed.length}/${ids.length} quotes OK; failed: ${failed.join('; ') || 'none'}; stale: ${stale.join(', ') || 'none'}`);
      expect(failed).toEqual([]);
    },
    240_000,
  );
});
