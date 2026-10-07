/**
 * Regression tests for the round-1 web review (reviews/web-r1.md, gaps W1–W20), adapted from the
 * reviewer's Playwright scripts (s2-phone, s4-real, s6-tasks, s7-a11y, s8-big). Each test names
 * the gap it guards. Runs offline against the production build (no market-data server needed).
 */
import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

const SHOTS = 'e2e/screenshots';

async function ready(page: Page) {
  await expect(page.getByTestId('kpis').locator('.skeleton')).toHaveCount(0, { timeout: 30_000 });
}

test.describe.configure({ mode: 'serial' });

test('W1: fast Enter in the ticker search never creates a phantom manual instrument', async ({ page }) => {
  await page.goto('/movimientos?nuevo=1');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await page.locator('#f-instrument').fill('MSFT');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);
  await expect(dialog.getByTestId('manual-instrument')).toHaveCount(0);
  // The exact symbol match was picked from the (offline) catalog instead.
  await expect(dialog.locator('#f-instrument')).toContainText('MSFT');
  await expect(dialog.locator('#f-instrument')).toContainText('NASDAQ');
  await page.keyboard.press('Escape');
});

test('W1/W4: manual instruments are an explicit flow with accrual (CDT) fields', async ({ page }) => {
  await page.goto('/movimientos?nuevo=1');
  const dialog = page.getByRole('dialog');
  await page.locator('#f-instrument').fill('CDT Banco Ejemplo');
  await page.getByRole('option', { name: /Crear activo manual/ }).click();
  const editor = dialog.getByTestId('manual-instrument');
  await expect(editor).toBeVisible();
  await expect(editor.getByLabel('Tasa anual %')).toBeVisible();
  await editor.getByLabel('Tasa anual %').fill('11,5');
  await editor.getByLabel('Vencimiento').fill('2027-10-01');
  await page.screenshot({ path: `${SHOTS}/form-manual-cdt.png` });
  await page.keyboard.press('Escape');
});

test('W6: FX conversion is compared with the TRM of the day', async ({ page }) => {
  await page.goto('/movimientos?nuevo=1');
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('radio', { name: 'Cambio de divisa' }).click();
  await dialog.getByLabel('Fecha').fill('2026-09-15');
  await dialog.getByLabel('Monto entregado').fill('20.000.000');
  await dialog.getByLabel('Moneda destino').selectOption('USD');
  await dialog.getByLabel('Monto recibido').fill('5.000');
  await expect(dialog.getByTestId('fx-reference')).toContainText('TRM');
  await expect(dialog.getByText(/difiere .* de la TRM/)).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/form-fx-vs-trm.png` });
  await page.keyboard.press('Escape');
});

test('W2: report prints with colours and every monthly column; snapshot is self-contained HTML', async ({ page }) => {
  await page.goto('/informe');
  const report = page.getByTestId('report');
  await expect(report).toBeVisible({ timeout: 30_000 });
  await expect(report.locator('table').nth(1).locator('thead th')).toHaveCount(13);
  const heatBg = await report.locator('.heat .c').first().evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(heatBg).not.toBe('rgb(255, 255, 255)');
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('report-snapshot').click()]);
  const html = readFileSync((await download.path())!, 'utf8');
  expect(html).toContain('<style>');
  expect(html).toContain('Informe de portafolio');
  expect(html).not.toContain('<script');
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('header').first()).toBeHidden();
  await page.screenshot({ path: `${SHOTS}/report-print.png`, fullPage: true });
  await page.pdf({ path: `${SHOTS}/report.pdf`, format: 'A4', landscape: true, printBackground: true });
  await page.emulateMedia({ media: 'screen' });
});

test('W3: price/FX effects and benchmark visible at 1440 px without scrolling; cards on the phone', async ({ page }) => {
  await page.goto('/mensual');
  const table = page.getByTestId('monthly-table');
  await expect(table).toBeVisible({ timeout: 30_000 });
  for (const name of ['Ef. precio', 'Ef. divisa', 'Diferencia']) {
    const box = await table.locator('th', { hasText: name }).first().boundingBox();
    expect(box, name).not.toBeNull();
    expect(box!.x + box!.width, `${name} inside viewport`).toBeLessThanOrEqual(1440);
  }
  const scroll = await table.evaluate((el) => el.scrollWidth - el.clientWidth);
  expect(scroll).toBeLessThanOrEqual(2);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId('monthly-cards')).toBeVisible();
  await page.getByTestId('monthly-cards').locator('summary').first().click();
  await expect(page.getByTestId('monthly-cards').locator('dl').first()).toContainText('Ef. divisa');
  await page.screenshot({ path: `${SHOTS}/monthly-phone-cards.png`, fullPage: true });
});

test('W5: every pending month-end of a manual fund is flagged and the close walks through them', async ({ page }) => {
  await page.goto('/');
  await ready(page);
  await expect(page.getByTestId('pending-close-warning')).toBeVisible();
  await page.goto('/mensual/cierre');
  await expect(page.getByTestId('pending-months')).toBeVisible();
  await expect(page.getByTestId('pending-months')).toContainText('FIC-RF');
  await page.getByRole('button', { name: 'Confirmar cierre' }).click();
  await expect(page.getByText(/guardado/)).toBeVisible();
});

test('W7: mobile menu is a modal dialog: focus trapped, Escape closes, focus returns', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByTestId('menu-button').click();
  const drawer = page.getByTestId('drawer');
  await expect(drawer).toBeVisible();
  await expect(drawer).toHaveAttribute('aria-modal', 'true');
  for (let i = 0; i < 25; i++) {
    await page.keyboard.press('Tab');
    expect(await page.evaluate(() => !!document.activeElement?.closest('[data-testid=drawer]'))).toBe(true);
  }
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  expect(await page.evaluate(() => document.activeElement?.getAttribute('data-testid'))).toBe('menu-button');
  await page.screenshot({ path: `${SHOTS}/dashboard-phone-header.png` });
});

test('W8: dividends compare year-to-date with the same period of last year', async ({ page }) => {
  await page.goto('/dividendos');
  await expect(page.getByTestId('div-yoy')).toContainText('mismo periodo');
});

test('W9: periods shorter than a year are not annualized', async ({ page }) => {
  await page.goto('/rendimiento');
  const row = page.getByTestId('periods-table').locator('tbody tr').first();
  await expect(row.locator('td').nth(2)).toHaveText('—');
  await expect(row.locator('td').nth(3)).toContainText('en el periodo');
  await page.screenshot({ path: `${SHOTS}/performance-r2.png`, fullPage: true });
});

test('W4/W11: positions performance view, rebalancing targets and goals', async ({ page }) => {
  await page.goto('/posiciones');
  await page.getByRole('button', { name: 'Rendimiento' }).click();
  await expect(page.getByTestId('positions-table')).toContainText('Retorno total');
  await page.getByRole('button', { name: 'Objetivos' }).click();
  await expect(page.getByTestId('targets-table')).toBeVisible();
  await page.getByTestId('targets-table').getByRole('textbox').first().fill('60');
  await page.getByTestId('targets-table').getByRole('textbox').first().blur();
  await page.getByTestId('rebalance-contribution').fill('10.000.000');
  await expect(page.getByTestId('targets-table')).toContainText('Con el aporte');
  await page.screenshot({ path: `${SHOTS}/positions-targets.png`, fullPage: true });
  await page.goto('/metas');
  await page.getByTestId('goal-new').click();
  await page.getByTestId('goal-save').click();
  await expect(page.getByTestId('goal-whatif')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/goals.png`, fullPage: true });
});

