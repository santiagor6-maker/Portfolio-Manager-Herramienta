/**
 * Regressions for the items without e2e after round 3 (W33, W34, W37, W38, W39) and the importers R5
 * pending-note review. All against the production build.
 */
import { expect, test, type Page } from '@playwright/test';

const SHOTS = 'e2e/screenshots';

async function onboardBR(page: Page, opts: { deposit: string; date: string; broker?: string }) {
  await page.goto('/');
  await page.getByTestId('start-portfolio').click();
  const wizard = page.getByRole('dialog', { name: 'Empieza tu portafolio' });
  await wizard.getByLabel('Nombre').fill('Carteira BR');
  await wizard.getByLabel('Moneda base').selectOption('BRL');
  await wizard.getByLabel('Residencia fiscal').selectOption('BR');
  if (opts.broker) await wizard.getByLabel('Corredor principal (opcional)').fill(opts.broker);
  await wizard.getByTestId('onboarding-create').click();
  await wizard.getByLabel(/Aporte inicial/).fill(opts.deposit);
  await wizard.getByLabel('¿Desde cuándo inviertes?').fill(opts.date);
  await wizard.getByRole('button', { name: 'Siguiente' }).click();
  await wizard.getByRole('button', { name: /Ir al resumen/ }).click();
}

async function importFile(page: Page, file: string) {
  await page.goto('/importar');
  await page.getByTestId('import-file').setInputFiles(`e2e/fixtures/${file}`);
  await expect(page.getByTestId('import-preview')).toBeVisible({ timeout: 30_000 });
}

test('W33 + W34: XP account labels merge; DARF payment asks for date and amount; KPI drops paid DARFs', async ({ page }) => {
  await onboardBR(page, { deposit: '100.000', date: '2025-01-02', broker: 'XP' });
  await importFile(page, 'br-darf.csv');
  await page.getByTestId('import-confirm').click();
  await expect(page.getByText(/importado/)).toBeVisible();

  // W33: the importer's "XP INVESTIMENTOS CCTVM S/A" is the onboarding "XP" account: no implicit deposit.
  await page.goto('/movimientos');
  await expect(page.getByTestId('tx-table')).toContainText('XP');
  await expect(page.getByTestId('tx-table')).not.toContainText('CCTVM');
  await expect(page.getByTestId('implicit-funding')).toHaveCount(0);

  // W34: R$ 30k of sales with R$ 10k gain in March 2025 → DARF 6015 of R$ 1.500 (overdue today).
  await page.goto('/impuestos');
  await page.getByRole('button', { name: /Brasil/ }).click();
  await page.getByLabel('Año').selectOption('2025');
  await expect(page.getByTestId('darf-kpi-sub')).toContainText('1 DARF', { timeout: 30_000 });
  await page.getByTestId('darf-pay').first().click();
  const dialog = page.getByTestId('darf-pay-dialog');
  await expect(dialog.getByLabel('Monto pagado (BRL)')).not.toHaveValue('');
  await dialog.getByLabel('Fecha del pago').fill('2025-04-25');
  await dialog.getByLabel('Monto pagado (BRL)').fill('1500');
  await page.screenshot({ path: `${SHOTS}/darf-payment.png` });
  await dialog.getByTestId('darf-pay-save').click();
  await expect(page.getByTestId('darf-status').first()).toContainText('Pagada', { timeout: 20_000 });
  await expect(page.getByTestId('darf-kpi-sub')).toContainText('0 DARF');
});

test('W37: printed tables show the Total row once (tfoot is not a repeating footer)', async ({ page }) => {
  await page.goto('/informe');
  await expect(page.getByTestId('report')).toBeVisible({ timeout: 30_000 });
  await page.emulateMedia({ media: 'print' });
  const display = await page.getByTestId('report').locator('tfoot').first().evaluate((el) => getComputedStyle(el).display);
  expect(display).toBe('table-row-group');
});

test('W38: an IBKR 403 explains the server setup (API_TOKEN, SYNC_SECRET)', async ({ page }) => {
  await page.route('**/api/sync/ibkr-flex**', (route) =>
    route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: { code: 'FORBIDDEN', message: 'Forbidden' } }) }),
  );
  await page.goto('/importar');
  const card = page.getByTestId('ibkr-sync');
  await card.getByLabel('Token Flex').fill('123');
  await card.getByLabel('Id de la consulta Flex (Activity)').fill('456');
  await card.getByRole('button', { name: 'Conectar' }).click();
  await expect(page.getByTestId('ibkr-error')).toContainText('API_TOKEN');
  await expect(page.getByTestId('ibkr-error')).toContainText('SYNC_SECRET');
  await card.getByText('Configurar el servidor (una sola vez)').click();
  await expect(card.getByTestId('ibkr-server-setup')).toContainText('SYNC_SECRET=');
});

