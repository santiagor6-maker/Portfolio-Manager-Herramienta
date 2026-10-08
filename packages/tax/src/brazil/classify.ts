import type { Instrument, Transaction } from '@pm/core';
import { daysBetween } from '../common/dates';
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

/** Venues matched exactly (short names that would be ambiguous as prefixes). */
const BR_EXACT = new Set(['MB', 'XP', 'BTG', 'INTER', 'RICO', 'CLEAR', 'ITAU', 'NU']);
/** Brazilian venues (CNPJ in Brazil) matched by prefix of the normalized name (T49). */
const BR_PREFIXES = [
  'MERCADOBITCOIN', 'FOXBIT', 'NOVADAX', 'BITPRECO', 'BITYPRECO', 'BRASILBITCOIN', 'RIPIO', 'XPCRIPTO', 'XPINVEST', 'NUBANK', 'NUCRIPTO',
  'BTGMYNT', 'MYNT', 'BTGPACTUAL', 'HASHDEX', 'BANCOINTER', 'PICPAY', 'MERCADOPAGO', 'COINEXT', 'ITAUCRIPTO', 'GENIAL', 'BITSO', 'TRUTHERBR',
];
/** Foreign venues (Lei 14.754 when the account is the global one) matched by prefix. */
const FOREIGN_PREFIXES = [
  'BINANCE', 'COINBASE', 'KRAKEN', 'BYBIT', 'OKX', 'KUCOIN', 'BITFINEX', 'GEMINI', 'BITSTAMP', 'CRYPTOCOM', 'GATEIO', 'HTX', 'HUOBI', 'BITGET',
  'MEXC', 'NEXO', 'REVOLUT',
];
/** Self-custody wallets: custody location unknown → DARF withheld until confirmed. */
const WALLET_PREFIXES = ['SELF', 'WALLET', 'CARTEIRA', 'LEDGER', 'TREZOR', 'COLD', 'METAMASK', 'EXODUS', 'TRUSTWALLET', 'ELECTRUM'];

/** Country of foreign crypto venues (Bens e Direitos location, T50). '' = several entities, ask the user. */
export const CRYPTO_VENUE_COUNTRY: Record<string, string> = {
  COINBASE: 'US', KRAKEN: 'US', GEMINI: 'US', BITSTAMP: 'LU', CRYPTOCOM: 'SG', BYBIT: 'AE', OKX: 'SC', KUCOIN: 'SC', BITFINEX: 'VG',
  BITGET: 'SC', MEXC: 'SC', NEXO: 'CH', REVOLUT: 'LT', BINANCE: '',
};

export const CRYPTO_CUSTODY_META: ParamMeta = {
  status: 'needs-verification',
  source: 'Listas internas de exchanges com/sem entidade no Brasil e país de cada venue (IN RFB 1.888/2019; Lei 14.754/2023)',
  checkedOn: '2026-10-08',
  note:
    '"Binance" sem sufixo é tratada como exterior, mas a Binance opera no Brasil com entidade local: se a conta é a brasileira, ' +
    'informe accountCustody { "Binance": "brasil" } (ou use a conta "Binance BR"). Bitso e OKX Brasil considerados brasileiros. ' +
    'País dos venues estrangeiros a conferir (Binance sem país definido).',
};

/** Normalized venue key for a name: 'MercadoBitcoin S.A.' → 'MERCADOBITCOIN', 'Coinbase Pro' → 'COINBASE'. */
export function cryptoVenueKey(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const n = norm(name);
  if (!n) return undefined;
  return [...BR_PREFIXES, ...FOREIGN_PREFIXES, ...WALLET_PREFIXES].find((p) => n.startsWith(p)) ?? (BR_EXACT.has(n) ? n : undefined);
}

/** Custody implied by a venue/account name (broker, exchange or wallet label), if recognised (fuzzy, T49). */
export function cryptoCustodyForVenue(name: string | undefined, accountCustody?: Record<string, CryptoCustody>): CryptoCustody | undefined {
  if (!name) return undefined;
  const n = norm(name);
  if (!n) return undefined;
  if (accountCustody) {
    for (const [k, v] of Object.entries(accountCustody)) {
      const nk = norm(k);
      if (nk && (n === nk || n.startsWith(nk) || nk.startsWith(n))) return v;
    }
  }
  if (WALLET_PREFIXES.some((p) => n.startsWith(p))) return 'desconhecida';
  if (BR_EXACT.has(n) || BR_PREFIXES.some((p) => n.startsWith(p))) return 'brasil';
  if (FOREIGN_PREFIXES.some((p) => n.startsWith(p))) {
    // 'Binance BR', 'Binance Brasil', 'OKX Brasil': local entity
    return /(BRASIL|BRAZIL|BR)$/.test(n) || /BRASIL/.test(n) ? 'brasil' : 'exterior';
  }
  return undefined;
}

