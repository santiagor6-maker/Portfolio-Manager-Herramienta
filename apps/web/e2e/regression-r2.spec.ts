/**
 * Regression tests for the round-2 web review (reviews/web-r2.md): W21 (first buy from the wizard
 * must not create a second portfolio) and W22 (dated initial deposit, implicit-funding warning).
 */
import { expect, test, type Page } from '@playwright/test';

const SHOTS = 'e2e/screenshots';

async function realPortfolios(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const req = indexedDB.open('portafolio-pro');
    const db: IDBDatabase = await new Promise((r) => (req.onsuccess = () => r(req.result)));
    const all: { name: string; isDemo?: boolean }[] = await new Promise((r) => {
      const q = db.transaction('portfolios').objectStore('portfolios').getAll();
      q.onsuccess = () => r(q.result);
    });
    return all.filter((p) => !p.isDemo).map((p) => p.name);
  });
}

async function onboard(page: Page, deposit: string, date: string) {
  await page.goto('/');
  await page.getByTestId('start-portfolio').click();
  const wizard = page.getByRole('dialog', { name: 'Empieza tu portafolio' });
  await wizard.getByLabel('Nombre').fill('Carteira BR');
  await wizard.getByLabel('Moneda base').selectOption('BRL');
  await wizard.getByTestId('onboarding-create').click();
  await wizard.getByLabel(/Aporte inicial/).fill(deposit);
  await wizard.getByLabel('¿Desde cuándo inviertes?').fill(date);
  await page.screenshot({ path: `${SHOTS}/onboarding-deposit-date.png` });
  await wizard.getByRole('button', { name: 'Siguiente' }).click();
}

async function buyMsft(page: Page, date: string) {
  const dialog = page.getByRole('dialog', { name: 'Nuevo movimiento' });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('Fecha').fill(date);
  const input = page.locator('#f-instrument');
  await expect(async () => {
    await input.click();
    await input.fill('MSFT');
    await expect(page.getByRole('option', { name: /MSFT/ }).first()).toBeVisible({ timeout: 3000 });
  }).toPass();
  await page.getByRole('option', { name: /MSFT/ }).first().click();
  await dialog.getByLabel('Cantidad').fill('2');
  await dialog.getByLabel('Precio').fill('400');
  return dialog;
}

test('W21: "Registrar una compra" after the wizard goes into the portfolio just created', async ({ page }) => {
  await onboard(page, '50.000', '2026-01-05');
  await page.getByRole('button', { name: /Registrar una compra/ }).click();
  await expect(page).toHaveURL(/movimientos\?nuevo=1/);
  const dialog = await buyMsft(page, '2026-02-10');
  await expect(dialog.locator('#f-portfolio option:checked')).toHaveText('Carteira BR');
  await dialog.getByTestId('tx-save').click();
  await expect(dialog).toBeHidden();
  expect(await realPortfolios(page)).toEqual(['Carteira BR']);
});

test('W21: a cold deep link to /movimientos?nuevo=1 never preselects "Nuevo portafolio"', async ({ page }) => {
  await onboard(page, '50.000', '2026-01-05');
  await page.getByRole('button', { name: /Ir al resumen/ }).click();
  await page.goto('/movimientos?nuevo=1'); // cold load: the portfolios query starts empty
  const dialog = page.getByRole('dialog', { name: 'Nuevo movimiento' });
  await expect(dialog.locator('#f-portfolio option:checked')).toHaveText('Carteira BR');
});

test('W22: the initial deposit keeps its date; buys before it are flagged as implicit deposits', async ({ page }) => {
  await onboard(page, '50.000', '2026-03-02');
  await page.getByRole('button', { name: /Registrar una compra/ }).click();
  const dialog = await buyMsft(page, '2026-01-15');
  await dialog.getByTestId('tx-save').click();
  await expect(dialog).toBeHidden();
  // The deposit is dated as entered, not today.
  await page.getByPlaceholder('Buscar por activo, nota o cuenta…').fill('Aporte inicial');
  await expect(page.getByTestId('tx-table')).toContainText(/02\/03\/2026|2 de mar/);
  await page.getByPlaceholder('Buscar por activo, nota o cuenta…').fill('');
  // The January buy had no cash: visible warning with a one-click fix.
  const row = page.getByTestId('implicit-funding');
  await expect(row).toBeVisible({ timeout: 20_000 });
  await expect(row).toContainText('Compra sin aporte previo');
  await page.screenshot({ path: `${SHOTS}/implicit-funding.png`, fullPage: true });
  await page.goto('/mensual');
  await expect(page.getByTestId('implicit-month').first()).toBeVisible();
  await page.goto('/movimientos');
  await page.getByTestId('create-deposit').first().click();
  await expect(page.getByTestId('implicit-funding')).toHaveCount(0, { timeout: 20_000 });
});
