import type { Instrument, Transaction } from '@pm/core';
import { basisTotalCost, resolveTransferBasis, type TransferBasisMap } from '../common/basis';
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

export interface CryptoTransitPiece {
  /** Base (non-virtual) instrument id. */
  instrumentId: string;
  symbol: string;
  bucket: CryptoCustody;
  /** Virtual instrument id of the source custody. */
  sourceId: string;
  outDate: string;
  outTxId: string;
  units: number;
  fx: number;
  brl: number;
  country: string;
  /** Arrivals (incl. the fee written off on the last one). */
  consumptions: { date: string; units: number; fx: number; brl: number }[];
  /** Units of the piece whose cost is provisional/pending (came from an unmatched deposit) — T57. */
  provisional?: number;
  /** Of `provisional`, units with NO cost at all (deposit without value): "custo pendente" — T62. */
  pending?: number;
}

/** Provisional/pending units of one custody of an asset after a date's transactions (T62). */
export interface CryptoCostStatusEntry {
  instrumentId: string;
  bucket: CryptoCustody;
  date: string;
  provisional: number;
  pending: number;
}

export interface CryptoRouting {
  /** Input with crypto transactions split/re-pointed to per-custody virtual instruments. */
  input: TaxInput;
  /** Custody per (possibly virtual) instrument id. */
  custody: Record<string, CryptoCustody>;
  /** Original cost carried by matched transfers (by TRANSFER_IN id) — T48/T53. */
  transferBasis: Record<string, { openDate: string; totalCost: number; fxRate: number }>;
  /** Sale pieces routed with ambiguous custody: tax as Brazil, DARF withheld (T47/T52). */
  unconfirmedSales: Set<string>;
  /** Sale pieces with no recorded units: "custo pendente" (T56). */
  pendingCostSales: Set<string>;
  /**
   * Sale pieces drawn (even partly) from units of an unmatched deposit, whose cost is only provisional
   * (the deposit's own value, or zero): tax shown, DARF withheld until the cost is confirmed (T57).
   */
  provisionalCostSales: Set<string>;
  /** Sale pieces whose CUSTODY (not cost) is unconfirmed — they may not count toward the R$ 35k limit (T59). */
  custodyUnconfirmedSales: Set<string>;
  /** Country of the venue holding each (virtual) crypto instrument ('' unknown) — T50. */
  venueCountry: Record<string, string>;
  /** Units that left a custody and had not (fully) arrived at another one — T55. */
  transit: CryptoTransitPiece[];
  /** Timeline of provisional/pending units per asset and custody (T62). */
  costStatusLog: CryptoCostStatusEntry[];
  issues: TaxIssue[];
}

export interface CryptoRoutingOptions {
  cryptoCustody?: Record<string, CryptoCustody>;
  accountCustody?: Record<string, CryptoCustody>;
  /** BRL per unit of currency at a date (e.g. PTAX de compra); default market.fx. */
  brlRate?: (ccy: string, date: string) => number | undefined;
  /** Transfers whose OUT is at most this many days before the IN are preferred matches. Default 30. */
  transferWindowDays?: number;
  /** Max share of a transferred piece that can be lost as a network/withdrawal fee. Default 10%. */
  transferMaxFeePct?: number;
  /**
   * Transfers whose OUT is older than this many days are NOT paired automatically: the match is only
   * proposed (TRANSFER_MATCH_PROPOSED) and the IN keeps a provisional cost (T58). Default 90.
   */
  transferMaxLateDays?: number;
  /**
   * Original cost confirmed by the user per TRANSFER_IN id (also structured notes "[custo: ...]"):
   * makes the IN's cost final (not provisional), whatever the pairing (T57/T58).
   */
  transferBasis?: TransferBasisMap;
  /** Apply free-text note proposals as confirmed bases. */
  acceptNoteProposals?: boolean;
  /**
   * Pairings confirmed by the user: TRANSFER_IN id -> TRANSFER_OUT id. Allowed beyond
   * `transferMaxLateDays` and preferred over any other candidate (confirms TRANSFER_MATCH_PROPOSED).
   */
  confirmedTransfers?: Record<string, string>;
}

/**
 * Provisional and pending (no cost) units held at the end of `date` by a (possibly virtual) crypto
 * instrument (T62): Bens e Direitos marks those costs as "provisório"/"pendente".
 */
