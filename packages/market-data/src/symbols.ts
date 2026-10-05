/**
 * Symbol mapping between our instrument ids (`${MIC}:${symbol}`) and Yahoo Finance symbols,
 * plus inference of country / currency / asset class for provider search results.
 */
import type { AssetClass, CountryCode, CurrencyCode, ExchangeCode, Instrument } from '@pm/core';

export interface MarketInfo {
  mic: ExchangeCode;
  /** Yahoo symbol suffix including the dot ('' for the US). */
  suffix: string;
  country: CountryCode;
  currency: CurrencyCode;
  name: string;
}

/** Markets keyed by MIC. Order matters for suffix lookup (first match wins). */
export const MARKETS: readonly MarketInfo[] = [
  { mic: 'XBOG', suffix: '.CL', country: 'CO', currency: 'COP', name: 'Bolsa de Valores de Colombia' },
  { mic: 'BVMF', suffix: '.SA', country: 'BR', currency: 'BRL', name: 'B3' },
  { mic: 'XMAD', suffix: '.MC', country: 'ES', currency: 'EUR', name: 'BME Madrid' },
  { mic: 'XETR', suffix: '.DE', country: 'DE', currency: 'EUR', name: 'Xetra' },
  { mic: 'XFRA', suffix: '.F', country: 'DE', currency: 'EUR', name: 'Frankfurt' },
  { mic: 'XPAR', suffix: '.PA', country: 'FR', currency: 'EUR', name: 'Euronext Paris' },
  { mic: 'XAMS', suffix: '.AS', country: 'NL', currency: 'EUR', name: 'Euronext Amsterdam' },
  { mic: 'XBRU', suffix: '.BR', country: 'BE', currency: 'EUR', name: 'Euronext Brussels' },
  { mic: 'XLIS', suffix: '.LS', country: 'PT', currency: 'EUR', name: 'Euronext Lisbon' },
  { mic: 'XMSM', suffix: '.IR', country: 'IE', currency: 'EUR', name: 'Euronext Dublin' },
  { mic: 'XMIL', suffix: '.MI', country: 'IT', currency: 'EUR', name: 'Borsa Italiana' },
  { mic: 'XWBO', suffix: '.VI', country: 'AT', currency: 'EUR', name: 'Wiener Börse' },
  { mic: 'XHEL', suffix: '.HE', country: 'FI', currency: 'EUR', name: 'Nasdaq Helsinki' },
  { mic: 'XLON', suffix: '.L', country: 'GB', currency: 'GBP', name: 'London Stock Exchange' },
  { mic: 'XSWX', suffix: '.SW', country: 'CH', currency: 'CHF', name: 'SIX Swiss Exchange' },
  { mic: 'XSTO', suffix: '.ST', country: 'SE', currency: 'SEK', name: 'Nasdaq Stockholm' },
  { mic: 'XCSE', suffix: '.CO', country: 'DK', currency: 'DKK', name: 'Nasdaq Copenhagen' },
  { mic: 'XOSL', suffix: '.OL', country: 'NO', currency: 'NOK', name: 'Oslo Børs' },
  { mic: 'XMEX', suffix: '.MX', country: 'MX', currency: 'MXN', name: 'Bolsa Mexicana de Valores' },
  { mic: 'XSGO', suffix: '.SN', country: 'CL', currency: 'CLP', name: 'Bolsa de Santiago' },
  { mic: 'XLIM', suffix: '.LM', country: 'PE', currency: 'PEN', name: 'Bolsa de Valores de Lima' },
  { mic: 'XBUE', suffix: '.BA', country: 'AR', currency: 'ARS', name: 'Bolsas y Mercados Argentinos' },
  { mic: 'XTSE', suffix: '.TO', country: 'CA', currency: 'CAD', name: 'Toronto Stock Exchange' },
  { mic: 'XTSX', suffix: '.V', country: 'CA', currency: 'CAD', name: 'TSX Venture' },
  { mic: 'XHKG', suffix: '.HK', country: 'HK', currency: 'HKD', name: 'Hong Kong Exchanges' },
  { mic: 'XTKS', suffix: '.T', country: 'JP', currency: 'JPY', name: 'Tokyo Stock Exchange' },
  { mic: 'XNSE', suffix: '.NS', country: 'IN', currency: 'INR', name: 'National Stock Exchange of India' },
  { mic: 'XBOM', suffix: '.BO', country: 'IN', currency: 'INR', name: 'BSE India' },
  { mic: 'XASX', suffix: '.AX', country: 'AU', currency: 'AUD', name: 'ASX' },
  { mic: 'XNZE', suffix: '.NZ', country: 'NZ', currency: 'NZD', name: 'NZX' },
  { mic: 'XKRX', suffix: '.KS', country: 'KR', currency: 'KRW', name: 'Korea Exchange (KOSPI)' },
  { mic: 'XKOS', suffix: '.KQ', country: 'KR', currency: 'KRW', name: 'Korea Exchange (KOSDAQ)' },
  { mic: 'XTAI', suffix: '.TW', country: 'TW', currency: 'TWD', name: 'Taiwan Stock Exchange' },
  { mic: 'XIDX', suffix: '.JK', country: 'ID', currency: 'IDR', name: 'Indonesia Stock Exchange' },
  { mic: 'XKLS', suffix: '.KL', country: 'MY', currency: 'MYR', name: 'Bursa Malaysia' },
  { mic: 'XSES', suffix: '.SI', country: 'SG', currency: 'SGD', name: 'Singapore Exchange' },
  { mic: 'XBKK', suffix: '.BK', country: 'TH', currency: 'THB', name: 'Stock Exchange of Thailand' },
  { mic: 'XSHG', suffix: '.SS', country: 'CN', currency: 'CNY', name: 'Shanghai Stock Exchange' },
  { mic: 'XSHE', suffix: '.SZ', country: 'CN', currency: 'CNY', name: 'Shenzhen Stock Exchange' },
  { mic: 'XJSE', suffix: '.JO', country: 'ZA', currency: 'ZAR', name: 'Johannesburg Stock Exchange' },
  { mic: 'XTAE', suffix: '.TA', country: 'IL', currency: 'ILS', name: 'Tel Aviv Stock Exchange' },
  { mic: 'XIST', suffix: '.IS', country: 'TR', currency: 'TRY', name: 'Borsa Istanbul' },
  { mic: 'XWAR', suffix: '.WA', country: 'PL', currency: 'PLN', name: 'Warsaw Stock Exchange' },
  { mic: 'XSAU', suffix: '.SR', country: 'SA', currency: 'SAR', name: 'Saudi Exchange' },
];

