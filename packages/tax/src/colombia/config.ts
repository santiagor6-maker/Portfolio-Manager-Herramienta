import type { ParamMeta } from '../common/types';

/**
 * Colombian parameters for a "persona natural residente fiscal", per tax year (año gravable).
 * Every value is dated and carries provenance so it can be updated without touching the engine.
 */
export interface ColombiaTaxYearConfig {
  year: number;
  /** Unidad de Valor Tributario in COP (Art. 868 ET), fixed yearly by DIAN resolution. */
  uvt: number;
  /** Ganancia ocasional rate for individuals (Art. 314 ET). */
  gananciaOcasionalRate: number;
  /** Minimum holding period (years) for a sale of an "activo fijo" to be ganancia ocasional (Art. 300 ET). */
  gananciaOcasionalMinYears: number;
  /**
   * Art. 36-1 ET: gains on shares listed on a Colombian exchange are not income / ganancia
   * ocasional if the beneficial owner sells at most this share of the company's outstanding
   * shares in the same tax year.
   */
  art361MaxShareOfOutstanding: number;
  /** Art. 607 ET: Formulario 160 (activos en el exterior) when foreign assets > this many UVT at 1-Jan. */
  foreignAssetsDeclarationUvt: number;
  /** Art. 607 par. 2 ET: above this, assets abroad must be itemized (otherwise aggregated by country). */
  foreignAssetsItemizedUvt: number;
  /** Arts. 592-594-3 ET: must file income tax if patrimonio bruto at Dec 31 exceeds this many UVT. */
  filingPatrimonioUvt: number;
  /** Arts. 592-594-3 ET: must file if gross income in the year is >= this many UVT. */
  filingIngresosUvt: number;
  /** Art. 242 ET + DUR 1625/2016 art. 1.2.4.7.1: withholding on national dividends to residents. */
  dividendWithholding: { exemptUpToUvt: number; rate: number };
  /** Art. 254-1 ET (Ley 2277/2022): tax discount on national dividends above the threshold. */
  dividendDiscount?: { rate: number; fromUvt: number };
  /**
   * Arts. 38-41 ET: share of interest paid by Colombian financial entities that is "componente
   * inflacionario" (ingreso no constitutivo de renta), fixed yearly by decree. Undefined = not applied.
   */
  componenteInflacionario?: number;
  /** Gravamen a los Movimientos Financieros (Art. 871-872 ET). */
  gmfRate: number;
  /** Art. 879 num. 1 ET: monthly exempt withdrawals from one designated savings account. */
  gmfExemptMonthlyUvt: number;
  meta: Record<string, ParamMeta>;
}

const DIAN_UVT = (res: string): ParamMeta => ({
  status: 'verified',
  source: `DIAN, ${res}`,
  checkedOn: '2026-10-05',
});

const LEY_2277: ParamMeta = {
  status: 'verified',
  source: 'Ley 2277 de 2022 (arts. 2, 3, 5, 31 y 32); vigente desde el año gravable 2023',
  checkedOn: '2026-10-05',
  note:
    'La "ley de financiamiento" 2025 fue negada en el Congreso (9-dic-2025) y el Decreto 1474/2025 de ' +
    'emergencia quedó sin efectos (Sentencia C-075/2026, que declaró inexequible el Decreto 1390/2025).',
};

const BASE_META: Record<string, ParamMeta> = {
  foreignAssetsDeclarationUvt: { status: 'verified', source: 'Art. 607 ET (Formulario 160)' },
  foreignAssetsItemizedUvt: { status: 'verified', source: 'Art. 607 par. 2 ET' },
  filingPatrimonioUvt: { status: 'verified', source: 'Arts. 592, 593 y 594-3 ET' },
  filingIngresosUvt: { status: 'verified', source: 'Arts. 592, 593 y 594-3 ET' },
  gananciaOcasionalMinYears: { status: 'verified', source: 'Art. 300 ET' },
  gmfRate: { status: 'verified', source: 'Art. 872 ET' },
  gmfExemptMonthlyUvt: { status: 'verified', source: 'Art. 879 num. 1 ET' },
  dividendWithholding: {
    status: 'verified',
    source: 'Art. 242 ET; DUR 1625/2016 art. 1.2.4.7.1 (0% hasta 1.090 UVT, 15% sobre el exceso)',
  },
};

