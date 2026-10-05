import type { CountryCode, ISODate } from '@pm/core';
import type { ParamMeta, TaxInput } from '../common/types';
import { displaySymbol, grossAmount, instrumentMap } from '../common/util';

/** Statutory US withholding on US-source FDAP dividends paid to nonresident aliens (IRC §1441, §871(a)). */
export const US_NRA_DEFAULT_DIVIDEND_RATE = 0.3;

export interface TreatyRate {
  /** Portfolio dividend rate for individuals under the income tax treaty. */
  rate: number;
  treaty: boolean;
  note?: string;
  meta: ParamMeta;
}

const IRS: ParamMeta = {
  status: 'needs-verification',
  source: 'IRS Publication 515 / Tax Treaty Table 1 (dividends, individuals); revisar anualmente',
  checkedOn: '2026-10-05',
};
const t = (rate: number, note?: string): TreatyRate => ({ rate, treaty: true, note, meta: IRS });
const none = (note?: string): TreatyRate => ({ rate: 0.3, treaty: false, note: note ?? 'Sin tratado: 30%', meta: IRS });

/**
 * Residence country of the beneficial owner -> treaty rate for ordinary portfolio dividends.
 * Requires a valid W-8BEN on file at the broker; otherwise 30% applies anyway.
 */
export const US_TREATY_DIVIDEND_RATES: Record<CountryCode, TreatyRate> = {
  BR: none('Brasil no tiene tratado de renta con EE.UU.'),
  CO: none('Colombia no tiene tratado de renta con EE.UU.'),
  AR: none(),
  PE: none(),
  UY: none(),
  CL: t(0.15, 'Tratado EE.UU.-Chile vigente desde 2024 (verificar fecha de efectos)'),
  MX: t(0.1),
  VE: t(0.15),
  CA: t(0.15),
  ES: t(0.15),
  PT: t(0.15),
  FR: t(0.15),
  DE: t(0.15),
  IT: t(0.15),
  NL: t(0.15),
  BE: t(0.15),
  IE: t(0.15),
  GB: t(0.15),
  CH: t(0.15),
  AT: t(0.15),
  LU: t(0.15),
  JP: t(0.1),
  AU: t(0.15),
  CN: t(0.1),
  IN: t(0.25),
};

export function expectedUsDividendWithholding(residence: CountryCode | undefined): TreatyRate {
  if (!residence) return none('Residencia desconocida: 30%');
  return US_TREATY_DIVIDEND_RATES[residence] ?? none('País sin entrada en la tabla: se asume 30%');
}

export interface UsWithholdingCheckRow {
  transactionId: string;
  date: ISODate;
  instrumentId?: string;
  symbol?: string;
  gross: number;
  withheld: number;
  actualRate: number;
  expectedRate: number;
  status: 'ok' | 'over_withheld' | 'under_withheld' | 'missing_withholding';
  note?: string;
}

/**
 * Sanity-check imported dividends of US-source instruments (instrument.country === 'US') against
 * the expected nonresident withholding. Flags over-withholding (e.g. missing W-8BEN for a treaty
 * country) and rows without withholding (often a broker export that nets taxes).
 * Not covered: REIT capital-gain distributions, ETF interest-related/short-term gain dividends
 * (§871(k)), return of capital — those may legitimately differ.
 */
export function checkUsDividendWithholding(
  input: Pick<TaxInput, 'transactions' | 'instruments'>,
  residence: CountryCode | undefined,
  opts: { tolerance?: number; from?: ISODate; to?: ISODate } = {},
): UsWithholdingCheckRow[] {
  const tol = opts.tolerance ?? 0.01;
  const expected = expectedUsDividendWithholding(residence);
  const instruments = instrumentMap(input.instruments);
  const rows: UsWithholdingCheckRow[] = [];
  for (const tx of input.transactions) {
    if (tx.type !== 'DIVIDEND' || !tx.instrumentId) continue;
    if ((opts.from && tx.date < opts.from) || (opts.to && tx.date > opts.to)) continue;
    const inst = instruments.get(tx.instrumentId);
    if (inst?.country !== 'US') continue;
    const gross = grossAmount(tx);
    if (gross <= 0) continue;
    const withheld = tx.taxes ?? 0;
    const actualRate = withheld / gross;
    let status: UsWithholdingCheckRow['status'] = 'ok';
    if (withheld === 0) status = 'missing_withholding';
    else if (actualRate > expected.rate + tol) status = 'over_withheld';
    else if (actualRate < expected.rate - tol) status = 'under_withheld';
    rows.push({
      transactionId: tx.id,
      date: tx.date,
      instrumentId: tx.instrumentId,
      symbol: displaySymbol(tx.instrumentId, inst),
      gross,
      withheld,
      actualRate,
      expectedRate: expected.rate,
      status,
      note:
        status === 'over_withheld' && expected.treaty
          ? 'Retención mayor a la tarifa del tratado: revise el W-8BEN en su bróker; puede solicitar reembolso (Form 1040-NR).'
          : status === 'missing_withholding'
            ? 'Sin retención registrada: ¿el archivo trae el dividendo neto? Registre bruto y retención por separado.'
            : expected.note,
    });
  }
  return rows;
}
