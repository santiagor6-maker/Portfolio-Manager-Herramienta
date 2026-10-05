/**
 * Local sample-portfolio generator. Used only when `createDemoData()` from @pm/core is not
 * available. Deterministic (seeded) so screenshots and tests are stable.
 */
import type { FxSeries, Instrument, PriceSeries, Transaction } from '@pm/core';
import type { SeedData } from '../db/repo';
import type { StoredPortfolio } from '../db/schema';
import { addDays, monthsBetween, todayIso } from '../lib/ids';
import { BENCHMARKS } from '../lib/benchmarks';

const PID = 'demo-portfolio';

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(r: () => number): number {
  const u = Math.max(r(), 1e-9);
  const v = r();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function businessDays(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const dow = new Date(`${d}T00:00:00Z`).getUTCDay();
    if (dow !== 0 && dow !== 6) out.push(d);
  }
  return out;
}

interface Spec {
  inst: Instrument;
  start: number;
  drift: number; // annual
  vol: number; // annual
  dps?: number; // dividend yield per year (fraction of price)
  divMonths?: number[];
  wht?: number;
}

const I = (
  id: string,
  name: string,
  currency: string,
  country: string,
  assetClass: Instrument['assetClass'],
  sector: string,
  yahoo?: string,
  pricing: 'auto' | 'manual' = 'auto',
): Instrument => {
  const [exchange, symbol] = id.split(':') as [string, string];
  return {
    id,
    symbol,
    name,
    exchange,
    currency,
    country,
    assetClass,
    sector,
    pricing,
    providerSymbols: yahoo ? { yahoo } : undefined,
  };
};

const SPECS: Spec[] = [
  { inst: I('XBOG:ECOPETROL', 'Ecopetrol S.A.', 'COP', 'CO', 'equity', 'Energía', 'ECOPETROL.CL'), start: 2600, drift: 0.02, vol: 0.32, dps: 0.11, divMonths: [4, 9], wht: 0.1 },
  { inst: I('XBOG:PFBCOLOM', 'Bancolombia Preferencial', 'COP', 'CO', 'equity', 'Financiero', 'PFBCOLOM.CL'), start: 31000, drift: 0.06, vol: 0.3, dps: 0.08, divMonths: [4, 7, 10], wht: 0.1 },
  { inst: I('XBOG:ISA', 'Interconexión Eléctrica (ISA)', 'COP', 'CO', 'equity', 'Servicios públicos', 'ISA.CL'), start: 21000, drift: 0.04, vol: 0.25, dps: 0.06, divMonths: [6, 12], wht: 0.1 },
  { inst: I('BVMF:PETR4', 'Petrobras PN', 'BRL', 'BR', 'equity', 'Energía', 'PETR4.SA'), start: 28, drift: 0.12, vol: 0.34, dps: 0.12, divMonths: [2, 5, 8, 11], wht: 0 },
  { inst: I('BVMF:ITUB4', 'Itaú Unibanco PN', 'BRL', 'BR', 'equity', 'Financiero', 'ITUB4.SA'), start: 22, drift: 0.14, vol: 0.26, dps: 0.06, divMonths: [3, 6, 9, 12], wht: 0 },
  { inst: I('BVMF:VALE3', 'Vale ON', 'BRL', 'BR', 'equity', 'Materiales', 'VALE3.SA'), start: 80, drift: -0.03, vol: 0.33, dps: 0.08, divMonths: [3, 9], wht: 0 },
  { inst: I('XNAS:AAPL', 'Apple Inc.', 'USD', 'US', 'equity', 'Tecnología', 'AAPL'), start: 175, drift: 0.13, vol: 0.27, dps: 0.005, divMonths: [2, 5, 8, 11], wht: 0.3 },
  { inst: I('XNAS:MSFT', 'Microsoft Corp.', 'USD', 'US', 'equity', 'Tecnología', 'MSFT'), start: 320, drift: 0.15, vol: 0.25, dps: 0.008, divMonths: [3, 6, 9, 12], wht: 0.3 },
  { inst: I('ARCX:VOO', 'Vanguard S&P 500 ETF', 'USD', 'US', 'etf', 'Diversificado', 'VOO'), start: 390, drift: 0.1, vol: 0.17, dps: 0.014, divMonths: [3, 6, 9, 12], wht: 0.3 },
  { inst: I('XMAD:SAN', 'Banco Santander', 'EUR', 'ES', 'equity', 'Financiero', 'SAN.MC'), start: 3.0, drift: 0.16, vol: 0.3, dps: 0.04, divMonths: [5, 11], wht: 0.19 },
  { inst: I('XAMS:ASML', 'ASML Holding', 'EUR', 'NL', 'equity', 'Tecnología', 'ASML.AS'), start: 600, drift: 0.1, vol: 0.35, dps: 0.009, divMonths: [5, 8, 11], wht: 0.15 },
  { inst: I('MANUAL:FIC-RENTA', 'FIC Renta Fija Plus', 'COP', 'CO', 'fund', 'Renta fija', undefined, 'manual'), start: 10000, drift: 0.09, vol: 0.02 },
];

