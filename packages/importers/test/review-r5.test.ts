/**
 * Regression tests for the round-5 review (reviews/importers-r5.md): I40 (quantity × price = value per
 * note line), I41 (e-mail sender authentication bypasses), I42 (resource limits), I43 (held notes too
 * strict), I44 (conversions / mergers of the shared table proposed), I45 (broker names), I46 (PDF details).
 */
import { deflateSync } from 'node:zlib';
import { describe, expect, it, vi } from 'vitest';
import {
  accountsCompatible,
  authVerdict,
  createEmailInboxHandler,
  importEmail,
  importFile,
  importText,
  normalizeBrokerName,
  parseFromAddress,
  rawHeaderFields,
  type ImportResult,
} from '../src';
import { writePdf, type PdfText } from './helpers/pdf-writer';

vi.setConfig({ testTimeout: 30_000 });

const O = { portfolioId: 'p' };
const txs = (r: ImportResult) => r.transactions;

type Tr = [side: string, market: string, spec: string, qty: string, price: string, value: string, dc: string];
function note(trades: Tr[], fin: [string, string, string?][], o: { nr?: string; date?: string; extra?: string[] } = {}): Uint8Array {
  const t: PdfText[] = [
    [230, 815, 'NOTA DE CORRETAGEM', 11], [380, 795, 'Nr. nota'], [450, 795, 'Folha'], [500, 795, 'Data pregão'],
    [380, 783, o.nr ?? '8001'], [450, 783, '1'], [500, 783, o.date ?? '06/03/2024'],
    [40, 755, 'NU INVEST CORRETORA DE VALORES S.A.', 9], [40, 718, 'Negócios realizados', 9], [40, 705, 'Q Negociação'], [105, 705, 'C/V'],
    [125, 705, 'Tipo mercado'], [225, 705, 'Especificação do título'], [345, 705, 'Obs. (*)'], [390, 705, 'Quantidade'], [440, 705, 'Preço / Ajuste'],
    [500, 705, 'Valor Operação'], [565, 705, 'D/C'],
  ];
  let y = 692;
  for (const [side, market, spec, qty, price, value, dc] of trades) {
    t.push([40, y, 'B3 RV LISTADO'], [108, y, side], [125, y, market], [225, y, spec], [395, y, qty], [445, y, price], [505, y, value], [568, y, dc]);
    y -= 11;
  }
  for (const line of o.extra ?? []) {
    t.push([40, y, line]);
    y -= 11;
  }
  y -= 12;
  t.push([320, y, 'Resumo Financeiro', 9]);
  y -= 13;
  for (const [l, v, dc] of fin) {
    t.push([320, y, l], [505, y, v]);
    if (dc) t.push([560, y, dc]);
    y -= 11;
  }
  return writePdf([t]);
}
const FEES: [string, string, string?][] = [['Taxa de liquidação', '0,93', 'D'], ['Emolumentos', '0,25', 'D']];

describe('I40 — quantity × price must equal the printed value on every line', () => {
  it('"180 × 37,00 = 3.700,00" (OCR 100 → 180) is an error with the reading that adds up; the note waits', async () => {
    const r = await importFile({ data: note([['C', 'VISTA', 'PETROBRAS PN N2', '180', '37,00', '3.700,00', 'D'], ['C', 'VISTA', 'VALE ON NM', '10', '66,10', '661,00', 'D']], [...FEES, ['Líquido para 08/03/2024', '4.362,18', 'D']]) }, O);
    const err = r.errors.find((e) => e.code === 'QTY_PRICE_VALUE_MISMATCH')!;
    expect(err.params).toMatchObject({ nota: '8001', spec: 'PETROBRAS PN N2', quantity: 180, price: 37, value: 3700, reading: expect.stringMatching(/^100 × 37/) });
    expect(txs(r)).toEqual([]);
    expect(r.rows.find((x) => x.transaction?.instrumentId === 'BVMF:VALE3')!.status).toBe('pending');
    expect(r.noteChecks).toEqual([expect.objectContaining({ nota: '8001', mismatchLines: [err.line] })]);
  });
  it('rounding inside the tolerance passes (4 decimals price, fractional quantities)', async () => {
    const r = await importFile({ data: note([['C', 'VISTA', 'ITAUSA PN N1', '37', '8,9213', '330,09', 'D']], [['Líquido para 08/03/2024', '330,09', 'D']]) }, O);
    expect(r.errors).toEqual([]);
    expect(txs(r)).toHaveLength(1);
  });
});

