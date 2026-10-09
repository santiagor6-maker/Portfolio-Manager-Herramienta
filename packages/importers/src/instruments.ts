/**
 * Resolve importer hints (ticker / ISIN / name / exchange / currency) into Instrument ids following the
 * `${MIC}:${symbol}` convention, reusing the user's existing instruments when possible and otherwise
 * suggesting new ones (with Yahoo symbol, currency, country and asset class inferred by market).
 */
import type { AssetClass, ExchangeCode, Instrument } from '@pm/core';
import {
  B3_TICKER_RE_STRICT,
  BR_ETFS,
  BR_UNITS,
  CO_ETFS,
  CO_REITS,
  CO_TICKERS,
  CURRENCY_EXCHANGE,
  EU_TICKERS,
  EXCHANGES,
  ISIN_COUNTRY_EXCHANGE,
  ISIN_DIRECTORY,
  TICKER_RENAMES,
  US_ARCA,
  US_ETFS,
  US_EXCHANGES,
  US_NASDAQ,
  US_NYSE,
  YAHOO_SUFFIX_TO_MIC,
  b3TickerFromIsin,
  normalizeExchange,
  yahooSymbol,
} from './markets';
import type { InstrumentHint } from './types';
import { normalizeText } from './util';

export interface ResolveNote {
  code: 'EXCHANGE_GUESSED' | 'SYMBOL_FROM_ISIN' | 'CURRENCY_MISMATCH' | 'MGC_FOREIGN_LISTING' | 'EXCHANGE_REQUIRED' | 'EXCHANGE_REFINED' | 'TICKER_RENAMED';
  params: Record<string, string | number>;
}

export interface Resolution {
  instrument: Instrument;
  isNew: boolean;
  notes: ResolveNote[];
  /** Trade currency differs from the instrument's on purpose (MGC: US share bought in COP). */
  foreignListing?: boolean;
  /** Suggested change to an existing instrument (e.g. `US:ENB` now known to be on NYSE). */
  update?: { id: string; changes: Partial<Instrument>; reason: string };
}

export interface ResolveError {
  error: ResolveNote;
  /** Candidate answers for the user (e.g. MICs where the symbol exists). */
  suggestions?: string[];
}

const FIXED_INCOME_RE = /\b(tesouro|cdb|lci|lca|cdt|debenture|cri|cra|lf|tes|bono|bond|ntn|lft|ltn)\b/;

export function isValidIsin(s: string): boolean {
  return /^[A-Z]{2}[A-Z0-9]{9}\d$/.test(s);
}

export function slugSymbol(name: string): string {
  return normalizeText(name).toUpperCase().replace(/\s+/g, '-').slice(0, 40) || 'SIN-NOMBRE';
}

export function guessAssetClass(symbol: string, exchange: ExchangeCode, name?: string): AssetClass {
  const n = normalizeText(name ?? '');
  if (exchange === 'CRYPTO') return 'crypto';
  if (exchange === 'MANUAL') return FIXED_INCOME_RE.test(n) ? 'fixed_income' : /\bfondo|fundo|fic|fund\b/.test(n) ? 'fund' : 'other';
  if (/\b(etf|ishares|indice|index fund|ucits)\b/.test(n)) return 'etf';
  if (exchange === 'BVMF') {
    if (BR_ETFS.has(symbol)) return 'etf';
    if (BR_UNITS.has(symbol)) return 'equity';
    if (/\b(fii|imob|imobiliario|fdo inv|fundo de investimento|fiagro|real estate)\b/.test(n)) return 'reit';
    if (/11$/.test(symbol)) return 'reit'; // most XXXX11 retail holdings are FIIs
    return 'equity';
  }
  if (exchange === 'XBOG') {
    if (CO_ETFS.has(symbol)) return 'etf';
    if (CO_REITS.has(symbol)) return 'reit';
    return 'equity';
  }
  if (US_EXCHANGES.has(exchange)) {
    if (US_ETFS.has(symbol)) return 'etf';
    if (/\b(reit|realty)\b/.test(n)) return 'reit';
  }
  return 'equity';
}

export interface ResolverOptions {
  /** MIC used for unknown US tickers. Default 'US' (exchange to be confirmed; id `US:SYMBOL`). */
  defaultUsExchange?: ExchangeCode;
  /** Reference catalog (e.g. @pm/market-data CATALOG.instruments) consulted after the user's instruments. */
  catalog?: Instrument[];
  /** User answers: symbol/spec → instrument id ("BVMF:PETR4") or MIC ("XMAD"). */
  securityMap?: Record<string, string>;
}

