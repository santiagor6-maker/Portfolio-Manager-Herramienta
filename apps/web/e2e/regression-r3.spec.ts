/** Regression tests for the round-3 web review (reviews/web-r3.md). PDF/.eml (W30): pdf-import.spec.ts. */
import { expect, test } from '@playwright/test';

async function demoSeries(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate(async () => {
    const req = indexedDB.open('portafolio-pro');
    const db: IDBDatabase = await new Promise((r) => (req.onsuccess = () => r(req.result)));
    const count = (store: string) =>
      new Promise<number>((r) => {
        const q = db.transaction(store).objectStore(store).getAll();
        q.onsuccess = () => r((q.result as { isDemo?: boolean }[]).filter((x) => x.isDemo).length);
      });
    return (await count('priceSeries')) + (await count('fxSeries')) + (await count('indexSeries'));
  });
}

test('W31: leaving the sample removes its synthetic prices, FX and indices', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('kpis').locator('.skeleton')).toHaveCount(0, { timeout: 30_000 });
  await expect.poll(() => demoSeries(page)).toBeGreaterThan(0);
  await page.getByTestId('start-portfolio').click();
  const wizard = page.getByRole('dialog', { name: 'Empieza tu portafolio' });
  await wizard.getByTestId('onboarding-create').click();
  await expect.poll(() => demoSeries(page)).toBe(0);
});

test.describe('W35: browser language', () => {
  test.use({ locale: 'pt-BR' });
  test('a pt-BR browser opens the app in Portuguese', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('lang', 'pt');
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Resumo');
  });
});