describe('I43 — held notes: proportional tolerance, unknown cost labels, leftover kept', () => {
  it('20 trades with 0,08 of rounding difference are not held', async () => {
    const trades: Tr[] = Array.from({ length: 20 }, () => ['C', 'VISTA', 'PETROBRAS PN N2', '1', '37,00', '37,00', 'D']);
    const r = await importFile({ data: note(trades, [['Líquido para 08/03/2024', '740,08', 'D']]) }, O);
    expect(r.noteChecks).toBeUndefined();
    expect(txs(r)).toHaveLength(20);
  });
  it('an unknown fee label that explains the net exactly is accepted as other fees (warning) and kept as a cost', async () => {
    const r = await importFile({ data: note([['C', 'VISTA', 'PETROBRAS PN N2', '100', '37,00', '3.700,00', 'D']], [...FEES, ['Taxa Corretora Custódia Especial', '0,50', 'D'], ['Líquido para 08/03/2024', '3.701,68', 'D']]) }, O);
    expect(r.noteChecks).toBeUndefined();
    expect(r.warnings.find((w) => w.code === 'UNKNOWN_FEE_ACCEPTED')!.params).toMatchObject({ label: 'Taxa Corretora Custódia Especial', amount: 0.5 });
    expect(txs(r)[0]!.fees).toBeCloseTo(1.68, 8);
  });
  it('"Taxa de Transf. de Ativos" is a known cost now', async () => {
    const r = await importFile({ data: note([['C', 'VISTA', 'PETROBRAS PN N2', '100', '37,00', '3.700,00', 'D']], [...FEES, ['Taxa de Transf. de Ativos', '0,50', 'D'], ['Líquido para 08/03/2024', '3.701,68', 'D']]) }, O);
    expect(r.warnings.some((w) => w.code === 'UNKNOWN_FEE_ACCEPTED')).toBe(false);
    expect(txs(r)[0]!.fees).toBeCloseTo(1.68, 8);
  });
});

describe('I46 — PDF details', () => {
  it('BM&F futures lines are unsupported, not unreadable', async () => {
    const r = await importFile({ data: note([['C', 'VISTA', 'PETROBRAS PN N2', '100', '37,00', '3.700,00', 'D']], [...FEES, ['Líquido para 08/03/2024', '3.701,18', 'D']], { extra: ['BMF  C  WIN J24  15/04/2024  1  127.500,0000  DAY TRADE  25,00  D'] }) }, O);
    expect(r.errors).toEqual([]);
    expect(r.rows.some((x) => x.issues.some((i) => i.code === 'UNSUPPORTED_ASSET' && i.params?.value === 'futuro (BM&F)'))).toBe(true);
    expect(txs(r)).toHaveLength(1);
  });
  const statement = (rows: PdfText[]) =>
    writePdf([[
      [40, 810, 'DAVIVIENDA CORREDORES S.A.', 10], [40, 795, 'Periodo: 01/03/2024 al 31/03/2024'],
      [40, 770, 'Fecha'], [110, 770, 'Descripción'], [330, 770, 'Especie'], [400, 770, 'Cantidad'], [470, 770, 'Valor'],
      ...rows,
    ]]);
  it('"Periodo: 01/03/2024 al 31/03/2024" settles DD/MM; withholding written inside the text is added', async () => {
    const r = await importFile({
      data: statement([
        [40, 756, '04/03/2024'], [110, 756, 'ABONO DIVIDENDOS'], [330, 756, 'ISA'], [470, 756, '$ 1.125.400'],
        [110, 744, 'Retención 7% $ 78.778'],
        [40, 730, '05/03/2024'], [110, 730, 'Dividendo ECOPETROL, retención 10% $ 12.000'], [330, 730, 'ECOPETROL'], [470, 730, '$ 120.000'],
      ]),
    }, O);
    expect(r.needsConfirmation).toBeUndefined();
    expect(txs(r)).toEqual([
      expect.objectContaining({ date: '2024-03-04', type: 'DIVIDEND', instrumentId: 'XBOG:ISA', amount: 1_125_400, taxes: 78_778 }),
      expect.objectContaining({ date: '2024-03-05', type: 'DIVIDEND', instrumentId: 'XBOG:ECOPETROL', amount: 120_000, taxes: 12_000 }),
    ]);
  });
});

