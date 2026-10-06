/**
 * Fixed-income templates (CDT, CDB, LCI/LCA...) for search. They carry core's AccrualSpec so the
 * engine values them by accrual over the index series served by `/api/index`. The user clones a
 * template and fills rate, issue date and maturity.
 */
import type { Instrument } from '@pm/core';
import { normalizeText } from './text';
import type { SearchResult } from './types';

const t = (
  id: string,
  name: string,
  currency: string,
  country: string,
  accrual: NonNullable<Instrument['accrual']>,
  keywords: string,
): SearchResult & { keywords: string } => ({
  id: `TEMPLATE:${id}`,
  symbol: id,
  name,
  exchange: 'TEMPLATE',
  currency,
  country,
  assetClass: 'fixed_income',
  pricing: 'manual',
  accrual,
  origin: 'template',
  template: true,
  note: 'Plantilla: cree su propio instrumento con tasa, fecha de emisión y vencimiento.',
  keywords,
});

export const FIXED_INCOME_TEMPLATES = [
  t('CDT-FIJA', 'CDT tasa fija (E.A.)', 'COP', 'CO', { kind: 'fixed', annualRate: 0.1, dayCount: 'ACT/365' }, 'cdt tasa fija renta fija certificado deposito termino'),
  t('CDT-IBR', 'CDT indexado a IBR + spread', 'COP', 'CO', { kind: 'indexed', index: 'IBR', spread: 0.02, dayCount: 'ACT/360' }, 'cdt ibr indexado renta fija'),
  t('CDT-IPC', 'CDT indexado a IPC + spread', 'COP', 'CO', { kind: 'indexed', index: 'IPC_CO', spread: 0.04, dayCount: 'ACT/365' }, 'cdt ipc inflacion indexado renta fija'),
  t('CDT-DTF', 'CDT indexado a DTF + spread', 'COP', 'CO', { kind: 'indexed', index: 'DTF', spread: 0.02, dayCount: 'ACT/365' }, 'cdt dtf indexado renta fija'),
  t('TES-UVR', 'TES UVR (valor en UVR)', 'COP', 'CO', { kind: 'indexed', index: 'UVR', spread: 0.04, dayCount: 'ACT/365' }, 'tes uvr bono gobierno renta fija'),
  t('CDB-CDI', 'CDB % do CDI', 'BRL', 'BR', { kind: 'indexed', index: 'CDI', percentOfIndex: 1.1, dayCount: 'BUS/252' }, 'cdb cdi pos fixado renda fixa'),
  t('CDB-PRE', 'CDB prefixado', 'BRL', 'BR', { kind: 'fixed', annualRate: 0.13, dayCount: 'BUS/252' }, 'cdb prefixado pre renda fixa'),
  t('CDB-IPCA', 'CDB IPCA + spread', 'BRL', 'BR', { kind: 'indexed', index: 'IPCA', spread: 0.06, dayCount: 'BUS/252' }, 'cdb ipca inflacao renda fixa'),
  t('LCI-CDI', 'LCI % do CDI (isenta de IR)', 'BRL', 'BR', { kind: 'indexed', index: 'CDI', percentOfIndex: 0.95, dayCount: 'BUS/252' }, 'lci cdi isenta renda fixa'),
  t('LCA-CDI', 'LCA % do CDI (isenta de IR)', 'BRL', 'BR', { kind: 'indexed', index: 'CDI', percentOfIndex: 0.95, dayCount: 'BUS/252' }, 'lca cdi isenta renda fixa'),
  t('DEBENTURE-IPCA', 'Debênture IPCA + spread', 'BRL', 'BR', { kind: 'indexed', index: 'IPCA', spread: 0.07, dayCount: 'BUS/252' }, 'debenture ipca incentivada renda fixa'),
];

export function searchTemplates(query: string): SearchResult[] {
  const words = normalizeText(query).split(' ').filter(Boolean);
  if (!words.length) return [];
  return FIXED_INCOME_TEMPLATES.filter((x) => {
    const hay = normalizeText(`${x.name} ${x.keywords}`);
    return words.every((w) => hay.includes(w));
  }).map(({ keywords: _k, ...rest }) => rest);
}
