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
      const qs = (await Promise.all([0, 100, 200].map((i) => service.quotes(ids.slice(i, i + 100))))).flat();
      const failed = qs.map((q, i) => (q.ok ? null : `${ids[i]}: ${q.error.message}`)).filter(Boolean);
      const stale = qs.map((q, i) => (q.ok && q.data.stale ? `${ids[i]} (${q.data.date})` : null)).filter(Boolean);
      log(`[catalog] ${ids.length - failed.length}/${ids.length} quotes OK; failed: ${failed.join('; ') || 'none'}; stale: ${stale.join(', ') || 'none'}`);
      expect(failed).toEqual([]);
    },
    240_000,
  );
});

describe.skipIf(!LIVE)('LIVE round 2', () => {
  const service = new MarketDataService();
  const today = todayISO();
  const log = (s: string) => console.log(s);

  it(
    'Colombia indices from BanRep SDMX; IPC_CO derived from UVR equals DANE',
    async () => {
      for (const id of ['UVR', 'IBR', 'IBR_EA', 'IBR_3M', 'DTF', 'TPM_CO']) {
        const r = await service.index({ id, from: addDays(today, -40) });
        const last = r.series.points.at(-1)!;
        log(`[index] ${id.padEnd(7)} ${r.series.kind}${r.series.dayCount ? ' ' + r.series.dayCount : ''} n=${r.series.points.length} last ${last.date} ${last.value} (${r.series.source})`);
        expect(r.series.points.length).toBeGreaterThan(5);
      }
      const ipc = await service.index({ id: 'IPC_CO', from: '2024-12-01', to: '2025-03-31' });
      log(`[index] IPC_CO ${ipc.series.points.map((p) => `${p.date.slice(0, 7)}=${p.value}`).join(' ')}`);
      expect(ipc.series.points.map((p) => Math.round(p.value * 100) / 100)).toEqual([0.46, 0.94, 1.14, 0.52]);
      const recent = await service.index({ id: 'IPC_CO', from: addDays(today, -150) });
      log(`[index] IPC_CO recent ${recent.series.points.map((p) => `${p.date.slice(0, 7)}=${p.value}`).join(' ')}`);
      const colcap = await service.index({ id: 'COLCAP_AVG', from: addDays(today, -120) });
      log(`[index] COLCAP_AVG ${colcap.series.points.map((p) => `${p.date}=${p.value}`).join(' ')}`);
    },
    T,
  );

  it(
    'Brazil / US / EU indices (BCB SGS, FRED, ECB) — reported, may be blocked from the build container',
    async () => {
      for (const id of ['CDI', 'SELIC', 'IPCA', 'CPI_US', 'HICP_EA']) {
        try {
          const r = await service.index({ id, from: addDays(today, -60) });
          log(`[index] ${id} OK n=${r.series.points.length} last ${r.series.points.at(-1)?.date} ${r.series.points.at(-1)?.value}`);
        } catch (e) {
          log(`[index] ${id} UNREACHABLE: ${(e as Error).message.slice(0, 120)}`);
        }
      }
    },
    T,
  );

  it(
    'FIC and pension funds from the Superintendencia Financiera',
    async () => {
      const s = await service.search('fiducuenta');
      const fic = s.results.filter((r) => r.origin === 'fic');
      log(`[fic] search fiducuenta -> ${fic.map((r) => r.id).join(', ')}`);
      expect(fic.length).toBeGreaterThan(0);
      const h = await service.history({ symbol: fic[0]!.id, from: addDays(today, -60), interval: '1mo' });
      log(`[fic] ${fic[0]!.id} ${h.series.points.map((p) => `${p.date}=${p.close}`).join(' ')}`);
      expect(h.series.points.length).toBeGreaterThan(1);
      const afp = (await service.search('porvenir moderado')).results.find((r) => r.origin === 'afp');
      const ha = await service.history({ symbol: afp!.id, from: addDays(today, -20) });
      log(`[afp] ${afp!.id} ${afp!.name} last ${ha.series.points.at(-1)?.date} ${ha.series.points.at(-1)?.close}`);
      const cdt = (await service.search('cdt ibr')).results.find((r) => r.origin === 'template');
      log(`[template] ${cdt?.id} ${JSON.stringify(cdt?.accrual)}`);
    },
    T,
  );

  it(
    'renamed tickers, suspended stock, bonificação and spin-off on live Yahoo data',
    async () => {
      for (const old of ['PFBCOLOM.CL', 'BCOLOMBIA.CL', 'ELET3.SA', 'EMBR3.SA', 'CCRO3.SA']) {
        const h = await service.history({ symbol: old, from: '2025-01-01', to: '2025-03-31', interval: '1mo' });
        log(`[alias] ${old} -> ${h.instrument.id} n=${h.series.points.length} renamedFrom=${h.renamedFrom?.fromId}`);
        expect(h.series.points.length).toBe(3);
      }
      const cnec = await service.history({ symbol: 'CNEC.CL', from: '2025-10-01' });
      const q = await service.quote('CNEC.CL');
      log(`[stale] CNEC last ${JSON.stringify(cnec.series.points.at(-1))} lastTrade=${cnec.series.lastTradeDate} stale=${cnec.series.stale}; quote ${q.price} ${q.date} stale=${q.stale}`);
      expect(cnec.series.points.at(-1)!.close).toBe(q.price);
      const itub = await service.history({ symbol: 'ITUB4.SA', from: '2025-03-01', to: '2025-03-31' });
      const ge = await service.history({ symbol: 'GE', from: '2024-03-25', to: '2024-04-05' });
      log(`[actions] ITUB4 ${JSON.stringify(itub.actions.filter((a) => a.type !== 'DIVIDEND').map((a) => [a.date, a.type, a.ratio]))}; GE ${JSON.stringify(ge.actions.filter((a) => a.type !== 'DIVIDEND').map((a) => [a.date, a.subtype, a.targetInstrumentId, a.costFraction]))} GE 2024-03-25 as traded ${ge.series.points[0]!.close}`);
      expect(itub.actions.some((a) => a.type === 'STOCK_DIVIDEND')).toBe(true);
      expect(ge.actions.some((a) => a.subtype === 'SPINOFF')).toBe(true);
      const vusa = await service.history({ symbol: 'VUSA.L', from: addDays(today, -365) });
      log(`[divs] VUSA.L ${vusa.series.currency} ${JSON.stringify(vusa.actions.map((a) => [a.date, a.amountPerShare, a.currency]))}`);
      const petr = await service.history({ symbol: 'PETR4.SA', from: addDays(today, -10), interval: '1mo' });
      log(`[provisional] PETR4 marketState=${petr.marketState} last ${JSON.stringify(petr.series.points.at(-1))}`);
    },
    T,
  );

  it(
    'crypto via CoinGecko and reachability of the other fallback providers',
    async () => {
      const cg = await service.fallbackProviders.find((p) => p.id === 'coingecko')!.dailyHistory(
        { instrumentId: 'CRYPTO:BTC-USD', exchange: 'CRYPTO', symbol: 'BTC-USD', yahoo: 'BTC-USD' },
        addDays(today, -7),
        today,
      );
      log(`[coingecko] BTC-USD n=${cg.points.length} last ${JSON.stringify(cg.points.at(-1))}`);
      expect(cg.points.length).toBeGreaterThan(5);
      for (const p of service.fallbackProviders.filter((x) => x.id !== 'coingecko')) {
        const t = p.id === 'brapi' ? { instrumentId: 'BVMF:PETR4', exchange: 'BVMF', symbol: 'PETR4', yahoo: 'PETR4.SA' } : { instrumentId: 'XNAS:AAPL', exchange: 'XNAS', symbol: 'AAPL', yahoo: 'AAPL' };
        try {
          const h = await p.dailyHistory(t, addDays(today, -10), today);
          log(`[provider] ${p.id} OK n=${h.points.length}`);
        } catch (e) {
          log(`[provider] ${p.id} UNREACHABLE: ${(e as Error).message.slice(0, 100)}`);
        }
      }
      for (const [b, q, side] of [['USD', 'BRL', 'buy'], ['BTC', 'BRL', 'sell']] as const) {
        try {
          const r = await service.fxSeries({ base: b, quote: q, from: addDays(today, -10), side });
          log(`[fx] ${b}/${q} side=${side} source=${r.series.source} last ${JSON.stringify(r.series.points.at(-1))}`);
        } catch (e) {
          log(`[fx] ${b}/${q} side=${side} ${(e as Error).message.slice(0, 100)}`);
        }
      }
      try {
        const td = await service.search('tesouro ipca');
        log(`[tesouro] ${td.results.filter((r) => r.origin === 'tesouro').length} titles ${td.warnings ? 'warnings: ' + td.warnings.join('; ').slice(0, 120) : ''}`);
      } catch (e) {
        log(`[tesouro] ${(e as Error).message}`);
      }
    },
    T,
  );
});

