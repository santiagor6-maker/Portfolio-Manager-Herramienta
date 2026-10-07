import type { Instrument } from '@pm/core';
import type { ParamMeta, TaxInput, TaxIssue } from '../common/types';

/**
 * Tax categories for a Brazilian resident:
 * - ACAO: shares listed on B3 (eligible for the R$ 20k monthly exemption, swing trade 15%).
 * - ETF: B3-listed equity ETFs (15%, no exemption).
 * - ETF_RF: B3-listed fixed-income ETFs (Lei 13.043/2014 art. 2º): IR withheld at source by the
 *   fund/custodian on redemption or sale — no monthly apuração, no DARF.
 * - BDR: B3-listed BDRs (15%, no exemption).
 * - OPCAO: options on B3 (common operations 15% / day trade 20%, no exemption).
 * - FUTURO: B3 futures (mini-índice WIN, mini-dólar WDO, IND, DOL, commodities): 15% / 20% day trade.
 * - DIREITO: subscription rights/receipts (15%, no exemption — conservative reading).
 * - FII: real-estate funds and Fiagro (20%, no exemption, separate loss pool).
 * - FUNDO: domestic open-ended funds (come-cotas in May/November, IR withheld by the administrator).
 * - RENDA_FIXA: domestic fixed income (CDB, LCI/LCA, Tesouro, debêntures): taxed at source.
 * - CRYPTO: crypto-assets (GCAP, R$ 35k/month exemption when custodied in Brazil).
 * - FOREIGN: securities held abroad (Lei 14.754/2023 annual regime).
 * - OTHER: anything else, not handled by the monthly apuração.
 */
export type BrCategory =
  | 'ACAO'
  | 'ETF'
  | 'ETF_RF'
  | 'BDR'
  | 'OPCAO'
  | 'FUTURO'
  | 'DIREITO'
  | 'FII'
  | 'RENDA_FIXA'
  | 'FUNDO'
  | 'CRYPTO'
  | 'FOREIGN'
  | 'OTHER';

const BDR_SUFFIX = /(3[2345]|39)$/;
/** B3 option tickers: 4-letter root + series letter (A-L calls, M-X puts) + strike code. */
/** B3 futures: root + maturity month code (F G H J K M N Q U V X Z) + 2-digit year. */
export const FUTURES_RE = /^(WIN|WDO|IND|DOL|BGI|CCM|ICF|DI1|SJC|BIT|ETR|SOL)[FGHJKMNQUVXZ]\d{2}$/;

/** Point value (R$ per point per contract) of common B3 futures. Override via instrument.priceMultiplier < 1 is not used. */
export const FUTURES_POINT_VALUE: Record<string, number> = { WIN: 0.2, IND: 1, WDO: 10, DOL: 50, BGI: 330, CCM: 450, ICF: 100, SJC: 450 };
/** Futures quoted in US dollars (point value is in USD): converted to BRL at the trade date (T46). */
export const FUTURES_QUOTE_CURRENCY: Record<string, 'USD'> = { ICF: 'USD', SJC: 'USD' };

/** B3 option tickers, incl. weekly series with suffix W1-W5 (T40), e.g. PETRC350W4. */
export const OPTION_RE = /^[A-Z]{4}[A-X]\d{1,4}(?:[A-Z]|W[1-5])?$/;
/** Subscription rights (1, 2) and receipts (9, 10) of B3 shares. */
const RIGHTS_RE = /^[A-Z]{4}(1|2|9|10)$/;
/** Known B3 fixed-income ETFs (Lei 13.043/2014). Extend via categoryOverrides. */
const ETF_RF_SYMBOLS = new Set([
  'IMAB11', 'IRFM11', 'IB5M11', 'B5P211', 'B5MB11', 'FIXA11', 'IMBB11', 'LFTS11', 'LFTB11', 'NTNS11', 'IDKA11', 'KDIF11', 'DEBB11', 'IRFM11',
]);
const ETF_RF_NAME = /renda fixa|ima-?b|irf-?m|tesouro|treasury|\blft\b|\bntn|deb[eê]ntures|crédito privado|credito privado/i;

export type CryptoCustody = 'brasil' | 'exterior' | 'desconhecida';

const norm = (s: string) => s.toUpperCase().normalize('NFD').replace(/[^A-Z0-9]/g, '');

