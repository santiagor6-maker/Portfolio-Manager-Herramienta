/**
 * DEMO dataset ("Portafolio de ejemplo") so the UI opens in a working state before real
 * data loads. Prices, FX rates, dividends and the WEGE3 split are SYNTHETIC (plausible
 * ranges, deterministic pseudo-random noise); they are not historical market data.
 *
 * Colombian investor (base COP) with accounts at a Colombian broker (BVC), a US broker
 * (USD/EUR) and a Brazilian broker (B3). Month-end series 2023-01 .. 2026-09, two CDTs valued by
 * accrual (redeemed automatically at maturity), synthetic IPC (inflation) and IBR series.
 * Bancolombia appears as Grupo Cibest (PFCIBEST), its listing after the holding reorganization.
 */
import type {
  CurrencyCode,
  FxSeries,
  IndexSeries,
  Instrument,
  ISODate,
  MarketData,
  Portfolio,
  PriceSeries,
  Transaction,
  YearMonth,
} from './types';
import type { EngineInput, MarketDataInput } from './api';
import { createMarketDataImpl, type MarketDataEx } from './market';
import { isoToDay, monthEnd, monthRange } from './dates';

export const DEMO_PORTFOLIO_ID = 'demo-portafolio-ejemplo';

export interface DemoData {
  portfolio: Portfolio;
  instruments: Instrument[];
  transactions: Transaction[];
  prices: PriceSeries[];
  fx: FxSeries[];
  marketInput: MarketDataInput;
  market: MarketData & MarketDataEx;
  /** Ready-to-use engine input. */
  input: EngineInput;
  /** Last date with market data. */
  asOf: ISODate;
  /** Always true: lets the UI show a "datos de ejemplo" badge. */
  isDemo: true;
}

const FIRST_MONTH: YearMonth = '2023-01';
const LAST_MONTH: YearMonth = '2026-09';
const SPLIT_DATE = '2024-04-15'; // synthetic WEGE3 2:1 split

// ---------------------------------------------------------------------------
// deterministic noise
// ---------------------------------------------------------------------------