function cfg(c: Omit<ColombiaTaxYearConfig, 'meta'> & { meta: Record<string, ParamMeta> }): ColombiaTaxYearConfig {
  return { ...c, meta: { ...BASE_META, ...c.meta } };
}

const COMMON = {
  gananciaOcasionalMinYears: 2,
  foreignAssetsDeclarationUvt: 2000,
  foreignAssetsItemizedUvt: 3580,
  filingPatrimonioUvt: 4500,
  filingIngresosUvt: 1400,
  dividendWithholding: { exemptUpToUvt: 1090, rate: 0.15 },
  gmfRate: 0.004,
  gmfExemptMonthlyUvt: 350,
};

export const COLOMBIA_TAX_YEARS: Record<number, ColombiaTaxYearConfig> = {
  2022: cfg({
    ...COMMON,
    year: 2022,
    uvt: 38_004,
    gananciaOcasionalRate: 0.1,
    art361MaxShareOfOutstanding: 0.1,
    dividendDiscount: undefined,
    meta: {
      uvt: DIAN_UVT('Resolución 000140 de 2021'),
      gananciaOcasionalRate: { status: 'verified', source: 'Art. 314 ET antes de Ley 2277/2022' },
      art361MaxShareOfOutstanding: { status: 'verified', source: 'Art. 36-1 ET antes de Ley 2277/2022 (10%)' },
    },
  }),
  2023: cfg({
    ...COMMON,
    year: 2023,
    uvt: 42_412,
    gananciaOcasionalRate: 0.15,
    art361MaxShareOfOutstanding: 0.03,
    dividendDiscount: { rate: 0.19, fromUvt: 1090 },
    componenteInflacionario: 0.6671,
    meta: {
      uvt: DIAN_UVT('Resolución 001264 de 2022'),
      componenteInflacionario: { status: 'verified', source: 'Decreto anual (AG 2023: 66,71% de los rendimientos financieros)', checkedOn: '2026-10-06', note: 'Verificado en fuentes secundarias.' },
      gananciaOcasionalRate: LEY_2277,
      art361MaxShareOfOutstanding: { ...LEY_2277, source: 'Art. 36-1 ET modificado por Ley 2277/2022 (3%)' },
      dividendDiscount: { ...LEY_2277, source: 'Art. 254-1 ET (Ley 2277/2022)' },
    },
  }),
  2024: cfg({
    ...COMMON,
    year: 2024,
    uvt: 47_065,
    gananciaOcasionalRate: 0.15,
    art361MaxShareOfOutstanding: 0.03,
    dividendDiscount: { rate: 0.19, fromUvt: 1090 },
    componenteInflacionario: 0.5088,
    meta: {
      uvt: DIAN_UVT('Resolución 000187 de 2023'),
      componenteInflacionario: { status: 'verified', source: 'Decreto 771 de 2025 (AG 2024: 50,88%)', checkedOn: '2026-10-06', note: 'Verificado en fuentes secundarias.' },
      gananciaOcasionalRate: LEY_2277,
      art361MaxShareOfOutstanding: { ...LEY_2277, source: 'Art. 36-1 ET modificado por Ley 2277/2022 (3%)' },
      dividendDiscount: { ...LEY_2277, source: 'Art. 254-1 ET (Ley 2277/2022)' },
    },
  }),
  2025: cfg({
    ...COMMON,
    year: 2025,
    uvt: 49_799,
    gananciaOcasionalRate: 0.15,
    art361MaxShareOfOutstanding: 0.03,
    dividendDiscount: { rate: 0.19, fromUvt: 1090 },
    componenteInflacionario: 0.5543,
    meta: {
      uvt: DIAN_UVT('Resolución 000193 de 2024'),
      componenteInflacionario: { status: 'verified', source: 'Decreto 898 de 2026 (AG 2025: 55,43%)', checkedOn: '2026-10-06', note: 'Verificado en fuentes secundarias.' },
      gananciaOcasionalRate: LEY_2277,
      art361MaxShareOfOutstanding: { ...LEY_2277, source: 'Art. 36-1 ET modificado por Ley 2277/2022 (3%)' },
      dividendDiscount: { ...LEY_2277, source: 'Art. 254-1 ET (Ley 2277/2022)' },
    },
  }),
  2026: cfg({
    ...COMMON,
    year: 2026,
    uvt: 52_374,
    gananciaOcasionalRate: 0.15,
    art361MaxShareOfOutstanding: 0.03,
    dividendDiscount: { rate: 0.19, fromUvt: 1090 },
    meta: {
      uvt: DIAN_UVT('Resolución 000238 del 15-dic-2025'),
      gananciaOcasionalRate: {
        status: 'needs-verification',
        source: 'Art. 314 ET (Ley 2277/2022)',
        checkedOn: '2026-10-05',
        note:
          'El Gobierno radicó un proyecto de reforma tributaria el 20-jul-2026 que propone, entre otros, ' +
          'exigir 4 años (no 2) de tenencia para ganancia ocasional. Revisar si fue aprobado y su vigencia.',
      },
      gananciaOcasionalMinYears: {
        status: 'needs-verification',
        source: 'Art. 300 ET',
        note: 'Proyecto de reforma 2026 propone 4 años. Verificar.',
      },
      art361MaxShareOfOutstanding: { ...LEY_2277, source: 'Art. 36-1 ET modificado por Ley 2277/2022 (3%)' },
      dividendDiscount: { ...LEY_2277, source: 'Art. 254-1 ET (Ley 2277/2022)' },
    },
  }),
};