const US: Omit<MarketInfo, 'mic'> = { suffix: '', country: 'US', currency: 'USD', name: 'United States' };
export const US_MICS: readonly string[] = ['XNYS', 'XNAS', 'ARCX', 'XASE', 'BATS', 'OTC'];

const BY_MIC = new Map(MARKETS.map((m) => [m.mic as string, m]));
const BY_SUFFIX = new Map(MARKETS.map((m) => [m.suffix.toUpperCase(), m]));

/** Yahoo `exchange` codes (search results / chart meta `exchangeName`) -> MIC. */
export const YAHOO_EXCHANGE_TO_MIC: Readonly<Record<string, ExchangeCode>> = {
  BVC: 'XBOG',
  SAO: 'BVMF',
  NYQ: 'XNYS',
  NYS: 'XNYS',
  NMS: 'XNAS',
  NGM: 'XNAS',
  NCM: 'XNAS',
  NAS: 'XNAS',
  NasdaqGS: 'XNAS',
  PCX: 'ARCX',
  ASE: 'XASE',
  BTS: 'BATS',
  PNK: 'OTC',
  OQB: 'OTC',
  OQX: 'OTC',
  OEM: 'OTC',
  MCE: 'XMAD',
  GER: 'XETR',
  FRA: 'XFRA',
  PAR: 'XPAR',
  AMS: 'XAMS',
  BRU: 'XBRU',
  LIS: 'XLIS',
  ISE: 'XMSM',
  MIL: 'XMIL',
  VIE: 'XWBO',
  HEL: 'XHEL',
  LSE: 'XLON',
  IOB: 'XLON',
  EBS: 'XSWX',
  VTX: 'XSWX',
  STO: 'XSTO',
  CPH: 'XCSE',
  OSL: 'XOSL',
  MEX: 'XMEX',
  SGO: 'XSGO',
  LIM: 'XLIM',
  BUE: 'XBUE',
  TOR: 'XTSE',
  VAN: 'XTSX',
  HKG: 'XHKG',
  JPX: 'XTKS',
  NSI: 'XNSE',
  BSE: 'XBOM',
  ASX: 'XASX',
  NZE: 'XNZE',
  KSC: 'XKRX',
  KOE: 'XKOS',
  TAI: 'XTAI',
  JKT: 'XIDX',
  KLS: 'XKLS',
  SES: 'XSES',
  SET: 'XBKK',
  SHH: 'XSHG',
  SHZ: 'XSHE',
  JNB: 'XJSE',
  TLV: 'XTAE',
  IST: 'XIST',
  WSE: 'XWAR',
  SAU: 'XSAU',
};