export function cryptoCostStatusAt(r: CryptoRouting, instrumentId: string, date: string): { provisional: number; pending: number } {
  const [base, b] = instrumentId.includes('#') ? (instrumentId.split('#') as [string, CryptoCustody]) : [instrumentId, r.custody[instrumentId]];
  let out = { provisional: 0, pending: 0 };
  for (const e of r.costStatusLog) {
    if (e.instrumentId !== base || e.date > date || (b && e.bucket !== b)) continue;
    out = b ? { provisional: e.provisional, pending: e.pending } : out;
  }
  if (!b) {
    // Not routed by custody: sum the last entry of every bucket.
    const last = new Map<CryptoCustody, CryptoCostStatusEntry>();
    for (const e of r.costStatusLog) if (e.instrumentId === base && e.date <= date) last.set(e.bucket, e);
    for (const e of last.values()) out = { provisional: out.provisional + e.provisional, pending: out.pending + e.pending };
  }
  return out;
}

/** Order in which custodies are consumed when the named one lacks units (T52): named, then Brazil (conservative). */
export const CRYPTO_CONSUMPTION_ORDER: CryptoCustody[] = ['brasil', 'desconhecida', 'exterior'];

/** Units still in transit at a date (after the OUT, before the IN). */
export function cryptoInTransitAt(r: CryptoRouting, date: string): { piece: CryptoTransitPiece; units: number; fx: number; brl: number }[] {
  const out: { piece: CryptoTransitPiece; units: number; fx: number; brl: number }[] = [];
  for (const p of r.transit) {
    if (p.outDate > date) continue;
    const arrived = p.consumptions.filter((c) => c.date <= date);
    const u = p.units - arrived.reduce((a, c) => a + c.units, 0);
    if (u <= 1e-9) continue;
    out.push({ piece: p, units: u, fx: p.fx - arrived.reduce((a, c) => a + c.fx, 0), brl: p.brl - arrived.reduce((a, c) => a + c.brl, 0) });
  }
  return out;
}

/**
 * Decides the regime of each crypto transaction by CUSTODY, following where the UNITS are
 * (T38, T47, T48, T52-T56). For each asset, in date order (same day: inflows, transfers out,
 * transfers in, sales):
 * - inflows go to the custody of their account/venue (instrument override > account > exchange);
 * - sales and transfers out consume the custody named by the account first, then the others in
 *   CRYPTO_CONSUMPTION_ORDER (Brazil first, conservative); a sale spanning several custodies is SPLIT
 *   into one piece per custody (no phantom units); pieces not taken from the named custody — or any
 *   piece when the account is unknown and several custodies hold units — have their DARF withheld;
 * - transfers out create in-transit pieces; transfers in consume them (same custody first, then within
 *   `transferWindowDays`, closest quantity, oldest), one-to-many and many-to-one, carrying cost in the
 *   asset currency and in BRL; a shortfall up to `transferMaxFeePct` is the network fee (full cost carried);
 * - a sale/transfer from a custody without units first pulls pending in-transit units (inferred arrival);
 *   if there are none, the remainder becomes a "custo pendente" sale piece (counted in sales, DARF withheld);
 * - an IN without a matching OUT keeps its own amount (or zero) only as a PROVISIONAL cost, flagged
 *   TRANSFER_COST_UNKNOWN; sales drawing on those units have their DARF withheld (T57);
 * - OUTs older than `transferMaxLateDays` are never paired automatically, only proposed
 *   (TRANSFER_MATCH_PROPOSED); `confirmedTransfers` / `transferBasis` confirm (T58).
 */
