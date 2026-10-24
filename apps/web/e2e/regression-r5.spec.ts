/**
 * Round 5 (reviews/web-r4.md W40–W48, reviews/web-design-r1.md D1/D3/D4) against the production build.
 * The market-data server is mocked with page.route: USD/COP always answers; USD/BRL answers late (to
 * see "Convirtiendo a BRL…") or not at all (no rate → "—" and a warning, never R$ 0,00).
 */
import { expect, test, type Page, type Route } from '@playwright/test';

const SHOTS = 'e2e/screenshots';
const RATES: Record<string, number> = { COP: 4000, BRL: 5, EUR: 0.9 };

async function mockMarket(page: Page, opts: { brl: 'late' | 'never' }) {
  await page.route('**/api/health', (route) => route.fulfill({ json: { ok: true, service: 'mock', version: '0', time: new Date().toISOString() } }));
  await page.route('**/api/batch', async (route: Route) => {
    const req = route.request().postDataJSON() as { histories?: unknown[]; fx?: { base: string; quote: string; from: string }[]; quotes?: unknown[]; indices?: unknown[] };
    const err = { ok: false, error: { code: 'NOT_FOUND', message: 'mock' } };
    const fx = (req.fx ?? []).map((r) => {
      const rate = RATES[r.quote];
      if (!rate || (r.quote === 'BRL' && opts.brl === 'never')) return err;
      const today = new Date().toISOString().slice(0, 10);
      return { ok: true, data: { interval: '1d', series: { base: r.base, quote: r.quote, source: 'mock', points: [{ date: r.from, rate }, { date: today, rate }] } } };
    });
    if (opts.brl === 'late' && (req.fx ?? []).some((r) => r.quote === 'BRL')) await new Promise((r) => setTimeout(r, 2500));
    await route.fulfill({
      json: { histories: (req.histories ?? []).map(() => err), fx, quotes: (req.quotes ?? []).map(() => err), indices: (req.indices ?? []).map(() => err), tookMs: 1 },
    });
  });
}

async function onboardCO(page: Page, deposit: string, date: string) {
  await page.goto('/');
  await page.getByTestId('start-portfolio').click();
  const wizard = page.getByRole('dialog', { name: 'Empieza tu portafolio' });
  await wizard.getByLabel('Nombre').fill('Portafolio CO');
  await wizard.getByLabel('Moneda base').selectOption('COP');
  await wizard.getByTestId('onboarding-create').click();
  await wizard.getByLabel(/Aporte inicial/).fill(deposit);
  await wizard.getByLabel('¿Desde cuándo inviertes?').fill(date);
  await wizard.getByRole('button', { name: 'Siguiente' }).click();
  await wizard.getByRole('button', { name: /Ir al resumen/ }).click();
  await expect(page.getByTestId('kpis')).toContainText('30.000.000', { timeout: 30_000 });
}

test('W40: switching to a currency whose rate is not cached downloads it ("Convirtiendo a BRL…"), never R$ 0,00', async ({ page }) => {
  await mockMarket(page, { brl: 'late' });
  await onboardCO(page, '30.000.000', '2024-01-02');
  await page.getByTestId('currency-switch').selectOption('BRL');
  await expect(page.getByTestId('fx-converting')).toContainText('Convirtiendo a BRL');
  await page.screenshot({ path: `${SHOTS}/r5-converting.png` });
  await expect(page.getByTestId('kpis')).not.toContainText('R$ 0,00');
  // 30.000.000 COP ÷ 4.000 × 5 = R$ 37.500
  await expect(page.getByTestId('kpis')).toContainText('37.500', { timeout: 30_000 });
  await expect(page.getByTestId('fx-converting')).toHaveCount(0);
  await expect(page.getByTestId('fx-missing')).toHaveCount(0);
});

