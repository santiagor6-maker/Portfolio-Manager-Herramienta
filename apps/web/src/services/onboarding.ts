import { db } from '../db/schema';
import { createPortfolio, getMeta, loadSettings, removeDemoData, seedData, setMeta, type AppSettings } from '../db/repo';
import { useApp } from '../store/app';
import { loadDemoData } from './demo';
import i18n from '../i18n';

/**
 * First run: seed the sample portfolio so the app opens in a working state.
 * Returns the loaded settings.
 */
export async function bootstrap(): Promise<AppSettings> {
  const settings = await loadSettings();
  const seeded = await getMeta<boolean>('demoSeeded');
  if (!seeded && (await db.portfolios.count()) === 0) {
    await seedDemo();
  }
  return settings;
}

export async function seedDemo(): Promise<'core' | 'fallback'> {
  const { data, source } = loadDemoData();
  await seedData(data, true);
  await setMeta('demoSeeded', true);
  await setMeta('demoSource', source);
  return source;
}

/** Removes the sample data and creates an empty portfolio the user can fill. */
export async function startEmptyPortfolio(name?: string): Promise<string> {
  await removeDemoData();
  const { settings, setSetting } = useApp.getState();
  const existing = await db.portfolios.toArray();
  let id = existing[0]?.id;
  if (!id) {
    const p = await createPortfolio({
      name: name ?? i18n.t('portfolio.defaultName'),
      baseCurrency: settings.reportingCurrency,
      costMethod: settings.defaultCostMethod,
      taxResidence: settings.reportingCurrency === 'BRL' ? 'BR' : 'CO',
    });
    id = p.id;
  }
  setSetting('selectedPortfolioId', id);
  return id;
}

/** Ensures there is at least one non-demo portfolio to write into (forms, importer). */
export async function ensureWritablePortfolio(): Promise<string> {
  const { settings } = useApp.getState();
  const list = await db.portfolios.toArray();
  const selected = list.find((p) => p.id === settings.selectedPortfolioId);
  if (selected) return selected.id;
  const real = list.find((p) => !p.isDemo);
  if (real) return real.id;
  if (list[0]) return list[0].id;
  const p = await createPortfolio({
    name: i18n.t('portfolio.defaultName'),
    baseCurrency: settings.reportingCurrency,
    costMethod: settings.defaultCostMethod,
  });
  return p.id;
}
