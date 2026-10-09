/**
 * IBKR Flex sync on the Import page, against a mocked server (`page.route`): connect form,
 * clear error messages, daily inbox → preview → confirm → inbox cleared.
 */
import { expect, test } from '@playwright/test';

const SHOTS = 'e2e/screenshots';

test('IBKR Flex: connect, errors, daily inbox through the import preview', async ({ page }) => {
  const calls: { method: string; url: string; body?: Record<string, unknown> }[] = [];
  let saveStatus = 503;
  await page.route('**/api/sync/ibkr-flex**', async (route) => {
    const req = route.request();
    const body = req.postData() ? JSON.parse(req.postData()!) : undefined;
    calls.push({ method: req.method(), url: req.url(), body });
    const json = (status: number, data: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    if (req.method() === 'POST' && body?.action === 'save') {
      if (saveStatus === 503) return json(503, { error: { code: 'NOT_CONFIGURED', message: 'Sync not configured' } });
      return json(200, { credentialId: 'default' });
    }
    if (req.method() === 'GET' && req.url().includes('/inbox')) {
      return json(200, {
        portfolioId: 'x',
        pending: [{ id: 'ibkr-1', portfolioId: 'x', date: '2026-10-01', type: 'BUY', instrumentId: 'XNAS:MSFT', quantity: 3, price: 410, amount: 1230, fees: 1, currency: 'USD', importHash: 'ibkr-h1' }],
        instruments: [],
        lastRun: { ok: true },
      });
    }
    if (req.method() === 'DELETE') return json(200, { cleared: 1 });
    return json(400, { error: { code: 'BAD_REQUEST', message: '?' } });
  });

  await page.goto('/importar');
  const card = page.getByTestId('ibkr-sync');
  await expect(card).toBeVisible();
  await card.getByText('¿Dónde consigo el token y el id?').click();
  await card.getByLabel('Token Flex').fill('123456789012345678901234');
  await card.getByLabel('Id de la consulta Flex (Activity)').fill('987654');
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SHOTS}/ibkr-connect.png`, fullPage: true });

  // 503: the server has no SYNC_SECRET.
  await card.getByRole('button', { name: 'Conectar' }).click();
  await expect(page.getByTestId('ibkr-error')).toContainText('SYNC_SECRET');

  saveStatus = 200;
  await card.getByRole('button', { name: 'Conectar' }).click();
  await expect(card).toContainText('Conectado a Interactive Brokers (consulta 987654)');
  expect(calls.find((c) => c.body?.action === 'save')?.body).toMatchObject({ token: '123456789012345678901234', queryId: '987654' });

  // Daily inbox → same preview / confirm flow → DELETE.
  await expect(page.getByTestId('ibkr-inbox')).toContainText('1 movimiento nuevo');
  await page.getByTestId('ibkr-review-inbox').click();
  await expect(page.getByTestId('import-preview')).toBeVisible();
  await page.getByTestId('import-confirm').click();
  await expect(page.getByText(/1 movimiento importado/)).toBeVisible();
  await expect.poll(() => calls.some((c) => c.method === 'DELETE' && c.url.includes('/inbox?portfolioId='))).toBe(true);
});