describe('I44 — conversions and mergers of the shared table are proposed for affected holdings', () => {
  const csv = (rows: string) => `date,type,symbol,exchange,quantity,price,currency\n${rows}`;
  it('NATURA ON bought in 2019 → NATU3 → NTCO3 (2019-12-18) and NTCO3 → NATU3 (2025-07-02), accept by id', async () => {
    const r = await importText(csv('2019-06-10,BUY,NATU3,BVMF,100,50,BRL\n'), O);
    const ids = r.corporateActions!.map((c) => c.id);
    expect(ids).toEqual(['event:BVMF:NATU3>BVMF:NTCO3@2019-12-18', 'event:BVMF:NTCO3>BVMF:NATU3@2025-07-02']);
    expect(r.corporateActions![0]!.proposal).toMatchObject({ transaction: { type: 'SPLIT', subtype: 'MERGER', instrumentId: 'BVMF:NATU3', targetInstrumentId: 'BVMF:NTCO3', ratio: 1, date: '2019-12-18' }, missing: [] });
    const a = await importText(csv('2019-06-10,BUY,NATU3,BVMF,100,50,BRL\n'), { ...O, acceptCorporateActions: [ids[0]!] });
    expect(txs(a).filter((t) => t.type === 'SPLIT').map((t) => [t.instrumentId, t.targetInstrumentId])).toEqual([['BVMF:NATU3', 'BVMF:NTCO3']]);
    // Re-importing with the event applied: not proposed again.
    const again = await importText(csv('2019-06-10,BUY,NATU3,BVMF,100,50,BRL\n'), { ...O, existingTransactions: a.transactions });
    expect(again.corporateActions?.map((c) => c.id)).toEqual(['event:BVMF:NTCO3>BVMF:NATU3@2025-07-02']);
  });
  it('CPLE6 → CPLE5 → CPLE3 + R$ 0,7749 (cash and pay date), step by step; BRFS3 → 0,8521 MBRF3', async () => {
    const r = await importText(csv('2024-02-01,BUY,CPLE6,BVMF,200,9,BRL\n2024-02-01,BUY,BRFS3,BVMF,100,15,BRL\n'), { ...O, acceptCorporateActions: 'all' });
    const splits = txs(r).filter((t) => t.type === 'SPLIT');
    expect(splits.map((t) => [t.instrumentId, t.targetInstrumentId, t.ratio, t.amount ?? 0, t.cashPayDate ?? ''])).toEqual([
      ['BVMF:BRFS3', 'BVMF:MBRF3', 0.8521, 0, ''],
      ['BVMF:CPLE6', 'BVMF:CPLE5', 1, 0, ''],
      ['BVMF:CPLE5', 'BVMF:CPLE3', 1, 154.98, '2025-12-30'],
    ]);
    expect(r.corporateActions!.find((c) => c.id?.includes('CPLE5>'))!.proposal!.cash).toEqual({ amount: 154.98, payDate: '2025-12-30' });
  });
  it('AXIA6 (ex ELET6) → 1,1 AXIA3 on 2026-06-08', async () => {
    const r = await importText(csv('2023-05-02,BUY,ELET6,BVMF,100,40,BRL\n'), O);
    expect(r.corporateActions!.find((c) => c.id === 'event:BVMF:AXIA6>BVMF:AXIA3@2026-06-08')!.proposal!.transaction).toMatchObject({ ratio: 1.1, instrumentId: 'BVMF:AXIA6', targetInstrumentId: 'BVMF:AXIA3' });
  });
});

describe('I45 — broker names are matched on the whole name', () => {
  it.each([
    ['Global Investimentos', 'Global Securities', false], ['Casa de Bolsa', 'Casa de Valores', false],
    ['Credicorp Capital Colombia', 'Credicorp Capital Perú', false], ['Banco do Brasil', 'BB Investimentos', true],
    ['DEGIRO', 'flatexDEGIRO Bank', true], ['Bancolombia', 'Grupo Cibest', true], ['Interactive Brokers', 'Banco Inter', false],
    ['XP', 'CLEAR CORRETORA - GRUPO XP', false], ['Toro Investimentos', 'Toronto Dominion', false], ['Nu Invest', 'Nuvemshop', false],
    ['Foo Corretora', 'Foo', true],
  ])('%s vs %s → %s', (a, b, same) => expect(accountsCompatible(a, b)).toBe(same));
  it('unknown brokers stay unknown, with their own name', () => {
    expect(normalizeBrokerName('Global Investimentos')).toMatchObject({ known: false, displayName: 'Global Investimentos' });
    expect(normalizeBrokerName('Global Securities')).toMatchObject({ known: true, brokerId: 'global-securities' });
  });
});