/** Exchanges/brokers with a Brazilian entity (CNPJ): custody in Brazil → GCAP monthly. Extend via accountCustody. */
const BR_CRYPTO_VENUES = new Set(
  [
    'MERCADOBITCOIN', 'MB', 'FOXBIT', 'NOVADAX', 'BITPRECO', 'BITYPRECO', 'BRASILBITCOIN', 'RIPIO', 'RIPIOBR', 'XPCRIPTO', 'XP',
    'XPINVESTIMENTOS', 'NUBANK', 'NUCRIPTO', 'NUBANKCRIPTO', 'BTGMYNT', 'MYNT', 'BTG', 'BTGPACTUAL', 'HASHDEXBR', 'INTER', 'BANCOINTER',
    'PICPAY', 'MERCADOPAGO', 'BINANCEBR', 'BINANCEBRASIL', 'COINEXT', 'ITAU', 'ITAUCRIPTO', 'RICO', 'CLEAR', 'GENIAL', 'AVENUEBR',
  ].map(norm),
);
/** Foreign exchanges/custodians (Lei 14.754/2023 annual regime). */
const FOREIGN_CRYPTO_VENUES = new Set(
  ['BINANCE', 'BINANCECOM', 'COINBASE', 'KRAKEN', 'BYBIT', 'OKX', 'KUCOIN', 'BITFINEX', 'GEMINI', 'BITSTAMP', 'CRYPTOCOM', 'GATEIO', 'HTX', 'HUOBI', 'BITGET', 'MEXC', 'NEXO', 'REVOLUT'].map(norm),
);

export const CRYPTO_CUSTODY_META: ParamMeta = {
  status: 'needs-verification',
  source: 'Listas internas de exchanges com/sem entidade no Brasil (IN RFB 1.888/2019; Lei 14.754/2023)',
  checkedOn: '2026-10-07',
  note:
    '"Binance" sem sufixo é tratada como exterior, mas a Binance opera no Brasil com entidade local: se a conta é a brasileira, ' +
    'informe accountCustody { "Binance": "brasil" } (ou use a conta "Binance BR").',
};

/** Custody implied by a venue/account name (broker, exchange or wallet label), if recognised. */
export function cryptoCustodyForVenue(name: string | undefined, accountCustody?: Record<string, CryptoCustody>): CryptoCustody | undefined {
  if (!name) return undefined;
  const n = norm(name);
  if (accountCustody) {
    for (const [k, v] of Object.entries(accountCustody)) if (norm(k) === n) return v;
  }
  if (BR_CRYPTO_VENUES.has(n)) return 'brasil';
  if (FOREIGN_CRYPTO_VENUES.has(n)) return 'exterior';
  if (/^(SELF|WALLET|CARTEIRA|LEDGER|TREZOR|COLD|METAMASK)/.test(n)) return 'desconhecida';
  return undefined;
}

/**
 * Custody of a crypto-asset from the instrument alone (explicit override or the exchange in the
 * instrument id). The quote currency is NOT a custody signal (T38): BTC-USD from Yahoo may be held at
 * Mercado Bitcoin. Prefer `routeCryptoByCustody`, which also reads `Transaction.account`.
 */
export function cryptoCustodyOf(inst: Instrument, overrides?: Record<string, CryptoCustody>): CryptoCustody {
  const o = overrides?.[inst.id];
  if (o) return o;
  return cryptoCustodyForVenue(inst.exchange) ?? 'desconhecida';
}

export interface CryptoRouting {
  /** Input with crypto transactions re-pointed to per-custody virtual instruments when needed. */
  input: TaxInput;
  /** Custody per (possibly virtual) instrument id. */
  custody: Record<string, CryptoCustody>;
  issues: TaxIssue[];
}

/**
 * Decides the regime of each crypto transaction by CUSTODY (T38): instrument override, then the
 * transaction's account/broker (`Transaction.account`, `accountCustody` map, known Brazilian/foreign
 * venues), then the instrument's exchange; otherwise 'desconhecida' (DARF withheld + warning).
 * When one asset is held at venues with different regimes, it is split into virtual instruments
 * `${id}#brasil` / `${id}#exterior` so each part follows its own regime and cost basis.
 */