export function colombiaConfig(year: number): ColombiaTaxYearConfig {
  const c = COLOMBIA_TAX_YEARS[year];
  if (c) return c;
  const years = Object.keys(COLOMBIA_TAX_YEARS).map(Number).sort((a, b) => a - b);
  const latest = years[years.length - 1] ?? 2026;
  const base = COLOMBIA_TAX_YEARS[year > latest ? latest : (years[0] ?? latest)]!;
  const meta: Record<string, ParamMeta> = {};
  for (const k of Object.keys(base.meta)) {
    meta[k] = { status: 'needs-verification', source: `Copiado del año ${base.year}; sin parámetros para ${year}` };
  }
  return { ...base, year, meta };
}

/**
 * Art. 241 ET marginal table for the cédula general of resident individuals (in UVT), in force
 * since Ley 2010/2019 and kept by Ley 2277/2022 (which also routes dividends through it).
 * [from UVT, rate, base tax in UVT at `from`]
 */
export const ART_241_TABLE: { fromUvt: number; rate: number; baseUvt: number }[] = [
  { fromUvt: 0, rate: 0, baseUvt: 0 },
  { fromUvt: 1090, rate: 0.19, baseUvt: 0 },
  { fromUvt: 1700, rate: 0.28, baseUvt: 116 },
  { fromUvt: 4100, rate: 0.33, baseUvt: 788 },
  { fromUvt: 8670, rate: 0.35, baseUvt: 2296 },
  { fromUvt: 18970, rate: 0.37, baseUvt: 5901 },
  { fromUvt: 31000, rate: 0.39, baseUvt: 10352 },
];

export const ART_241_META: ParamMeta = {
  status: 'verified',
  source: 'Art. 241 ET (Ley 2010/2019, Ley 2277/2022 art. 2)',
  checkedOn: '2026-10-05',
};

/** Income tax (COP) of the cédula general per Art. 241 ET for a taxable base in COP. */
export function art241TaxCop(baseCop: number, uvt: number): { taxCop: number; marginalRate: number } {
  const baseUvt = Math.max(0, baseCop) / uvt;
  let row = ART_241_TABLE[0]!;
  for (const r of ART_241_TABLE) if (baseUvt > r.fromUvt) row = r;
  return { taxCop: (row.baseUvt + (baseUvt - row.fromUvt) * row.rate) * uvt, marginalRate: row.rate };
}
