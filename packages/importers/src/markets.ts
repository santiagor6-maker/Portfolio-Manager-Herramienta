/**
 * Exchange metadata and broker-code → MIC tables used to build Instrument ids (`MIC:SYMBOL`),
 * Yahoo symbols and currencies.
 */
import type { AssetClass, CountryCode, CurrencyCode, ExchangeCode } from '@pm/core';

export interface ExchangeInfo {
  country: CountryCode;
  currency: CurrencyCode;
  /** Yahoo Finance suffix ('' for US). `undefined` = not on Yahoo. */
  yahooSuffix?: string;
  name: string;
}

export const EXCHANGES: Record<string, ExchangeInfo> = {
  XBOG: { country: 'CO', currency: 'COP', yahooSuffix: '.CL', name: 'Bolsa de Valores de Colombia' },
  BVMF: { country: 'BR', currency: 'BRL', yahooSuffix: '.SA', name: 'B3' },
  XNYS: { country: 'US', currency: 'USD', yahooSuffix: '', name: 'NYSE' },
  XNAS: { country: 'US', currency: 'USD', yahooSuffix: '', name: 'Nasdaq' },
  ARCX: { country: 'US', currency: 'USD', yahooSuffix: '', name: 'NYSE Arca' },
  XASE: { country: 'US', currency: 'USD', yahooSuffix: '', name: 'NYSE American' },
  BATS: { country: 'US', currency: 'USD', yahooSuffix: '', name: 'Cboe BZX' },
  OTC: { country: 'US', currency: 'USD', yahooSuffix: '', name: 'OTC' },
  XMEX: { country: 'MX', currency: 'MXN', yahooSuffix: '.MX', name: 'BMV' },
  XSGO: { country: 'CL', currency: 'CLP', yahooSuffix: '.SN', name: 'Bolsa de Santiago' },
  XLIM: { country: 'PE', currency: 'PEN', yahooSuffix: '.LM', name: 'BVL' },
  XBUE: { country: 'AR', currency: 'ARS', yahooSuffix: '.BA', name: 'BYMA' },
  XMAD: { country: 'ES', currency: 'EUR', yahooSuffix: '.MC', name: 'BME Madrid' },
  XETR: { country: 'DE', currency: 'EUR', yahooSuffix: '.DE', name: 'Xetra' },
  XFRA: { country: 'DE', currency: 'EUR', yahooSuffix: '.F', name: 'Frankfurt' },
  XGAT: { country: 'DE', currency: 'EUR', yahooSuffix: '.DE', name: 'Tradegate' },
  XPAR: { country: 'FR', currency: 'EUR', yahooSuffix: '.PA', name: 'Euronext Paris' },
  XAMS: { country: 'NL', currency: 'EUR', yahooSuffix: '.AS', name: 'Euronext Amsterdam' },
  XBRU: { country: 'BE', currency: 'EUR', yahooSuffix: '.BR', name: 'Euronext Brussels' },
  XLIS: { country: 'PT', currency: 'EUR', yahooSuffix: '.LS', name: 'Euronext Lisbon' },
  XMIL: { country: 'IT', currency: 'EUR', yahooSuffix: '.MI', name: 'Borsa Italiana' },
  XDUB: { country: 'IE', currency: 'EUR', yahooSuffix: '.IR', name: 'Euronext Dublin' },
  XWBO: { country: 'AT', currency: 'EUR', yahooSuffix: '.VI', name: 'Wiener Börse' },
  XHEL: { country: 'FI', currency: 'EUR', yahooSuffix: '.HE', name: 'Nasdaq Helsinki' },
  XLON: { country: 'GB', currency: 'GBP', yahooSuffix: '.L', name: 'London Stock Exchange' },
  XSWX: { country: 'CH', currency: 'CHF', yahooSuffix: '.SW', name: 'SIX Swiss' },
  XSTO: { country: 'SE', currency: 'SEK', yahooSuffix: '.ST', name: 'Nasdaq Stockholm' },
  XCSE: { country: 'DK', currency: 'DKK', yahooSuffix: '.CO', name: 'Nasdaq Copenhagen' },
  XOSL: { country: 'NO', currency: 'NOK', yahooSuffix: '.OL', name: 'Oslo Børs' },
  XTSE: { country: 'CA', currency: 'CAD', yahooSuffix: '.TO', name: 'Toronto' },
  XHKG: { country: 'HK', currency: 'HKD', yahooSuffix: '.HK', name: 'Hong Kong' },
  XTKS: { country: 'JP', currency: 'JPY', yahooSuffix: '.T', name: 'Tokyo' },
  XASX: { country: 'AU', currency: 'AUD', yahooSuffix: '.AX', name: 'ASX' },
  CRYPTO: { country: 'INTL', currency: 'USD', name: 'Crypto' },
  MANUAL: { country: 'INTL', currency: 'USD', name: 'Manual' },
};