/**
 * Contract tests (review R2, M15): validate the documented-but-unreachable-from-CI providers
 * against the REAL services. From a machine with access they assert the parsed shape; with
 * RECORD=1 they also overwrite the synthetic fixtures with real responses. From the build
 * container (403 egress) they only report that the service is unreachable.
 */
describe.skipIf(!LIVE)('LIVE contract tests for providers validated only with synthetic fixtures', () => {
  const service = new MarketDataService();
  const today = todayISO();
  const RECORD = process.env.RECORD === '1';
  const unreachable = (e: unknown) =>
    /403|ENOTFOUND|ECONN|fetch failed|forbidden|egress|allowlist|timeout|timed out/i.test(`${String((e as Error)?.message ?? e)} ${JSON.stringify((e as { details?: unknown })?.details ?? '')}`);

  // CONTRACT_STRICT=1 (CI / a machine with access): an unreachable service is a FAILURE, so the
  // contract really validates the formats instead of passing silently (review R3, M15).
  const STRICT = process.env.CONTRACT_STRICT === '1';
  const contract = async (name: string, run: () => Promise<void>) => {
    try {
      await run();
      console.log(`[contract] ${name}: OK`);
    } catch (e) {
      if (unreachable(e) && !STRICT) console.log(`[contract] ${name}: UNREACHABLE from here (${String((e as Error).message).slice(0, 80)})`);
      else throw e;
    }
  };

  it(
    'BCB SGS / PTAX, SIDRA, ECB, FRED, Tesouro, brapi, stooq',
    async () => {
      const from = addDays(today, -40);
      await contract('SGS 12 (CDI)', async () => {
        const r = await service.index({ id: 'CDI', from });
        expect(r.series.points.every((p) => p.value > 0 && p.value < 1)).toBe(true);
      });
      await contract('SGS 433 / SIDRA (IPCA)', async () => {
        const r = await service.index({ id: 'IPCA', from: addDays(today, -200) });
        expect(r.series.points.length).toBeGreaterThan(3);
      });
      await contract('PTAX buy/sell', async () => {
        const [b, s] = await Promise.all([
          service.fxSeries({ base: 'USD', quote: 'BRL', from, side: 'buy', source: 'official' }),
          service.fxSeries({ base: 'USD', quote: 'BRL', from, source: 'official' }),
        ]);
        expect(b.series.points.at(-1)!.rate).toBeLessThan(s.series.points.at(-1)!.rate);
      });
      await contract('ECB EXR', async () => {
        const r = await service.fxSeries({ base: 'EUR', quote: 'USD', from, source: 'official' });
        expect(r.series.source).toBe('ecb');
      });
      await contract('FRED CPI', async () => {
        expect((await service.index({ id: 'CPI_US', from: addDays(today, -120) })).series.points.length).toBeGreaterThan(1);
      });
      await contract('Tesouro CSV', async () => {
        const titles = await service.tesouro.titles();
        expect(titles.size).toBeGreaterThan(5);
      });
      for (const p of service.fallbackProviders.filter((x) => ['brapi', 'stooq'].includes(String(x.id)))) {
        await contract(String(p.id), async () => {
          const t = p.id === 'brapi' ? { instrumentId: 'BVMF:PETR4', exchange: 'BVMF', symbol: 'PETR4', yahoo: 'PETR4.SA' } : { instrumentId: 'XNAS:AAPL', exchange: 'XNAS', symbol: 'AAPL', yahoo: 'AAPL' };
          const h = await p.dailyHistory(t, addDays(today, -10), today);
          expect(h.points.length).toBeGreaterThan(2);
        });
      }
      if (RECORD) console.log('[contract] RECORD=1: re-record fixtures with the curl commands listed in the README (section Pruebas).');
    },
    300_000, // blocked hosts are retried with backoff before being reported unreachable
  );
});