/** Generic exchange code for Yahoo symbols on venues we do not map: the id keeps the Yahoo symbol verbatim. */
export const GENERIC_EXCHANGE = 'YAHOO';

/** Allowed characters of a provider symbol / the symbol part of an id. */
const SYMBOL_RE = /^[A-Za-z0-9^][A-Za-z0-9.^=\-&]{0,31}$/;

/**
 * Validate a symbol (or the symbol part of an id) before it reaches a provider URL: 1-32 chars,
 * letters, digits and `. ^ = - &`, must start with a letter, digit or `^`, and may not contain
 * `..` (path traversal into other provider endpoints).
 */
export function isValidSymbol(s: string): boolean {
  return SYMBOL_RE.test(s) && !s.includes('..') && !s.endsWith('.');
}

/** Suffixes of secondary German venues Yahoo uses; mapped to their MIC, currency EUR. */
const DE_REGIONALS: Record<string, ExchangeCode> = { '.MU': 'XMUN', '.DU': 'XDUS', '.SG': 'XSTU', '.BE': 'XBER', '.HM': 'XHAM' };

export function marketByMic(mic: string): MarketInfo | undefined {
  if (US_MICS.includes(mic)) return { mic, ...US };
  return BY_MIC.get(mic);
}

/**
 * Currencies quoted in minor units by Yahoo. Values must be divided by `divisor` to obtain the
 * ISO currency. London is the important one: most LSE equities quote in GBp (pence), while
 * many LSE ETFs quote in USD/GBP. Always trust the chart `meta.currency`.
 */
export const MINOR_CURRENCIES: Readonly<Record<string, { currency: CurrencyCode; divisor: number }>> = {
  GBp: { currency: 'GBP', divisor: 100 },
  GBX: { currency: 'GBP', divisor: 100 },
  ZAc: { currency: 'ZAR', divisor: 100 },
  ZAC: { currency: 'ZAR', divisor: 100 },
  ILA: { currency: 'ILS', divisor: 100 },
};

export function normalizeCurrency(c: string | undefined | null): { currency: CurrencyCode; divisor: number } | undefined {
  if (!c) return undefined;
  const minor = MINOR_CURRENCIES[c];
  if (minor) return minor;
  return { currency: c.toUpperCase(), divisor: 1 };
}

export interface ParsedYahooSymbol {
  /** Local ticker without suffix (e.g. `PETR4`, `ECOPETROL`, `^GSPC`). */
  symbol: string;
  exchange: ExchangeCode;
  country?: CountryCode;
  currency?: CurrencyCode;
  kind: 'security' | 'index' | 'fx' | 'crypto' | 'future';
}

/**
 * Parse a Yahoo symbol into our (exchange, symbol) pair. For US listings without suffix the
 * exchange is unknown from the symbol alone; pass the Yahoo exchange code when available.
 */
export function parseYahooSymbol(yahoo: string, yahooExchange?: string): ParsedYahooSymbol {
  const s = yahoo.trim().toUpperCase();
  if (s.startsWith('^')) return { symbol: s, exchange: 'INDEX', kind: 'index' };
  if (s.endsWith('=X')) {
    const body = s.slice(0, -2);
    const pair = body.length === 3 ? `USD${body}` : body;
    return { symbol: pair, exchange: 'FX', kind: 'fx', currency: pair.slice(3, 6) };
  }
  if (s.endsWith('=F')) return { symbol: s, exchange: 'FUT', kind: 'future' };
  if (/^[A-Z0-9]+-(USD|EUR|BRL|GBP)$/.test(s) && (yahooExchange === 'CCC' || !yahooExchange)) {
    return { symbol: s, exchange: 'CRYPTO', kind: 'crypto', currency: s.split('-')[1] };
  }
  const dot = s.lastIndexOf('.');
  if (dot > 0) {
    const suffix = s.slice(dot);
    const market = BY_SUFFIX.get(suffix);
    if (market) {
      return { symbol: s.slice(0, dot), exchange: market.mic, country: market.country, currency: market.currency, kind: 'security' };
    }
    const de = DE_REGIONALS[suffix];
    if (de) return { symbol: s.slice(0, dot), exchange: de, country: 'DE', currency: 'EUR', kind: 'security' };
    // Unmapped venue: keep the Yahoo symbol verbatim so the id round-trips (YAHOO:0254.HK style).
    if (/^\.[A-Z]{1,3}$/.test(suffix)) return { symbol: s, exchange: GENERIC_EXCHANGE, kind: 'security' };
  }
  const mic = (yahooExchange && YAHOO_EXCHANGE_TO_MIC[yahooExchange]) || undefined;
  if (mic && !US_MICS.includes(mic)) {
    // Unusual: exchange code known but no suffix (shouldn't happen for non-US venues).
    const m = marketByMic(mic);
    return { symbol: s, exchange: mic, country: m?.country, currency: m?.currency, kind: 'security' };
  }
  // US listing: BRK-B, BF-B keep their dash form in Yahoo.
  return { symbol: s, exchange: mic ?? 'XNYS', country: 'US', currency: 'USD', kind: 'security' };
}

