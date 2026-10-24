/**
 * Round 7 (reviews/web-r6.md). W55: an unrecorded split of a held position (NVDA 10:1, 2024-06-10) and
 * announced proventos surface on the Resumen / Proventos with one-click fixes — never "Todo en orden".
 */
import { expect, test, type Page, type Route } from '@playwright/test';

const SHOTS = 'e2e/screenshots';

async function mockProvider(page: Page, actions: Record<string, unknown[]>, series: Record<string, [string, number][]>) {
  await page.route('**/api/health', (route) => route.fulfill({ json: { ok: true, service: 'mock', version: '0', time: new Date().toISOString() } }));
  await page.route('**/api/batch', async (route: Route) => {
    const req = route.request().postDataJSON() as { histories?: { symbol: string }[]; fx?: { base: string; quote: string; from: string }[]; quotes?: unknown[]; indices?: unknown[] };
    const err = { ok: false, error: { code: 'NOT_FOUND', message: 'mock' } };
    const today = new Date().toISOString().slice(0, 10);
    await route.fulfill({
      json: {
        histories: (req.histories ?? []).map((h) => {
          const key = Object.keys(series).find((k) => h.symbol.includes(k));
          if (!key) return err;
          const ccy = key === 'NVDA' ? 'USD' : 'BRL';
          return { ok: true, data: { requested: h.symbol, providerSymbol: key, interval: '1d', actions: actions[key] ?? [], series: { currency: ccy, source: 'mock', points: series[key]!.map(([date, close]) => ({ date, close })) } } };
        }),
        fx: (req.fx ?? []).map((r) => ({ ok: true, data: { interval: '1d', series: { base: r.base, quote: r.quote, source: 'mock', points: [{ date: r.from, rate: r.quote === 'BRL' ? 5 : 4000 }, { date: today, rate: r.quote === 'BRL' ? 5 : 4000 }] } } })),
        quotes: (req.quotes ?? []).map(() => err),
        indices: (req.indices ?? []).map(() => err),
        tookMs: 1,
      },
    });
  });
}

async function onboard(page: Page, ccy: string, deposit: string, date: string) {
  await page.goto('/');
  await page.getByTestId('start-portfolio').click();
  const wizard = page.getByRole('dialog', { name: 'Empieza tu portafolio' });
  await wizard.getByLabel('Nombre').fill('Mi portafolio');
  await wizard.getByLabel('Moneda base').selectOption(ccy);
  await wizard.getByTestId('onboarding-create').click();
  await wizard.getByLabel(/Aporte inicial/).fill(deposit);
  await wizard.getByLabel('¿Desde cuándo inviertes?').fill(date);
  await wizard.getByRole('button', { name: 'Siguiente' }).click();
  await wizard.getByRole('button', { name: /Ir al resumen/ }).click();
}

async function importCsv(page: Page, file: string) {
  await page.goto('/importar');
  await page.getByTestId('import-file').setInputFiles(`e2e/fixtures/${file}`);
  await expect(page.getByTestId('import-preview')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('import-confirm').click();
  await expect(page.getByText(/importado/)).toBeVisible();
}

test('W55: an unrecorded NVDA 10:1 split is a blocking, one-click alert on the Resumen (never "Todo en orden")', async ({ page }) => {
  const today = new Date().toISOString().slice(0, 10);
  await mockProvider(
    page,
    { NVDA: [{ type: 'SPLIT', date: '2024-06-10', ratio: 10, source: 'yahoo' }] },
    { NVDA: [['2023-01-05', 142.65], ['2024-06-07', 1208.88], ['2024-06-10', 121.79], [today, 140]] },
  );
  await onboard(page, 'USD', '1.500.000', '2023-01-02');
  await importCsv(page, 'nvda-split.csv');
  await page.goto('/');
  const banner = page.getByTestId('pending-splits');
  await expect(banner).toContainText('NVDA', { timeout: 30_000 });
  await expect(banner).toContainText('10:1');
  await expect(page.getByText('Todo en orden')).toHaveCount(0);
  await expect(page.getByTestId('warning-split')).toContainText('NVDA');
  await page.screenshot({ path: `${SHOTS}/r7-pending-split.png` });
  await page.goto('/posiciones');
  await expect(page.getByTestId('pending-split-chip').first()).toBeVisible();

  await page.goto('/');
  await page.getByTestId('apply-splits').click();
  await expect(page.getByTestId('pending-splits')).toHaveCount(0, { timeout: 30_000 });
  // 100.000 × USD 140 + USD 73.500 of cash
  await expect(page.getByTestId('kpis')).toContainText('14.073.500');
});

test('W55: announced proventos are listed in Proventos with "registrar todos" instead of "no hay proventos"', async ({ page }) => {
  await mockProvider(
    page,
    {
      PETR4: ['2025-03-03', '2025-06-02', '2025-09-01'].map((d) => ({ type: 'DIVIDEND', date: d, exDate: d, payDate: d, amountPerShare: 1.2, currency: 'BRL', source: 'yahoo' })),
    },
    { PETR4: [['2025-01-10', 20], ['2025-06-30', 25], [new Date().toISOString().slice(0, 10), 25]] },
  );
  await onboard(page, 'BRL', '10.000', '2025-01-02');
  await importCsv(page, 'br-hold.csv');
  await page.goto('/');
  await expect(page.getByTestId('dashboard-pending-income')).toContainText('3', { timeout: 30_000 });
  await expect(page.getByTestId('warning-inbox')).toBeVisible();
  await page.goto('/dividendos');
  await expect(page.getByTestId('suggestions')).toContainText('PETR4');
  await page.screenshot({ path: `${SHOTS}/r7-pending-income.png` });
  await page.getByRole('button', { name: /Registrar todo|Aceptar todo/ }).click();
  await expect(page.getByTestId('suggestions')).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByText(/360/).first()).toBeVisible(); // 3 × 1,20 × 100
});