export function routeCryptoByCustody(
  input: TaxInput,
  opts: { cryptoCustody?: Record<string, CryptoCustody>; accountCustody?: Record<string, CryptoCustody> } = {},
): CryptoRouting {
  const custody: Record<string, CryptoCustody> = {};
  const issues: TaxIssue[] = [];
  const cryptos = new Map(input.instruments.filter((i) => i.assetClass === 'crypto').map((i) => [i.id, i]));
  if (!cryptos.size) return { input, custody: { ...(opts.cryptoCustody ?? {}) }, issues };
  const txCustody = new Map<string, CryptoCustody>();
  const byInst = new Map<string, Set<CryptoCustody>>();
  for (const t of input.transactions) {
    const inst = t.instrumentId ? cryptos.get(t.instrumentId) : undefined;
    if (!inst) continue;
    const c =
      opts.cryptoCustody?.[inst.id] ??
      cryptoCustodyForVenue(t.account, opts.accountCustody) ??
      cryptoCustodyForVenue(inst.exchange, opts.accountCustody) ??
      'desconhecida';
    txCustody.set(t.id, c);
    byInst.set(inst.id, (byInst.get(inst.id) ?? new Set()).add(c));
  }
  const extra: Instrument[] = [];
  for (const [id, set] of byInst) {
    if (set.size === 1) {
      custody[id] = [...set][0]!;
      continue;
    }
    const inst = cryptos.get(id)!;
    for (const c of set) {
      extra.push({ ...inst, id: `${id}#${c}`, name: `${inst.name} (${c})` });
      custody[`${id}#${c}`] = c;
    }
    issues.push({
      level: 'info',
      code: 'CRYPTO_SPLIT_BY_CUSTODY',
      instrumentId: id,
      message: `${inst.symbol} está em custódias diferentes (${[...set].join(', ')}): cada parte segue seu regime e custo médio próprios.`,
    });
  }
  for (const [id, inst] of cryptos) if (!custody[id] && !byInst.has(id)) custody[id] = opts.cryptoCustody?.[id] ?? cryptoCustodyOf(inst);
  if (!extra.length) return { input, custody, issues };
  const split = new Set(extra.map((e) => e.id.split('#')[0]!));
  return {
    input: {
      ...input,
      instruments: [...input.instruments, ...extra],
      transactions: input.transactions.map((t) =>
        t.instrumentId && split.has(t.instrumentId) ? { ...t, instrumentId: `${t.instrumentId}#${txCustody.get(t.id)}` } : t,
      ),
    },
    custody,
    issues,
  };
}

export function classifyForBrazil(
  inst: Instrument | undefined,
  overrides?: Record<string, BrCategory>,
  cryptoCustody?: Record<string, CryptoCustody>,
): BrCategory {
  if (!inst) return 'OTHER';
  const o = overrides?.[inst.id];
  if (o) return o;
  const sym = inst.symbol.toUpperCase();
  if (inst.assetClass === 'crypto') return cryptoCustodyOf(inst, cryptoCustody) === 'exterior' ? 'FOREIGN' : 'CRYPTO';
  if (inst.exchange === 'BVMF') {
    if (FUTURES_RE.test(sym)) return 'FUTURO';
    // Options first: a share ticker never has a letter in the 5th position (T25).
    if (OPTION_RE.test(sym)) return 'OPCAO';
    if (inst.assetClass === 'reit') return 'FII';
    if (inst.assetClass === 'fund' && /fiagro/i.test(inst.name)) return 'FII';
    if (inst.assetClass === 'etf') return ETF_RF_SYMBOLS.has(sym) || ETF_RF_NAME.test(inst.name) ? 'ETF_RF' : 'ETF';
    if (inst.assetClass === 'fixed_income' || inst.assetClass === 'bond') return 'RENDA_FIXA';
    if (inst.assetClass === 'equity') {
      if (RIGHTS_RE.test(sym)) return 'DIREITO';
      return inst.country !== 'BR' || BDR_SUFFIX.test(sym) ? 'BDR' : 'ACAO';
    }
    return 'OTHER';
  }
  if (inst.country === 'BR' && inst.currency === 'BRL') {
    if (inst.assetClass === 'fixed_income' || inst.assetClass === 'bond') return 'RENDA_FIXA';
    if (inst.assetClass === 'fund') return 'FUNDO';
    return 'OTHER';
  }
  if (['equity', 'etf', 'reit', 'fund', 'bond', 'fixed_income', 'crypto'].includes(inst.assetClass)) return 'FOREIGN';
  return 'OTHER';
}

/** Categories that go through the B3 ledger (preço médio, day trade, short positions). */
export const isB3Category = (c: BrCategory): boolean =>
  c === 'ACAO' || c === 'ETF' || c === 'ETF_RF' || c === 'BDR' || c === 'FII' || c === 'OPCAO' || c === 'FUTURO' || c === 'DIREITO';

/** Categories in the monthly apuração (DARF 6015). ETF_RF is taxed at source. */
export const isApuracaoCategory = (c: BrCategory): boolean => isB3Category(c) && c !== 'ETF_RF';