test('W40: without a rate every figure is "—" with a warning (KPIs, monthly table, charts, report)', async ({ page }) => {
  await mockMarket(page, { brl: 'never' });
  await onboardCO(page, '30.000.000', '2024-01-02');
  await page.getByTestId('currency-switch').selectOption('BRL');
  await expect(page.getByTestId('fx-missing')).toContainText('COP/BRL', { timeout: 30_000 });
  await expect(page.getByTestId('kpi-no-fx')).toBeVisible();
  await expect(page.getByTestId('kpis')).not.toContainText('R$ 0,00');
  await expect(page.getByTestId('kpis')).toContainText('—');
  await expect(page.getByTestId('fx-unavailable').first()).toBeVisible();
  await page.screenshot({ path: `${SHOTS}/r5-no-rate.png` });

  await page.goto('/mensual');
  await expect(page.getByTestId('fx-unavailable')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('monthly-table')).not.toContainText('R$ 0,00');
  await expect(page.getByTestId('monthly-table')).not.toContainText('0,00 %');

  await page.goto('/informe');
  await expect(page.getByTestId('report-fx-missing')).toContainText('COP/BRL', { timeout: 30_000 });
  await expect(page.getByTestId('report')).not.toContainText('R$ 0,00');

  // Retry (same page, no reload) once the server has the pair.
  await page.unroute('**/api/batch');
  await mockMarket(page, { brl: 'late' });
  await page.getByTestId('fx-retry').click();
  await expect(page.getByTestId('report-fx-missing')).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByTestId('report')).toContainText('37.500');
});

test('W46 + W47 + W48: compact links that follow the hash, report table fits, data-quality marks travel', async ({ page, browser }) => {
  await mockMarket(page, { brl: 'late' });
  await onboardCO(page, '30.000.000', '2026-06-01');
  // Buys in April 2026 before the June deposit → implicit deposits (W22) in April.
  await page.goto('/importar');
  await page.getByTestId('import-file').setInputFiles('e2e/fixtures/extracto-trii.csv');
  await expect(page.getByTestId('import-preview')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('import-confirm').click();
  await expect(page.getByText(/importado/)).toBeVisible();

  await page.goto('/informe');
  const report = page.getByTestId('report');
  await expect(report).toBeVisible({ timeout: 30_000 });
  await expect(report.getByTestId('report-mark-implicit').first()).toBeVisible();
  await expect(report.getByTestId('report-quality-legend')).toContainText('Aporte implícito');
  // W47: the monthly table fits its sheet at 1440 px (no clipped benchmark column).
  const fits = await report.locator('.tw').first().evaluate((el) => el.scrollWidth <= el.clientWidth + 1);
  expect(fits).toBe(true);
  await report.locator('.tw').first().screenshot({ path: `${SHOTS}/r5-report-table.png` });

  await page.getByTestId('report-share').click();
  await page.getByTestId('share-create').click();
  const first = await page.getByTestId('share-url').inputValue();
  await page.getByLabel('Contraseña (opcional)').fill('clave-r5');
  await page.getByTestId('share-create').click();
  await expect(page.getByTestId('share-url')).toHaveValue(/#e2\./);
  const enc = await page.getByTestId('share-url').inputValue();
  // W46: the encrypted link costs only salt + iv + tag over the plain one (e1 was ≈ 1.8×).
  expect(enc.length - first.length).toBeLessThan(80);

  const ctx = await browser.newContext();
  const viewer = await ctx.newPage();
  await viewer.goto(first);
  const frame = viewer.frameLocator('[data-testid=shared-frame]');
  await expect(frame.getByText('‡').first()).toBeVisible();
  await expect(frame.getByText(/Aporte implícito/)).toBeVisible();

  // Another link pasted in the same tab (only the # changes): the new report shows without reload.
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Mes', exact: true }).click();
  await page.getByTestId('report-share').click();
  await page.getByLabel('Contraseña (opcional)').fill('');
  await page.getByTestId('share-create').click();
  await expect(page.getByTestId('share-url')).not.toHaveValue(first);
  const second = await page.getByTestId('share-url').inputValue();
  const titleBefore = await viewer.locator('header .font-semibold').first().textContent();
  await viewer.evaluate((h) => (location.hash = h), new URL(second).hash);
  await expect(viewer.locator('header .font-semibold').first()).not.toHaveText(titleBefore ?? '');
  await viewer.screenshot({ path: `${SHOTS}/r5-share-hashchange.png` });
  await ctx.close();
});

test('D3: long tables keep their header while scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/mensual');
  const box = page.getByTestId('monthly-table');
  await expect(box.locator('tbody tr').nth(10)).toBeVisible({ timeout: 30_000 });
  await box.evaluate((el) => (el.scrollTop = 600));
  const [th, top] = await box.evaluate((el) => [el.querySelector('th')!.getBoundingClientRect().top, el.getBoundingClientRect().top]);
  expect(Math.abs(th - top)).toBeLessThan(2);
  await page.screenshot({ path: `${SHOTS}/r5-sticky-monthly.png` });
});