/**
 * Custody of a crypto-asset from the instrument alone (explicit override or the exchange in the
 * instrument id). The quote currency is NOT a custody signal (T38).
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
  /** Original cost carried by matched transfers between custodians (by TRANSFER_IN id) — T48. */
  transferBasis: Record<string, { openDate: string; totalCost: number; fxRate: number }>;
  /** Sales routed by holdings with ambiguous custody: tax as Brazil, DARF withheld (T47). */
  unconfirmedSales: Set<string>;
  /** Country of the venue holding each (virtual) crypto instrument ('' unknown) — T50. */
  venueCountry: Record<string, string>;
  issues: TaxIssue[];
}

/**
 * Decides the regime of each crypto transaction by CUSTODY, following where the UNITS are (T38, T47, T48):
 * - inflows go to the custody of their account/venue (instrument override > account > instrument exchange);
 * - outflows (sales/transfers out) consume the custody named by the account when it holds the units;
 *   otherwise the custody that actually holds them (no account, unrecognised or misspelled label);
 *   when several custodies hold units, the sale is taxed as Brazil (conservative) with the DARF withheld;
 * - TRANSFER_OUT / TRANSFER_IN pairs (same asset, quantity within 2%, up to 10 days apart) carry the
 *   average cost (in the asset currency and in BRL) from the source custody to the destination.
 * When units live in more than one custody, the instrument is split into `${id}#<custody>` parts.
 */
