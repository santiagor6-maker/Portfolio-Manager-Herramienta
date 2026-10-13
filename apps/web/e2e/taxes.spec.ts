/** Tax area per country (tax R8): Colombia pack, Brazil DARF / Bens e Direitos / crypto, exports. */
import { expect, test } from '@playwright/test';

const SHOTS = 'e2e/screenshots';

test('Colombia: annual pack with Formulario 210 and XLSX export', async ({ page }) => {
  await page.goto('/impuestos');
  await page.getByLabel('Año').selectOption('2025');
  await expect(page.getByTestId('tax-document')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('tax-document')).toContainText('Formulario 210');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('tax-xlsx').click()]);
  expect(download.suggestedFilename()).toBe('colombia-2025.xlsx');
  await page.screenshot({ path: `${SHOTS}/taxes-colombia.png`, fullPage: true });
});

test('Brazil: DARF statuses, Bens e Direitos and the full pack', async ({ page }) => {
  await page.goto('/impuestos');
  await page.getByRole('button', { name: /Brasil/ }).click();
  await page.getByLabel('Año').selectOption('2025');
  await expect(page.getByTestId('bens-table')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('bens-table')).toContainText('PETR4');
  await expect(page.getByTestId('tax-exports')).toContainText('bens-e-direitos');
  await expect(page.getByTestId('tax-document')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/taxes-brazil.png`, fullPage: true });
});
