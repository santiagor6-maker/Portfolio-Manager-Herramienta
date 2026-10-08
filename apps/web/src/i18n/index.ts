import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { es } from './es';
import { pt } from './pt';
import { en } from './en';
import { esR2 } from './es.r2';
import { ptR2 } from './pt.r2';
import { enR2 } from './en.r2';

type Dict = { [k: string]: string | Dict };

/** Deep merge (b wins). Round-2 strings live in *.r2.ts and override/extend the base files. */
export function deepMerge(a: Dict, b: Dict): Dict {
  const out: Dict = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const prev = out[k];
    out[k] = typeof v === 'object' && typeof prev === 'object' ? deepMerge(prev, v) : v;
  }
  return out;
}

export const resources = {
  es: { translation: deepMerge(es as unknown as Dict, esR2 as unknown as Dict) },
  pt: { translation: deepMerge(pt as unknown as Dict, ptR2 as unknown as Dict) },
  en: { translation: deepMerge(en as unknown as Dict, enR2 as unknown as Dict) },
};

void i18n.use(initReactI18next).init({
  resources,
  lng: 'es',
  fallbackLng: 'es',
  interpolation: { escapeValue: false },
  returnNull: false,
  // Resources are bundled: never suspend (a suspension would remount the whole layout).
  react: { useSuspense: false },
});

export default i18n;
