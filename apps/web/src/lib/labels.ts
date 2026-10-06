import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import type { AllocationDimension, AllocationSlice } from '@pm/core';
import { useFmt } from '../store/app';

const regionCache = new Map<string, Intl.DisplayNames>();

export function countryName(code: string, locale: string): string {
  if (!code) return '—';
  if (code === 'EU') return locale.startsWith('en') ? 'Eurozone' : locale.startsWith('pt') ? 'Zona do euro' : 'Zona euro';
  try {
    let dn = regionCache.get(locale);
    if (!dn) {
      dn = new Intl.DisplayNames([locale], { type: 'region' });
      regionCache.set(locale, dn);
    }
    return dn.of(code.toUpperCase()) ?? code;
  } catch {
    return code;
  }
}

export function flagEmoji(country: string): string {
  if (!/^[A-Z]{2}$/i.test(country)) return '';
  if (country.toUpperCase() === 'EU') return '🇪🇺';
  return String.fromCodePoint(...[...country.toUpperCase()].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

/** Human label for an allocation slice according to its dimension. */
export function useSliceLabel(dim: AllocationDimension): (s: AllocationSlice) => string {
  const { t } = useTranslation();
  const { locale } = useFmt();
  return useCallback(
    (s: AllocationSlice) => {
      if (s.key === '__other') return s.label;
      switch (dim) {
        case 'country':
          return countryName(s.key, locale);
        case 'assetClass':
          return t(`assetClass.${s.key}`, { defaultValue: s.label });
        case 'currency':
          return s.key === 'CASH' ? t('common.cash') : s.key;
        case 'sector':
        case 'account':
          return s.key === '' || s.key === 'unknown' || s.label === '' ? t('common.unassigned') : s.label;
        default:
          return s.label;
      }
    },
    [dim, locale, t],
  );
}

export { indexName } from './indexNames';
