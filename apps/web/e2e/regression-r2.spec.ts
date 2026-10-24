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

test('W20: the Resumen paints its figures before the charting library loads', async ({ page }) => {
  // Record, inside the page, the moment the KPI figures are painted (no skeleton left).
  await page.addInitScript(() => {
    const w = window as unknown as { __kpiAt?: number };
    const tick = () => {
      const k = document.querySelector('[data-testid=kpis]');
      if (k && !k.querySelector('.skeleton') && k.textContent && /\d/.test(k.textContent)) w.__kpiAt = performance.now();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await page.goto('/');
  await expect(page.getByTestId('kpis').locator('.skeleton')).toHaveCount(0, { timeout: 30_000 });
  await expect(page.locator('canvas').first()).toBeVisible({ timeout: 10_000 });
  const r = await page.evaluate(() => {
    const kpiAt = (window as unknown as { __kpiAt?: number }).__kpiAt ?? Infinity;
    const res = performance.getEntriesByType('resource') as PerformanceResourceTiming[];
    const js = res.filter((e) => e.name.endsWith('.js'));
    const charts = js.find((e) => /EChartsView/.test(e.name));
    const before = js.filter((e) => e.startTime <= kpiAt).reduce((s, e) => s + (e.decodedBodySize || 0), 0);
    return { kpiAt, chartsAt: charts?.startTime ?? -1, before };
  });
  // ECharts (~570 kB) is requested only after the figures are painted (it used to be ~1.25 MB of JS
  // before the KPIs).
  expect(r.chartsAt).toBeGreaterThan(r.kpiAt);
  // R7: the demo seed imports only the core demo module and the worker boots with the database (~750 kB).
  expect(r.before).toBeLessThan(800 * 1024);
});

test('W10: read-only share link (data in the URL fragment), optionally encrypted', async ({ page, browser }) => {
  await page.goto('/informe');
  await expect(page.getByTestId('report')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('report-share').click();
  await page.getByTestId('share-create').click();
  const url = await page.getByTestId('share-url').inputValue();
  expect(url).toMatch(/\/compartido#p1\./);
  expect(url.length).toBeLessThan(40_000);
  await page.screenshot({ path: `${SHOTS}/share-link.png` });

  // A different person (fresh browser profile) opens it: read-only report, nothing seeded.
  const ctx = await browser.newContext();
  const viewer = await ctx.newPage();
  await viewer.goto(url);
  const frame = viewer.frameLocator('[data-testid=shared-frame]');
  await expect(frame.getByText('Informe de portafolio')).toBeVisible();
  await expect(frame.locator('script')).toHaveCount(0);
  await expect(viewer.getByTestId('demo-banner')).toHaveCount(0);
  await viewer.screenshot({ path: `${SHOTS}/share-view.png` });

  // Encrypted link: asks for the passphrase.
  await page.getByLabel('Contraseña (opcional)').fill('secreto-123');
  await page.getByTestId('share-create').click();
  await expect(page.getByTestId('share-url')).toHaveValue(/#e2\./); // W46: compact encrypted format
  const enc = await page.getByTestId('share-url').inputValue();
  const v2 = await ctx.newPage();
  await v2.goto(enc);
  await v2.getByLabel('Contraseña').fill('mala');
  await v2.getByRole('button', { name: 'Abrir' }).click();
  await expect(v2.getByText('Contraseña incorrecta.')).toBeVisible();
  await v2.getByLabel('Contraseña').fill('secreto-123');
  await v2.getByRole('button', { name: 'Abrir' }).click();
  await expect(v2.frameLocator('[data-testid=shared-frame]').getByText('Informe de portafolio')).toBeVisible();
  await ctx.close();
});
