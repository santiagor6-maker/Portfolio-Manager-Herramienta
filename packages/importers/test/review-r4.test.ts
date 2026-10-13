/**
 * Regression tests for the round-4 review (reviews/importers-r4.md): I35 (unreadable note lines),
 * I34 (consolidated IBKR statements), I36 (shared rename table in @pm/core), I37 (NATURA before 2019),
 * I38 (withholding on a second statement line), I39 (learned answer vs table), I2 (e-mail inbox webhook).
 */
import { tickerIdOn, tickerRenameMap, TICKER_EVENTS, type Transaction } from '@pm/core';
import { describe, expect, it, vi } from 'vitest';
import { createEmailInboxHandler, importFile, importText, sinacorTicker, type ImportResult, type InboxTarget } from '../src';
import { TICKER_RENAMES } from '../src/markets';
import type { EmailImportResult } from '../src/email';
import { byLine } from './helpers/load';
import { writePdf, type PdfText } from './helpers/pdf-writer';

// pdf.js loads lazily: the first PDF of a cold run can take several seconds.
vi.setConfig({ testTimeout: 30_000 });

const O = { portfolioId: 'p' };
const txs = (r: ImportResult) => r.transactions;

type Tr = [side: string, market: string, spec: string, qty: string, price: string, value: string, dc: string];
function note(trades: Tr[], fin: [string, string, string?][], o: { nr?: string; date?: string; wrap?: [number, string] } = {}): Uint8Array {
  const t: PdfText[] = [
    [230, 815, 'NOTA DE CORRETAGEM', 11], [380, 795, 'Nr. nota'], [450, 795, 'Folha'], [500, 795, 'Data pregão'],
    [380, 783, o.nr ?? '777'], [450, 783, '1'], [500, 783, o.date ?? '06/03/2024'],
    [40, 755, 'NU INVEST CORRETORA DE VALORES S.A.', 9], [40, 718, 'Negócios realizados', 9], [40, 705, 'Q Negociação'], [105, 705, 'C/V'],
    [125, 705, 'Tipo mercado'], [225, 705, 'Especificação do título'], [345, 705, 'Obs. (*)'], [390, 705, 'Quantidade'], [440, 705, 'Preço / Ajuste'],
    [500, 705, 'Valor Operação'], [565, 705, 'D/C'],
  ];
  let y = 692;
  trades.forEach(([side, market, spec, qty, price, value, dc], k) => {
    t.push([40, y, 'B3 RV LISTADO'], [108, y, side], [125, y, market], [225, y, spec], [395, y, qty], [445, y, price], [505, y, value], [568, y, dc]);
    y -= 12;
    if (o.wrap?.[0] === k) {
      t.push([225, y, o.wrap[1]]);
      y -= 12;
    }
  });
  y -= 12;
  t.push([320, y, 'Resumo Financeiro', 9]);
  y -= 13;
  for (const [l, v, dc] of fin) {
    t.push([320, y, l], [505, y, v]);
    if (dc) t.push([560, y, dc]);
    y -= 12;
  }
  return writePdf([t]);
}
const FEES: [string, string, string?][] = [['Taxa de liquidação', '0,93', 'D'], ['Emolumentos', '0,25', 'D']];
const PETR: Tr = ['C', 'VISTA', 'PETROBRAS PN N2', '100', '37,00', '3.700,00', 'D'];
const ITSA_OCR: Tr = ['C', 'VISTA', 'ITAUSA PN N1', '1OO', '10,00', '1.000,00', 'D'];

describe('I35 — unreadable note lines are never dropped; unreconciled notes wait', () => {
  it.each([
    ['with "Líquido para"', [...FEES, ['Líquido para 08/03/2024', '4.701,18', 'D']] as [string, string, string?][]],
    ['without "Líquido para"', FEES],
  ])('OCR "1OO" %s → UNPARSED_LINE with the raw text and a suggested reading; the rest waits without costs', async (_l, fin) => {
    const r = await importFile({ data: note([PETR, ITSA_OCR], fin) }, O);
    const bad = r.errors.find((e) => e.code === 'UNPARSED_LINE')!;
    expect(bad.params).toMatchObject({ nota: '777', text: expect.stringContaining('ITAUSA PN N1  1OO'), reading: 'C ITAUSA PN N1 100 × 10' });
    expect(txs(r)).toEqual([]);
    const petr = r.rows.find((x) => x.transaction?.instrumentId === 'BVMF:PETR4')!;
    expect(petr.status).toBe('pending');
    expect(petr.transaction!.fees).toBeUndefined(); // costs are NOT loaded onto the trade that was read
    expect(r.noteChecks).toEqual([expect.objectContaining({ nota: '777', expectedNet: -3701.18, costs: 1.18, unparsedLines: [bad.line] })]);
  });
  it('accepting the note (after entering the unreadable trade by hand) imports it with its costs', async () => {
    const r = await importFile({ data: note([PETR, ITSA_OCR], FEES) }, { ...O, acceptNotes: ['777'] });
    expect(txs(r)).toEqual([expect.objectContaining({ instrumentId: 'BVMF:PETR4', fees: 1.18 })]);
    expect(r.errors.map((e) => e.code)).toEqual(['UNPARSED_LINE']); // still reported
  });
  it('a note that reconciles imports normally; a specification wrapped onto a second line is joined', async () => {
    const r = await importFile({ data: note([['C', 'VISTA', 'ITAUUNIBANCO', '100', '33,40', '3.340,00', 'D']], [...FEES, ['Líquido para 08/03/2024', '3.341,18', 'D']], { wrap: [0, 'PN EJ N1'] }) }, O);
    expect(txs(r)).toEqual([expect.objectContaining({ instrumentId: 'BVMF:ITUB4', note: 'Nota 777 · ITAUUNIBANCO PN EJ N1', fees: 1.18 })]);
    expect(r.noteChecks).toBeUndefined();
  });
});