export function routeCryptoByCustody(
  input: TaxInput,
  opts: {
    cryptoCustody?: Record<string, CryptoCustody>;
    accountCustody?: Record<string, CryptoCustody>;
    /** BRL per unit of currency at a date (e.g. PTAX de compra); default market.fx. */
    brlRate?: (ccy: string, date: string) => number | undefined;
  } = {},
): CryptoRouting {
  const custody: Record<string, CryptoCustody> = { ...(opts.cryptoCustody ?? {}) };
  const issues: TaxIssue[] = [];
  const transferBasis: CryptoRouting['transferBasis'] = {};
  const unconfirmedSales = new Set<string>();
  const venueCountry: Record<string, string> = {};
  const cryptos = new Map(input.instruments.filter((i) => i.assetClass === 'crypto').map((i) => [i.id, i]));
  if (!cryptos.size) return { input, custody, transferBasis, unconfirmedSales, venueCountry, issues };
  const brl = (ccy: string, date: string) => (ccy === 'BRL' ? 1 : (opts.brlRate?.(ccy, date) ?? input.market.fx(ccy, 'BRL', date) ?? 0));
  const sorted = [...input.transactions]
    .map((t, i) => ({ t, i }))
    .filter(({ t }) => t.instrumentId && cryptos.has(t.instrumentId))
    .sort((a, b) => a.t.date.localeCompare(b.t.date) || a.i - b.i)
    .map(({ t }) => t);
  const isIn = (t: Transaction) => t.type === 'BUY' || t.type === 'TRANSFER_IN' || t.type === 'STOCK_DIVIDEND';
  const isOut = (t: Transaction) => t.type === 'SELL' || t.type === 'TRANSFER_OUT';

  // Match transfer pairs.
  const pairOf = new Map<string, string>(); // out id -> in id
  const inMatched = new Set<string>();
  for (const out of sorted.filter((t) => t.type === 'TRANSFER_OUT')) {
    const q = out.quantity ?? 0;
    const cand = sorted.find(
      (t) =>
        t.type === 'TRANSFER_IN' &&
        !inMatched.has(t.id) &&
        t.instrumentId === out.instrumentId &&
        t.date >= out.date &&
        daysBetween(out.date, t.date) <= 10 &&
        (t.quantity ?? 0) <= q * 1.000001 &&
        (t.quantity ?? 0) >= q * 0.98,
    );
    if (cand) {
      pairOf.set(out.id, cand.id);
      inMatched.add(cand.id);
    }
  }

  const txBucket = new Map<string, CryptoCustody>();
  for (const [id, inst] of cryptos) {
    const forced = opts.cryptoCustody?.[id];
    const units: Record<CryptoCustody, number> = { brasil: 0, exterior: 0, desconhecida: 0 };
    const costFx: Record<CryptoCustody, number> = { brasil: 0, exterior: 0, desconhecida: 0 };
    const costBrl: Record<CryptoCustody, number> = { brasil: 0, exterior: 0, desconhecida: 0 };
    const lastVenue: Partial<Record<CryptoCustody, string>> = {};
    const carry = new Map<string, { fx: number; brl: number }>(); // in id -> carried cost
    const label = (t: Transaction): CryptoCustody | undefined =>
      forced ?? cryptoCustodyForVenue(t.account, opts.accountCustody) ?? (t.account ? undefined : cryptoCustodyForVenue(inst.exchange, opts.accountCustody));
    for (const t of sorted.filter((x) => x.instrumentId === id)) {
      const q = t.quantity ?? 0;
      if (isIn(t)) {
        const b = label(t) ?? 'desconhecida';
        if (!forced && t.account && !cryptoCustodyForVenue(t.account, opts.accountCustody)) {
          issues.push({
            level: 'warning',
            code: 'CRYPTO_VENUE_UNKNOWN',
            transactionId: t.id,
            instrumentId: id,
            message: `Conta "${t.account}" não reconhecida para ${inst.symbol}: custódia desconhecida (DARF retido). Informe accountCustody.`,
          });
        }
        txBucket.set(t.id, b);
        const c = carry.get(t.id);
        const fx = c ? c.fx : (t.amount ?? q * (t.price ?? 0)) + (t.fees ?? 0);
        const br = c ? c.brl : fx * brl(t.currency, t.date);
        if (c) transferBasis[t.id] = { openDate: t.date, totalCost: c.fx, fxRate: c.fx > 0 ? c.brl / c.fx : 0 };
        units[b] += t.type === 'STOCK_DIVIDEND' && t.quantity === undefined ? 0 : q;
        costFx[b] += fx;
        costBrl[b] += br;
        const vk = cryptoVenueKey(t.account ?? inst.exchange);
        if (vk) lastVenue[b] = vk;
      } else if (isOut(t)) {
        const named = label(t);
        let b: CryptoCustody;
        const holders = (Object.keys(units) as CryptoCustody[]).filter((k) => units[k] > 1e-12);
        if (named && units[named] >= q - 1e-9) b = named;
        else if (holders.length === 1) {
          b = holders[0]!;
          if (named !== b) {
            issues.push({
              level: 'info',
              code: 'CRYPTO_OUTFLOW_ROUTED_TO_HOLDINGS',
              transactionId: t.id,
              instrumentId: id,
              message: `${t.type === 'SELL' ? 'Venda' : 'Saída'} de ${inst.symbol} ${t.account ? `com conta "${t.account}"` : 'sem conta'} atribuída à custódia onde estão as unidades (${b}).`,
            });
          }
        } else if (holders.length > 1) {
          b = named && units[named] > 1e-12 ? named : units.brasil > 1e-12 ? 'brasil' : holders.sort((x, y) => units[y] - units[x])[0]!;
          if (!named || units[named] < q - 1e-9) {
            if (t.type === 'SELL') unconfirmedSales.add(t.id);
            issues.push({
              level: 'warning',
              code: 'CRYPTO_SALE_CUSTODY_AMBIGUOUS',
              transactionId: t.id,
              instrumentId: id,
              message:
                `${inst.symbol} tem unidades em mais de uma custódia (${holders.join(', ')}) e a ${t.type === 'SELL' ? 'venda' : 'saída'} de ${t.date} ` +
                `não indica de qual: atribuída a "${b}" (regra conservadora); DARF retido até confirmar a conta.`,
            });
          }
        } else b = named ?? 'desconhecida';
        txBucket.set(t.id, b);
        const share = units[b] > 1e-12 ? Math.min(1, q / units[b]) : 0;
        const outFx = costFx[b] * share;
        const outBrl = costBrl[b] * share;
        units[b] = Math.max(0, units[b] - q);
        costFx[b] -= outFx;
        costBrl[b] -= outBrl;
        const inId = pairOf.get(t.id);
        if (inId) carry.set(inId, { fx: outFx, brl: outBrl });
      } else {
        txBucket.set(t.id, label(t) ?? (Object.keys(units) as CryptoCustody[]).find((k) => units[k] > 1e-12) ?? 'desconhecida');
        if (t.type === 'SPLIT') for (const k of Object.keys(units) as CryptoCustody[]) units[k] *= t.ratio ?? 1;
      }
    }
    const used = new Set(sorted.filter((t) => t.instrumentId === id).map((t) => txBucket.get(t.id)!));
    const country = (b: CryptoCustody) => (b === 'exterior' ? (CRYPTO_VENUE_COUNTRY[lastVenue[b] ?? ''] ?? '') : b === 'brasil' ? 'BR' : '');
    if (used.size <= 1) {
      const b = [...used][0] ?? forced ?? cryptoCustodyOf(inst, opts.cryptoCustody);
      custody[id] = b;
      venueCountry[id] = country(b);
    } else {
      for (const b of used) {
        custody[`${id}#${b}`] = b;
        venueCountry[`${id}#${b}`] = country(b);
      }
      issues.push({
        level: 'info',
        code: 'CRYPTO_SPLIT_BY_CUSTODY',
        instrumentId: id,
        message: `${inst.symbol} está em custódias diferentes (${[...used].join(', ')}): cada parte segue seu regime; transferências entre elas levam o custo.`,
      });
    }
  }
  const splitIds = new Set(Object.keys(custody).filter((k) => k.includes('#')).map((k) => k.split('#')[0]!));
  if (!splitIds.size) return { input, custody, transferBasis, unconfirmedSales, venueCountry, issues };
  const extra: Instrument[] = [];
  for (const k of Object.keys(custody)) {
    if (!k.includes('#')) continue;
    const base = cryptos.get(k.split('#')[0]!)!;
    extra.push({ ...base, id: k, name: `${base.name} (${custody[k]})` });
  }
  return {
    input: {
      ...input,
      instruments: [...input.instruments, ...extra],
      transactions: input.transactions.map((t) =>
        t.instrumentId && splitIds.has(t.instrumentId) ? { ...t, instrumentId: `${t.instrumentId}#${txBucket.get(t.id)}` } : t,
      ),
    },
    custody,
    transferBasis,
    unconfirmedSales,
    venueCountry,
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