test('W11: alerts can be created and listed', async ({ page }) => {
  await page.goto('/alertas');
  await page.getByLabel('Tipo').selectOption('monthClose');
  await page.getByTestId('alert-create').click();
  await expect(page.getByTestId('alert-rules')).toContainText('Cierres de mes pendientes');
  await page.screenshot({ path: `${SHOTS}/alerts.png`, fullPage: true });
});

test('W15: importing the Trii statement enriches names and flags duplicates on re-import', async ({ page }) => {
  await page.goto('/importar');
  await page.getByTestId('import-file').setInputFiles('e2e/fixtures/extracto-trii.csv');
  await expect(page.getByTestId('import-preview')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('import-preview')).toContainText('Retención/imp.');
  await page.screenshot({ path: `${SHOTS}/import-preview.png`, fullPage: true });
  await page.getByTestId('import-confirm').click();
  await expect(page.getByText(/importado/)).toBeVisible();
  const names = await page.evaluate(async () => {
    const req = indexedDB.open('portafolio-pro');
    const db: IDBDatabase = await new Promise((r) => (req.onsuccess = () => r(req.result)));
    const all: { id: string; name: string }[] = await new Promise((r) => {
      const q = db.transaction('instruments').objectStore('instruments').getAll();
      q.onsuccess = () => r(q.result);
    });
    return all.filter((i) => i.id === 'XBOG:ISA' || i.id === 'XBOG:PFBCOLOM').map((i) => i.name);
  });
  for (const n of names) expect(n).not.toMatch(/^(ISA|PFBCOLOM)$/);
  await page.getByRole('button', { name: 'Importar otro archivo' }).click();
  await page.getByTestId('import-file').setInputFiles('e2e/fixtures/extracto-trii.csv');
  await expect(page.getByTestId('import-preview')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: /Duplicados \(\d+\)/ })).toBeVisible();
});

test('W20: PWA manifest and service worker are served', async ({ page, request }) => {
  const m = await request.get('/manifest.webmanifest');
  expect(m.ok()).toBe(true);
  expect((await m.json()).name).toBe('Portafolio Pro');
  expect((await request.get('/sw.js')).ok()).toBe(true);
  await page.goto('/');
  await expect(page.locator('link[rel=manifest]')).toHaveCount(1);
});

test('W17/W13: delete-all does not reseed the sample; the onboarding wizard starts', async ({ page }) => {
  await page.goto('/ajustes');
  await page.getByRole('button', { name: /Borrar todos los datos/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox').fill('BORRAR');
  await dialog.getByRole('button', { name: 'Borrar todo' }).click();
  await expect(page.getByRole('dialog', { name: 'Empieza tu portafolio' })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId('demo-banner')).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/onboarding.png` });
  await page.getByLabel('Moneda base').selectOption('BRL');
  await page.getByTestId('onboarding-create').click();
  await page.getByLabel(/Aporte inicial/).fill('50.000');
  await page.getByRole('button', { name: 'Siguiente' }).click();
  await page.getByRole('button', { name: /Ir al resumen/ }).click();
  await expect(page.getByTestId('getting-started')).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/dashboard-checklist.png`, fullPage: true });
});

test('performance: 3,000-transaction import stays responsive (reviewer big.csv)', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/importar');
  await page.getByTestId('import-file').setInputFiles('e2e/fixtures/big.csv');
  await expect(page.getByTestId('import-preview')).toBeVisible({ timeout: 60_000 });
  await page.getByTestId('import-confirm').click();
  await expect(page.getByText(/importados/)).toBeVisible({ timeout: 60_000 });
  const t0 = Date.now();
  await page.goto('/');
  await ready(page);
  expect(Date.now() - t0).toBeLessThan(15_000);
});