export function routeCryptoByCustody(input: TaxInput, opts: CryptoRoutingOptions = {}): CryptoRouting {
  const custody: Record<string, CryptoCustody> = { ...(opts.cryptoCustody ?? {}) };
  const issues: TaxIssue[] = [];
  const transferBasis: CryptoRouting['transferBasis'] = {};
  const unconfirmedSales = new Set<string>();
  const pendingCostSales = new Set<string>();
  const provisionalCostSales = new Set<string>();
  const custodyUnconfirmedSales = new Set<string>();
  const venueCountry: Record<string, string> = {};
  const transit: CryptoTransitPiece[] = [];
  const costStatusLog: CryptoCostStatusEntry[] = [];
  const cryptos = new Map(input.instruments.filter((i) => i.assetClass === 'crypto').map((i) => [i.id, i]));
  const empty = (): CryptoRouting => ({ input, custody, transferBasis, unconfirmedSales, pendingCostSales, provisionalCostSales, custodyUnconfirmedSales, venueCountry, transit, costStatusLog, issues });
  if (!cryptos.size) return empty();
  const windowDays = opts.transferWindowDays ?? 30;
  const maxFee = opts.transferMaxFeePct ?? 0.1;
  const maxLate = opts.transferMaxLateDays ?? 90;
  const brl = (ccy: string, date: string) => (ccy === 'BRL' ? 1 : (opts.brlRate?.(ccy, date) ?? input.market.fx(ccy, 'BRL', date) ?? 0));
  const dayOrder = (t: Transaction) =>
    t.type === 'TRANSFER_OUT' ? 1 : t.type === 'TRANSFER_IN' ? 2 : t.type === 'SELL' ? 3 : t.type === 'BUY' || t.type === 'STOCK_DIVIDEND' ? 0 : 4;
  const all = input.transactions.map((t, i) => ({ t, i }));
  const rewritten = new Map<string, Transaction[]>(); // original id -> replacement pieces
  const pieceBucket = new Map<string, CryptoCustody>(); // piece/tx id -> bucket
  const inferred = new Map<string, Transaction>(); // sale/out id -> synthetic TRANSFER_IN
  const BUCKETS: CryptoCustody[] = ['brasil', 'exterior', 'desconhecida'];

  for (const [id, inst] of cryptos) {
    const forced = opts.cryptoCustody?.[id];
    const txs = all
      .filter(({ t }) => t.instrumentId === id)
      .sort((a, b) => a.t.date.localeCompare(b.t.date) || dayOrder(a.t) - dayOrder(b.t) || a.i - b.i)
      .map(({ t }) => t);
    if (!txs.length) continue;
    const units: Record<CryptoCustody, number> = { brasil: 0, exterior: 0, desconhecida: 0 };
    const costFx: Record<CryptoCustody, number> = { brasil: 0, exterior: 0, desconhecida: 0 };
    const costBrl: Record<CryptoCustody, number> = { brasil: 0, exterior: 0, desconhecida: 0 };
    const lastVenue: Partial<Record<CryptoCustody, string>> = {};
    /** Units whose cost is provisional/pending (unmatched deposits), per custody (T57). */
    const prov: Record<CryptoCustody, number> = { brasil: 0, exterior: 0, desconhecida: 0 };
    /** Of `prov`, units with no cost at all (pending), per custody (T62). */
    const pend: Record<CryptoCustody, number> = { brasil: 0, exterior: 0, desconhecida: 0 };
    const pool: CryptoTransitPiece[] = [];
    const used = new Set<CryptoCustody>();
    const label = (t: Transaction): CryptoCustody | undefined =>
      forced ?? cryptoCustodyForVenue(t.account, opts.accountCustody) ?? (t.account ? undefined : cryptoCustodyForVenue(inst.exchange, opts.accountCustody));
    const countryOf = (b: CryptoCustody) => (b === 'exterior' ? (CRYPTO_VENUE_COUNTRY[lastVenue[b] ?? ''] ?? '') : b === 'brasil' ? 'BR' : '');
    const add = (b: CryptoCustody, u: number, fx: number, br: number, venue?: string, provisional = 0, pending = 0) => {
      prov[b] += provisional;
      pend[b] += pending;
      units[b] += u;
      costFx[b] += fx;
      costBrl[b] += br;
      used.add(b);
      if (venue) lastVenue[b] = venue;
    };
    const take = (b: CryptoCustody, u: number) => {
      const share = units[b] > 1e-12 ? Math.min(1, u / units[b]) : 0;
      const fx = costFx[b] * share;
      const br = costBrl[b] * share;
      const pv = prov[b] * share;
      prov[b] -= pv;
      const pd = pend[b] * share;
      pend[b] -= pd;
      units[b] = Math.max(0, units[b] - u);
      costFx[b] -= fx;
      costBrl[b] -= br;
      if (units[b] < 1e-12) {
        units[b] = 0;
        costFx[b] = 0;
        costBrl[b] = 0;
        prov[b] = 0;
        pend[b] = 0;
      }
      return { fx, br, pv, pd };
    };
    /** Consume pool pieces for an arrival of q units into bucket D at date d. Returns carried cost and matched units. */
    const arrive = (
      q: number,
      D: CryptoCustody,
      d: string,
      txId: string,
      o: { futureIns?: number[]; ownValue?: number; link?: string; quiet?: boolean; uncapped?: boolean } = {},
    ) => {
      const futureIns = o.futureIns ?? [];
      const ownValue = o.ownValue ?? 0;
      let need = q;
      let fx = 0;
      let br = 0;
      let pv = 0;
      let pd = 0;
      const linked = (p: CryptoTransitPiece) => !!o.link && (p.outTxId === o.link || p.outTxId.startsWith(`${o.link}~`));
      const cands = pool
        .filter((p) => p.outDate <= d && (daysBetween(p.outDate, d) <= maxLate || linked(p) || o.uncapped) && p.units - p.consumptions.reduce((a, c) => a + c.units, 0) > 1e-12)
        .sort((a, b) => {
          const lk = (p: CryptoTransitPiece) => (linked(p) ? 0 : 1);
          const inWin = (p: CryptoTransitPiece) => (daysBetween(p.outDate, d) <= windowDays ? 0 : 1);
          const same = (p: CryptoTransitPiece) => (p.bucket === D ? 0 : 1);
          const rem = (p: CryptoTransitPiece) => p.units - p.consumptions.reduce((x, c) => x + c.units, 0);
          return lk(a) - lk(b) || inWin(a) - inWin(b) || same(a) - same(b) || Math.abs(rem(a) - q) - Math.abs(rem(b) - q) || a.outDate.localeCompare(b.outDate);
        });
      // T60: ambiguous only when the candidates exceed the arrival (some will be left out) and the
      // top two tie on custody and quantity but differ in unit cost.
      const remOf = (p: CryptoTransitPiece) => p.units - p.consumptions.reduce((x, c) => x + c.units, 0);
      const totalCand = cands.filter((p) => daysBetween(p.outDate, d) <= windowDays).reduce((a, p) => a + remOf(p), 0);
      if (!o.quiet && !o.link && cands.length > 1 && totalCand > q * (1 + maxFee) + 1e-9 && (cands[0]!.bucket === D) === (cands[1]!.bucket === D)) {
        const rem = remOf;
        const unit = (p: CryptoTransitPiece) => (p.brl - p.consumptions.reduce((x, c) => x + c.brl, 0)) / Math.max(rem(p), 1e-12);
        if (Math.abs(unit(cands[0]!) - unit(cands[1]!)) > 1e-6 && Math.abs(Math.abs(rem(cands[0]!) - q) - Math.abs(rem(cands[1]!) - q)) < 1e-9) {
          issues.push({
            level: 'warning',
            code: 'TRANSFER_PAIR_AMBIGUOUS',
            transactionId: txId,
            instrumentId: id,
            message: `Entrada de ${inst.symbol} em ${d} pode vir de mais de uma saída pendente com custos diferentes: usada a de ${cands[0]!.outDate} (${cands[0]!.bucket}). Confira.`,
          });
        }
      }
      for (const p of cands) {
        if (need <= 1e-12) break;
        const remU = p.units - p.consumptions.reduce((a, c) => a + c.units, 0);
        const remFx = p.fx - p.consumptions.reduce((a, c) => a + c.fx, 0);
        const remBr = p.brl - p.consumptions.reduce((a, c) => a + c.brl, 0);
        let u = Math.min(remU, need);
        let share = u / remU;
        // The last needed piece: a small shortfall is the network fee → carry its full remaining cost,
        // unless a later arrival can still take the remainder (two-part arrival, T60).
        const laterCovers = futureIns.some((fq) => fq <= (remU - u) * 1.02 + 1e-9);
        if (u === need && remU - u > 1e-12 && remU - u <= p.units * maxFee && !laterCovers) {
          const pct = (remU - u) / remU;
          if (pct > 0.02 && !o.quiet) {
            issues.push({
              level: 'info',
              code: 'TRANSFER_FEE_ASSUMED',
              transactionId: txId,
              instrumentId: id,
              message: `Transferência de ${inst.symbol}: chegaram ${u} de ${remU} unidades; a diferença (${(pct * 100).toFixed(1)}%) foi tratada como taxa de rede (custo integral transferido).`,
            });
          }
          share = 1;
          u = remU;
        }
        if (daysBetween(p.outDate, d) > windowDays && !o.quiet && !linked(p)) {
          issues.push({
            level: 'warning',
            code: 'TRANSFER_MATCHED_LATE',
            transactionId: txId,
            instrumentId: id,
            message:
              `Entrada de ${inst.symbol} em ${d} casada com a saída de ${p.outDate} (mais de ${windowDays} dias): custo de origem transferido` +
              (ownValue > 0 ? ` em vez do valor informado na entrada (${ownValue.toFixed(2)} ${inst.currency})` : '') +
              '. Confirme o vínculo (ou informe transferBasis).',
          });
        }
        const cfx = remFx * share;
        const cbr = remBr * share;
        // Inferred arrival beyond the cap: the carried cost is only a proposal → provisional (T58).
        pv += daysBetween(p.outDate, d) > maxLate && !linked(p) ? u : (p.provisional ?? 0) * share;
        pd += (p.pending ?? 0) * share;
        p.consumptions.push({ date: d, units: u, fx: cfx, brl: cbr });
        fx += cfx;
        br += cbr;
        need -= Math.min(u, need);
      }
      return { fx, br, pv, pd, matched: q - Math.max(0, need) };
    };
    /** Pending OUT pieces older than the late-match cap (proposals only, T58). */
    const tooLate = (d: string) =>
      pool.filter((p) => p.outDate <= d && daysBetween(p.outDate, d) > maxLate && p.units - p.consumptions.reduce((a, c) => a + c.units, 0) > 1e-12);
    /** Consumes q units starting from `first`, then CRYPTO_CONSUMPTION_ORDER. */
    const consume = (q: number, first: CryptoCustody | undefined) => {
      const order = [...(first ? [first] : []), ...CRYPTO_CONSUMPTION_ORDER.filter((b) => b !== first)];
      const parts: { b: CryptoCustody; u: number; fx: number; br: number; pv: number; pd: number }[] = [];
      let need = q;
      for (const b of order) {
        if (need <= 1e-12) break;
        const u = Math.min(units[b], need);
        if (u <= 1e-12) continue;
        const c = take(b, u);
        parts.push({ b, u, fx: c.fx, br: c.br, pv: c.pv, pd: c.pd });
        need -= u;
      }
      return { parts, unmet: need > 1e-9 ? need : 0 };
    };
    const piece = (t: Transaction, part: number, b: CryptoCustody, n: number): Transaction => {
      const q = t.quantity ?? 0;
      const f = q > 0 ? part / q : 1;
      const p: Transaction = {
        ...t,
        id: n === 0 ? t.id : `${t.id}~${n}`,
        quantity: part,
        amount: t.amount !== undefined ? t.amount * f : undefined,
        fees: t.fees !== undefined ? t.fees * f : undefined,
        taxes: t.taxes !== undefined ? t.taxes * f : undefined,
      };
      pieceBucket.set(p.id, b);
      return p;
    };

    for (const t of txs) {
      const q = t.quantity ?? 0;
      const named = label(t);
      if (t.type === 'BUY' || t.type === 'STOCK_DIVIDEND') {
        const b = named ?? 'desconhecida';
        if (!forced && t.account && !cryptoCustodyForVenue(t.account, opts.accountCustody)) {
          issues.push({
            level: 'warning',
            code: 'CRYPTO_VENUE_UNKNOWN',
            transactionId: t.id,
            instrumentId: id,
            message: `Conta "${t.account}" não reconhecida para ${inst.symbol}: custódia desconhecida (DARF retido). Informe accountCustody.`,
          });
        }
        const fx = (t.amount ?? q * (t.price ?? 0)) + (t.fees ?? 0);
        add(b, t.type === 'STOCK_DIVIDEND' && t.quantity === undefined ? 0 : q, fx, fx * brl(t.currency, t.date), cryptoVenueKey(t.account ?? inst.exchange));
        pieceBucket.set(t.id, b);
      } else if (t.type === 'TRANSFER_IN') {
        const D = named ?? 'desconhecida';
        const hasOwn = t.amount !== undefined || t.price !== undefined;
        const ownValue = hasOwn ? t.amount ?? q * (t.price ?? 0) : 0;
        // Later INs of this asset not yet processed: a partial arrival may be completed by them (T60).
        const futureIns = txs.filter((x) => x.type === 'TRANSFER_IN' && x !== t && txs.indexOf(x) > txs.indexOf(t)).map((x) => x.quantity ?? 0);
        const userBasis = resolveTransferBasis(t, opts.transferBasis, opts.acceptNoteProposals).basis;
        const userCost = userBasis ? basisTotalCost(userBasis, q) : undefined;
        const a = arrive(q, D, t.date, t.id, { futureIns, ownValue, link: opts.confirmedTransfers?.[t.id], quiet: userCost !== undefined });
        let fx = a.fx;
        let br = a.br;
        let provisional = a.pv;
        let pendingU = a.pd;
        if (userBasis && userCost !== undefined) {
          // Cost confirmed by the user: final, whatever was (or was not) paired.
          fx = userCost;
          br = userCost * (userBasis.fxRate ?? brl(t.currency, userBasis.openDate));
          provisional = 0;
          pendingU = 0;
          transferBasis[t.id] = { openDate: userBasis.openDate, totalCost: fx, fxRate: fx > 0 ? br / fx : 0 };
        } else if (a.matched < q - 1e-9) {
          const unmatched = q - a.matched;
          const own = hasOwn ? (ownValue * unmatched) / q : 0;
          fx += own;
          br += own * brl(t.currency, t.date);
          provisional += unmatched;
          if (own <= 0) pendingU += unmatched;
          const late = tooLate(t.date);
          if (late.length) {
            // T58: an OUT older than the cap is only PROPOSED, never paired automatically.
            const c = late.sort((x, y) => Math.abs(x.units - unmatched) - Math.abs(y.units - unmatched))[0]!;
            issues.push({
              level: 'warning',
              code: 'TRANSFER_MATCH_PROPOSED',
              transactionId: t.id,
              instrumentId: id,
              message:
                `Entrada de ${unmatched} ${inst.symbol} em ${t.date} pode corresponder à saída de ${c.outDate} (${c.bucket}, custo R$ ${c.brl.toFixed(2)}), ` +
                `mais de ${maxLate} dias antes: NÃO vinculada automaticamente. Se for a mesma unidade, informe transferBasis para esta entrada.`,
            });
          }
          issues.push({
            level: 'warning',
            code: 'TRANSFER_COST_UNKNOWN',
            transactionId: t.id,
            instrumentId: id,
            message:
              `Entrada de ${unmatched} ${inst.symbol} em ${t.date} sem saída correspondente (depósito externo?): ` +
              (own > 0
                ? `valor informado na entrada (${own.toFixed(2)} ${t.currency}) usado como custo PROVISÓRIO — não é necessariamente o custo de aquisição.`
                : 'custo PENDENTE (considerado ZERO só provisoriamente).') +
              ' Imposto das vendas dessas unidades calculado, DARF retido até confirmar o custo (transferBasis ou a compra/saída de origem).',
          });
        }
        if ((fx > 0 || br > 0) && !transferBasis[t.id]) transferBasis[t.id] = { openDate: t.date, totalCost: fx, fxRate: fx > 0 ? br / fx : 0 };
        add(D, q, fx, br, cryptoVenueKey(t.account ?? inst.exchange), provisional, pendingU);
        pieceBucket.set(t.id, D);
      } else if (t.type === 'TRANSFER_OUT' || t.type === 'SELL') {
        // Units sent elsewhere earlier but never recorded as arrived: infer the arrival into the named custody.
        if (named && units[named] < q - 1e-9 && pool.some((p) => p.outDate <= t.date)) {
          const before = units[named];
          const a = arrive(q - before, named, t.date, t.id, { uncapped: true });
          if (a.matched > 1e-12) {
            add(named, a.matched, a.fx, a.br, cryptoVenueKey(t.account), a.pv, a.pd);
            // Synthetic arrival so the per-regime reports see the units and their carried cost.
            const synth: Transaction = {
              id: `${t.id}~in`,
              portfolioId: t.portfolioId,
              date: t.date,
              type: 'TRANSFER_IN',
              instrumentId: id,
              quantity: a.matched,
              currency: t.currency,
              account: t.account,
              note: 'entrada inferida (saída anterior sem entrada registrada)',
            };
            pieceBucket.set(synth.id, named);
            transferBasis[synth.id] = { openDate: t.date, totalCost: a.fx, fxRate: a.fx > 0 ? a.br / a.fx : 0 };
            inferred.set(t.id, synth);
            issues.push({
              level: 'info',
              code: 'TRANSFER_IN_INFERRED',
              transactionId: t.id,
              instrumentId: id,
              message: `${a.matched} ${inst.symbol} enviados antes sem entrada registrada foram considerados recebidos em "${t.account}" (custo de origem transferido).`,
            });
          }
        }
        const holdersBefore = BUCKETS.filter((b) => units[b] > 1e-12);
        const { parts, unmet } = consume(q, named);
        const pieces: Transaction[] = [];
        parts.forEach((p, n) => {
          const pc = piece(t, p.u, p.b, n);
          pieces.push(pc);
          if (t.type === 'TRANSFER_OUT') {
            const tp: CryptoTransitPiece = {
              instrumentId: id,
              symbol: inst.symbol,
              bucket: p.b,
              sourceId: id,
              outDate: t.date,
              outTxId: pc.id,
              units: p.u,
              fx: p.fx,
              brl: p.br,
              country: countryOf(p.b),
              consumptions: [],
              provisional: p.pv > 1e-12 ? p.pv : undefined,
              pending: p.pd > 1e-12 ? p.pd : undefined,
            };
            pool.push(tp);
            transit.push(tp);
          } else {
            const ambiguous = named ? p.b !== named : holdersBefore.length > 1;
            if (ambiguous) {
              unconfirmedSales.add(pc.id);
              custodyUnconfirmedSales.add(pc.id);
            }
            if (p.pv > 1e-12) {
              // T57: sold units came (even partly) from a deposit without confirmed cost.
              provisionalCostSales.add(pc.id);
              unconfirmedSales.add(pc.id);
              issues.push({
                level: 'warning',
                code: 'CRYPTO_SALE_COST_PROVISIONAL',
                transactionId: pc.id,
                instrumentId: id,
                message:
                  `Venda de ${p.u} ${inst.symbol} em ${t.date}: ${+p.pv.toFixed(8)} unidade(s) vêm de entrada sem saída correspondente — custo PROVISÓRIO ` +
                  '(valor do depósito ou zero). Imposto calculado; DARF desta parte retido até confirmar o custo de aquisição (transferBasis).',
              });
            }
          }
        });
        if (parts.length > 1 || (named && parts.some((p) => p.b !== named))) {
          issues.push({
            level: 'warning',
            code: t.type === 'SELL' ? 'CRYPTO_SALE_SPLIT_ACROSS_CUSTODY' : 'CRYPTO_TRANSFER_SPLIT_ACROSS_CUSTODY',
            transactionId: t.id,
            instrumentId: id,
            message:
              `${t.type === 'SELL' ? 'Venda' : 'Saída'} de ${q} ${inst.symbol} em ${t.date} ${named ? `(conta ${named})` : '(sem conta reconhecida)'} repartida entre custódias: ` +
              `${parts.map((p) => `${p.u} ${p.b}`).join(' + ')} (ordem: conta, Brasil, desconhecida, exterior). DARF retido nas partes não confirmadas.`,
          });
        } else if (parts.length === 1 && parts[0]!.b !== named) {
          issues.push({
            level: holdersBefore.length > 1 ? 'warning' : 'info',
            code: holdersBefore.length > 1 ? 'CRYPTO_SALE_CUSTODY_AMBIGUOUS' : 'CRYPTO_OUTFLOW_ROUTED_TO_HOLDINGS',
            transactionId: t.id,
            instrumentId: id,
            message:
              `${t.type === 'SELL' ? 'Venda' : 'Saída'} de ${inst.symbol} ${t.account ? `com conta "${t.account}"` : 'sem conta'} atribuída à custódia onde estão as unidades (${parts[0]!.b})` +
              (holdersBefore.length > 1 ? `, entre várias (${holdersBefore.join(', ')}): regra conservadora, DARF retido.` : '.'),
          });
        }
        if (unmet > 0) {
          const b = named ?? 'desconhecida';
          const pc = piece(t, unmet, b, parts.length);
          pieces.push(pc);
          used.add(b);
          if (t.type === 'SELL') {
            pendingCostSales.add(pc.id);
            unconfirmedSales.add(pc.id);
          }
          issues.push({
            level: 'error',
            code: t.type === 'SELL' ? 'CRYPTO_SALE_COST_PENDING' : 'TRANSFER_OUT_WITHOUT_UNITS',
            transactionId: t.id,
            instrumentId: id,
            message:
              t.type === 'SELL'
                ? `Venda de ${unmet} ${inst.symbol} em ${t.date} sem unidades registradas: lançada com CUSTO PENDENTE (conta no limite mensal; DARF retido até informar a compra/entrada).`
                : `Saída de ${unmet} ${inst.symbol} em ${t.date} sem unidades registradas: registre a compra ou a entrada de origem.`,
          });
        }
        const inf = inferred.get(t.id);
        rewritten.set(t.id, inf ? [inf, ...pieces] : pieces);
      } else {
        const b = named ?? BUCKETS.find((x) => units[x] > 1e-12) ?? 'desconhecida';
        if (t.type === 'SPLIT') {
          for (const x of BUCKETS) {
            units[x] *= t.ratio ?? 1;
            prov[x] *= t.ratio ?? 1;
            pend[x] *= t.ratio ?? 1;
          }
        }
        pieceBucket.set(t.id, b);
        used.add(b);
      }
      for (const b of BUCKETS) {
        const last = [...costStatusLog].reverse().find((e) => e.instrumentId === id && e.bucket === b);
        if ((last?.provisional ?? 0) !== prov[b] || (last?.pending ?? 0) !== pend[b]) {
          costStatusLog.push({ instrumentId: id, bucket: b, date: t.date, provisional: prov[b], pending: pend[b] });
        }
      }
    }
    for (const p of pool) {
      const left = p.units - p.consumptions.reduce((a, c) => a + c.units, 0);
      if (left > 1e-9) {
        issues.push({
          level: 'warning',
          code: 'TRANSFER_OUT_UNMATCHED',
          instrumentId: id,
          message: `${left} ${inst.symbol} saíram de ${p.bucket} em ${p.outDate} sem entrada registrada: mantidos como "em trânsito" (Bens e Direitos) até registrar a entrada ou a venda.`,
        });
      }
    }
    const split = used.size > 1;
    for (const b of used) {
      const vid = split ? `${id}#${b}` : id;
      custody[vid] = b;
      venueCountry[vid] = countryOf(b);
    }
    for (const tp of transit) if (tp.instrumentId === id) tp.sourceId = split ? `${id}#${tp.bucket}` : id;
    if (split) {
      issues.push({
        level: 'info',
        code: 'CRYPTO_SPLIT_BY_CUSTODY',
        instrumentId: id,
        message: `${inst.symbol} está em custódias diferentes (${[...used].join(', ')}): cada parte segue seu regime; transferências entre elas levam o custo.`,
      });
    }
  }

  const splitIds = new Set(Object.keys(custody).filter((k) => k.includes('#')).map((k) => k.split('#')[0]!));
  const extra: Instrument[] = [];
  for (const k of Object.keys(custody)) {
    if (!k.includes('#')) continue;
    const base = cryptos.get(k.split('#')[0]!)!;
    extra.push({ ...base, id: k, name: `${base.name} (${custody[k]})` });
  }
  const txOut: Transaction[] = [];
  for (const t of input.transactions) {
    const pieces = rewritten.get(t.id) ?? [t];
    for (const p of pieces) {
      txOut.push(p.instrumentId && splitIds.has(p.instrumentId) ? { ...p, instrumentId: `${p.instrumentId}#${pieceBucket.get(p.id) ?? 'desconhecida'}` } : p);
    }
  }
  return {
    input: { ...input, instruments: [...input.instruments, ...extra], transactions: txOut },
    custody,
    transferBasis,
    unconfirmedSales,
    pendingCostSales,
    provisionalCostSales,
    custodyUnconfirmedSales,
    venueCountry,
    transit,
    costStatusLog,
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