describe('I41 — e-mail sender authentication cannot be bypassed', () => {
  const SECRET = 'inbox-secret-0123456789';
  const csv = 'date,type,symbol,exchange,quantity,price,currency\r\n2024-03-11,BUY,AAPL,XNAS,3,170.5,USD\r\n';
  const msg = (headers: string[]) =>
    [...headers, 'To: importar+tok123456@portafolio.exemplo', 'Subject: x', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="b"', '',
      '--b', 'Content-Type: text/csv; name="c.csv"', 'Content-Disposition: attachment; filename="c.csv"', '', csv, '--b--', ''].join('\r\n');
  const setup = (extra: Partial<Parameters<typeof createEmailInboxHandler>[0]> = {}) => {
    const saved: unknown[] = [];
    const h = createEmailInboxHandler({
      secret: SECRET, resolveRecipient: (t) => (t === 'tok123456' ? { portfolioId: 'p1' } : undefined), save: (_t, r) => void saved.push(r),
      allowedSenders: [/@(mail\.)?xpi\.com\.br$/], ...extra,
    });
    const post = (body: string | ReadableStream<Uint8Array>, q = '', headers: Record<string, string> = { 'x-inbox-secret': SECRET }) =>
      h(new Request(`https://x/api/inbox/email${q}`, { method: 'POST', headers: { 'content-type': 'message/rfc822', ...headers }, body, ...(typeof body === 'string' ? {} : { duplex: 'half' }) } as RequestInit));
    return { post, saved };
  };
  const GOOD = 'Authentication-Results: mx.provider.exemplo; dkim=pass header.d=xpi.com.br; spf=pass smtp.mailfrom=bounce@mail.xpi.com.br; dmarc=pass header.from=xpi.com.br';
  it('a properly authenticated broker mail passes', async () => {
    const { post, saved } = setup();
    expect((await post(msg([GOOD, 'From: XP <notas@mail.xpi.com.br>']))).status).toBe(200);
    expect(saved).toHaveLength(1);
  });
  it.each([
    ['DKIM d= not aligned (dmarc=fail)', ['Authentication-Results: mx.provider.exemplo; dkim=pass header.d=evil.com; dmarc=fail header.from=xpi.com.br', 'From: XP <notas@xpi.com.br>'], 403],
    ['DKIM d= not aligned (no dmarc)', ['Authentication-Results: mx.provider.exemplo; dkim=pass header.d=evil.com; spf=pass smtp.mailfrom=x@evil.com', 'From: XP <notas@xpi.com.br>'], 403],
    ['forged A-R below the provider\'s', ['Authentication-Results: mx.provider.exemplo; dkim=fail; spf=fail', 'Authentication-Results: mx.provider.exemplo; dkim=pass header.d=xpi.com.br', 'From: <notas@xpi.com.br>'], 403],
    ['comment in From', [GOOD, 'From: attacker@evil.com (XP <noreply@xpi.com.br>)'], 403],
    ['encoded display name', [GOOD, 'From: =?UTF-8?B?PG5vcmVwbHlAeHBpLmNvbS5icj4=?= <attacker@evil.com>'], 403],
    ['two From headers', [GOOD, 'From: <notas@xpi.com.br>', 'From: <attacker@evil.com>'], 400],
    ['group / list in From', [GOOD, 'From: notas@xpi.com.br, attacker@evil.com'], 400],
    ['public-suffix "alignment" (d=com.br)', ['Authentication-Results: mx.provider.exemplo; dkim=pass header.d=com.br', 'From: <notas@xpi.com.br>'], 403],
  ])('%s → %s', async (_n, headers, status) => {
    const { post, saved } = setup();
    expect((await post(msg(headers as string[]))).status).toBe(status);
    expect(saved).toEqual([]);
  });
  it('with authservIds, only the provider\'s header counts (a sender-added "pass" above it is ignored)', async () => {
    const { post } = setup({ authservIds: ['mx.provider.exemplo'] });
    const forgedOnTop = ['Authentication-Results: evil.exemplo; dkim=pass header.d=xpi.com.br', 'Authentication-Results: mx.provider.exemplo; dkim=fail', 'From: <notas@xpi.com.br>'];
    expect((await post(msg(forgedOnTop))).status).toBe(403);
    expect((await post(msg([GOOD, 'From: <notas@xpi.com.br>'])))).toMatchObject({ status: 200 });
  });
  it('From parsing and the verdict, unit level', () => {
    expect(parseFromAddress('"XP <noreply@xpi.com.br>" <a@evil.com>')).toBe('a@evil.com');
    expect(parseFromAddress('a@evil.com (XP <noreply@xpi.com.br>)')).toBe('a@evil.com');
    expect(parseFromAddress('Notas XP <Notas@Mail.XPI.com.br>')).toBe('notas@mail.xpi.com.br');
    expect(parseFromAddress('<a@x.com> <b@y.com>')).toBeUndefined();
    const f = rawHeaderFields('Authentication-Results: mx; spf=pass smtp.mailfrom=bounces.xpi.com.br\r\nFrom: a@xpi.com.br\r\n\r\nbody');
    expect(authVerdict(f, 'xpi.com.br')).toMatchObject({ ok: true });
  });
});

