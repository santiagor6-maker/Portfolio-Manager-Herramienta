import { expect, test } from '@playwright/test';

/**
 * Live market data (optional): runs only when the market-data server answers on :8787
 * (`npm run dev:server`). Checks the refresh flow end to end and captures screenshots.
 */
test('refreshes prices from the market-data server', async ({ page, request }) => {
  const health = await request.get('http://localhost:8787/api/health').catch(() => undefined);
  test.skip(!health || !health.ok(), 'market-data server not running');
  test.setTimeout(180_000);
  await page.goto('/');
  const status = page.getByRole('button', { name: /Actualizar precios/ });
  await expect(status).toHaveAttribute('aria-label', /Actualizado/, { timeout: 150_000 });
  await expect(page.getByText('Servidor de precios no disponible.')).toHaveCount(0);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'e2e/screenshots/dashboard-live.png', fullPage: true });
  await page.goto('/divisas');
  await page.waitForTimeout(1200);
  await page.screenshot({ path: 'e2e/screenshots/currencies-live.png', fullPage: true });
  await page.goto('/rendimiento');
  await page.waitForTimeout(1200);
  await page.screenshot({ path: 'e2e/screenshots/performance-live.png', fullPage: true });
});