export class InstrumentResolver {
  private readonly byId = new Map<string, Instrument>();
  private readonly byIsin = new Map<string, Instrument>();
  private readonly bySymbol = new Map<string, Instrument[]>();
  private readonly created = new Map<string, Instrument>();
  private readonly matched = new Set<string>();

  private readonly catalogById = new Map<string, Instrument>();
  private readonly catalogByIsin = new Map<string, Instrument>();
  private readonly catalogBySymbol = new Map<string, Instrument[]>();
  private readonly catalogByName = new Map<string, Instrument[]>();
  private readonly securityMap = new Map<string, string>();

  constructor(
    existing: Instrument[] = [],
    private readonly opts: ResolverOptions = {},
  ) {
    for (const i of existing) this.index(i);
    for (const i of opts.catalog ?? []) {
      this.catalogById.set(i.id, i);
      if (i.isin) this.catalogByIsin.set(i.isin.toUpperCase(), i);
      const k = i.symbol.toUpperCase();
      this.catalogBySymbol.set(k, [...(this.catalogBySymbol.get(k) ?? []), i]);
      const n = normalizeText(i.name);
      this.catalogByName.set(n, [...(this.catalogByName.get(n) ?? []), i]);
    }
    for (const [k, v] of Object.entries(opts.securityMap ?? {})) this.securityMap.set(normalizeText(k), v.trim());
  }

  /** Adopt a catalog instrument as a new suggestion (copy, so callers can't mutate the catalog). */
  private adopt(i: Instrument): Resolution {
    const known = this.byId.get(i.id);
    if (known) return this.existing(known);
    const copy: Instrument = JSON.parse(JSON.stringify(i));
    this.created.set(copy.id, copy);
    this.index(copy);
    return { instrument: copy, isNew: true, notes: [] };
  }

  private index(i: Instrument): void {
    this.byId.set(i.id, i);
    if (i.isin) this.byIsin.set(i.isin.toUpperCase(), i);
    const list = this.bySymbol.get(i.symbol.toUpperCase()) ?? [];
    list.push(i);
    this.bySymbol.set(i.symbol.toUpperCase(), list);
  }

  /** New instruments suggested so far. */
  newInstruments(): Instrument[] {
    return [...this.created.values()];
  }

  matchedCount(): number {
    return this.matched.size;
  }

  private knownUsExchange(symbol: string): ExchangeCode | undefined {
    if (US_NASDAQ.has(symbol)) return 'XNAS';
    if (US_NYSE.has(symbol)) return 'XNYS';
    if (US_ARCA.has(symbol)) return 'ARCX';
    const cat = (this.catalogBySymbol.get(symbol) ?? []).find((i) => EXCHANGES[i.exchange]?.country === 'US');
    return cat?.exchange;
  }

  private usExchange(symbol: string, notes: ResolveNote[]): ExchangeCode {
    const known = this.knownUsExchange(symbol);
    if (known) return known;
    // Same default as @pm/market-data (parseYahooSymbol): unknown US listings are XNYS; Yahoo needs no suffix.
    const ex = this.opts.defaultUsExchange ?? 'XNYS';
    notes.push({ code: 'EXCHANGE_GUESSED', params: { symbol, exchange: ex } });
    return ex;
  }

  private existing(i: Instrument, isNew = false): Resolution {
    if (!isNew && !this.created.has(i.id)) this.matched.add(i.id);
    return { instrument: i, isNew, notes: [] };
  }

