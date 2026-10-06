/**
 * Curated instrument catalog (src/catalog/instruments.json): most traded instruments in Colombia
 * (BVC), Brazil (B3: Ibovespa leaders, FIIs, ETFs), the US and Europe, plus benchmarks.
 * Every Yahoo symbol was validated against the live API on 2026-10-05; ISINs only where known
 * with confidence. Generated/maintained by hand (see README).
 */
import type { Instrument } from '@pm/core';
import catalogJson from './catalog/instruments.json';
import { normalizeText } from './text';
import type { Benchmark, Catalog, SearchResult } from './types';

export const CATALOG: Catalog = catalogJson as Catalog;

export { normalizeText };

export class InstrumentCatalog {
  private readonly byId = new Map<string, Instrument>();
  private readonly byYahoo = new Map<string, Instrument>();
  private readonly byIsin = new Map<string, Instrument[]>();
  private readonly index: { inst: Instrument; symbol: string; name: string }[];

  constructor(readonly data: Catalog = CATALOG) {
    for (const inst of data.instruments) {
      this.byId.set(inst.id.toUpperCase(), inst);
      const y = inst.providerSymbols?.yahoo;
      if (y) this.byYahoo.set(y.toUpperCase(), inst);
      if (inst.isin) this.byIsin.set(inst.isin, [...(this.byIsin.get(inst.isin) ?? []), inst]);
    }
    this.index = data.instruments.map((inst) => ({
      inst,
      symbol: normalizeText(inst.symbol),
      name: normalizeText(inst.name),
    }));
  }

  get instruments(): Instrument[] {
    return this.data.instruments;
  }

  get benchmarks(): Benchmark[] {
    return this.data.benchmarks;
  }

  get(id: string): Instrument | undefined {
    return this.byId.get(id.toUpperCase());
  }

  byYahooSymbol(symbol: string): Instrument | undefined {
    return this.byYahoo.get(symbol.toUpperCase());
  }

  byIsinCode(isin: string): Instrument[] {
    return this.byIsin.get(isin.toUpperCase()) ?? [];
  }

  /** Resolve an id, a Yahoo symbol, an ISIN or a benchmark id. */
  resolve(key: string): Instrument | undefined {
    const bench = this.data.benchmarks.find((b) => b.id.toUpperCase() === key.toUpperCase());
    if (bench) return this.get(bench.instrumentId);
    return this.get(key) ?? this.byYahooSymbol(key) ?? this.byIsinCode(key)[0];
  }

  /** Ranked local search (symbol exact > symbol prefix > ISIN > name word prefix > substring). */
  search(query: string, limit = 20): SearchResult[] {
    const q = normalizeText(query);
    if (!q) return [];
    const isinQ = query.trim().toUpperCase();
    const scored: { inst: Instrument; score: number }[] = [];
    for (const { inst, symbol, name } of this.index) {
      let score = 0;
      if (symbol === q || normalizeText(inst.providerSymbols?.yahoo ?? '') === q) score = 100;
      else if (symbol.startsWith(q)) score = 80 - Math.min(20, symbol.length - q.length);
      else if (inst.isin === isinQ) score = 90;
      else if (name.split(' ').some((w) => w.startsWith(q))) score = 60;
      // Substring matches only for longer queries ('isa' must not match 'Visa').
      else if (q.length >= 5 && name.includes(q)) score = 40;
      else if (q.includes(' ') && q.split(' ').every((part) => name.includes(part))) score = 35;
      if (score > 0) scored.push({ inst, score });
    }
    return scored
      .sort((a, b) => b.score - a.score || a.inst.symbol.localeCompare(b.inst.symbol))
      .slice(0, limit)
      .map(({ inst }) => ({ ...inst, origin: 'catalog' as const }));
  }
}