function hashString(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand: () => number): number {
  const u = Math.max(rand(), 1e-12);
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

const MONTHS = monthRange(FIRST_MONTH, LAST_MONTH);
const monthIndex = (ym: YearMonth) => MONTHS.indexOf(ym);

/** Log-linear interpolation between keyframes plus smooth deterministic noise. */
function path(seedKey: string, keys: Record<YearMonth, number>, sigma: number, decimals: number, clamp?: [number, number]): number[] {
  const kf = Object.entries(keys)
    .map(([ym, v]) => [monthIndex(ym), Math.log(v)] as [number, number])
    .sort((a, b) => a[0] - b[0]);
  const rand = mulberry32(hashString(seedKey));
  let noise = 0;
  return MONTHS.map((_, i) => {
    let base: number;
    if (i <= kf[0]![0]) base = kf[0]![1];
    else if (i >= kf[kf.length - 1]![0]) base = kf[kf.length - 1]![1];
    else {
      let j = 0;
      while (kf[j + 1]![0] < i) j++;
      const [i0, v0] = kf[j]!;
      const [i1, v1] = kf[j + 1]!;
      base = v0 + ((v1 - v0) * (i - i0)) / (i1 - i0);
    }
    // AR(1) noise so consecutive months are correlated, pinned near keyframes.
    noise = 0.55 * noise + sigma * gaussian(rand);
    const atKey = kf.some(([k]) => k === i);
    let v = Math.exp(base + (atKey ? noise * 0.3 : noise));
    if (clamp) v = Math.min(clamp[1], Math.max(clamp[0], v));
    const f = 10 ** decimals;
    return Math.round(v * f) / f;
  });
}

// ---------------------------------------------------------------------------
// instruments
// ---------------------------------------------------------------------------

const INSTRUMENTS: Instrument[] = [
  { id: 'XBOG:ECOPETROL', symbol: 'ECOPETROL', name: 'Ecopetrol S.A.', exchange: 'XBOG', currency: 'COP', country: 'CO', assetClass: 'equity', sector: 'Energía', industry: 'Petróleo y gas integrado', isin: 'COC04PA00016', providerSymbols: { yahoo: 'ECOPETROL.CL' } },
  { id: 'XBOG:PFCIBEST', symbol: 'PFCIBEST', name: 'Grupo Cibest S.A. Preferencial (antes Bancolombia PFBCOLOM)', exchange: 'XBOG', currency: 'COP', country: 'CO', assetClass: 'equity', sector: 'Financiero', industry: 'Bancos', providerSymbols: { yahoo: 'PFCIBEST.CL' } },
  { id: 'XBOG:ISA', symbol: 'ISA', name: 'Interconexión Eléctrica S.A. E.S.P.', exchange: 'XBOG', currency: 'COP', country: 'CO', assetClass: 'equity', sector: 'Servicios públicos', industry: 'Transmisión de energía', isin: 'COE15PA00026', providerSymbols: { yahoo: 'ISA.CL' } },
  { id: 'BVMF:PETR4', symbol: 'PETR4', name: 'Petrobras PN', exchange: 'BVMF', currency: 'BRL', country: 'BR', assetClass: 'equity', sector: 'Energía', industry: 'Petróleo y gas integrado', isin: 'BRPETRACNPR6', providerSymbols: { yahoo: 'PETR4.SA' } },
  { id: 'BVMF:ITUB4', symbol: 'ITUB4', name: 'Itaú Unibanco PN', exchange: 'BVMF', currency: 'BRL', country: 'BR', assetClass: 'equity', sector: 'Financiero', industry: 'Bancos', isin: 'BRITUBACNPR1', providerSymbols: { yahoo: 'ITUB4.SA' } },
  { id: 'BVMF:WEGE3', symbol: 'WEGE3', name: 'WEG ON', exchange: 'BVMF', currency: 'BRL', country: 'BR', assetClass: 'equity', sector: 'Industrial', industry: 'Equipos eléctricos', isin: 'BRWEGEACNOR0', providerSymbols: { yahoo: 'WEGE3.SA' } },
  { id: 'XNAS:AAPL', symbol: 'AAPL', name: 'Apple Inc.', exchange: 'XNAS', currency: 'USD', country: 'US', assetClass: 'equity', sector: 'Tecnología', industry: 'Hardware', isin: 'US0378331005', providerSymbols: { yahoo: 'AAPL' } },
  { id: 'XNAS:MSFT', symbol: 'MSFT', name: 'Microsoft Corporation', exchange: 'XNAS', currency: 'USD', country: 'US', assetClass: 'equity', sector: 'Tecnología', industry: 'Software', isin: 'US5949181045', providerSymbols: { yahoo: 'MSFT' } },
  { id: 'ARCX:VOO', symbol: 'VOO', name: 'Vanguard S&P 500 ETF', exchange: 'ARCX', currency: 'USD', country: 'US', assetClass: 'etf', sector: 'Diversificado', isin: 'US9229083632', providerSymbols: { yahoo: 'VOO' } },
  { id: 'XAMS:ASML', symbol: 'ASML', name: 'ASML Holding N.V.', exchange: 'XAMS', currency: 'EUR', country: 'NL', assetClass: 'equity', sector: 'Tecnología', industry: 'Semiconductores', isin: 'NL0010273215', providerSymbols: { yahoo: 'ASML.AS' } },
  { id: 'XMAD:IBE', symbol: 'IBE', name: 'Iberdrola S.A.', exchange: 'XMAD', currency: 'EUR', country: 'ES', assetClass: 'equity', sector: 'Servicios públicos', industry: 'Electricidad', isin: 'ES0144580Y14', providerSymbols: { yahoo: 'IBE.MC' } },
  {
    id: 'MANUAL:CDT-2024',
    symbol: 'CDT 12,0 % E.A.',
    name: 'CDT Banco de ejemplo 12,0 % E.A. a 360 días',
    exchange: 'MANUAL',
    currency: 'COP',
    country: 'CO',
    assetClass: 'fixed_income',
    sector: 'Renta fija',
    pricing: 'manual',
    accrual: { kind: 'fixed', annualRate: 0.12, dayCount: 'ACT/365', issueDate: '2024-02-15', maturity: '2025-02-09' },
  },
  {
    id: 'MANUAL:CDT-2025',
    symbol: 'CDT 10,5 % E.A.',
    name: 'CDT Banco de ejemplo 10,5 % E.A. a 360 días',
    exchange: 'MANUAL',
    currency: 'COP',
    country: 'CO',
    assetClass: 'fixed_income',
    sector: 'Renta fija',
    pricing: 'manual',
    accrual: { kind: 'fixed', annualRate: 0.105, dayCount: 'ACT/365', issueDate: '2025-03-10', maturity: '2026-03-05' },
  },
  { id: 'XBOG:ICOLCAP', symbol: 'ICOLCAP', name: 'iShares MSCI COLCAP (referencia)', exchange: 'XBOG', currency: 'COP', country: 'CO', assetClass: 'etf', sector: 'Diversificado', providerSymbols: { yahoo: 'ICOLCAP.CL' } },
];

/** Keyframes in pre-split terms (WEGE3 series is halved from the split date on). */
const PRICE_KEYS: Record<string, { keys: Record<YearMonth, number>; sigma: number; decimals: number }> = {
  'XBOG:ECOPETROL': { keys: { '2023-01': 2450, '2023-06': 2300, '2023-12': 2600, '2024-06': 2400, '2024-12': 1900, '2025-06': 1850, '2025-12': 2000, '2026-09': 2150 }, sigma: 0.035, decimals: 0 },
  'XBOG:PFCIBEST': { keys: { '2023-01': 30500, '2023-06': 27000, '2023-12': 31000, '2024-06': 34500, '2024-12': 36500, '2025-06': 40000, '2025-12': 45000, '2026-09': 48000 }, sigma: 0.03, decimals: 0 },
  'XBOG:ISA': { keys: { '2023-01': 16500, '2023-06': 15800, '2023-12': 15200, '2024-06': 17000, '2024-12': 16200, '2025-06': 17500, '2025-12': 18500, '2026-09': 19200 }, sigma: 0.025, decimals: 0 },
  'XBOG:ICOLCAP': { keys: { '2023-01': 11000, '2023-06': 10600, '2023-12': 11500, '2024-06': 12800, '2024-12': 13000, '2025-06': 15000, '2025-12': 16500, '2026-09': 17000 }, sigma: 0.02, decimals: 0 },
  'BVMF:PETR4': { keys: { '2023-01': 24, '2023-06': 28, '2023-12': 37, '2024-06': 37, '2024-12': 37.5, '2025-06': 31, '2025-12': 32, '2026-09': 34 }, sigma: 0.04, decimals: 2 },
  'BVMF:ITUB4': { keys: { '2023-01': 25, '2023-06': 28, '2023-12': 33.5, '2024-06': 33, '2024-12': 31, '2025-06': 36, '2025-12': 38, '2026-09': 40 }, sigma: 0.03, decimals: 2 },
  'BVMF:WEGE3': { keys: { '2023-01': 40, '2023-06': 39, '2023-12': 37, '2024-06': 42, '2024-12': 52, '2025-06': 46, '2025-12': 50, '2026-09': 54 }, sigma: 0.035, decimals: 2 },
  'XNAS:AAPL': { keys: { '2023-01': 145, '2023-06': 193, '2023-12': 192, '2024-06': 210, '2024-12': 250, '2025-06': 205, '2025-12': 255, '2026-09': 265 }, sigma: 0.035, decimals: 2 },
  'XNAS:MSFT': { keys: { '2023-01': 248, '2023-06': 340, '2023-12': 376, '2024-06': 447, '2024-12': 421, '2025-06': 495, '2025-12': 480, '2026-09': 520 }, sigma: 0.03, decimals: 2 },
  'ARCX:VOO': { keys: { '2023-01': 372, '2023-06': 407, '2023-12': 436, '2024-06': 500, '2024-12': 540, '2025-06': 565, '2025-12': 600, '2026-09': 630 }, sigma: 0.02, decimals: 2 },
  'XAMS:ASML': { keys: { '2023-01': 580, '2023-06': 660, '2023-12': 680, '2024-06': 950, '2024-12': 680, '2025-06': 680, '2025-12': 900, '2026-09': 950 }, sigma: 0.045, decimals: 1 },
  'XMAD:IBE': { keys: { '2023-01': 10.9, '2023-06': 11.9, '2023-12': 11.9, '2024-06': 12.1, '2024-12': 13.3, '2025-06': 16.3, '2025-12': 17, '2026-09': 17.5 }, sigma: 0.025, decimals: 3 },
};

const FX_KEYS: { base: CurrencyCode; quote: CurrencyCode; keys: Record<YearMonth, number>; sigma: number; decimals: number; clamp: [number, number]; source: string }[] = [
  { base: 'USD', quote: 'COP', keys: { '2023-01': 4400, '2023-06': 4150, '2023-12': 3880, '2024-06': 4120, '2024-12': 4380, '2025-06': 4080, '2025-12': 3800, '2026-09': 3750 }, sigma: 0.012, decimals: 2, clamp: [3700, 4400], source: 'demo' },
  { base: 'USD', quote: 'BRL', keys: { '2023-01': 5.1, '2023-06': 4.85, '2023-12': 4.88, '2024-06': 5.5, '2024-12': 5.78, '2025-06': 5.45, '2025-12': 5.35, '2026-09': 5.25 }, sigma: 0.012, decimals: 4, clamp: [4.8, 5.8], source: 'demo' },
  { base: 'EUR', quote: 'USD', keys: { '2023-01': 1.085, '2023-06': 1.09, '2023-12': 1.1, '2024-06': 1.07, '2024-12': 1.055, '2025-06': 1.135, '2025-12': 1.145, '2026-09': 1.13 }, sigma: 0.006, decimals: 4, clamp: [1.05, 1.15], source: 'demo' },
];

// ---------------------------------------------------------------------------
// builder
// ---------------------------------------------------------------------------

type Draft = Omit<Transaction, 'id' | 'portfolioId'>;

export function createDemoData(): DemoData {
  const ends = MONTHS.map(monthEnd);
  const splitDay = isoToDay(SPLIT_DATE);

  const prices: PriceSeries[] = Object.entries(PRICE_KEYS).map(([id, cfg]) => {
    const inst = INSTRUMENTS.find((i) => i.id === id)!;
    const values = path(id, cfg.keys, cfg.sigma, cfg.decimals);
    return {
      instrumentId: id,
      currency: inst.currency,
      source: 'demo',
      points: ends.map((date, i) => {
        let close = values[i]!;
        if (id === 'BVMF:WEGE3' && isoToDay(date) >= splitDay) close = Math.round((close / 2) * 100) / 100;
        return { date, close };
      }),
    };
  });
  const fx: FxSeries[] = FX_KEYS.map((c) => {
    const values = path(`${c.base}/${c.quote}`, c.keys, c.sigma, c.decimals, c.clamp);
    return { base: c.base, quote: c.quote, source: c.source, points: ends.map((date, i) => ({ date, rate: values[i]! })) };
  });
  // Synthetic Colombian CPI (monthly variation, %) and IBR overnight (annual nominal %, ACT/360).
  const ipcMonthly = (ym: YearMonth): number => {
    const k = monthIndex(ym);
    const annual = Math.max(0.045, 0.13 - 0.0035 * k); // ~13 % in early 2023 down to ~5 %
    return Math.round((Math.pow(1 + annual, 1 / 12) - 1) * 100 * 10000) / 10000;
  };
  const indexSeries: IndexSeries[] = [
    { id: 'IPC_CO', kind: 'periodRate', period: 'month', unit: 'percent', currency: 'COP', source: 'demo', points: MONTHS.map((ym) => ({ date: `${ym}-01`, value: ipcMonthly(ym) })) },
    {
      id: 'IBR',
      kind: 'annualRate',
      dayCount: 'ACT/360',
      unit: 'percent',
      currency: 'COP',
      source: 'demo',
      points: MONTHS.map((ym) => ({ date: `${ym}-01`, value: Math.round(Math.max(8.9, 12.9 - 0.11 * monthIndex(ym)) * 100) / 100 })),
    },
  ];
  const marketInput: MarketDataInput = { prices, fx, indexSeries };
  const market = createMarketDataImpl(marketInput);

  /** Trade price: linear interpolation between month-end closes (unadjusted). */
  const priceOn = (id: string, date: ISODate): number => {
    const s = prices.find((p) => p.instrumentId === id)!;
    const d = isoToDay(date);
    const pts = s.points;
    let i = pts.findIndex((p) => isoToDay(p.date) >= d);
    if (i <= 0) return pts[Math.max(0, i === -1 ? pts.length - 1 : 0)]!.close;
    const a = pts[i - 1]!;
    const b = pts[i]!;
    const da = isoToDay(a.date);
    const db = isoToDay(b.date);
    let pb = b.close;
    // Do not interpolate across the split.
    if (id === 'BVMF:WEGE3' && da < splitDay && db >= splitDay && d < splitDay) pb = b.close * 2;
    const v = a.close + ((pb - a.close) * (d - da)) / (db - da);
    const dec = PRICE_KEYS[id]!.decimals;
    return Math.round(v * 10 ** dec) / 10 ** dec;
  };
  const fxOn = (from: CurrencyCode, to: CurrencyCode, date: ISODate): number => market.fxNearest(from, to, isoToDay(date)) ?? 1;

  const ACCT_CO = 'Trii (BVC)';
  const ACCT_US = 'Interactive Brokers';
  const ACCT_BR = 'XP Investimentos';
  const accountOf = (id: string) => (id.startsWith('XBOG') ? ACCT_CO : id.startsWith('BVMF') ? ACCT_BR : ACCT_US);
  const ccyOf = (id: string) => INSTRUMENTS.find((i) => i.id === id)!.currency;
  const round = (v: number, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
  const feeFor = (id: string, gross: number, qty: number): number => {
    const c = ccyOf(id);
    if (c === 'COP') return Math.round(Math.max(gross * 0.0025, 12000));
    if (c === 'BRL') return round(gross * 0.0003);
    if (c === 'USD') return round(Math.max(1, 0.005 * qty));
    return round(Math.max(3, gross * 0.0005));
  };

  const drafts: Draft[] = [];
  const deposit = (date: ISODate, amount: number, currency: CurrencyCode, account: string, note?: string) =>
    drafts.push({ date, type: 'DEPOSIT', amount, currency, account, note });
  const convert = (date: ISODate, from: CurrencyCode, amount: number, to: CurrencyCode, account: string, spread = 0.004) => {
    const toAmount = round(amount * fxOn(from, to, date) * (1 - spread));
    drafts.push({ date, type: 'FX_CONVERSION', currency: from, amount, toCurrency: to, toAmount, account, note: `Conversión ${from}→${to}` });
  };
  const trade = (type: 'BUY' | 'SELL', date: ISODate, id: string, quantity: number) => {
    const price = priceOn(id, date);
    const gross = round(price * quantity, ccyOf(id) === 'COP' ? 0 : 2);
    drafts.push({ date, type, instrumentId: id, quantity, price, amount: gross, fees: feeFor(id, gross, quantity), currency: ccyOf(id), account: accountOf(id) });
  };
  const buy = (date: ISODate, id: string, q: number) => trade('BUY', date, id, q);
  const sell = (date: ISODate, id: string, q: number) => trade('SELL', date, id, q);

  // Funding
  deposit('2023-01-31', 25_000_000, 'COP', ACCT_CO, 'Aporte inicial');
  deposit('2023-01-31', 65_000_000, 'COP', ACCT_US, 'Giro al exterior');
  convert('2023-02-01', 'COP', 65_000_000, 'USD', ACCT_US);
  convert('2023-04-03', 'USD', 5_000, 'EUR', ACCT_US, 0.002);
  deposit('2023-05-02', 30_000, 'BRL', ACCT_BR, 'Aporte cuenta Brasil');
  for (const d of ['2023-07-05', '2023-10-05', '2024-01-10', '2024-04-08', '2024-07-08', '2024-10-07', '2025-01-13', '2025-04-07', '2025-07-07', '2025-10-06', '2026-01-13', '2026-04-07', '2026-07-07']) {
    deposit(d, 6_000_000, 'COP', ACCT_CO, 'Aporte trimestral');
  }
  for (const d of ['2023-09-12', '2024-03-12', '2024-09-10', '2025-03-11', '2025-09-09', '2026-03-10']) deposit(d, 3_000, 'USD', ACCT_US, 'Aporte en dólares');
  deposit('2024-02-06', 10_000, 'BRL', ACCT_BR, 'Aporte cuenta Brasil');
  deposit('2025-02-05', 10_000, 'BRL', ACCT_BR, 'Aporte cuenta Brasil');
  deposit('2024-05-02', 3_000, 'USD', ACCT_US, 'Aporte en dólares');
  convert('2024-05-06', 'USD', 3_000, 'EUR', ACCT_US, 0.002);
  convert('2026-03-16', 'USD', 1_500, 'EUR', ACCT_US, 0.002);

  // Trades
  buy('2023-02-06', 'XBOG:ECOPETROL', 3000);
  buy('2023-02-06', 'XBOG:PFCIBEST', 200);
  buy('2023-02-06', 'XBOG:ISA', 300);
  buy('2023-02-08', 'XNAS:AAPL', 20);
  buy('2023-02-08', 'XNAS:MSFT', 10);
  buy('2023-02-08', 'ARCX:VOO', 8);
  buy('2023-04-12', 'XAMS:ASML', 4);
  buy('2023-04-12', 'XMAD:IBE', 150);
  buy('2023-05-10', 'BVMF:PETR4', 400);
  buy('2023-05-10', 'BVMF:ITUB4', 300);
  buy('2023-05-10', 'BVMF:WEGE3', 250);
  buy('2023-07-12', 'XBOG:ECOPETROL', 1000);
  buy('2023-07-12', 'XBOG:PFCIBEST', 100);
  buy('2023-09-20', 'ARCX:VOO', 5);
  buy('2023-09-20', 'XNAS:MSFT', 2);
  buy('2023-10-12', 'XBOG:ISA', 200);
  buy('2023-10-12', 'XBOG:ECOPETROL', 1000);
  buy('2024-01-17', 'XBOG:PFCIBEST', 150);
  deposit('2024-02-14', 10_000_000, 'COP', ACCT_CO, 'Aporte para CDT');
  drafts.push({ date: '2024-02-15', type: 'BUY', instrumentId: 'MANUAL:CDT-2024', quantity: 1, price: 10_000_000, amount: 10_000_000, currency: 'COP', account: ACCT_CO, note: 'Constitución CDT (vence 2025-02-09, redención automática)' });
  buy('2024-02-14', 'BVMF:PETR4', 200);
  buy('2024-02-14', 'BVMF:ITUB4', 100);
  buy('2024-03-20', 'XNAS:AAPL', 8);
  buy('2024-03-20', 'ARCX:VOO', 3);
  drafts.push({ date: SPLIT_DATE, type: 'SPLIT', instrumentId: 'BVMF:WEGE3', ratio: 2, currency: 'BRL', account: ACCT_BR, note: 'Desdoblamiento 2:1 (dato sintético de ejemplo)' });
  buy('2024-04-17', 'XBOG:ECOPETROL', 2000);
  buy('2024-05-14', 'XMAD:IBE', 100);
  buy('2024-05-14', 'XAMS:ASML', 1);
  buy('2024-07-15', 'XBOG:ISA', 250);
  sell('2024-08-20', 'BVMF:PETR4', 300);
  buy('2024-09-18', 'XNAS:MSFT', 3);
  buy('2024-09-18', 'ARCX:VOO', 3);
  buy('2024-10-15', 'XBOG:PFCIBEST', 120);
  buy('2024-11-12', 'BVMF:WEGE3', 200);
  buy('2025-01-20', 'XBOG:ECOPETROL', 2500);
  buy('2025-02-12', 'BVMF:ITUB4', 200);
  buy('2025-03-18', 'XNAS:AAPL', 10);
  drafts.push({ date: '2025-03-10', type: 'BUY', instrumentId: 'MANUAL:CDT-2025', quantity: 1, price: 12_000_000, amount: 12_000_000, currency: 'COP', account: ACCT_CO, note: 'Constitución CDT (vence 2026-03-05, redención automática)' });
  buy('2025-04-14', 'XBOG:ISA', 300);
  sell('2025-06-10', 'XBOG:ECOPETROL', 3000);
  buy('2025-07-15', 'XBOG:PFCIBEST', 100);
  buy('2025-09-16', 'ARCX:VOO', 4);
  buy('2025-09-16', 'XNAS:MSFT', 1);
  buy('2025-10-14', 'XBOG:ISA', 200);
  drafts.push({ date: '2025-12-15', type: 'WITHDRAWAL', amount: 5_000_000, currency: 'COP', account: ACCT_CO, note: 'Retiro para gastos de fin de año' });
  buy('2026-02-10', 'XBOG:PFCIBEST', 50);
  buy('2026-03-17', 'XAMS:ASML', 1);
  buy('2026-04-14', 'XBOG:ECOPETROL', 2000);
  buy('2026-07-14', 'XBOG:ISA', 150);
  buy('2026-09-15', 'ARCX:VOO', 3);
  for (const d of ['2024-06-28', '2024-12-31', '2025-06-30', '2025-12-31', '2026-06-30']) {
    drafts.push({ date: d, type: 'INTEREST', amount: 14.5, currency: 'USD', account: ACCT_US, note: 'Intereses sobre saldo en efectivo' });
  }
  drafts.push({ date: '2024-12-31', type: 'FEE', amount: 120_000, currency: 'COP', account: ACCT_CO, note: 'Cuota de custodia anual' });
  drafts.push({ date: '2025-12-31', type: 'FEE', amount: 130_000, currency: 'COP', account: ACCT_CO, note: 'Cuota de custodia anual' });

  // Dividends (amount per share by year, withholding rate) on the given months, day 15/20.
  const DIVS: { id: string; months: number[]; day: number; dps: Record<number, number>; wht: number; note: string }[] = [
    { id: 'XBOG:ECOPETROL', months: [4], day: 20, dps: { 2023: 590, 2024: 312, 2025: 214, 2026: 150 }, wht: 0.1, note: 'Dividendo ordinario' },
    { id: 'XBOG:PFCIBEST', months: [1, 4, 7, 10], day: 15, dps: { 2023: 891, 2024: 936, 2025: 1012, 2026: 1040 }, wht: 0.1, note: 'Dividendo trimestral' },
    { id: 'XBOG:ISA', months: [7, 12], day: 15, dps: { 2023: 1000, 2024: 1080, 2025: 1150, 2026: 1200 }, wht: 0.1, note: 'Dividendo semestral' },
    { id: 'BVMF:PETR4', months: [2, 5, 8, 11], day: 20, dps: { 2023: 1.5, 2024: 1.0, 2025: 0.7, 2026: 0.6 }, wht: 0, note: 'Dividendos' },
    { id: 'BVMF:ITUB4', months: [3, 6, 9, 12], day: 15, dps: { 2023: 0.35, 2024: 0.38, 2025: 0.4, 2026: 0.42 }, wht: 0.15, note: 'JCP (IR 15%)' },
    { id: 'BVMF:WEGE3', months: [3, 9], day: 15, dps: { 2023: 0.3, 2024: 0.16, 2025: 0.17, 2026: 0.18 }, wht: 0.15, note: 'JCP (IR 15%)' },
    { id: 'XNAS:AAPL', months: [2, 5, 8, 11], day: 15, dps: { 2023: 0.24, 2024: 0.25, 2025: 0.26, 2026: 0.27 }, wht: 0.3, note: 'Dividendo (retención EE.UU. 30%)' },
    { id: 'XNAS:MSFT', months: [3, 6, 9, 12], day: 12, dps: { 2023: 0.68, 2024: 0.75, 2025: 0.83, 2026: 0.91 }, wht: 0.3, note: 'Dividendo (retención EE.UU. 30%)' },
    { id: 'ARCX:VOO', months: [3, 6, 9, 12], day: 28, dps: { 2023: 1.5, 2024: 1.6, 2025: 1.7, 2026: 1.8 }, wht: 0.3, note: 'Distribución (retención EE.UU. 30%)' },
    { id: 'XAMS:ASML', months: [2, 5, 8, 11], day: 15, dps: { 2023: 1.45, 2024: 1.52, 2025: 1.6, 2026: 1.8 }, wht: 0.15, note: 'Dividendo (retención Países Bajos 15%)' },
    { id: 'XMAD:IBE', months: [1, 7], day: 30, dps: { 2023: 0.2, 2024: 0.21, 2025: 0.23, 2026: 0.25 }, wht: 0.19, note: 'Dividendo (retención España 19%)' },
  ];
  const sortDrafts = () => drafts.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  sortDrafts();
  const qtyAt = (id: string, date: ISODate): number => {
    let q = 0;
    for (const t of drafts) {
      if (t.date > date || t.instrumentId !== id) continue;
      if (t.type === 'BUY') q += t.quantity ?? 0;
      else if (t.type === 'SELL') q -= t.quantity ?? 0;
      else if (t.type === 'SPLIT') q *= t.ratio ?? 1;
    }
    return q;
  };
  const divDrafts: Draft[] = [];
  for (const dv of DIVS) {
    for (const ym of MONTHS) {
      const y = Number(ym.slice(0, 4));
      const m = Number(ym.slice(5, 7));
      if (!dv.months.includes(m)) continue;
      const date = `${ym}-${String(dv.day).padStart(2, '0')}`;
      if (date > `${LAST_MONTH}-30`) continue;
      const q = qtyAt(dv.id, date);
      if (q <= 0) continue;
      const dps = dv.dps[y]!;
      const gross = round(q * dps, ccyOf(dv.id) === 'COP' ? 0 : 2);
      divDrafts.push({
        date,
        type: 'DIVIDEND',
        instrumentId: dv.id,
        quantity: q,
        price: dps,
        amount: gross,
        taxes: round(gross * dv.wht, ccyOf(dv.id) === 'COP' ? 0 : 2),
        currency: ccyOf(dv.id),
        account: accountOf(dv.id),
        note: dv.note,
      });
    }
  }
  drafts.push(...divDrafts);
  sortDrafts();

  const portfolio: Portfolio = {
    id: DEMO_PORTFOLIO_ID,
    name: 'Portafolio de ejemplo',
    baseCurrency: 'COP',
    taxResidence: 'CO',
    costMethod: 'FIFO',
    createdAt: '2023-01-31',
    benchmarks: ['XBOG:ICOLCAP', 'ARCX:VOO'],
    tags: ['Ejemplo'],
  };
  const transactions: Transaction[] = drafts.map((d, i) => ({
    ...d,
    id: `demo-${String(i + 1).padStart(4, '0')}`,
    portfolioId: DEMO_PORTFOLIO_ID,
    source: 'demo',
  }));
  const asOf = monthEnd(LAST_MONTH);
  return {
    portfolio,
    instruments: INSTRUMENTS.map((i) => ({ ...i })),
    transactions,
    prices,
    fx,
    marketInput,
    market,
    input: { portfolio, transactions, instruments: INSTRUMENTS.map((i) => ({ ...i })), market, options: { asOf } },
    asOf,
    isDemo: true,
  };
}
