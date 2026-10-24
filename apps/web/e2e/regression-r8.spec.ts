/**
 * Round 8 (reviews/web-r7.md): W61 double clicks write once, W62 B3 grupamentos reach the Resumen,
 * W64 a split from "Todos" goes to every holder, W65 "+ Nuevo portafolio" in Importar creates one.
 */
import { expect, test, type Page, type Route } from '@playwright/test';

const SHOTS = 'e2e/screenshots';
const today = () => new Date().toISOString().slice(0, 10);
const NVDA_SERIES: [string, number][] = [['2023-01-05', 142.65], ['2024-06-07', 1208.88], ['2024-06-10', 121.79]];

async function mockProvider(page: Page, actions: Record<string, unknown[]>, series: Record<string, [string, number][]>) {
  await page.route('**/api/health', (route) => route.fulfill({ json: { ok: true, service: 'mock', version: '0', time: new Date().toISOString() } }));
  await page.route('**/api/batch', async (route: Route) => {
    const req = route.request().postDataJSON() as { histories?: { symbol: string }[]; fx?: { base: string; quote: string; from: string }[]; quotes?: unknown[]; indices?: unknown[] };
    const err = { ok: false, error: { code: 'NOT_FOUND', message: 'mock' } };
    await route.fulfill({
      json: {
        histories: (req.histories ?? []).map((h) => {
          const key = Object.keys(series).find((k) => h.symbol.includes(k));
          if (!key) return err;
          const ccy = key === 'NVDA' ? 'USD' : 'BRL';
          return { ok: true, data: { requested: h.symbol, providerSymbol: key, interval: '1d', actions: actions[key] ?? [], series: { currency: ccy, source: 'mock', points: [...series[key]!, [today(), series[key]!.at(-1)![1]]].map(([date, close]) => ({ date, close })) } } };
        }),
        fx: (req.fx ?? []).map((r) => ({ ok: true, data: { interval: '1d', series: { base: r.base, quote: r.quote, source: 'mock', points: [{ date: r.from, rate: r.quote === 'BRL' ? 5 : 4000 }, { date: today(), rate: r.quote === 'BRL' ? 5 : 4000 }] } } })),
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
  await wizard.getByLabel('Nombre').fill('Cartera A');
  await wizard.getByLabel('Moneda base').selectOption(ccy);
  await wizard.getByTestId('onboarding-create').click();
  await wizard.getByLabel(/Aporte inicial/).fill(deposit);
  await wizard.getByLabel('¿Desde cuándo inviertes?').fill(date);
  await wizard.getByRole('button', { name: 'Siguiente' }).click();
  await wizard.getByRole('button', { name: /Ir al resumen/ }).click();
}

async function importCsv(page: Page, file: string, newPortfolio?: { name: string; ccy: string }) {
  await page.goto('/importar');
  if (newPortfolio) {
    await page.locator('#i-pf').selectOption('__new');
    await page.locator('#i-new-name').fill(newPortfolio.name);
    await page.locator('#i-new-ccy').selectOption(newPortfolio.ccy);
  }
  await page.getByTestId('import-file').setInputFiles(`e2e/fixtures/${file}`);
  await expect(page.getByTestId('import-preview')).toBeVisible({ timeout: 30_000 });
  await page.getByTestId('import-confirm').click();
  await expect(page.getByText(/importado/)).toBeVisible();
}

/** Rows of the local database (IndexedDB), for asserting what a click really wrote. */
async function rows(page: Page, type?: string): Promise<{ portfolioId: string; type: string; instrumentId?: string; quantity?: number }[]> {
  return page.evaluate(
    (type) =>
      new Promise((resolve, reject) => {
        const open = indexedDB.open('portafolio-pro');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const req = open.result.transaction('transactions').objectStore('transactions').getAll();
          req.onsuccess = () => {
            resolve((req.result as { type: string }[]).filter((r) => !type || r.type === type));
            open.result.close();
          };
        };
      }),
    type,
  );
}

test('W61: a double click on "Crear aporte" and on "Registrar split" in the Diagnóstico writes once', async ({ page }) => {
  await mockProvider(page, {}, { NVDA: NVDA_SERIES });
  await onboard(page, 'USD', '1.000', '2023-01-02');
  await importCsv(page, 'nvda-split.csv');
  await page.goto('/movimientos');
  const diag = page.getByTestId('diagnostics');
  await expect(diag.getByTestId('create-deposit').first()).toBeVisible({ timeout: 30_000 });
  await diag.getByTestId('create-deposit').first().dblclick();
  await expect.poll(async () => (await rows(page, 'DEPOSIT')).length, { timeout: 10_000 }).toBe(2);
  await expect(diag.getByTestId('create-deposit')).toHaveCount(0);
  await expect(diag).toHaveAttribute('open', ''); // stays open after the fix
  await expect(diag.getByTestId('record-split').first()).toBeVisible({ timeout: 30_000 });
  await diag.getByTestId('record-split').first().dblclick();
  await expect.poll(async () => (await rows(page, 'SPLIT')).length, { timeout: 10_000 }).toBe(1);
  await page.waitForTimeout(1500);
  expect((await rows(page, 'SPLIT')).length).toBe(1);
  expect((await rows(page, 'DEPOSIT')).length).toBe(2);
  await page.goto('/');
  await expect(page.getByTestId('kpis')).toContainText('12.179.000', { timeout: 30_000 }); // 100.000 NVDA × 121,79
});

test('W62: 2.000 AMER3 and the 1:100 grupamento (sent as "SPINOFF to review") alert on the Resumen and fix in one click', async ({ page }) => {
  await mockProvider(
    page,
    { AMER3: [{ instrumentId: 'BVMF:AMER3', type: 'SPLIT', subtype: 'SPINOFF', date: '2024-08-27', priceFactor: 0.01, costFraction: -99, reviewRequired: true, source: 'yahoo' }] },
    { AMER3: [['2022-12-05', 11.5], ['2024-08-26', 0.05], ['2024-08-27', 7], ['2024-10-31', 6.63]] },
  );
  await onboard(page, 'BRL', '50.000', '2022-12-01');
  await importCsv(page, 'amer3.csv');
  await page.goto('/');
  const banner = page.getByTestId('pending-splits');
  await expect(banner).toContainText('AMER3', { timeout: 30_000 });
  await expect(banner).toContainText('1:100');
  await expect(page.getByText('Todo en orden')).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/r8-amer3-banner.png` });
  await banner.getByTestId('apply-splits').dblclick();
  await expect.poll(async () => (await rows(page, 'SPLIT')).map((r) => r.instrumentId), { timeout: 10_000 }).toEqual(['BVMF:AMER3']);
  await page.goto('/posiciones');
  await expect(page.getByTestId('positions-table')).toContainText('20', { timeout: 30_000 });
  await expect(page.getByTestId('positions-table')).not.toContainText('2.000');
});

test('W64/W65: "+ Nuevo portafolio" creates a portfolio; from "Todos" the split goes to both holders', async ({ page }) => {
  await mockProvider(page, { NVDA: [{ type: 'SPLIT', date: '2024-06-10', ratio: 10, source: 'yahoo' }] }, { NVDA: NVDA_SERIES });
  await onboard(page, 'USD', '1.500.000', '2023-01-02');
  await importCsv(page, 'nvda-split.csv');
  await importCsv(page, 'nvda-split.csv', { name: 'Cartera B', ccy: 'USD' });
  const pf = page.locator('#pf-select');
  await expect(pf.locator('option', { hasText: 'Cartera B' })).toHaveCount(1);
  await expect(pf.locator('option', { hasText: 'Cartera A' })).toHaveCount(1);
  const byPf = (list: { portfolioId: string }[]) => Object.values(list.reduce<Record<string, number>>((m, r) => ({ ...m, [r.portfolioId]: (m[r.portfolioId] ?? 0) + 1 }), {}));
  expect(byPf(await rows(page, 'BUY'))).toEqual([1, 1]); // one BUY in each, none duplicated into A
  await pf.selectOption('all');
  await page.goto('/');
  const banner = page.getByTestId('pending-splits');
  await expect(banner).toContainText('2 portafolios', { timeout: 30_000 });
  await banner.getByTestId('apply-splits').click();
  await expect.poll(async () => byPf(await rows(page, 'SPLIT')), { timeout: 10_000 }).toEqual([1, 1]);
  await expect(banner).toHaveCount(0);
  // The other portfolio's view has no stale alert either.
  await pf.selectOption({ label: 'Cartera B' });
  await expect(page.getByTestId('kpis')).toContainText(/\d/, { timeout: 30_000 });
  await expect(page.getByTestId('pending-splits')).toHaveCount(0);
});

/**
 * W63: on the phone every KPI figure, on every page, is at least 16 px, on one line, never cut and
 * never with an ellipsis; labels are not cut either.
 */
async function phoneKpiProblems(page: Page): Promise<string[]> {
  return page.locator('.kpi-value').evaluateAll((els) =>
    els.flatMap((el) => {
      const e = el as HTMLElement;
      if (!e.offsetParent) return [];
      const text = (e.textContent ?? '').trim();
      const out: string[] = [];
      const size = parseFloat(getComputedStyle(e).fontSize);
      if (size < 16) out.push(`${text}: ${size}px`);
      if (e.scrollWidth > e.clientWidth + 1) out.push(`${text}: cut ${e.scrollWidth}>${e.clientWidth}`);
      if (e.dataset.ellipsis) out.push(`${text}: ellipsis`);
      const range = document.createRange();
      range.selectNodeContents(e);
      const tops = new Set(Array.from(range.getClientRects()).filter((r) => r.width > 0).map((r) => Math.round(r.top / 6)));
      if (tops.size > 1) out.push(`${text}: ${tops.size} lines`);
      const label = e.closest('.card')?.firstElementChild as HTMLElement | null;
      if (label && (label.scrollWidth > label.clientWidth + 1 || label.scrollHeight > label.clientHeight + 1)) out.push(`label «${label.textContent}» cut`);
      return out;
    }),
  );
}

for (const [locale, width, ccys] of [['es-CO', 390, ['COP', 'USD']], ['pt-BR', 360, ['BRL', 'COP']]] as const) {
  test.describe(`W63 in ${locale}`, () => {
    test.use({ locale });
    test(`every KPI card at ${width} px keeps its figure whole and ≥ 16 px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 844 });
      await page.goto('/');
      await expect(page.getByTestId('kpis')).toContainText(/\d/, { timeout: 30_000 });
      for (const ccy of ccys) {
        await page.getByTestId('currency-switch').selectOption(ccy);
        for (const path of ['/', '/rendimiento', '/divisas', '/dividendos', '/mensual', '/impuestos']) {
          await page.goto(path);
          await expect(page.locator('.kpi-value').first()).toBeVisible({ timeout: 30_000 });
          await expect(page.locator('.kpi-value').first()).toContainText(/\d|—/);
          await page.waitForTimeout(250);
          expect(await phoneKpiProblems(page), `${locale} ${ccy} ${path} ${width}px`).toEqual([]);
        }
      }
      await page.goto('/impuestos');
      await expect(page.locator('.kpi-value').first()).toBeVisible({ timeout: 30_000 });
      await page.screenshot({ path: `${SHOTS}/r8-phone-taxes-${locale}.png` });
    });
  });
}

test('W66: Impuestos opens on Brasil for a BRL portfolio (no tax residence set) and names the tabs in the language', async ({ page }) => {
  await mockProvider(page, {}, {});
  await onboard(page, 'BRL', '10.000', '2025-01-02');
  await page.goto('/impuestos');
  const tabs = page.getByRole('group', { name: /residencia fiscal/i });
  await expect(tabs.getByRole('button', { name: /Brasil/ })).toHaveAttribute('aria-pressed', 'true', { timeout: 30_000 });
  await expect(tabs.getByRole('button', { name: /Colombia/ })).toHaveAttribute('aria-pressed', 'false');
  // Portuguese names the tab «Colômbia».
  await page.goto('/ajustes');
  await page.getByLabel(/Idioma/).selectOption('pt');
  // Navigate in the app (a reload could race the saved language setting).
  await page.getByRole('link', { name: 'Impostos' }).click();
  await expect(page.getByRole('heading', { name: 'Impostos' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: /Colômbia/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /Brasil/ })).toHaveAttribute('aria-pressed', 'true');
});