  resolve(hint: InstrumentHint): Resolution | ResolveError | undefined {
    const notes: ResolveNote[] = [];
    if (hint.create) {
      const known = this.byId.get(hint.create.id);
      if (known) return this.existing(known);
      const inst: Instrument = { ...hint.create };
      this.created.set(inst.id, inst);
      this.index(inst);
      return { instrument: inst, isNew: true, notes };
    }
    // User answers first ("PETROBRAS PN N2" → BVMF:PETR4, "SAN" → XMAD).
    for (const key of [hint.symbol, hint.name, hint.isin]) {
      const mapped = key ? this.securityMap.get(normalizeText(key)) : undefined;
      if (!mapped) continue;
      if (mapped.includes(':')) {
        const [ex, ...rest] = mapped.split(':');
        hint = { ...hint, id: mapped, exchange: ex, symbol: rest.join(':') };
      } else hint = { ...hint, exchange: mapped };
      break;
    }
    if (hint.id) {
      const known = this.byId.get(hint.id);
      if (known) return this.existing(known);
    }
    const isin = hint.isin?.trim().toUpperCase();
    if (isin && isValidIsin(isin)) {
      const known = this.byIsin.get(isin);
      if (known) return this.existing(known);
      const cat = this.catalogByIsin.get(isin);
      if (cat) return this.adopt(cat);
    }
    if (hint.id && this.catalogById.has(hint.id)) return this.adopt(this.catalogById.get(hint.id)!);
    let symbol = hint.symbol?.trim().toUpperCase().replace(/\s+/g, ' ');
    let exchange = normalizeExchange(hint.exchange);
    let currency = hint.currency?.toUpperCase();
    if (currency === 'GBX') currency = 'GBP';
    let assetClass = hint.assetClass;

    if (hint.id && !exchange) {
      const m = /^([^:]+):(.+)$/.exec(hint.id);
      if (m) {
        exchange = m[1]!;
        symbol = symbol ?? m[2]!;
      }
    }

    // Yahoo-style suffix: PETR4.SA, SAP.DE, BARC.L
    if (symbol && !exchange) {
      const m = /^(.+)\.([A-Z]{1,3})$/.exec(symbol);
      if (m && YAHOO_SUFFIX_TO_MIC[m[2]!]) {
        exchange = YAHOO_SUFFIX_TO_MIC[m[2]!];
        symbol = m[1]!;
      }
    }

    // Symbol from ISIN when missing.
    if (!symbol && isin) {
      const dir = ISIN_DIRECTORY[isin];
      const b3 = b3TickerFromIsin(isin);
      if (dir) {
        symbol = dir.symbol;
        exchange = exchange ?? dir.exchange;
        assetClass = assetClass ?? dir.assetClass;
      } else if (b3) {
        symbol = b3;
        exchange = exchange ?? 'BVMF';
      } else {
        symbol = isin;
        notes.push({ code: 'SYMBOL_FROM_ISIN', params: { isin, name: hint.name ?? isin } });
      }
    } else if (symbol && isin && !exchange && ISIN_DIRECTORY[isin]) {
      exchange = ISIN_DIRECTORY[isin]!.exchange;
    }

    if (!symbol && hint.name) {
      // Funds / Tesouro / CDT names: exact name match in the user's instruments or the catalog
      // (e.g. @pm/market-data FIC:… and TD:… instruments) before falling back to a manual instrument.
      const n = normalizeText(hint.name);
      const mine = [...this.byId.values()].filter((i) => normalizeText(i.name) === n);
      if (mine.length === 1) return this.existing(mine[0]!);
      const cat = this.catalogByName.get(n);
      if (cat && cat.length === 1) return this.adopt(cat[0]!);
      symbol = slugSymbol(hint.name);
      exchange = exchange ?? 'MANUAL';
    }
    if (!symbol) return undefined;

    let foreignListing = false;
    if (!exchange) {
      const country = hint.country?.toUpperCase() ?? (isin && isValidIsin(isin) ? isin.slice(0, 2) : undefined);
      const catHits = this.catalogBySymbol.get(symbol) ?? [];
      const catSameCcy = catHits.filter((i) => !currency || i.currency === currency);
      const usKnown = this.knownUsExchange(symbol);
      if (B3_TICKER_RE_STRICT.test(symbol) && (!currency || currency === 'BRL')) exchange = 'BVMF';
      else if (CO_TICKERS.has(symbol) || catHits.some((i) => i.exchange === 'XBOG')) exchange = 'XBOG';
      else if (catSameCcy.length === 1) return this.adopt(catSameCcy[0]!);
      else if (currency === 'COP' && (usKnown || country === 'US')) {
        // Mercado Global Colombiano: foreign share traded in COP → the US instrument, trade kept in COP.
        exchange = usKnown ?? this.usExchange(symbol, notes);
        foreignListing = true;
        notes.push({ code: 'MGC_FOREIGN_LISTING', params: { symbol, id: `${exchange}:${symbol}` } });
      } else if (currency === 'EUR' && !country) {
        exchange = EU_TICKERS[symbol];
        if (!exchange) {
          const cands = [...new Set(catHits.map((i) => i.exchange))];
          return { error: { code: 'EXCHANGE_REQUIRED', params: { symbol, currency } }, suggestions: cands.length ? cands : ['XMAD', 'XETR', 'XPAR', 'XAMS', 'XMIL'] };
        }
      } else if (currency && CURRENCY_EXCHANGE[currency] && !(currency === 'COP' && country === 'US')) exchange = CURRENCY_EXCHANGE[currency];
      else if (country === 'US' || currency === 'USD') exchange = this.usExchange(symbol, notes);
      else if (country === 'CO') exchange = 'XBOG';
      else if (country === 'BR') exchange = 'BVMF';
      else if (country && ISIN_COUNTRY_EXCHANGE[country]) {
        exchange = ISIN_COUNTRY_EXCHANGE[country];
        notes.push({ code: 'EXCHANGE_GUESSED', params: { symbol, exchange } });
      } else if (currency === 'EUR') {
        exchange = 'XETR';
        notes.push({ code: 'EXCHANGE_GUESSED', params: { symbol, exchange } });
      } else if (/^[A-Z]{1,5}(\.[A-Z])?$/.test(symbol)) exchange = this.usExchange(symbol, notes);
      else exchange = 'MANUAL';
    }

    if (!exchange) exchange = 'MANUAL';
    if (exchange === 'BVMF' && /^[A-Z0-9]{4}\d{1,2}F$/.test(symbol)) symbol = symbol.slice(0, -1); // fractional market

    let id = `${exchange}:${symbol}`;
    // Renamed tickers (ELET3 → AXIA3, TRPL4 → ISAE4…): one instrument per security. Reuse whichever id
    // the user already has; otherwise create the current one.
    const renamedTo = TICKER_RENAMES[id];
    const renamedFrom = Object.keys(TICKER_RENAMES).filter((k) => TICKER_RENAMES[k] === id);
    if (renamedTo || renamedFrom.length) {
      const family = renamedTo ? [id, renamedTo] : [id, ...renamedFrom];
      const mine = family.map((x) => this.byId.get(x)).find((x): x is Instrument => !!x);
      if (mine) {
        const r = this.created.has(mine.id) ? { instrument: mine, isNew: true, notes: [] as ResolveNote[] } : this.existing(mine);
        if (mine.id !== id) r.notes = [{ code: 'TICKER_RENAMED', params: { from: id, to: mine.id } }];
        return { ...r, foreignListing };
      }
      if (renamedTo) {
        notes.push({ code: 'TICKER_RENAMED', params: { from: id, to: renamedTo } });
        id = renamedTo;
        symbol = renamedTo.split(':')[1]!;
      }
    }
    const keepNotes = notes.filter((n) => n.code === 'MGC_FOREIGN_LISTING' || n.code === 'TICKER_RENAMED');
    const known = this.byId.get(id);
    if (known) return { ...this.existing(known), notes: keepNotes, foreignListing };
    const created = this.created.get(id);
    if (created) return { instrument: created, isNew: true, notes: keepNotes, foreignListing };
    const same = (this.bySymbol.get(symbol) ?? []).filter((i) => EXCHANGES[i.exchange]?.country === EXCHANGES[exchange!]?.country);
    // Same symbol already known on an exchange we only guessed → reuse it.
    if (notes.some((n) => n.code === 'EXCHANGE_GUESSED') && same.length === 1) {
      return { ...this.existing(same[0]!), notes: keepNotes, foreignListing };
    }
    // All US venues share the same Yahoo symbol: one instrument per US symbol. If the user's instrument
    // sits on another US MIC (e.g. an earlier guess) reuse it and, when the venue is now known, suggest the fix.
    if (US_EXCHANGES.has(exchange) && same.length) {
      const prev = same.find((i) => US_EXCHANGES.has(i.exchange));
      if (prev) {
        const guessed = notes.some((n) => n.code === 'EXCHANGE_GUESSED');
        const r = prev === this.created.get(prev.id) ? { instrument: prev, isNew: true, notes: [] as ResolveNote[] } : this.existing(prev);
        if (!guessed && prev.exchange !== exchange) {
          return {
            ...r,
            notes: [{ code: 'EXCHANGE_REFINED', params: { id: prev.id, exchange } }],
            update: { id: prev.id, changes: { exchange }, reason: `exchange:${exchange}` },
          };
        }
        return { ...r, notes: keepNotes };
      }
    }

    const info = EXCHANGES[exchange];
    const instCurrency = exchange === 'MANUAL' || exchange === 'CRYPTO' || !info ? currency ?? info?.currency ?? 'USD' : info.currency;
    const instrument: Instrument = {
      id,
      symbol,
      name: hint.name?.trim() || symbol,
      exchange,
      currency: instCurrency,
      country: info && info.country !== 'INTL' ? info.country : isin && isValidIsin(isin) ? isin.slice(0, 2) : hint.country ?? 'INTL',
      assetClass: assetClass ?? guessAssetClass(symbol, exchange, hint.name),
    };
    if (isin && isValidIsin(isin)) instrument.isin = isin;
    const ySym = yahooSymbol(symbol, exchange);
    if (ySym && exchange !== 'MANUAL') instrument.providerSymbols = { yahoo: ySym };
    instrument.pricing = exchange === 'MANUAL' ? 'manual' : 'auto';
    if (hint.extra) Object.assign(instrument, hint.extra);
    this.created.set(id, instrument);
    this.index(instrument);
    return { instrument, isNew: true, notes, foreignListing };
  }
}