export const US_EXCHANGES = new Set(['XNYS', 'XNAS', 'ARCX', 'XASE', 'BATS', 'OTC']);

/** Yahoo suffix → MIC (for symbols such as `PETR4.SA`, `SAP.DE`, eToro `BARC.L`). */
export const YAHOO_SUFFIX_TO_MIC: Record<string, ExchangeCode> = {
  SA: 'BVMF', CL: 'XBOG', MX: 'XMEX', SN: 'XSGO', LM: 'XLIM', BA: 'XBUE', MC: 'XMAD', DE: 'XETR', F: 'XFRA',
  PA: 'XPAR', AS: 'XAMS', BR: 'XBRU', LS: 'XLIS', MI: 'XMIL', IR: 'XDUB', VI: 'XWBO', HE: 'XHEL', L: 'XLON',
  SW: 'XSWX', ST: 'XSTO', CO: 'XCSE', OL: 'XOSL', TO: 'XTSE', HK: 'XHKG', T: 'XTKS', AX: 'XASX',
  // eToro-style suffixes
  ZU: 'XSWX', NV: 'XAMS', ASX: 'XASX',
};

/** Interactive Brokers listing-exchange codes → MIC. */
export const IBKR_EXCHANGES: Record<string, ExchangeCode> = {
  NASDAQ: 'XNAS', NYSE: 'XNYS', ARCA: 'ARCX', AMEX: 'XASE', NYSEAMER: 'XASE', BATS: 'BATS', PINK: 'OTC', OTC: 'OTC',
  IBIS: 'XETR', IBIS2: 'XETR', FWB: 'XFRA', FWB2: 'XFRA', GETTEX: 'XFRA', TGATE: 'XGAT', SBF: 'XPAR', AEB: 'XAMS',
  'ENEXT.BE': 'XBRU', BVL: 'XLIS', BM: 'XMAD', BVME: 'XMIL', 'BVME.ETF': 'XMIL', LSE: 'XLON', LSEETF: 'XLON',
  EBS: 'XSWX', MEXI: 'XMEX', TSE: 'XTSE', SFB: 'XSTO', CPH: 'XCSE', OSE: 'XOSL', HEX: 'XHEL', VSE: 'XWBO',
  ISED: 'XDUB', SEHK: 'XHKG', ASX: 'XASX', BOVESPA: 'BVMF', 'TSEJ': 'XTKS',
};

/** DEGIRO reference-exchange / venue codes → MIC. */
export const DEGIRO_EXCHANGES: Record<string, ExchangeCode> = {
  NDQ: 'XNAS', NSY: 'XNYS', ASE: 'XASE', BAT: 'BATS', XET: 'XETR', FRA: 'XFRA', TDG: 'XGAT', EPA: 'XPAR',
  EAM: 'XAMS', EBR: 'XBRU', ELI: 'XLIS', MAD: 'XMAD', MIL: 'XMIL', LSE: 'XLON', SWX: 'XSWX', OMX: 'XSTO',
  OMK: 'XCSE', OSL: 'XOSL', HSE: 'XHEL', TOR: 'XTSE', HKS: 'XHKG', ASX: 'XASX', WBO: 'XWBO', ISE: 'XDUB',
};

/** Accept MIC, IBKR or DEGIRO codes, or plain names ("NASDAQ", "B3", "BVC"). */
export function normalizeExchange(raw: string | undefined): ExchangeCode | undefined {
  if (!raw) return undefined;
  const s = raw.trim().toUpperCase();
  if (!s) return undefined;
  if (EXCHANGES[s]) return s;
  const alias: Record<string, ExchangeCode> = {
    B3: 'BVMF', BOVESPA: 'BVMF', BMFBOVESPA: 'BVMF', BVC: 'XBOG', 'BOLSA DE VALORES DE COLOMBIA': 'XBOG', COLOMBIA: 'XBOG',
    'NYSE ARCA': 'ARCX', 'NYSE AMERICAN': 'XASE', XETRA: 'XETR', BMV: 'XMEX', BVL: 'XLIM', MGC: 'XBOG',
    'EURONEXT PARIS': 'XPAR', 'EURONEXT AMSTERDAM': 'XAMS', LONDON: 'XLON', LSE: 'XLON', SIX: 'XSWX',
  };
  return alias[s] ?? DEGIRO_EXCHANGES[s] ?? IBKR_EXCHANGES[s];
}

