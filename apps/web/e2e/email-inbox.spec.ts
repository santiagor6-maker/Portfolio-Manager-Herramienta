/** "Importar por correo": drafts from forwarded e-mails → preview (dedup) → confirm → ack by ids. */
import { expect, test } from '@playwright/test';

const SHOTS = 'e2e/screenshots';

test('e-mail drafts go through the import preview and are acknowledged by id', async ({ page }) => {
  const calls: { method: string; url: string; body?: unknown }[] = [];
  let mode: 'off' | 'on' = 'off';
  await page.route('**/api/inbox/email/drafts**', async (route) => {
    const req = route.request();
    calls.push({ method: req.method(), url: req.url(), body: req.postData() ? JSON.parse(req.postData()!) : undefined });
    const json = (status: number, data: unknown) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    if (mode === 'off') return json(503, { error: { code: 'NOT_CONFIGURED', message: 'Inbox not configured' } });
    if (req.method() === 'DELETE') return json(200, { cleared: 1 });
    return json(200, {
      portfolioId: 'x',
      drafts: [
        {
          id: 'draft-1',
          receivedAt: '2026-10-08T14:00:00Z',
          from: 'notas@xpi.com.br',
          subject: 'Nota de corretagem 08/10/2026',
          transactions: [{ id: 't1', portfolioId: 'x', date: '2026-10-08', type: 'BUY', instrumentId: 'BVMF:PETR4', quantity: 100, price: 38.5, amount: 3850, fees: 4.2, currency: 'BRL', importHash: 'mail-h1' }],
          instruments: [],
          attachments: ['nota.pdf'],
          needsPassword: [],
        },
      ],
    });
  });

  await page.goto('/importar');
  const card = page.getByTestId('email-inbox');
  await expect(card).toBeVisible();
  // 503: the server has no INBOX_SECRET / INBOX_RECIPIENTS.
  await card.getByTestId('email-check').click();
  await expect(page.getByTestId('email-error')).toContainText('INBOX_SECRET');
  await card.getByText('Configurar el buzón en el servidor').click();
  await expect(card.getByTestId('email-setup')).toContainText('INBOX_RECIPIENTS=');

  mode = 'on';
  await card.getByLabel('Tu dirección de reenvío').fill('importar+a1b2c3@finanzas.ejemplo.com');
  await card.getByTestId('email-check').click();
  await expect(card.getByTestId('email-draft')).toContainText('Nota de corretagem 08/10/2026');
  await card.screenshot({ path: `${SHOTS}/email-inbox.png` });
  await card.getByTestId('email-review').click();
  await expect(page.getByTestId('import-preview')).toBeVisible();
  await page.getByTestId('import-confirm').click();
  await expect(page.getByText(/1 movimiento importado/)).toBeVisible();
  await expect.poll(() => calls.find((c) => c.method === 'DELETE')?.body).toEqual({ ids: ['draft-1'] });
});