describe.skipIf(!LIVE)('LIVE round 3', () => {
  const service = new MarketDataService();
  it(
    'mergers vs renames, SAP.DE last close',
    async () => {
      const brf = await service.history({ symbol: 'BRFS3', from: '2024-01-01', to: '2025-12-31', interval: '1mo' });
      const mrfg = await service.history({ symbol: 'MRFG3', from: '2024-01-01', to: '2024-06-30', interval: '1mo' });
      console.log(`[M23] BRFS3 points=${brf.series.points.length} delisted=${JSON.stringify(brf.delisted)} actions=${JSON.stringify(brf.actions.map((a) => [a.date, a.subtype, a.ratio, a.targetInstrumentId]))}`);
      console.log(`[M23] MRFG3 -> ${mrfg.instrument.id} ${mrfg.series.points.map((p) => p.close).join(',')}`);
      expect(brf.series.points.every((p) => !mrfg.series.points.some((m) => m.date === p.date && m.close === p.close))).toBe(true);
      expect(brf.actions.some((a) => a.subtype === 'MERGER' && a.ratio === 0.8521)).toBe(true);
      const cple = await service.history({ symbol: 'CPLE6', from: '2025-12-01', to: '2026-01-31' });
      console.log(`[M23] CPLE6 actions=${JSON.stringify(cple.actions.map((a) => [a.date, a.type, a.subtype, a.ratio ?? a.amountPerShare]))}`);
      const sap = await service.history({ symbol: 'SAP.DE', from: addDays(todayISO(), -7) });
      const q = await service.quote('SAP.DE');
      console.log(`[M20] SAP.DE history last ${JSON.stringify(sap.series.points.at(-1))} lastTrade=${sap.series.lastTradeDate}; quote ${q.date} ${q.price}`);
      expect(sap.series.points.at(-1)!.date).toBe(q.date);
    },
    T,
  );
});

