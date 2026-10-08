import { expect, test, type Page } from '@playwright/test';

const SHOTS = 'e2e/screenshots';

async function waitForData(page: Page) {
  // KPI skeletons disappear once the engine worker has produced the analysis.
  await expect(page.getByTestId('kpis').locator('.skeleton')).toHaveCount(0);
}

async function shot(page: Page, name: string) {
  await page.waitForTimeout(600); // let charts finish their entry animation
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

test.describe.configure({ mode: 'serial' });

test('dashboard opens with sample data', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('demo-banner')).toBeVisible();
  await expect(page.getByTestId('demo-banner')).toContainText('datos de ejemplo');
  await expect(page.locator('header .chip', { hasText: 'Datos de ejemplo' })).toBeVisible();
  await waitForData(page);
  await expect(page.getByRole('heading', { name: 'Resumen', level: 1 })).toBeVisible();
  // es-CO formatting of COP: "$ 1.234.567" (no decimals)
  await expect(page.getByTestId('kpis')).toContainText(/\$\s?\d{1,3}(\.\d{3})+/);
  await shot(page, 'dashboard-desktop');
});

test('currency switch re-renders figures', async ({ page }) => {
  await page.goto('/');
  await waitForData(page);
  const before = await page.getByTestId('kpis').innerText();
  const sel = page.getByTestId('currency-switch');
  // Startup status updates re-render the header; make sure the selection has been applied.
  await expect(async () => {
    await sel.selectOption('USD');
    await expect(sel).toHaveValue('USD', { timeout: 1000 });
  }).toPass();
  // Non-local dollar currencies are disambiguated with their ISO code in es-CO: "USD 97.733,74".
  await expect(page.getByTestId('kpis')).toContainText(/USD\s\d{1,3}(\.\d{3})*,\d{2}/);
  await expect(page.locator('main')).not.toHaveAttribute('aria-busy', 'true');
  const after = await page.getByTestId('kpis').innerText();
  expect(after).not.toEqual(before);
  await page.getByTestId('currency-switch').selectOption('COP');
});

test('monthly tracking page', async ({ page }) => {
  await page.goto('/mensual');
  await expect(page.getByRole('heading', { name: 'Seguimiento mensual', level: 1 })).toBeVisible();
  await expect(page.getByTestId('monthly-heatmap')).toBeVisible();
  await expect(page.getByTestId('monthly-table').locator('tbody tr').first()).toBeVisible();
  await shot(page, 'monthly-desktop');
});

test('add a transaction', async ({ page }) => {
  await page.goto('/movimientos');
  await expect(page.getByTestId('tx-table')).toBeVisible();
  await expect.poll(() => page.getByTestId('tx-table').locator('tbody tr').count()).toBeGreaterThan(10);
  await page.getByTestId('add-tx').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByRole('radio', { name: 'Aporte' }).click();
  await dialog.getByLabel('Monto').fill('1.500.000');
  await dialog.getByText('Más detalles').click();
  await dialog.getByLabel('Nota').fill('Aporte e2e');
  // Validation: empty amount would block; here it is valid.
  await dialog.getByTestId('tx-save').click();
  await expect(dialog).toBeHidden();
  await page.getByPlaceholder('Buscar por activo, nota o cuenta…').fill('Aporte e2e');
  await expect(page.getByTestId('tx-table').locator('tbody tr')).toHaveCount(1);
  // The first real transaction goes to a new portfolio, never into the sample one.
  await expect(page.locator('#pf-select option:checked')).toHaveText('Mi portafolio');
});

test('form validation blocks invalid buy', async ({ page }) => {
  await page.goto('/movimientos?nuevo=1');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await dialog.getByTestId('tx-save').click();
  await expect(dialog.getByText('Elige un activo.')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

const PAGES: [string, string][] = [
  ['/posiciones', 'positions'],
  ['/divisas', 'currencies'],
  ['/dividendos', 'dividends'],
  ['/rendimiento', 'performance'],
  ['/impuestos', 'taxes'],
  ['/importar', 'import'],
  ['/ajustes', 'settings'],
  ['/mensual/cierre', 'month-close'],
  ['/movimientos', 'transactions'],
  ['/informe', 'report'],
  ['/metas', 'goals-empty'],
  ['/lista', 'watchlist'],
  ['/alertas', 'alerts-empty'],
];

test('screenshots of the remaining pages (desktop)', async ({ page }) => {
  for (const [path, name] of PAGES) {
    await page.goto(path);
    await expect(page.locator('main h1').first()).toBeVisible();
    await page.waitForTimeout(400);
    await shot(page, `${name}-desktop`);
  }
});

test('phone width + dark theme', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await waitForData(page);
  await shot(page, 'dashboard-phone');
  await page.goto('/mensual');
  await expect(page.getByTestId('monthly-heatmap')).toBeVisible();
  await shot(page, 'monthly-phone');
  await page.goto('/posiciones');
  await expect(page.getByTestId('positions-table')).toBeVisible();
  await shot(page, 'positions-phone');
  await page.goto('/');
  await page.getByTestId('menu-button').click();
  await page.getByTestId('drawer').getByRole('button', { name: 'Tema oscuro' }).click();
  await page.keyboard.press('Escape');
  await waitForData(page);
  await shot(page, 'dashboard-phone-dark');
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await waitForData(page);
  await shot(page, 'dashboard-desktop-dark');
  await page.goto('/mensual');
  await expect(page.getByTestId('monthly-heatmap')).toBeVisible();
  await shot(page, 'monthly-desktop-dark');
});

test('no horizontal page scroll at phone width', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of ['/', '/mensual', '/posiciones', '/movimientos', '/divisas', '/ajustes', '/informe', '/metas', '/alertas', '/rendimiento', '/dividendos']) {
    await page.goto(path);
    await expect(page.locator('main h1').first()).toBeVisible();
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    expect(overflow, `horizontal overflow on ${path}`).toBeLessThanOrEqual(1);
  }
});