describe('I34 — consolidated IBKR Activity Statement (linked accounts)', () => {
  const csv =
    'Statement,Header,Field Name,Field Value\nStatement,Data,Title,Activity Statement\nStatement,Data,Period,"January 1, 2024 - June 30, 2024"\n' +
    'Account Information,Header,Field Name,Field Value\nAccount Information,Data,Account,U1111111 (Consolidated)\n' +
    'Trades,Header,DataDiscriminator,Asset Category,Currency,Account,Symbol,Date/Time,Quantity,T. Price,C. Price,Proceeds,Comm/Fee,Basis,Realized P/L,MTM P/L,Code\n' +
    'Trades,Data,Order,Stocks,USD,U1111111,AAPL,"2024-01-03, 10:30:00",10,185,185,-1850,-1,1851,0,0,O\n' +
    'Trades,Data,Order,Stocks,USD,U2222222,AAPL,"2024-01-03, 10:30:00",10,185,185,-1850,-1,1851,0,0,O\n' +
    'Deposits & Withdrawals,Header,Currency,Account,Settle Date,Description,Amount\n' +
    'Deposits & Withdrawals,Data,USD,U1111111,2024-01-02,Electronic Fund Transfer,2000\nDeposits & Withdrawals,Data,USD,U2222222,2024-01-02,Electronic Fund Transfer,2000\n' +
    'Dividends,Header,Currency,Account,Date,Description,Amount\n' +
    'Dividends,Data,USD,U1111111,2024-05-16,AAPL(US0378331005) Cash Dividend USD 0.25 per Share (Ordinary Dividend),2.5\n' +
    'Dividends,Data,USD,U2222222,2024-05-16,AAPL(US0378331005) Cash Dividend USD 0.25 per Share (Ordinary Dividend),2.5\n' +
    'Withholding Tax,Header,Currency,Account,Date,Description,Amount,Code\n' +
    'Withholding Tax,Data,USD,U2222222,2024-05-16,AAPL(US0378331005) Cash Dividend USD 0.25 per Share - US Tax,-0.75,\n' +
    'Open Positions,Header,DataDiscriminator,Asset Category,Currency,Account,Symbol,Quantity,Mult,Cost Price,Cost Basis,Close Price,Value,Unrealized P/L,Code\n' +
    'Open Positions,Data,Summary,Stocks,USD,U1111111,AAPL,10,1,185,1850,200,2000,150,\nOpen Positions,Data,Summary,Stocks,USD,U2222222,AAPL,10,1,185,1850,200,2000,150,\n' +
    'Cash Report,Header,Currency Summary,Currency,Account,Total,Securities,Futures,Month to Date,Year to Date,\n' +
    'Cash Report,Data,Ending Cash,USD,U1111111,151.5,151.5,0,0,0,\nCash Report,Data,Ending Cash,USD,U2222222,150.75,150.75,0,0,0,\n';
  it('every row keeps its account; dividends and withholding stay in their account', async () => {
    const r = await importText(csv, O);
    expect(txs(r).map((t) => [t.type, t.account])).toEqual([
      ['BUY', 'U1111111'], ['BUY', 'U2222222'], ['DEPOSIT', 'U1111111'], ['DEPOSIT', 'U2222222'], ['DIVIDEND', 'U1111111'], ['DIVIDEND', 'U2222222'],
    ]);
    expect(txs(r).filter((t) => t.type === 'DIVIDEND').map((t) => t.taxes ?? 0)).toEqual([0, 0.75]);
    expect(r.warnings.some((w) => w.code === 'POSSIBLE_DUPLICATE_IN_FILE')).toBe(false);
  });
  it('reconciliation compares each account with its own transactions (no false differences)', async () => {
    const r = await importText(csv, O);
    expect(r.reconciliation).toMatchObject({ accounts: ['U1111111', 'U2222222'], positionDifferences: [], cashDifferences: [] });
    expect(r.warnings.some((w) => w.code === 'RECONCILIATION_DIFF')).toBe(false);
    // A real difference is reported on its account.
    const extra: Transaction = { id: 'x', portfolioId: 'p', date: '2024-02-01', type: 'BUY', instrumentId: 'XNAS:AAPL', quantity: 5, price: 180, amount: 900, currency: 'USD', account: 'U2222222', source: 'manual' };
    const d = await importText(csv, { ...O, existingTransactions: [extra] });
    expect(d.reconciliation!.positionDifferences).toEqual([expect.objectContaining({ account: 'U2222222', reported: 10, computed: 15 })]);
  });
});

