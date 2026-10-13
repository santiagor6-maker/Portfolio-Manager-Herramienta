import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { es } from './es';
import { esR2 } from './es.r2';

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

export type Lang = 'es' | 'pt' | 'en';

/** Spanish is bundled; Portuguese and English load on demand (W20: smaller first load). */
export const resources = {
  es: { translation: deepMerge(es as unknown as Dict, esR2 as unknown as Dict) },
};

export async function translationsFor(lng: Lang): Promise<Dict> {
  if (lng === 'pt') {
    const [{ pt }, { ptR2 }] = await Promise.all([import('./pt'), import('./pt.r2')]);
    return deepMerge(pt as unknown as Dict, ptR2 as unknown as Dict);
  }
  if (lng === 'en') {
    const [{ en }, { enR2 }] = await Promise.all([import('./en'), import('./en.r2')]);
    return deepMerge(en as unknown as Dict, enR2 as unknown as Dict);
  }
  return resources.es.translation;
}

/** Loads the language's strings if needed, then switches to it. */
export async function setLanguage(lng: string): Promise<void> {
  const l = (['es', 'pt', 'en'].includes(lng) ? lng : 'es') as Lang;
  if (!i18n.hasResourceBundle(l, 'translation')) i18n.addResourceBundle(l, 'translation', await translationsFor(l), true, true);
  await i18n.changeLanguage(l);
}

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
