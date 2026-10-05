import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import { es } from './es';
import { pt } from './pt';
import { en } from './en';

export const resources = {
  es: { translation: es },
  pt: { translation: pt },
  en: { translation: en },
} as const;

void i18n.use(initReactI18next).init({
  resources,
  lng: 'es',
  fallbackLng: 'es',
  interpolation: { escapeValue: false },
  returnNull: false,
});

export default i18n;