describe.skipIf(!LIVE)('LIVE round 4', () => {
  const service = new MarketDataService();
  it(
    'every rename alias has continuous monthly history since 2019; NATU3 June-2025 not phantom; B3 bare tickers',
    async () => {
      const { TICKER_ALIASES } = await import('../src/index');
      for (const a of TICKER_ALIASES.filter((x) => x.kind === 'rename')) {
        const h = await service.history({ symbol: a.fromYahoo, from: '2019-01-01', to: '2026-09-30', interval: '1mo' });
        const months = new Set(h.series.points.map((p) => p.date.slice(0, 7)));
        const missing: string[] = [];
        for (let y = 2019; y <= 2026; y++) for (let m = 1; m <= 12; m++) {
          const k = `${y}-${String(m).padStart(2, '0')}`;
          if (k <= '2026-09' && !months.has(k)) missing.push(k);
        }
        console.log(`[continuity] ${a.fromYahoo} -> ${a.toId}: ${h.series.points.length} months, missing ${missing.length} ${missing.slice(0, 6).join(',')}`);
        expect(missing).toEqual([]);
      }
      const natu = await service.history({ symbol: 'NATU3.SA', from: '2025-05-01', to: '2025-08-31', interval: '1mo' });
      console.log(`[M28] NATU3 ${JSON.stringify(natu.series.points)} notes=${JSON.stringify(natu.notes)}`);
      expect(natu.series.points.every((p) => p.close < 20)).toBe(true);
      const ntco = await service.history({ symbol: 'NTCO3', from: '2025-01-01', to: '2025-12-31', interval: '1mo' });
      console.log(`[M28] NTCO3 delisted=${ntco.delisted?.kind} points=${ntco.series.points.length} actions=${JSON.stringify(ntco.actions.map((a) => [a.date, a.subtype, a.targetInstrumentId]))}`);
      for (const s of ['CPLE3', 'TAEE11', 'SAPR11']) {
        const q = await service.quote(s);
        console.log(`[M30] ${s} -> ${q.instrumentId} ${q.price} ${q.currency}`);
        expect(q.instrumentId.startsWith('BVMF:')).toBe(true);
      }
    },
    T,
  );
});

describe.skipIf(!LIVE)('LIVE round 5', () => {
  const service = new MarketDataService();
  it(
    'bare BVC tickers quote from the BVC; windows without trades are seeded; unknown symbols are NOT_FOUND',
    async () => {
      const quotes = await service.quotes(['ECOPETROL', 'PFAVAL', 'GEB', 'ISA', 'NUTRESA', 'ICOLCAP', 'CEMARGOS', 'PFCIBEST']);
      for (const q of quotes) {
        expect(q.ok).toBe(true);
        if (q.ok) expect(q.data).toMatchObject({ instrumentId: expect.stringMatching(/^XBOG:/), currency: 'COP' });
      }
      const h = await service.history({ symbol: 'ELCONDOR.CL', from: '2023-04-01', to: '2023-05-31', interval: '1mo' });
      console.log('[live] ELCONDOR 2023-04..05:', JSON.stringify(h.series.points));
      expect(h.series.points[0]).toMatchObject({ carried: true });
      expect(h.series.points[0]!.date < '2023-04-01').toBe(true);
      const err = await service.history({ symbol: 'QQXZ', from: '2025-01-01', to: '2025-02-01' }).catch((e: unknown) => e as { code?: string });
      expect(err.code).toBe('NOT_FOUND');
    },
    T,
  );
});