test('W39: "Crear aporte" books a base-currency deposit plus the FX conversion at the day rate', async ({ page }) => {
  await onboardBR(page, { deposit: '50.000', date: '2026-03-02' });
  // A USD/BRL rate of 5 on the purchase date (as a market refresh would cache it).
  await page.evaluate(async () => {
    const req = indexedDB.open('portafolio-pro');
    const db: IDBDatabase = await new Promise((r) => (req.onsuccess = () => r(req.result)));
    await new Promise<void>((r) => {
      const tx = db.transaction('fxSeries', 'readwrite');
      tx.objectStore('fxSeries').put({ pair: 'USD/BRL', base: 'USD', quote: 'BRL', points: [{ date: '2026-01-02', rate: 5 }], source: 'test', updatedAt: Date.now() });
      tx.oncomplete = () => r();
    });
  });
  await page.goto('/movimientos?nuevo=1');
  const dialog = page.getByRole('dialog', { name: 'Nuevo movimiento' });
  await dialog.getByLabel('Fecha').fill('2026-01-15');
  const input = page.locator('#f-instrument');
  await expect(async () => {
    await input.click();
    await input.fill('MSFT');
    await expect(page.getByRole('option', { name: /MSFT/ }).first()).toBeVisible({ timeout: 3000 });
  }).toPass();
  await page.getByRole('option', { name: /MSFT/ }).first().click();
  await dialog.getByLabel('Cantidad').fill('2');
  await dialog.getByLabel('Precio').fill('400');
  await dialog.getByTestId('tx-save').click();
  await expect(dialog).toBeHidden();
  await page.getByTestId('create-deposit').first().click();
  const table = page.getByTestId('tx-table');
  await expect(table).toContainText('Cambio de divisa', { timeout: 20_000 });
  await expect(table).toContainText('R$ 4.000,00');
  await expect(page.getByTestId('implicit-funding')).toHaveCount(0, { timeout: 20_000 });
});

test('Importers R5: a SINACOR note held for review shows its unread line and totals, and can be accepted', async ({ page }) => {
  await importFile(page, 'nota-sinacor.pdf');
  const notes = page.getByTestId('pending-notes');
  await expect(notes).toBeVisible();
  await expect(notes.getByTestId('pending-note').first()).toContainText('99887766');
  await expect(notes.getByTestId('note-diff').first()).not.toHaveText('—');
  await page.screenshot({ path: `${SHOTS}/import-pending-note.png`, fullPage: true });
  const before = Number((await page.getByTestId('import-confirm').textContent())?.match(/\d+/)?.[0] ?? 0);
  await notes.getByTestId('note-accept').first().click();
  await expect(page.getByTestId('pending-notes')).toHaveCount(0, { timeout: 20_000 });
  await expect.poll(async () => Number((await page.getByTestId('import-confirm').textContent())?.match(/\d+/)?.[0] ?? 0)).toBeGreaterThan(before);
});

test('Core R8: an imported old ticker (PFBCOLOM) is held under its current id with "antes PFBCOLOM"', async ({ page }) => {
  // A real portfolio (the sample's PFCIBEST is gone): the instrument is created from the old ticker.
  await page.goto('/');
  await page.getByTestId('start-portfolio').click();
  await page.getByRole('dialog', { name: 'Empieza tu portafolio' }).getByTestId('onboarding-create').click();
  await importFile(page, 'extracto-trii.csv');
  await page.getByTestId('import-confirm').click();
  await expect(page.getByText(/importado/)).toBeVisible();
  await page.goto('/posiciones');
  const table = page.getByTestId('positions-table');
  await expect(table).toContainText('PFCIBEST', { timeout: 20_000 });
  const row = table.locator('tr', { hasText: 'PFCIBEST' }).first();
  await expect(row).toContainText('PFBCOLOM'); // "antes PFBCOLOM"
  await expect(table.locator('tr', { hasText: /^PFBCOLOM/ })).toHaveCount(0);
  // An old link resolves to the current instrument.
  await page.goto('/posiciones/XBOG%3APFBCOLOM');
  await expect(page.getByRole('heading', { level: 1 })).toContainText('PFCIBEST');
});
