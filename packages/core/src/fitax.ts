/**
 * Taxes on fixed-income yield (C31), used for the net ("líquido") value of holdings and for the
 * estimated withholding of automatic redemptions at maturity (C24).
 *
 * BR_IR_REGRESSIVE (CDB, Tesouro Direto, debêntures comuns; residents of Brazil):
 *   IOF on the yield for redemptions within 30 days (regressive table 96 % ... 3 %), then
 *   IR on (yield - IOF): 22.5 % up to 180 days, 20 % up to 360, 17.5 % up to 720, 15 % after.
 * CO_RETENCION (CDT and other financial yields; residents of Colombia): withholding of 4 %
 *   (configurable with accrual.withholdingRate) on the interest earned.
 * EXEMPT (LCI, LCA, CRI, CRA, debêntures incentivadas, ...) and NONE: no tax.
 * The default regime follows the instrument's jurisdiction (withholding is applied at source by
 * the paying bank/issuer): BRL / country BR -> BR_IR_REGRESSIVE, COP / country CO -> CO_RETENCION.
 * It never depends on the reporting currency or a view's portfolio. Set `accrual.taxRegime` to
 * override (e.g. EXEMPT for LCI/LCA). These are estimates for display; the tax package computes
 * the official figures.
 */
import type { AccrualSpec, Instrument } from './types';

export type FixedIncomeTaxRegime = NonNullable<AccrualSpec['taxRegime']>;

export const IOF_TABLE = [96, 93, 90, 86, 83, 80, 76, 73, 70, 66, 63, 60, 56, 53, 50, 46, 43, 40, 36, 33, 30, 26, 23, 20, 16, 13, 10, 6, 3];

export function taxRegimeFor(inst: Instrument, _residence?: string): FixedIncomeTaxRegime {
  const spec = inst.accrual;
  if (!spec) return 'NONE';
  if (spec.taxRegime) return spec.taxRegime;
  if (inst.currency === 'BRL' || inst.country === 'BR') return 'BR_IR_REGRESSIVE';
  if (inst.currency === 'COP' || inst.country === 'CO') return 'CO_RETENCION';
  return 'NONE';
}

export function irRate(holdingDays: number): number {
  if (holdingDays <= 180) return 0.225;
  if (holdingDays <= 360) return 0.2;
  if (holdingDays <= 720) return 0.175;
  return 0.15;
}

export function iofRate(holdingDays: number): number {
  if (holdingDays >= 30) return 0;
  return (IOF_TABLE[Math.max(1, holdingDays) - 1] as number) / 100;
}

/** Tax due on a yield (instrument currency). Losses pay nothing. */
export function fixedIncomeTax(regime: FixedIncomeTaxRegime, holdingDays: number, gain: number, spec?: AccrualSpec): { iof: number; ir: number; total: number } {
  if (!(gain > 0)) return { iof: 0, ir: 0, total: 0 };
  switch (regime) {
    case 'BR_IR_REGRESSIVE': {
      const iof = gain * iofRate(holdingDays);
      const ir = (gain - iof) * irRate(holdingDays);
      return { iof, ir, total: iof + ir };
    }
    case 'CO_RETENCION': {
      const ir = gain * (spec?.withholdingRate ?? 0.04);
      return { iof: 0, ir, total: ir };
    }
    default:
      return { iof: 0, ir: 0, total: 0 };
  }
}

/** Tax residence: explicit, else inferred from the portfolio base currency. */
export function residenceOf(taxResidence: string | undefined, portfolioBase: string): string | undefined {
  return taxResidence ?? (portfolioBase === 'BRL' ? 'BR' : portfolioBase === 'COP' ? 'CO' : undefined);
}
