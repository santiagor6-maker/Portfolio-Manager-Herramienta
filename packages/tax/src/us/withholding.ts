import type { CountryCode, Instrument, ISODate, MarketData } from '@pm/core';
import type { ParamMeta, TaxInput } from '../common/types';
import { displaySymbol, grossAmount, instrumentMap, sortTransactions } from '../common/util';

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
 * US-source income: the issuer must be a US corporation (instrument.country === 'US') and, when an
 * ISIN is known, it must be a US ISIN. ADRs of foreign companies (country = issuer's country, even
 * though their ISIN starts with US) and UCITS ETFs domiciled in Ireland/Luxembourg (IE/LU ISIN)
 * are NOT US-source, even when listed in the US.
 */
export function isUsSource(inst: Instrument | undefined): boolean {
  if (!inst || inst.country !== 'US') return false;
  return !inst.isin || inst.isin.toUpperCase().startsWith('US');
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
    if (!isUsSource(inst)) continue;
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

/** Countries with an estate-tax treaty with the US that may raise the exemption (non-exhaustive). */
const ESTATE_TREATY: Set<CountryCode> = new Set(['AU', 'AT', 'DK', 'FI', 'FR', 'DE', 'GR', 'IE', 'IT', 'JP', 'NL', 'NO', 'ZA', 'CH', 'GB']);

export interface UsEstateTaxCheck {
  asOf: ISODate;
  /** Market value in USD of US-situs securities (shares of US corporations, US-domiciled ETFs). */
  usSitusUsd: number;
  exemptionUsd: number;
  exceeds: boolean;
  treatyCountry: boolean;
  holdings: { instrumentId: string; symbol: string; valueUsd: number }[];
  missingPrices: string[];
  note: string;
  meta: ParamMeta;
}

/**
 * US estate tax exposure of a nonresident alien: US-situs assets above US$ 60,000 are subject to
 * US estate tax (18%-40%) at death (IRC §2101-2106; Form 706-NA). Very relevant for Latin American
 * investors holding US shares/ETFs directly; Irish UCITS ETFs are not US-situs.
 */
export function checkUsEstateTaxExposure(
  input: TaxInput,
  residence: CountryCode | undefined,
  asOf: ISODate,
  market: MarketData = input.market,
): UsEstateTaxCheck {
  const instruments = instrumentMap(input.instruments);
  const qty = new Map<string, number>();
  for (const tx of sortTransactions(input.transactions)) {
    if (tx.date > asOf || !tx.instrumentId) continue;
    const q = qty.get(tx.instrumentId) ?? 0;
    if (tx.type === 'BUY' || tx.type === 'TRANSFER_IN' || tx.type === 'STOCK_DIVIDEND') qty.set(tx.instrumentId, q + (tx.quantity ?? q * (tx.ratio ?? 0)));
    else if (tx.type === 'SELL' || tx.type === 'TRANSFER_OUT') qty.set(tx.instrumentId, q - (tx.quantity ?? 0));
    else if (tx.type === 'SPLIT') qty.set(tx.instrumentId, q * (tx.ratio ?? 1));
  }
  const holdings: UsEstateTaxCheck['holdings'] = [];
  const missing: string[] = [];
  for (const [id, q] of qty) {
    const inst = instruments.get(id);
    if (q <= 1e-9 || !isUsSource(inst) || inst?.assetClass === 'bond') continue;
    const price = market.price(id, asOf);
    const fx = market.fx(inst?.currency ?? 'USD', 'USD', asOf);
    if (price === undefined || fx === undefined) {
      missing.push(id);
      continue;
    }
    holdings.push({ instrumentId: id, symbol: displaySymbol(id, inst), valueUsd: (q * price * fx) / (inst?.priceMultiplier ?? 1) });
  }
  const usSitusUsd = holdings.reduce((a, h) => a + h.valueUsd, 0);
  const exemptionUsd = 60_000;
  const treaty = !!residence && ESTATE_TREATY.has(residence);
  return {
    asOf,
    usSitusUsd,
    exemptionUsd,
    exceeds: usSitusUsd > exemptionUsd,
    treatyCountry: treaty,
    holdings,
    missingPrices: missing,
    note:
      'Não residentes nos EUA: ações de empresas americanas e ETFs domiciliados nos EUA são bens "US-situs"; acima de US$ 60 mil ' +
      'podem pagar imposto sobre herança nos EUA (18%-40%). Colômbia e Brasil não têm tratado sobre herança com os EUA. ' +
      'Alternativas comuns: ETFs UCITS domiciliados na Irlanda. Consulte um especialista. / Para no residentes: acciones de ' +
      'empresas de EE.UU. y ETFs domiciliados allí son activos "US-situs"; por encima de US$ 60.000 pueden causar impuesto de sucesiones.',
    meta: { status: 'verified', source: 'IRC §2101-2106; exención de US$ 60.000 para no residentes (§2102(b))', checkedOn: '2026-10-05' },
  };
}