/** Instrument id for a Yahoo symbol. */
export function instrumentIdFromYahoo(yahoo: string, yahooExchange?: string): string {
  const p = parseYahooSymbol(yahoo, yahooExchange);
  return `${p.exchange}:${p.symbol}`;
}

/**
 * Yahoo symbol for an instrument id (`BVMF:PETR4` -> `PETR4.SA`, `XNAS:AAPL` -> `AAPL`,
 * `INDEX:^GSPC` -> `^GSPC`, `FX:USDCOP` -> `USDCOP=X`). Returns undefined for unknown venues.
 */
export function yahooSymbolFromId(id: string): string | undefined {
  const i = id.indexOf(':');
  if (i <= 0) return undefined;
  const exchange = id.slice(0, i).toUpperCase();
  const symbol = id.slice(i + 1).toUpperCase();
  if (!symbol) return undefined;
  if (exchange === 'INDEX') return symbol.startsWith('^') ? symbol : `^${symbol}`;
  if (exchange === 'FX') return `${symbol.replace('/', '')}=X`;
  if (exchange === 'CRYPTO' || exchange === 'FUT' || exchange === GENERIC_EXCHANGE) return symbol;
  if (US_MICS.includes(exchange)) return symbol.replace('.', '-');
  const m = BY_MIC.get(exchange);
  if (m) return `${symbol}${m.suffix}`;
  const de = Object.entries(DE_REGIONALS).find(([, mic]) => mic === exchange);
  if (de) return `${symbol}${de[0]}`;
  return undefined;
}

export function yahooSymbolForInstrument(inst: Pick<Instrument, 'id' | 'providerSymbols'>): string | undefined {
  return inst.providerSymbols?.yahoo ?? yahooSymbolFromId(inst.id);
}

/** Yahoo FX symbol for a pair: units of `quote` per 1 `base`. */
export function yahooFxSymbol(base: string, quote: string): string {
  return base === 'USD' ? `${quote}=X` : `${base}${quote}=X`;
}

/** Map Yahoo `quoteType` / `instrumentType` to our asset class. */
export function assetClassFromYahoo(quoteType: string | undefined, symbol: string, name = ''): AssetClass {
  const t = (quoteType ?? '').toUpperCase();
  switch (t) {
    case 'ETF':
      return 'etf';
    case 'MUTUALFUND':
      return 'fund';
    case 'CRYPTOCURRENCY':
      return 'crypto';
    case 'CURRENCY':
      return 'cash';
    case 'FUTURE':
      return 'commodity';
    case 'INDEX':
      return 'other';
    default:
      break;
  }
  // Brazilian listed funds end in 11 and Yahoo reports them as EQUITY: FIIs (real estate),
  // ETFs ("fundo de índice" / "classe de índice") and also share units (TAEE11, KLBN11), so
  // decide by name.
  if (/\.SA$/i.test(symbol) && /11$/.test(symbol.replace(/\.SA$/i, ''))) {
    const n = name.normalize('NFD').replace(/[̀-ͯ]/g, '');
    if (/(\bFII\b|IMOBILI)/i.test(n)) return 'reit';
    if (/(INDICE|\bETF\b)/i.test(n)) return 'etf';
  }
  return 'equity';
}

/** Is `s` an instrument id (`MIC:SYMBOL`) rather than a provider symbol? */
export function looksLikeInstrumentId(s: string): boolean {
  return /^[A-Za-z]{2,8}:.+/.test(s);
}