/**
 * D1 (R5 review): every KPI figure is rendered on ONE line (no break inside "+COP 21.081.632") and is
 * not clipped. Lines are counted from the text's client rects, not from the absence of an ellipsis.
 */
async function kpiProblems(page: Page): Promise<string[]> {
  return page.locator('.kpi-value').evaluateAll((els) =>
    els.flatMap((el) => {
      const range = document.createRange();
      range.selectNodeContents(el);
      const tops: number[] = [];
      for (const r of Array.from(range.getClientRects())) if (r.width > 0 && !tops.some((t) => Math.abs(t - r.top) < 6)) tops.push(r.top);
      const text = (el.textContent ?? '').trim();
      const out: string[] = [];
      if (tops.length > 1) out.push(`${text}: ${tops.length} lines`);
      if (el.scrollWidth > el.clientWidth + 1) out.push(`${text}: clipped ${el.scrollWidth}>${el.clientWidth}`);
      // A compact figure ("+$ 21,1 M") is allowed on narrow cards only with the full one in the tooltip.
      if ((el as HTMLElement).dataset.compact && !/\d{3}/.test(el.getAttribute('title') ?? '')) out.push(`${text}: compact without the full value`);
      return out;
    }),
  );
}

for (const locale of ['es-CO', 'pt-BR']) {
  test.describe(`D1 in ${locale}`, () => {
    test.use({ locale });
    test(`KPI figures stay on one line (COP/BRL/USD; 1280, 1366, 1440, 390 px)`, async ({ page }) => {
      await page.goto('/');
      await expect(page.getByTestId('kpis')).toContainText(/\d/, { timeout: 30_000 });
      for (const ccy of ['COP', 'BRL', 'USD']) {
        await page.getByTestId('currency-switch').selectOption(ccy);
        await expect(page.locator('.kpi-value').first()).toContainText(ccy === 'COP' ? /\d{3}\.\d{3}/ : /\d/, { timeout: 30_000 });
        for (const [w, h] of [[1280, 800], [1366, 768], [1440, 900], [390, 844]] as const) {
          await page.setViewportSize({ width: w, height: h });
          await page.waitForTimeout(150); // ResizeObserver fit
          expect(await kpiProblems(page), `${locale} ${ccy} ${w}px`).toEqual([]);
        }
        await page.setViewportSize({ width: 1440, height: 900 });
      }
      await page.setViewportSize({ width: 1280, height: 800 });
      await page.screenshot({ path: `${SHOTS}/r6-kpis-${locale}-1280.png` });
      for (const path of ['/rendimiento', '/divisas', '/dividendos', '/mensual']) {
        await page.goto(path);
        await expect(page.locator('.kpi-value').first()).toBeVisible({ timeout: 30_000 });
        await page.waitForTimeout(150);
        expect(await kpiProblems(page), `${locale} ${path} 1280px`).toEqual([]);
      }
    });
  });
}