const START = '2022-01-03';

function genPrices(spec: Spec, days: string[], seed: number): PriceSeries {
  const r = rng(seed);
  const dt = 1 / 252;
  let p = spec.start;
  const points = days.map((date) => {
    p *= Math.exp((spec.drift - 0.5 * spec.vol ** 2) * dt + spec.vol * Math.sqrt(dt) * gauss(r));
    return { date, close: Number(p.toPrecision(6)) };
  });
  return { instrumentId: spec.inst.id, currency: spec.inst.currency, points, source: 'demo' };
}

function genFx(base: string, quote: string, start: number, vol: number, days: string[], seed: number, mean = start): FxSeries {
  const r = rng(seed);
  const dt = 1 / 252;
  let x = start;
  const points = days.map((date) => {
    x *= Math.exp(1.2 * Math.log(mean / x) * dt + vol * Math.sqrt(dt) * gauss(r));
    return { date, rate: Number(x.toPrecision(6)) };
  });
  return { base, quote, points, source: 'demo' };
}

export function createFallbackDemo(today = todayIso()): SeedData {
  const days = businessDays('2021-12-01', today);
  const prices = SPECS.filter((s) => s.inst.pricing !== 'manual').map((s, i) => genPrices(s, days, 101 + i * 7));
  const fic = genPrices(SPECS.find((s) => s.inst.id === 'MANUAL:FIC-RENTA')!, days, 999);
  const benchSpecs: Record<string, [number, number, number]> = {
    'INDEX:COLCAP': [1400, 0.03, 0.2],
    'INDEX:IBOV': [104000, 0.1, 0.22],
    'INDEX:SPX': [4700, 0.1, 0.17],
    'INDEX:MSCIW': [130, 0.08, 0.16],
  };
  BENCHMARKS.forEach((b, i) => {
    const [start, drift, vol] = benchSpecs[b.id] ?? [100, 0.05, 0.2];
    prices.push(genPrices({ inst: b, start, drift, vol }, days, 500 + i));
  });
  const fx = [
    genFx('USD', 'COP', 3980, 0.12, days, 7, 4150),
    genFx('USD', 'BRL', 5.6, 0.14, days, 11, 5.3),
    genFx('EUR', 'USD', 1.13, 0.07, days, 13, 1.1),
  ];

  const priceOn = (series: PriceSeries, date: string) => {
    let last = series.points[0]?.close ?? 0;
    for (const p of series.points) {
      if (p.date > date) break;
      last = p.close;
    }
    return last;
  };
  const fxOn = (s: FxSeries, date: string) => {
    let last = s.points[0]?.rate ?? 1;
    for (const p of s.points) {
      if (p.date > date) break;
      last = p.rate;
    }
    return last;
  };
  const usdCop = fx[0]!;
  const usdBrl = fx[1]!;
  const eurUsd = fx[2]!;
  const copPer = (ccy: string, d: string) =>
    ccy === 'COP' ? 1 : ccy === 'USD' ? fxOn(usdCop, d) : ccy === 'BRL' ? fxOn(usdCop, d) / fxOn(usdBrl, d) : fxOn(eurUsd, d) * fxOn(usdCop, d);

  const txs: Transaction[] = [];
  const held = new Map<string, number>();
  let n = 0;
  const push = (t: Omit<Transaction, 'id' | 'portfolioId'>) => txs.push({ id: `demo-tx-${++n}`, portfolioId: PID, source: 'demo', ...t });
  const firstBiz = (month: string, offset = 0) => days.find((d) => d.startsWith(month) && d >= START) ?? `${month}-0${2 + offset}`;

  const rotation: Record<number, string[]> = {
    0: ['XBOG:ECOPETROL', 'XBOG:PFBCOLOM', 'XBOG:ISA'],
    1: ['XNAS:AAPL', 'XNAS:MSFT', 'ARCX:VOO'],
    2: ['BVMF:PETR4', 'BVMF:ITUB4', 'BVMF:VALE3'],
    3: ['XMAD:SAN', 'XAMS:ASML', 'MANUAL:FIC-RENTA'],
  };
  const months = monthsBetween(START, today);
  months.forEach((m, idx) => {
    const d = firstBiz(m);
    if (d > today) return;
    const deposit = idx === 0 ? 30_000_000 : 4_000_000;
    push({ date: d, type: 'DEPOSIT', currency: 'COP', amount: deposit, note: idx === 0 ? 'Aporte inicial' : 'Aporte mensual' });
    const group = rotation[idx % 4]!;
    const budgetCop = idx === 0 ? 27_000_000 : 3_600_000;
    const picks = idx === 0 ? [...rotation[0]!, ...rotation[1]!, 'BVMF:PETR4', 'XMAD:SAN'] : [group[idx % 3]!];
    const per = budgetCop / picks.length;
    // Convert COP into the currencies needed this month.
    const need = new Map<string, number>();
    for (const id of picks) {
      const spec = SPECS.find((s) => s.inst.id === id)!;
      if (spec.inst.currency !== 'COP') need.set(spec.inst.currency, (need.get(spec.inst.currency) ?? 0) + per);
    }
    for (const [ccy, cop] of need) {
      const rate = copPer(ccy, d);
      push({ date: d, type: 'FX_CONVERSION', currency: 'COP', amount: Math.round(cop), toCurrency: ccy, toAmount: Math.round((cop / rate) * 100) / 100 });
    }
    for (const id of picks) {
      const spec = SPECS.find((s) => s.inst.id === id)!;
      const series = id === 'MANUAL:FIC-RENTA' ? fic : prices.find((p) => p.instrumentId === id)!;
      const price = priceOn(series, d);
      const budget = (per / copPer(spec.inst.currency, d)) * 0.99;
      const qty = spec.inst.currency === 'COP' ? Math.floor(budget / price) : Math.floor((budget / price) * 100) / 100;
      if (qty <= 0) continue;
      const fees = Math.round(qty * price * 0.002 * 100) / 100;
      push({ date: d, type: 'BUY', instrumentId: id, quantity: qty, price, currency: spec.inst.currency, fees, account: brokerFor(spec.inst.currency) });
      held.set(id, (held.get(id) ?? 0) + qty);
    }
    // Dividends paid mid-month for positions held.
    const monthNum = Number(m.slice(5, 7));
    const payDate = addDays(`${m}-15`, 0);
    if (payDate <= today) {
      for (const spec of SPECS) {
        const q = held.get(spec.inst.id) ?? 0;
        if (!q || !spec.dps || !spec.divMonths?.includes(monthNum)) continue;
        const series = prices.find((p) => p.instrumentId === spec.inst.id)!;
        const gross = Math.round(q * priceOn(series, payDate) * (spec.dps / spec.divMonths.length) * 100) / 100;
        push({
          date: payDate,
          type: 'DIVIDEND',
          instrumentId: spec.inst.id,
          currency: spec.inst.currency,
          amount: gross,
          taxes: Math.round(gross * (spec.wht ?? 0) * 100) / 100,
          account: brokerFor(spec.inst.currency),
        });
      }
    }
    // A couple of sells to produce realized gains.
    if (m === '2024-06' || m === '2025-08') {
      const id = m === '2024-06' ? 'BVMF:VALE3' : 'XMAD:SAN';
      const q = held.get(id) ?? 0;
      if (q > 0) {
        const sd = addDays(d, 9);
        const series = prices.find((p) => p.instrumentId === id)!;
        const qty = Math.floor((q / 2) * 100) / 100;
        const spec = SPECS.find((s) => s.inst.id === id)!;
        const price = priceOn(series, sd);
        push({ date: sd, type: 'SELL', instrumentId: id, quantity: qty, price, currency: spec.inst.currency, fees: Math.round(qty * price * 0.002 * 100) / 100, account: brokerFor(spec.inst.currency) });
        held.set(id, q - qty);
      }
    }
    if (idx % 3 === 2) push({ date: addDays(d, 20) <= today ? addDays(d, 20) : d, type: 'FEE', currency: 'COP', amount: 15_000, note: 'Cuota de administración' });
  });

  // Month-end manual prices for the FIC (the "cierre de mes" flow fills these in normally).
  const manualPrices = months
    .slice(0, -1)
    .map((m) => {
      const end = [...fic.points].reverse().find((p) => p.date.startsWith(m));
      return end ? { instrumentId: 'MANUAL:FIC-RENTA', date: end.date, close: end.close, currency: 'COP', note: 'Extracto mensual' } : undefined;
    })
    .filter((x): x is NonNullable<typeof x> => !!x);

  const portfolio: StoredPortfolio = {
    id: PID,
    name: 'Portafolio de ejemplo',
    baseCurrency: 'COP',
    taxResidence: 'CO',
    costMethod: 'FIFO',
    createdAt: START,
    benchmarks: ['INDEX:COLCAP', 'INDEX:SPX'],
    isDemo: true,
  };
  return {
    portfolios: [portfolio],
    instruments: SPECS.map((s) => s.inst),
    transactions: txs.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)),
    prices,
    fx,
    manualPrices,
  };
}

function brokerFor(ccy: string): string {
  return ccy === 'COP' ? 'Trii' : ccy === 'BRL' ? 'XP Investimentos' : 'Interactive Brokers';
}
