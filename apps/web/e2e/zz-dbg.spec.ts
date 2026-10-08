import { test, expect } from '@playwright/test';
test('w3dbg', async ({ page }) => {
  await page.goto('/mensual');
  const table = page.getByTestId('monthly-table');
  await expect(table).toBeVisible({ timeout: 30000 });
  await page.waitForTimeout(1500);
  const ths = await table.locator('thead th').evaluateAll((els) => els.map((e) => `${(e as HTMLElement).innerText.replace(/\n/g,' ')}:${Math.round(e.getBoundingClientRect().width)}`));
  console.log(ths.join(' | '));
  console.log('main', await page.locator('main').evaluate((e) => e.getBoundingClientRect().width), 'table', await table.evaluate((e) => [e.scrollWidth, e.clientWidth]));
  await page.screenshot({ path: '/tmp/claude-0/-home-user-Portfolio-Manager-Herramienta/8b757dea-bb3a-58bd-aa07-26758394d338/scratchpad/w3.png' });
});