describe('I42 — resource limits', () => {
  const SECRET = 'inbox-secret-0123456789';
  const mk = (o: Partial<Parameters<typeof createEmailInboxHandler>[0]> = {}) =>
    createEmailInboxHandler({ secret: SECRET, resolveRecipient: () => ({ portfolioId: 'p1' }), save: () => {}, requireAuthResults: false, ...o });
  it('the secret is accepted only in its header, never in the URL', async () => {
    const h = mk();
    expect((await h(new Request(`https://x/api/inbox/email?secret=${SECRET}`, { method: 'POST', body: 'From: a@b.co\r\n\r\n' }))).status).toBe(400);
  });
  it('the body is capped while streaming (no content-length)', async () => {
    const h = mk({ maxBytes: 1000 });
    const chunk = new TextEncoder().encode('x'.repeat(600));
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(chunk);
        c.enqueue(chunk);
        c.close();
      },
    });
    const res = await h(new Request('https://x/api/inbox/email', { method: 'POST', headers: { 'x-inbox-secret': SECRET }, body, duplex: 'half' } as RequestInit));
    expect(res.status).toBe(413);
  });
  it('too many attachments: only the first N are imported', async () => {
    const parts = Array.from({ length: 30 }, (_, i) => ['--b', `Content-Type: text/csv; name="c${i}.csv"`, `Content-Disposition: attachment; filename="c${i}.csv"`, '', `date,type,symbol,exchange,quantity,price,currency\r\n2024-03-${String((i % 28) + 1).padStart(2, '0')},BUY,AAPL,XNAS,${i + 1},170.5,USD\r\n`].join('\r\n'));
    const raw = ['From: a@b.co', 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="b"', '', ...parts, '--b--', ''].join('\r\n');
    const r = await importEmail(raw, { ...O, maxAttachments: 5 });
    expect(r.attachments).toHaveLength(5);
    expect(r.ignored.filter((i) => i.reason === 'too_many')).toHaveLength(25);
  });
  it('a PDF bomb (FlateDecode inflating far beyond the budget) is refused before pdf.js parses it', async () => {
    const bomb = deflateSync(Buffer.alloc(30 * 1024 * 1024, 0x20));
    const head = `%PDF-1.4\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R >> endobj\n4 0 obj << /Length ${bomb.length} /Filter /FlateDecode >>\nstream\n`;
    const bytes = new Uint8Array([...Buffer.from(head, 'latin1'), ...bomb, ...Buffer.from('\nendstream\nendobj\ntrailer << /Root 1 0 R >>\n%%EOF\n', 'latin1')]);
    const r = await importFile({ data: bytes }, { ...O, limits: { maxPdfInflatedBytes: 5 * 1024 * 1024 } });
    expect(r.errors[0]).toMatchObject({ code: 'PDF_LIMIT_EXCEEDED', params: { reason: 'inflated' } });
  });
  it('page limit', async () => {
    const pages: PdfText[][] = Array.from({ length: 5 }, () => [[40, 800, 'hola']]);
    const r = await importFile({ data: writePdf(pages) }, { ...O, limits: { maxPdfPages: 3 } });
    expect(r.errors[0]).toMatchObject({ code: 'PDF_LIMIT_EXCEEDED', params: { reason: 'pages', limit: 3 } });
  });
});