test('W56: in a one-currency BRL portfolio Cantidad, Aportes and Dividendos stay at 1280 px; a zero FX effect gives way first', async ({ page }) => {
  await mockProvider(page, {}, { PETR4: [['2025-01-10', 20], ['2025-06-30', 25], [new Date().toISOString().slice(0, 10), 25]] });
  await onboard(page, 'BRL', '10.000', '2025-01-02');
  await importCsv(page, 'br-hold.csv');
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/posiciones');
  const pos = page.getByTestId('positions-table');
  await expect(pos.locator('thead')).toContainText('Cantidad', { timeout: 30_000 });
  await page.goto('/mensual');
  const head = page.getByTestId('monthly-table').locator('thead');
  await expect(head).toContainText('Aportes');
  await expect(head).toContainText('Dividendos');
  const hidden = page.getByTestId('hidden-columns');
  if (await hidden.count()) await expect(hidden).not.toContainText(/Aportes|Dividendos/);
});

/** Font size, compact flag and grid row (offsetTop of the card) of every secondary KPI figure. */
async function kpiSizes(page: Page) {
  return page.locator('.card:not(.kpi-primary) .kpi-value').evaluateAll((els) =>
    els.map((el) => ({
      size: parseFloat(getComputedStyle(el).fontSize),
      compact: !!(el as HTMLElement).dataset.compact,
      row: `${(el.closest('.card')!.parentElement as HTMLElement).dataset.testid ?? ''}@${(el.closest('.card') as HTMLElement).offsetTop}`,
      text: el.textContent ?? '',
    })),
  );
}

test.describe('W57/W58 in es-CO', () => {
  test.use({ locale: 'es-CO' });
  test('KPI figures keep a floor above the label, one size per row, and re-fit after resize and a full-page capture', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto('/');
    await expect(page.getByTestId('kpis')).toContainText(/\d{3}\.\d{3}/, { timeout: 30_000 });
    await page.waitForTimeout(200);
    for (const [w, h] of [[1280, 800], [1366, 768], [1440, 900], [1024, 768]] as const) {
      await page.setViewportSize({ width: w, height: h });
      await page.waitForTimeout(200);
      const sizes = await kpiSizes(page);
      for (const k of sizes) expect(k.size, `${w}px ${k.text}`).toBeGreaterThanOrEqual(16);
      const byRow = new Map<string, number[]>();
      for (const k of sizes) byRow.set(k.row, [...(byRow.get(k.row) ?? []), k.size]);
      for (const [row, s] of byRow) expect(new Set(s).size, `${w}px row ${row}: ${s.join('/')}`).toBe(1);
    }
    // Phone → desktop: the compact fallback chosen at 360 px does not stick.
    await page.setViewportSize({ width: 360, height: 800 });
    await page.waitForTimeout(200);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.waitForTimeout(200);
    const wide = await kpiSizes(page);
    expect(wide.filter((k) => k.compact).map((k) => k.text)).toEqual([]);
    // A full-page capture (which relayouts the page) leaves the same fit behind.
    await page.screenshot({ path: `${SHOTS}/r7-kpis-1440-fullpage.png`, fullPage: true });
    await page.waitForTimeout(200);
    expect(await kpiSizes(page)).toEqual(wide);
    // Compact notation in Spanish: "M" / "mil", never "MRD" or a mix.
    await page.getByTestId('currency-switch').selectOption('COP');
    await expect(page.locator('body')).not.toContainText(/\bMRD\b/);
  });
});
