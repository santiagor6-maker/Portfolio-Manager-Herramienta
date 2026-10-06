import type { Instrument } from '@pm/core';

/**
 * Tax categories for a Brazilian resident:
 * - ACAO: shares listed on B3 (eligible for the R$ 20k monthly exemption, swing trade 15%).
 * - ETF: B3-listed equity ETFs (15%, no exemption).
 * - ETF_RF: B3-listed fixed-income ETFs (Lei 13.043/2014 art. 2º): IR withheld at source by the
 *   fund/custodian on redemption or sale — no monthly apuração, no DARF.
 * - BDR: B3-listed BDRs (15%, no exemption).
 * - OPCAO: options on B3 (common operations 15% / day trade 20%, no exemption).
 * - DIREITO: subscription rights/receipts (15%, no exemption — conservative reading).
 * - FII: real-estate funds and Fiagro (20%, no exemption, separate loss pool).
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
  | 'DIREITO'
  | 'FII'
  | 'RENDA_FIXA'
  | 'CRYPTO'
  | 'FOREIGN'
  | 'OTHER';

const BDR_SUFFIX = /(3[2345]|39)$/;
/** B3 option tickers: 4-letter root + series letter (A-L calls, M-X puts) + strike code. */
export const OPTION_RE = /^[A-Z]{4}[A-X]\d{1,4}[A-Z]?$/;
/** Subscription rights (1, 2) and receipts (9, 10) of B3 shares. */
const RIGHTS_RE = /^[A-Z]{4}(1|2|9|10)$/;
/** Known B3 fixed-income ETFs (Lei 13.043/2014). Extend via categoryOverrides. */
const ETF_RF_SYMBOLS = new Set([
  'IMAB11', 'IRFM11', 'IB5M11', 'B5P211', 'B5MB11', 'FIXA11', 'IMBB11', 'LFTS11', 'LFTB11', 'NTNS11', 'IDKA11', 'KDIF11', 'DEBB11', 'IRFM11',
]);
const ETF_RF_NAME = /renda fixa|ima-?b|irf-?m|tesouro|treasury|\blft\b|\bntn|deb[eê]ntures|crédito privado|credito privado/i;

export type CryptoCustody = 'brasil' | 'exterior' | 'desconhecida';

/** Exchanges with Brazilian entity/CNPJ (custody in Brazil → GCAP monthly). Extend via cryptoCustody. */
const BR_CRYPTO_EXCHANGES = new Set(['MERCADOBITCOIN', 'MB', 'FOXBIT', 'NOVADAX', 'BITPRECO', 'BITYPRECO', 'BRASILBITCOIN', 'RIPIO_BR', 'XP_CRIPTO', 'NUBANK_CRIPTO', 'BTG_MYNT', 'MYNT', 'HASHDEX_BR']);
/** Foreign exchanges/custodians (Lei 14.754/2023 annual regime). */
const FOREIGN_CRYPTO_EXCHANGES = new Set(['BINANCE', 'COINBASE', 'KRAKEN', 'BYBIT', 'OKX', 'KUCOIN', 'BITFINEX', 'GEMINI', 'BITSTAMP', 'CRYPTOCOM', 'GATEIO', 'HTX', 'HUOBI', 'BITGET', 'MEXC', 'NEXO']);

/**
 * Where a crypto-asset is custodied, which defines its regime for a Brazilian resident:
 * 'brasil' → GCAP monthly (R$ 35k exemption, DARF 4600); 'exterior' → Lei 14.754/2023 annual 15%;
 * 'desconhecida' → never generates a DARF until the user confirms (self-custody wallets, MANUAL...).
 */
export function cryptoCustodyOf(inst: Instrument, overrides?: Record<string, CryptoCustody>): CryptoCustody {
  const o = overrides?.[inst.id];
  if (o) return o;
  const ex = inst.exchange.toUpperCase().replace(/[\s.-]/g, '');
  if (BR_CRYPTO_EXCHANGES.has(ex)) return 'brasil';
  if (FOREIGN_CRYPTO_EXCHANGES.has(ex)) return 'exterior';
  if (inst.currency !== 'BRL') return 'exterior';
  return 'desconhecida';
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
    return inst.assetClass === 'fixed_income' || inst.assetClass === 'bond' ? 'RENDA_FIXA' : 'OTHER';
  }
  if (['equity', 'etf', 'reit', 'fund', 'bond', 'fixed_income', 'crypto'].includes(inst.assetClass)) return 'FOREIGN';
  return 'OTHER';
}

/** Categories that go through the B3 ledger (preço médio, day trade, short positions). */
export const isB3Category = (c: BrCategory): boolean =>
  c === 'ACAO' || c === 'ETF' || c === 'ETF_RF' || c === 'BDR' || c === 'FII' || c === 'OPCAO' || c === 'DIREITO';

/** Categories in the monthly apuração (DARF 6015). ETF_RF is taxed at source. */
export const isApuracaoCategory = (c: BrCategory): boolean => isB3Category(c) && c !== 'ETF_RF';
