/**
 * Round 9 (reviews/web-r8.md): W68 "Todos" equals the sum of the portfolios when a corporate event is
 * recorded in each (NVDA 10:1 from "Todos" and per portfolio, ITUB4 bonificação, AMER3 grupamento).
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


/** Full value of the Resumen's headline figure in a portfolio view ("all" = Todos). */
async function totalIn(page: Page, view: string): Promise<number> {
  const pf = page.locator('#pf-select');
  if (view === 'all') await pf.selectOption('all');
  else await pf.selectOption({ label: view });
  await page.goto('/');
  const v = page.locator('.kpi-primary .kpi-value');
  await expect(v).toHaveAttribute('title', /\d/, { timeout: 30_000 });
  await page.waitForTimeout(800); // the worker's last pass
  const title = (await v.getAttribute('title')) ?? '';
  return Number(title.replace(/[^\d,]/g, '').replace(',', '.'));
}

async function twoPortfolios(page: Page, ccy: string, deposit: string, since: string, file: string) {
  await onboard(page, ccy, deposit, since);
  await importCsv(page, file);
  await importCsv(page, file, { name: 'Cartera B', ccy });
  await expect(page.locator('#pf-select option', { hasText: 'Cartera B' })).toHaveCount(1);
}

async function applyFromBanner(page: Page) {
  await page.goto('/');
  const banner = page.getByTestId('pending-splits');
  await expect(banner.getByTestId('apply-splits')).toBeVisible({ timeout: 30_000 });
  await banner.getByTestId('apply-splits').click();
  await expect(banner).toHaveCount(0, { timeout: 30_000 });
}

const byPf = (list: { portfolioId: string }[]) => Object.values(list.reduce<Record<string, number>>((m, r) => ({ ...m, [r.portfolioId]: (m[r.portfolioId] ?? 0) + 1 }), {}));

async function expectSum(page: Page) {
  const a = await totalIn(page, 'Cartera A');
  const b = await totalIn(page, 'Cartera B');
  const all = await totalIn(page, 'all');
  expect(Math.abs(all - (a + b)), `Todos ${all} vs ${a} + ${b}`).toBeLessThan(1);
  return { a, b, all };
}

test('W68: NVDA 10:1 recorded from "Todos" in two portfolios — Todos = A + B, 150.000 shares, no "ya se importó"', async ({ page }) => {
  await mockProvider(page, { NVDA: [{ type: 'SPLIT', date: '2024-06-10', ratio: 10, source: 'yahoo' }] }, { NVDA: NVDA_SERIES });
  await twoPortfolios(page, 'USD', '1.500.000', '2023-01-02', 'nvda-split.csv');
  await page.locator('#pf-select').selectOption('all');
  await applyFromBanner(page);
  expect(byPf(await rows(page, 'SPLIT'))).toEqual([1, 1]);
  const t = await expectSum(page);
  expect(t.all).toBeCloseTo(200_000 * 121.79 + 73_500, -2); // 2 × 10.000 × 10 shares
  await page.goto('/posiciones');
  await expect(page.getByTestId('positions-table')).toContainText('200.000', { timeout: 30_000 });
  await expect(page.getByTestId('positions-table')).not.toContainText('2.000.000');
  await page.goto('/');
  await expect(page.getByText(/ya se importó/)).toHaveCount(0);
  await page.screenshot({ path: `${SHOTS}/r9-todos-nvda.png` });
});

test('W68: NVDA 10:1 recorded separately in each portfolio — Todos = A + B', async ({ page }) => {
  await mockProvider(page, { NVDA: [{ type: 'SPLIT', date: '2024-06-10', ratio: 10, source: 'yahoo' }] }, { NVDA: NVDA_SERIES });
  await twoPortfolios(page, 'USD', '1.500.000', '2023-01-02', 'nvda-split.csv');
  for (const name of ['Cartera A', 'Cartera B']) {
    await page.locator('#pf-select').selectOption({ label: name });
    await applyFromBanner(page);
  }
  expect(byPf(await rows(page, 'SPLIT'))).toEqual([1, 1]);
  await expectSum(page);
});

test('W68: ITUB4 bonificação 10 % and AMER3 grupamento 1:100 in two portfolios — Todos = A + B', async ({ page }) => {
  await mockProvider(
    page,
    {
      ITUB4: [{ type: 'STOCK_DIVIDEND', date: '2024-03-18', ratio: 0.1, priceFactor: 1.1, source: 'yahoo' }],
      AMER3: [{ type: 'SPLIT', date: '2024-08-27', ratio: 0.01, priceFactor: 0.01, source: 'yahoo' }],
    },
    {
      ITUB4: [['2023-01-05', 25], ['2024-03-15', 33], ['2024-03-18', 30]],
      AMER3: [['2022-12-05', 11.5], ['2024-08-26', 0.05], ['2024-08-27', 7], ['2024-10-31', 6.63]],
    },
  );
  await twoPortfolios(page, 'BRL', '100.000', '2022-12-01', 'itub4.csv');
  // AMER3 into both portfolios (an import goes to the selected one: Cartera B, then Cartera A).
  await importCsv(page, 'amer3.csv');
  await page.locator('#pf-select').selectOption({ label: 'Cartera A' });
  await importCsv(page, 'amer3.csv');
  await page.locator('#pf-select').selectOption('all');
  await page.goto('/');
  const banner = page.getByTestId('pending-splits');
  await expect(banner).toContainText('AMER3', { timeout: 30_000 });
  await expect(banner).toContainText('2 portafolios');
  await banner.getByTestId('apply-splits').click();
  await page.goto('/movimientos');
  // The ITUB4 bonificação (one suggestion per portfolio) is recorded from the inbox.
  await expect(page.getByTestId('suggestions')).toContainText('ITUB4', { timeout: 30_000 });
  await page.getByRole('button', { name: /Registrar todo|Aceptar todo/ }).click();
  await expect.poll(async () => byPf(await rows(page, 'STOCK_DIVIDEND')), { timeout: 15_000 }).toEqual([1, 1]);
  await expectSum(page);
  await page.goto('/posiciones');
  const table = page.getByTestId('positions-table');
  await expect(table).toContainText('220', { timeout: 30_000 }); // 2 × 110 ITUB4
  await expect(table.locator('tr', { hasText: 'AMER3' })).toContainText('40'); // 2 × 2.000 / 100
});