/** W49 (R5 review): an interrupted price refresh is retried at the next start and never goes unnoticed. */
test('W49: holdings without market prices are flagged and the refresh is retried after a reload', async ({ page }) => {
  let serve = false;
  await page.route('**/api/health', (route) => route.fulfill({ json: { ok: true, service: 'mock', version: '0', time: new Date().toISOString() } }));
  await page.route('**/api/batch', async (route) => {
    if (!serve) return; // never answered: the refresh is cut short by the next reload (W49)
    const req = route.request().postDataJSON() as { histories?: { symbol: string; from: string }[]; fx?: { base: string; quote: string; from: string }[]; quotes?: unknown[]; indices?: unknown[] };
    const today = new Date().toISOString().slice(0, 10);
    const err = { ok: false, error: { code: 'NOT_FOUND', message: 'mock' } };
    await route.fulfill({
      json: {
        histories: (req.histories ?? []).map((h) =>
          h.symbol.includes('PETR4') ? { ok: true, data: { requested: h.symbol, providerSymbol: 'PETR4.SA', interval: '1d', actions: [], series: { currency: 'BRL', source: 'mock', points: [{ date: h.from, close: 20 }, { date: today, close: 25 }] } } } : err,
        ),
        fx: (req.fx ?? []).map((r) => ({ ok: true, data: { interval: '1d', series: { base: r.base, quote: r.quote, source: 'mock', points: [{ date: r.from, rate: RATES[r.quote] ?? 1 }, { date: today, rate: RATES[r.quote] ?? 1 }] } } })),
        quotes: (req.quotes ?? []).map(() => err),
        indices: (req.indices ?? []).map(() => err),
        tookMs: 1,
      },
    });
  });
  await page.goto('/');
  await page.getByTestId('start-portfolio').click();
  const wizard = page.getByRole('dialog', { name: 'Empieza tu portafolio' });
  await wizard.getByLabel('Nombre').fill('Carteira');
  await wizard.getByLabel('Moneda base').selectOption('BRL');
  await wizard.getByTestId('onboarding-create').click();
  await wizard.getByLabel(/Aporte inicial/).fill('10.000');
  await wizard.getByLabel('¿Desde cuándo inviertes?').fill('2025-01-02');
  await wizard.getByRole('button', { name: 'Siguiente' }).click();
  await wizard.getByRole('button', { name: /Ir al resumen/ }).click();
  await page.goto('/importar');
  await page.getByTestId('import-file').setInputFiles('e2e/fixtures/br-hold.csv');
  await expect(page.getByTestId('import-preview')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('import-confirm').click();
  await expect(page.getByText(/importado/)).toBeVisible();

  // The refresh after the import never finished: reload — the holding is flagged, months are "sin precio".
  await page.goto('/');
  await expect(page.getByTestId('stale-market')).toContainText('PETR4', { timeout: 30_000 });
  await page.screenshot({ path: `${SHOTS}/r6-stale-market.png` });
  await page.goto('/mensual');
  await expect(page.getByTestId('heat-no-price').first()).toBeVisible({ timeout: 30_000 });

  // The server is back: the very next start retries at once (no 2-minute throttle) and prices arrive.
  serve = true;
  await page.goto('/');
  await expect(page.getByTestId('kpis')).toContainText('10.500', { timeout: 30_000 }); // R$ 8.000 cash + 100 × R$ 25
  await expect(page.getByTestId('stale-market')).toHaveCount(0);
});

test('W50: /mensual opened directly compares a BRL portfolio with Ibovespa, and follows the currency', async ({ page }) => {
  await mockMarket(page, { brl: 'late' });
  await page.goto('/');
  await page.getByTestId('start-portfolio').click();
  const wizard = page.getByRole('dialog', { name: 'Empieza tu portafolio' });
  await wizard.getByLabel('Nombre').fill('Carteira');
  await wizard.getByLabel('Moneda base').selectOption('BRL');
  await wizard.getByTestId('onboarding-create').click();
  await wizard.getByLabel(/Aporte inicial/).fill('10.000');
  await wizard.getByLabel('¿Desde cuándo inviertes?').fill('2025-01-02');
  await wizard.getByRole('button', { name: 'Siguiente' }).click();
  await wizard.getByRole('button', { name: /Ir al resumen/ }).click();
  await expect(page.getByTestId('currency-switch')).toHaveValue('BRL');
  await page.goto('/mensual'); // cold load: settings arrive after the first render
  await expect(page.locator('#bench')).toHaveValue('INDEX:^BVSP');
  await page.getByTestId('currency-switch').selectOption('USD');
  await expect(page.locator('#bench')).toHaveValue('INDEX:^GSPC');
});

/** W51 (R5 review): no table hides columns behind a horizontal scroll at 1280/1440 px; hidden ones are named. */
for (const [locale, ccy] of [['es-CO', 'COP'], ['pt-BR', 'BRL']] as const) {
  test.describe(`W51 in ${locale}`, () => {
    test.use({ locale });
    test(`tables fit their card at 1280 and 1440 px (${ccy})`, async ({ page }) => {
      await page.goto('/');
      await expect(page.getByTestId('kpis')).toContainText(/\d/, { timeout: 30_000 });
      await page.getByTestId('currency-switch').selectOption(ccy);
      for (const w of [1280, 1440]) {
        await page.setViewportSize({ width: w, height: 900 });
        for (const path of ['/mensual', '/movimientos', '/posiciones', '/dividendos', '/rendimiento']) {
          await page.goto(path);
          await expect(page.locator('table.table').first()).toBeVisible({ timeout: 30_000 });
          await page.waitForTimeout(300);
          const over = await page.locator('table.table').evaluateAll((ts) =>
            ts.filter((t) => t.getClientRects().length && t.scrollWidth > t.parentElement!.clientWidth + 1).map((t) => `${t.scrollWidth}>${t.parentElement!.clientWidth}`),
          );
          expect(over, `${locale} ${w}px ${path}`).toEqual([]);
        }
      }
      // Movimientos at 1280 px gives way with a visible note (never silently).
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto('/movimientos');
      await expect(page.getByTestId('hidden-columns')).toBeVisible();
      await page.screenshot({ path: `${SHOTS}/r6-movements-1280-${locale}.png` });
      const before = await page.getByTestId('tx-table').locator('thead th').count();
      await page.getByTestId('hidden-columns').getByRole('button').click(); // "Mostrar todas"
      await expect(page.getByTestId('tx-table').locator('thead th')).toHaveCount(before + 2); // costs + account
    });
  });
}

test('W54: on the phone the first chart starts within the first screen; KPI cards fill their rows', async ({ page }) => {
  await mockMarket(page, { brl: 'late' });
  await onboardCO(page, '30.000.000', '2024-01-02');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByTestId('gs-next')).toBeVisible();
  const kpis = page.getByTestId('kpis').locator('.card');
  await expect(kpis).toHaveCount(4);
  // One card per row on the phone: every card as wide as the grid (no empty cell next to a lone card).
  const widths = await kpis.evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().width)));
  expect(new Set(widths).size).toBe(1);
  // R7 (W54): the plotted area, not only the chart title, starts within the first screen.
  const heading = page.getByRole('heading', { name: 'Valor vs. aportado' });
  const plotTop = await heading.locator('xpath=ancestor::*[contains(@class,"card")][1]').locator('canvas, svg[role], .echarts-root, [_echarts_instance_]').first().evaluate((e) => e.getBoundingClientRect().top + window.scrollY);
  expect(plotTop + 80, `plot starts at ${plotTop}`).toBeLessThan(844);
  await page.screenshot({ path: `${SHOTS}/r6-phone-dashboard.png` });
});
