/**
 * W30: PDF and .eml imports in the BUILT app (Playwright runs against `vite preview`, so the pdf.js
 * worker must be emitted and registered as in production).
 */
import { expect, test } from '@playwright/test';

const SHOTS = 'e2e/screenshots';

for (const [file, label] of [
  ['nota-sinacor.pdf', 'SINACOR'],
  ['extracto-trii.pdf', 'Trii'],
  ['nota.eml', 'e-mail'],
] as const) {
  test(`imports ${label} (${file}) through the production pdf.js worker`, async ({ page }) => {
    await page.goto('/importar');
    await page.getByTestId('import-file').setInputFiles(`e2e/fixtures/${file}`);
    await expect(page.getByTestId('import-preview')).toBeVisible({ timeout: 30_000 });
    const preview = page.getByTestId('import-preview');
    await expect(preview).not.toContainText('GlobalWorkerOptions');
    await expect(preview).not.toContainText('contraseña');
    // Something to import (or questions to answer), never a reader failure.
    await expect(page.getByTestId('import-confirm')).toBeVisible();
    const rows = await preview.locator('tbody tr').count();
    expect(rows).toBeGreaterThan(0);
    if (file === 'nota-sinacor.pdf') await page.screenshot({ path: `${SHOTS}/import-pdf-sinacor.png`, fullPage: true });
  });
}
