import type { LocalizedText } from './types';

/** Shown on every tax report. The engine is informational; it is not tax advice. */
export const TAX_DISCLAIMER: LocalizedText = {
  es:
    'Información de carácter informativo y educativo; no constituye asesoría tributaria, contable ni legal. ' +
    'Los cálculos dependen de la calidad de los movimientos registrados y de parámetros legales (tarifas, UVT, ' +
    'umbrales) que cambian cada año y pueden haber sido modificados. Verifique siempre con un contador público ' +
    'o asesor tributario antes de declarar o pagar impuestos.',
  pt:
    'Informação de caráter informativo e educativo; não constitui consultoria tributária, contábil ou jurídica. ' +
    'Os cálculos dependem da qualidade das operações registradas e de parâmetros legais (alíquotas, limites, ' +
    'códigos) que mudam a cada ano e podem ter sido alterados. Confira sempre com um contador ou assessor ' +
    'tributário antes de declarar ou recolher impostos.',
  en:
    'Informational and educational only; this is not tax, accounting or legal advice. Results depend on the ' +
    'recorded transactions and on legal parameters (rates, thresholds, units) that change every year and may ' +
    'have been amended. Always check with a qualified accountant or tax adviser before filing or paying taxes.',
};