export function exchangeCurrency(ex: ExchangeCode | undefined): CurrencyCode | undefined {
  return ex ? EXCHANGES[ex]?.currency : undefined;
}

export function yahooSymbol(symbol: string, ex: ExchangeCode): string | undefined {
  if (ex === 'CRYPTO') return `${symbol}-USD`;
  const info = EXCHANGES[ex];
  if (!info || info.yahooSuffix === undefined) return undefined;
  const sym = info.country === 'US' ? symbol.replace(/[./]/g, '-') : symbol.replace(/\//g, '-');
  return sym + info.yahooSuffix;
}

// ---------------------------------------------------------------------------
// Known tickers (improve exchange / asset-class guesses when a file carries only a symbol)
// ---------------------------------------------------------------------------

/** Colombian (BVC) tickers. ETFs flagged separately. */
export const CO_TICKERS = new Set([
  'ECOPETROL', 'BCOLOMBIA', 'PFBCOLOM', 'ISA', 'GEB', 'GRUPOSURA', 'PFGRUPSURA', 'NUTRESA', 'GRUPOARGOS', 'PFGRUPOARG',
  'CEMARGOS', 'PFCEMARGOS', 'CELSIA', 'PROMIGAS', 'MINEROS', 'BOGOTA', 'GRUPOAVAL', 'PFAVAL', 'PFDAVVNDA', 'CORFICOLCF',
  'PFCORFICOL', 'BVC', 'ETB', 'TERPEL', 'CNEC', 'CONCONCRET', 'ENKA', 'BHI', 'CLH', 'EXITO', 'ELCONDOR', 'CANACOL',
  'VALOREM', 'FABRICATO', 'OCCIDENTE', 'POPULAR', 'BBVACOL', 'PFCARPAK', 'GRUPOBOLIV', 'ICOLCAP', 'HCOLSEL', 'ICOLRISK',
  'GXTESCOL', 'PEI', 'CIBEST', 'PFCIBEST',
]);
export const CO_ETFS = new Set(['ICOLCAP', 'HCOLSEL', 'ICOLRISK', 'GXTESCOL']);
export const CO_REITS = new Set(['PEI']);

export const US_NASDAQ = new Set([
  'AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'GOOG', 'META', 'TSLA', 'AVGO', 'COST', 'NFLX', 'AMD', 'ADBE', 'PEP', 'CSCO',
  'INTC', 'QCOM', 'TXN', 'AMGN', 'SBUX', 'PYPL', 'MELI', 'QQQ', 'ASML', 'PDD', 'ABNB', 'MRNA', 'BKNG', 'INTU', 'ISRG',
  'GILD', 'MDLZ', 'ADP', 'TMUS', 'CMCSA', 'HON', 'MU', 'AMAT', 'LRCX', 'PANW', 'CRWD', 'ZM', 'TLT', 'SHY', 'IEF',
  'VXUS', 'BND', 'VNQI', 'BNDX', 'XP', 'STNE', 'PAGS', 'INTR', 'PLTR', 'COIN', 'MSTR', 'ARM', 'SMCI', 'ACWI', 'IBIT',
]);
export const US_NYSE = new Set([
  'KO', 'JNJ', 'JPM', 'V', 'MA', 'WMT', 'PG', 'XOM', 'CVX', 'BAC', 'DIS', 'NKE', 'MCD', 'IBM', 'BRK.B', 'BRK.A', 'T',
  'VZ', 'PFE', 'MRK', 'ABBV', 'LLY', 'UNH', 'HD', 'ORCL', 'CRM', 'BABA', 'TSM', 'PBR', 'PBR.A', 'VALE', 'ITUB', 'BBD',
  'EC', 'CIB', 'AVAL', 'NU', 'SHOP', 'UBER', 'GE', 'CAT', 'BA', 'GS', 'MS', 'C', 'WFC', 'PM', 'MO', 'TM', 'SONY', 'SAP',
  'BHP', 'RIO', 'SHEL', 'BP', 'SPOT', 'O', 'BMA', 'GGAL', 'YPF', 'SQM', 'BSAC', 'AMX', 'FMX', 'ABEV', 'SID', 'GGB',
  'ERJ', 'SUZ', 'UGP', 'CBD', 'NVO', 'UL', 'DEO', 'TTE', 'NVS', 'AZN', 'HSBC', 'SAN', 'BBVA', 'LYG',
]);
export const US_ARCA = new Set([
  'SPY', 'VOO', 'VTI', 'VT', 'IVV', 'VEA', 'VWO', 'EEM', 'EFA', 'GLD', 'SLV', 'IWM', 'DIA', 'AGG', 'SCHD', 'VIG', 'VYM',
  'XLK', 'XLF', 'XLE', 'XLV', 'ARKK', 'EWZ', 'GXG', 'ILF', 'VNQ', 'IEMG', 'IEFA', 'SPLG', 'SCHX', 'SCHB', 'RSP', 'IAU',
  'VGT', 'VUG', 'VTV', 'HYG', 'LQD', 'EMB', 'JEPI', 'QUAL', 'MTUM', 'USMV', 'EWW', 'ECH', 'EPU', 'COLO', 'SOXX',
]);
export const US_ETFS = new Set([...US_ARCA, 'QQQ', 'TLT', 'SHY', 'IEF', 'VXUS', 'BND', 'VNQI', 'BNDX', 'ACWI', 'IBIT']);

/** Brazilian ETFs (end in 11 but are not FIIs/units). */
export const BR_ETFS = new Set([
  'BOVA11', 'IVVB11', 'SMAL11', 'BOVV11', 'HASH11', 'SPXI11', 'DIVO11', 'NASD11', 'XFIX11', 'IMAB11', 'B5P211',
  'GOLD11', 'ACWI11', 'BRAX11', 'ECOO11', 'PIBB11', 'FIND11', 'MATB11', 'WRLD11', 'EURP11', 'XINA11', 'QBTC11',
  'BITH11', 'ETHE11', 'FIXA11', 'IRFM11', 'DEFI11', 'BOVB11', 'BOVX11', 'SPXB11', 'IB5M11', 'LFTS11', 'NTNS11',
]);
/** Brazilian units (end in 11, they are shares). */
export const BR_UNITS = new Set([
  'TAEE11', 'KLBN11', 'SANB11', 'BPAC11', 'ALUP11', 'ENGI11', 'SAPR11', 'TIET11', 'SULA11', 'IGTI11', 'BIDI11',
  'AESB11', 'RNEW11', 'ITSA11', 'CPLE11', 'ENEV11', 'BRBI11', 'STBP11', 'INBR11', 'CMIG11', 'PPLA11', 'NEOE11',
]);

/**
 * Same-security ticker renames (old id → current id). Mirrors the `kind: 'rename'` rows of
 * @pm/market-data `TICKER_ALIASES` (history is stitched there, so the current id is quotable for old
 * dates), plus ISA CTEEP → ISA Energia Brasil (TRPL → ISAE, 2024). Mergers and conversions (BRFS3 →
 * MBRF3, NTCO3 → NATU3, CPLE6 → CPLE3) are NOT renames: they stay separate instruments.
 */
export const TICKER_RENAMES: Record<string, string> = {
  'BVMF:ELET3': 'BVMF:AXIA3',
  'BVMF:EMBR3': 'BVMF:EMBJ3',
  'BVMF:CCRO3': 'BVMF:MOTV3',
  'BVMF:MRFG3': 'BVMF:MBRF3',
  'BVMF:TRPL3': 'BVMF:ISAE3',
  'BVMF:TRPL4': 'BVMF:ISAE4',
  'XBOG:PFBCOLOM': 'XBOG:PFCIBEST',
  'XBOG:BCOLOMBIA': 'XBOG:CIBEST',
};

/** Popular ISIN → (symbol, exchange). Used when a file carries only the ISIN (DEGIRO). */
export const ISIN_DIRECTORY: Record<string, { symbol: string; exchange: ExchangeCode; assetClass?: AssetClass }> = {
  US0378331005: { symbol: 'AAPL', exchange: 'XNAS' },
  US5949181045: { symbol: 'MSFT', exchange: 'XNAS' },
  US0231351067: { symbol: 'AMZN', exchange: 'XNAS' },
  US02079K3059: { symbol: 'GOOGL', exchange: 'XNAS' },
  US02079K1079: { symbol: 'GOOG', exchange: 'XNAS' },
  US30303M1027: { symbol: 'META', exchange: 'XNAS' },
  US88160R1014: { symbol: 'TSLA', exchange: 'XNAS' },
  US67066G1040: { symbol: 'NVDA', exchange: 'XNAS' },
  US64110L1061: { symbol: 'NFLX', exchange: 'XNAS' },
  US1912161007: { symbol: 'KO', exchange: 'XNYS' },
  US4781601046: { symbol: 'JNJ', exchange: 'XNYS' },
  US46625H1005: { symbol: 'JPM', exchange: 'XNYS' },
  US92826C8394: { symbol: 'V', exchange: 'XNYS' },
  US2546871060: { symbol: 'DIS', exchange: 'XNYS' },
  US7170811035: { symbol: 'PFE', exchange: 'XNYS' },
  US0846707026: { symbol: 'BRK.B', exchange: 'XNYS' },
  US4592001014: { symbol: 'IBM', exchange: 'XNYS' },
  US7427181091: { symbol: 'PG', exchange: 'XNYS' },
  US30231G1022: { symbol: 'XOM', exchange: 'XNYS' },
  US58933Y1055: { symbol: 'MRK', exchange: 'XNYS' },
  US71654V4086: { symbol: 'PBR', exchange: 'XNYS' },
  US91912E1055: { symbol: 'VALE', exchange: 'XNYS' },
  US2791581091: { symbol: 'EC', exchange: 'XNYS' },
  US05968L1026: { symbol: 'CIB', exchange: 'XNYS' },
  US78462F1030: { symbol: 'SPY', exchange: 'ARCX', assetClass: 'etf' },
  US9229083632: { symbol: 'VOO', exchange: 'ARCX', assetClass: 'etf' },
  US9229087690: { symbol: 'VTI', exchange: 'ARCX', assetClass: 'etf' },
  IE00B4L5Y983: { symbol: 'IWDA', exchange: 'XAMS', assetClass: 'etf' },
  IE00B5BMR087: { symbol: 'SXR8', exchange: 'XETR', assetClass: 'etf' },
  IE00BK5BQT80: { symbol: 'VWCE', exchange: 'XETR', assetClass: 'etf' },
  NL0010273215: { symbol: 'ASML', exchange: 'XAMS' },
  DE0007164600: { symbol: 'SAP', exchange: 'XETR' },
  ES0113900J37: { symbol: 'SAN', exchange: 'XMAD' },
  ES0148396007: { symbol: 'ITX', exchange: 'XMAD' },
  FR0000121014: { symbol: 'MC', exchange: 'XPAR' },
  COC04PA00016: { symbol: 'ECOPETROL', exchange: 'XBOG' },
};

/** B3 ISIN heuristic: BRPETRACNPR6 → PETR4 (OR=3, PR=4, PA=5, PB=6, PC=7). */
export function b3TickerFromIsin(isin: string): string | undefined {
  const m = /^BR([A-Z]{4})ACN(OR|PR|PA|PB|PC)\d$/.exec(isin);
  if (!m) return undefined;
  const cls: Record<string, number> = { OR: 3, PR: 4, PA: 5, PB: 6, PC: 7 };
  return `${m[1]}${cls[m[2]!]}`;
}

/** B3 equity / FII / ETF / BDR ticker (optionally with fractional-market `F` suffix). */
export const B3_TICKER_RE = /^[A-Z]{4}\d{1,2}F?$/;
export const B3_TICKER_RE_STRICT = /^[A-Z0-9]{4}(3|4|5|6|7|8|11|31|32|33|34|35|39)F?$/;

/** ISIN country prefix → default MIC when nothing better is known. */
export const ISIN_COUNTRY_EXCHANGE: Record<string, ExchangeCode> = {
  BR: 'BVMF', CO: 'XBOG', MX: 'XMEX', CL: 'XSGO', PE: 'XLIM', ES: 'XMAD', DE: 'XETR', FR: 'XPAR', NL: 'XAMS',
  BE: 'XBRU', PT: 'XLIS', IT: 'XMIL', GB: 'XLON', CH: 'XSWX', SE: 'XSTO', DK: 'XCSE', NO: 'XOSL', FI: 'XHEL',
  AT: 'XWBO', CA: 'XTSE', HK: 'XHKG', JP: 'XTKS', AU: 'XASX',
};

/** Currency → default exchange when only the quote currency is known. */
export const CURRENCY_EXCHANGE: Record<string, ExchangeCode> = {
  BRL: 'BVMF', COP: 'XBOG', MXN: 'XMEX', CLP: 'XSGO', PEN: 'XLIM', GBP: 'XLON', GBX: 'XLON', CHF: 'XSWX', SEK: 'XSTO',
  DKK: 'XCSE', NOK: 'XOSL', CAD: 'XTSE', HKD: 'XHKG', JPY: 'XTKS', AUD: 'XASX',
};

/**
 * Unambiguous European tickers → MIC. Symbols that exist on several EU venues with different
 * companies (e.g. SAN = Santander in Madrid, Sanofi in Paris) are deliberately absent.
 */
export const EU_TICKERS: Record<string, ExchangeCode> = {
  ITX: 'XMAD', IBE: 'XMAD', TEF: 'XMAD', REP: 'XMAD', BBVA: 'XMAD', CABK: 'XMAD', AENA: 'XMAD', FER: 'XMAD', AMS: 'XMAD', ELE: 'XMAD',
  SAP: 'XETR', SIE: 'XETR', ALV: 'XETR', DTE: 'XETR', BAS: 'XETR', BAYN: 'XETR', VOW3: 'XETR', MBG: 'XETR', BMW: 'XETR', ADS: 'XETR',
  IFX: 'XETR', MUV2: 'XETR', DBK: 'XETR', EUNL: 'XETR', SXR8: 'XETR', VWCE: 'XETR', XDWD: 'XETR', IS3N: 'XETR',
  MC: 'XPAR', OR: 'XPAR', TTE: 'XPAR', AIR: 'XPAR', BNP: 'XPAR', SU: 'XPAR', RMS: 'XPAR', KER: 'XPAR', CW8: 'XPAR',
  ASML: 'XAMS', INGA: 'XAMS', ADYEN: 'XAMS', HEIA: 'XAMS', PRX: 'XAMS', IWDA: 'XAMS', VWRL: 'XAMS',
  ENEL: 'XMIL', ISP: 'XMIL', UCG: 'XMIL', ENI: 'XMIL', RACE: 'XMIL', STLAM: 'XMIL',
};

/** Tesouro Direto title type → code used by @pm/market-data ids (`TD:<code>-<maturity>`). */
const TESOURO_CODES: [RegExp, string][] = [
  [/^tesouro ipca\+? com juros semestrais/i, 'NTNB'],
  [/^tesouro ipca\+?/i, 'NTNBP'],
  [/^tesouro prefixado com juros semestrais/i, 'NTNF'],
  [/^tesouro prefixado/i, 'LTN'],
  [/^tesouro selic/i, 'LFT'],
  [/^tesouro igpm\+? com juros semestrais/i, 'NTNC'],
];

/**
 * "Tesouro IPCA+ 2035" → { id: 'TD:NTNBP-2035-05-15', ... }. B3 prints only the maturity year; the
 * day follows the Treasury's calendar (LFT 1-Mar; LTN/NTN-F/NTN-C 1-Jan; NTN-B/NTN-B Principal
 * 15-May in odd years, 15-Aug in even years). Renda+/Educa+ (maturity not derivable) → undefined.
 */
export function tesouroId(product: string): { id: string; code: string; maturity: string; tipo: string } | undefined {
  const p = product.trim().replace(/\s+/g, ' ');
  const hit = TESOURO_CODES.find(([re]) => re.test(p));
  if (!hit) return undefined;
  const full = /(\d{2})\/(\d{2})\/(\d{4})/.exec(p);
  const year = /\b(20\d{2})\b/.exec(p)?.[1];
  if (!full && !year) return undefined;
  const code = hit[1];
  let maturity: string;
  if (full) maturity = `${full[3]}-${full[2]}-${full[1]}`;
  else {
    const y = Number(year);
    const md = code === 'LFT' ? '03-01' : code === 'LTN' || code === 'NTNF' || code === 'NTNC' ? '01-01' : y % 2 ? '05-15' : '08-15';
    maturity = `${y}-${md}`;
  }
  const tipo = p.replace(/\s*\b(20\d{2})\b.*$/, '').replace(/\s*\d{2}\/\d{2}\/\d{4}.*$/, '').trim();
  return { id: `TD:${code}-${maturity}`, code, maturity, tipo };
}