describe('I36 / I37 — one rename table in @pm/core, shared with market-data', () => {
  it('the core table has every rename (incl. TRPL → ISAE and ELET6 → AXIA6) and the importers use it', () => {
    expect(tickerRenameMap()).toMatchObject({
      'BVMF:ELET3': 'BVMF:AXIA3', 'BVMF:ELET6': 'BVMF:AXIA6', 'BVMF:TRPL3': 'BVMF:ISAE3', 'BVMF:TRPL4': 'BVMF:ISAE4', 'BVMF:EMBR3': 'BVMF:EMBJ3',
      'BVMF:CCRO3': 'BVMF:MOTV3', 'BVMF:MRFG3': 'BVMF:MBRF3', 'XBOG:PFBCOLOM': 'XBOG:PFCIBEST', 'XBOG:BCOLOMBIA': 'XBOG:CIBEST',
    });
    expect(TICKER_RENAMES).toEqual(tickerRenameMap());
    // Mergers and conversions are not renames.
    expect(TICKER_RENAMES['BVMF:BRFS3']).toBeUndefined();
    expect(TICKER_EVENTS.find((e) => e.fromId === 'BVMF:CPLE5')).toMatchObject({ kind: 'conversion', cashPerShare: 0.7749 });
  });
  it('ELET6 resolves to AXIA6 like ELET3 to AXIA3', async () => {
    const r = await importText('date,type,symbol,exchange,quantity,price,currency\n2023-05-02,BUY,ELET6,BVMF,10,40,BRL\n', O);
    expect(txs(r)[0]!.instrumentId).toBe('BVMF:AXIA6');
  });
  it('NATURA ON by date: NATU3 (Natura Cosméticos) before 2019-12-18, NTCO3 until 2025-07-01, NATU3 again after', () => {
    expect(tickerIdOn('BVMF:NATU3', '2019-06-10')).toBe('BVMF:NATU3');
    expect(tickerIdOn('BVMF:NATU3', '2019-12-18')).toBe('BVMF:NTCO3');
    expect(tickerIdOn('BVMF:NATU3', '2025-07-01')).toBe('BVMF:NTCO3');
    expect(tickerIdOn('BVMF:NATU3', '2025-07-02')).toBe('BVMF:NATU3');
    expect(sinacorTicker('NATURA ON NM', '2019-06-10')).toBe('NATU3');
    expect(sinacorTicker('NATURA ON NM', '2024-07-02')).toBe('NTCO3');
    expect(sinacorTicker('NATURA ON NM', '2025-08-05')).toBe('NATU3');
  });
  it('a 2019 note with NATURA ON imports as NATU3', async () => {
    const r = await importFile({ data: note([['C', 'VISTA', 'NATURA ON NM', '100', '50,00', '5.000,00', 'D']], [...FEES, ['Líquido para 12/06/2019', '5.001,18', 'D']], { date: '10/06/2019' }) }, O);
    expect(txs(r)[0]).toMatchObject({ instrumentId: 'BVMF:NATU3', date: '2019-06-10' });
  });
});

