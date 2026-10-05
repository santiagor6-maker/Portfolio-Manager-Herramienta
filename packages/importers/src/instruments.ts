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
  EXCHANGES,
  ISIN_COUNTRY_EXCHANGE,
  ISIN_DIRECTORY,
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
  code: 'EXCHANGE_GUESSED' | 'SYMBOL_FROM_ISIN' | 'CURRENCY_MISMATCH';
  params: Record<string, string | number>;
}

export interface Resolution {
  instrument: Instrument;
  isNew: boolean;
  notes: ResolveNote[];
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
  defaultUsExchange?: ExchangeCode;
}

export class InstrumentResolver {
  private readonly byId = new Map<string, Instrument>();
  private readonly byIsin = new Map<string, Instrument>();
  private readonly bySymbol = new Map<string, Instrument[]>();
  private readonly created = new Map<string, Instrument>();
  private readonly matched = new Set<string>();

  constructor(
    existing: Instrument[] = [],
    private readonly opts: ResolverOptions = {},
  ) {
    for (const i of existing) this.index(i);
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

  private usExchange(symbol: string, notes: ResolveNote[]): ExchangeCode {
    if (US_NASDAQ.has(symbol)) return 'XNAS';
    if (US_NYSE.has(symbol)) return 'XNYS';
    if (US_ARCA.has(symbol)) return 'ARCX';
    const ex = this.opts.defaultUsExchange ?? 'XNAS';
    notes.push({ code: 'EXCHANGE_GUESSED', params: { symbol, exchange: ex } });
    return ex;
  }

  private existing(i: Instrument, isNew = false): Resolution {
    if (!isNew && !this.created.has(i.id)) this.matched.add(i.id);
    return { instrument: i, isNew, notes: [] };
  }

  resolve(hint: InstrumentHint): Resolution | undefined {
    const notes: ResolveNote[] = [];
    if (hint.id) {
      const known = this.byId.get(hint.id);
      if (known) return this.existing(known);
    }
    const isin = hint.isin?.trim().toUpperCase();
    if (isin && isValidIsin(isin)) {
      const known = this.byIsin.get(isin);
      if (known) return this.existing(known);
    }
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
      symbol = slugSymbol(hint.name);
      exchange = exchange ?? 'MANUAL';
    }
    if (!symbol) return undefined;

    if (!exchange) {
      const country = hint.country?.toUpperCase() ?? (isin && isValidIsin(isin) ? isin.slice(0, 2) : undefined);
      if (B3_TICKER_RE_STRICT.test(symbol) && (!currency || currency === 'BRL')) exchange = 'BVMF';
      else if (CO_TICKERS.has(symbol) && (!currency || currency === 'COP')) exchange = 'XBOG';
      else if (currency && CURRENCY_EXCHANGE[currency] && !(currency === 'COP' && country === 'US')) exchange = CURRENCY_EXCHANGE[currency];
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

    const id = `${exchange}:${symbol}`;
    const known = this.byId.get(id);
    if (known) return this.existing(known);
    const created = this.created.get(id);
    if (created) return { instrument: created, isNew: true, notes: [] };
    // Same symbol already in the user's list on an exchange we only guessed → reuse it.
    if (notes.some((n) => n.code === 'EXCHANGE_GUESSED')) {
      const same = this.bySymbol.get(symbol);
      if (same && same.length === 1) return this.existing(same[0]!);
    }

    const info = EXCHANGES[exchange];
    const instCurrency = exchange === 'MANUAL' || exchange === 'CRYPTO' || !info ? currency ?? info?.currency ?? 'USD' : info.currency;
    if (currency && instCurrency !== currency) {
      notes.push({ code: 'CURRENCY_MISMATCH', params: { currency, instrumentCurrency: instCurrency } });
    }
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
    this.created.set(id, instrument);
    this.index(instrument);
    return { instrument, isNew: true, notes };
  }
}
