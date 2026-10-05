import type { Instrument } from '@pm/core';

/**
 * Tax categories for a Brazilian resident:
 * - ACAO: shares listed on B3 (eligible for the R$ 20k monthly exemption, swing trade 15%).
 * - ETF: B3-listed equity ETFs (15%, no exemption).
 * - BDR: B3-listed BDRs (15%, no exemption).
 * - FII: real-estate funds (20%, no exemption, separate loss pool).
 * - FOREIGN: securities held abroad (Lei 14.754/2023 annual regime).
 * - OTHER: anything else (fixed income, crypto...), not handled by the monthly apuração.
 */
export type BrCategory = 'ACAO' | 'ETF' | 'BDR' | 'FII' | 'FOREIGN' | 'OTHER';

const BDR_SUFFIX = /(3[2345]|39)$/;

export function classifyForBrazil(inst: Instrument | undefined, overrides?: Record<string, BrCategory>): BrCategory {
  if (!inst) return 'OTHER';
  const o = overrides?.[inst.id];
  if (o) return o;
  if (inst.exchange === 'BVMF') {
    if (inst.assetClass === 'reit') return 'FII';
    if (inst.assetClass === 'etf') return 'ETF';
    if (inst.assetClass === 'equity') {
      return inst.country !== 'BR' || BDR_SUFFIX.test(inst.symbol) ? 'BDR' : 'ACAO';
    }
    return 'OTHER';
  }
  if (inst.country === 'BR' && inst.currency === 'BRL') return 'OTHER';
  if (['equity', 'etf', 'reit', 'fund', 'bond'].includes(inst.assetClass)) return 'FOREIGN';
  return 'OTHER';
}

export const isB3Category = (c: BrCategory): c is 'ACAO' | 'ETF' | 'BDR' | 'FII' =>
  c === 'ACAO' || c === 'ETF' || c === 'BDR' || c === 'FII';