describe('I38 — withholding / commission on the next line of a Colombian statement', () => {
  it('"ABONO DIVIDENDOS ISA $ 1.125.400" + "Retención 7% $ 78.778" → one dividend with taxes', async () => {
    const t: PdfText[] = [
      [40, 810, 'DAVIVIENDA CORREDORES S.A.', 10], [40, 795, 'Periodo: 01/03/2024 - 31/03/2024'],
      [40, 770, 'Fecha'], [110, 770, 'Descripción'], [260, 770, 'Especie'], [360, 770, 'Cantidad'], [460, 770, 'Valor'],
      [40, 756, '20/03/2024'], [110, 756, 'ABONO DIVIDENDOS'], [260, 756, 'ISA'], [460, 756, '$ 1.125.400'],
      [110, 744, 'Retención 7%'], [460, 744, '$ 78.778'],
      [40, 730, '22/03/2024'], [110, 730, 'Compra acciones'], [260, 730, 'ECOPETROL'], [360, 730, '1.000'], [460, 730, '$ 2.380.000'],
      [110, 718, 'Comisión'], [460, 718, '$ 7.140'],
    ];
    const r = await importFile({ data: writePdf([t]) }, O);
    expect(txs(r)).toEqual([
      expect.objectContaining({ type: 'DIVIDEND', instrumentId: 'XBOG:ISA', amount: 1_125_400, taxes: 78_778 }),
      expect.objectContaining({ type: 'BUY', instrumentId: 'XBOG:ECOPETROL', quantity: 1000, fees: 7140 }),
    ]);
    expect(r.rows.filter((x) => x.issues.some((i) => i.code === 'CONTINUATION_MERGED'))).toHaveLength(2);
  });
});

describe('I39 — a learned answer that contradicts the built-in table is flagged', () => {
  it('GERDAU MET PN N1 was imported as GGBR4 before; the table says GOAU4', async () => {
    const old: Transaction = { id: 'o', portfolioId: 'p', date: '2023-01-02', type: 'BUY', instrumentId: 'BVMF:GGBR4', quantity: 10, price: 20, amount: 200, currency: 'BRL', note: 'Nota 1 · GERDAU MET PN N1', source: 'import:nota-sinacor-pdf' };
    const r = await importFile({ data: note([['C', 'VISTA', 'GERDAU MET PN N1', '100', '10,00', '1.000,00', 'D']], [...FEES, ['Líquido para 08/03/2024', '1.001,18', 'D']]) }, { ...O, existingTransactions: [old] });
    expect(txs(r)[0]!.instrumentId).toBe('BVMF:GOAU4');
    expect(r.warnings.find((w) => w.code === 'SECURITY_ANSWER_CONFLICT')!.params).toEqual({ spec: 'GERDAU MET PN N1', learned: 'BVMF:GGBR4', table: 'BVMF:GOAU4' });
  });
});

describe('I2 — e-mail inbox webhook (ready to mount)', () => {
  const csv = 'date,type,symbol,exchange,quantity,price,currency\r\n2024-03-11,BUY,AAPL,XNAS,3,170.5,USD\r\n';
  const mail = (from: string, auth: string, to = 'importar+tok123456@portafolio.exemplo') =>
    [
      `From: Broker <${from}>`, `To: ${to}`, 'Subject: confirmation', auth, 'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="b"', '',
      '--b', 'Content-Type: text/csv; name="c.csv"', 'Content-Disposition: attachment; filename="c.csv"', '', csv, '--b--', '',
    ].join('\r\n');
  const setup = () => {
    const saved: [InboxTarget, EmailImportResult][] = [];
    const h = createEmailInboxHandler({
      secret: 'inbox-secret-0123456789',
      resolveRecipient: (t) => (t === 'tok123456' ? { portfolioId: 'p1' } : undefined),
      save: (t, r) => void saved.push([t, r]),
      allowedSenders: [/@broker\.exemplo$/],
    });
    const post = (body: string, secret = 'inbox-secret-0123456789') => h(new Request('https://x/api/inbox/email', { method: 'POST', headers: { 'x-inbox-secret': secret, 'content-type': 'message/rfc822' }, body }));
    return { saved, post };
  };
  const OK_AUTH = 'Authentication-Results: mx.exemplo; spf=pass smtp.mailfrom=broker.exemplo; dkim=pass header.d=broker.exemplo';
  it('authenticated mail from an allowed sender to a known recipient is imported and saved as a draft', async () => {
    const { saved, post } = setup();
    const res = await post(mail('confirm@broker.exemplo', OK_AUTH));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ portfolioId: 'p1', transactions: 1, attachments: [{ fileName: 'c.csv', imported: 1 }] });
    expect(saved[0]![1].transactions[0]).toMatchObject({ instrumentId: 'XNAS:AAPL', portfolioId: 'p1' });
  });
  it('rejects a wrong secret, unknown senders, unauthenticated mail and unknown recipients', async () => {
    const { saved, post } = setup();
    expect((await post(mail('confirm@broker.exemplo', OK_AUTH), 'wrong-secret-0123456789')).status).toBe(401);
    expect((await post(mail('evil@phish.exemplo', OK_AUTH))).status).toBe(403);
    expect((await post(mail('confirm@broker.exemplo', 'Authentication-Results: mx; spf=fail; dkim=none'))).status).toBe(403);
    expect((await post(mail('confirm@broker.exemplo', OK_AUTH, 'importar+nobody999@portafolio.exemplo'))).status).toBe(404);
    expect(saved).toEqual([]);
  });
});

it('byLine helper still available', () => expect(typeof byLine).toBe('function'));
