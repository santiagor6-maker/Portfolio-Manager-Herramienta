/**
 * Real-like SINACOR notes (I31) for XP, Clear, BTG, Inter and Nu Invest, built from the public layout of
 * the standard "nota de negociação" (CBLC/B3 SINACOR): header box with Nr. nota / Folha / Data pregão,
 * broker block (name, address, CNPJ, SAC, Ouvidoria), client block, "Negócios realizados" with the 10
 * standard columns, the two-column "Resumo dos Negócios" | "Resumo Financeiro" (Clearing, Bolsa, Custos
 * Operacionais, Total CBLC / Total Bovespa / Total Custos subtotals that must NOT be added as costs),
 * "Especificações diversas", the Obs (*) legend, multi-page notes with "CONTINUA...", and IRRF lines with
 * their base ("I.R.R.F. s/ operações, base R$ 3.312,00  0,16").
 *
 * Each broker differs in what breaks parsers: font, how text is drawn (cell / word / glyph / TJ with
 * kerning), compression, drawing order, encryption (RC4 / AES), header layout (labels over values or
 * stacked "Nr. nota: 123"), "1-BOVESPA" vs "B3 RV LISTADO", title on the broker name's baseline.
 * Identifiers (CPF, CNPJ, addresses, phone numbers) are placeholders.
 */
import { writeRealPdf, type RealPage, type RealPdfOptions, type RealText } from '../../helpers/pdf-real';

export interface NoteTrade {
  side: 'C' | 'V';
  market: string;
  prazo?: string;
  spec: string;
  obs?: string;
  qty: number;
  price: number;
  /** Expected instrument id after import (undefined = must be asked). */
  expect?: string;
}

export interface NoteSpec {
  broker: string;
  nr: string;
  date: string; // dd/mm/yyyy
  /** Trades per page (a note can span pages: "CONTINUA..."). */
  pages: NoteTrade[][];
  qNeg: string;
  header: 'grid' | 'stacked';
  /** Print the title on the same baseline as the broker name (header box beside it). */
  titleOnBrokerLine?: boolean;
  extraCosts?: { label: string; value: number; dc: 'D' | 'C' }[];
  termo?: number;
  irrfDayTrade?: number;
  pdf: RealPdfOptions;
}

export const br = (n: number, dec = 2) => {
  const [i, d] = Math.abs(n).toFixed(dec).split('.');
  return `${n < 0 ? '-' : ''}${i!.replace(/\B(?=(\d{3})+(?!\d))/g, '.')}${dec ? `,${d}` : ''}`;
};
const r2 = (n: number) => Math.round(n * 100) / 100;

export interface NoteTotals {
  sells: number;
  buys: number;
  liquidacao: number;
  emolumentos: number;
  irrf: number;
  costs: number;
  net: number;
}

export function noteTotals(n: NoteSpec): NoteTotals {
  const all = n.pages.flat();
  const val = (t: NoteTrade) => r2(t.qty * t.price);
  const sells = r2(all.filter((t) => t.side === 'V').reduce((a, t) => a + val(t), 0));
  const buys = r2(all.filter((t) => t.side === 'C').reduce((a, t) => a + val(t), 0));
  const total = sells + buys;
  const liquidacao = r2(total * 0.00025);
  const emolumentos = r2(total * 0.00005);
  const swingSells = all.filter((t) => t.side === 'V' && !t.obs?.includes('D')).reduce((a, t) => a + val(t), 0);
  const irrf = r2(swingSells * 0.00005);
  const extra = (n.extraCosts ?? []).reduce((a, c) => a + (c.dc === 'C' ? -c.value : c.value), 0);
  const costs = r2(liquidacao + emolumentos + extra + (n.termo ?? 0));
  const net = r2(sells - buys - costs - irrf - (n.irrfDayTrade ?? 0));
  return { sells, buys, liquidacao, emolumentos, irrf, costs, net };
}

const COL = { q: 40, cv: 100, tipo: 116, prazo: 172, spec: 200, obs: 340, qtyL: 398, qtyR: 440, priceL: 447, priceR: 490, valL: 497, valR: 565, dc: 572 };

function header(n: NoteSpec, folha: number): RealText[] {
  const t: RealText[] = [];
  const brokerY = 815;
  t.push({ x: 40, y: brokerY, text: n.broker, size: 9, font: 'HB' });
  t.push({ x: n.titleOnBrokerLine ? 400 : 395, y: n.titleOnBrokerLine ? brokerY : 826, text: 'NOTA DE NEGOCIAÇÃO', size: 10, font: 'HB' });
  if (n.header === 'grid') {
    t.push({ x: 365, y: 804, text: 'Nr. nota' }, { x: 450, y: 804, text: 'Folha' }, { x: 505, y: 804, text: 'Data pregão' });
    t.push({ x: 365, y: 793, text: n.nr }, { x: 450, y: 793, text: String(folha) }, { x: 505, y: 793, text: n.date });
  } else {
    t.push({ x: 430, y: 804, text: `Nr. nota: ${n.nr}` }, { x: 430, y: 794, text: `Folha: ${folha}` }, { x: 430, y: 784, text: `Data pregão: ${n.date}` });
  }
  t.push(
    { x: 40, y: 805, text: 'Av. Exemplo, 1000 - 10º andar - Centro - São Paulo - SP - 00000-000', size: 6 },
    { x: 40, y: 797, text: 'Tel. (11) 0000-0000   Fax: (11) 0000-0001', size: 6 },
    { x: 40, y: 789, text: 'Internet: www.corretora.exemplo   SAC: 0800 000 0000   e-mail: atendimento@corretora.exemplo', size: 6 },
    { x: 40, y: 781, text: 'C.N.P.J: 00.000.000/0001-00   Carta Patente: 0000', size: 6 },
    { x: 40, y: 773, text: 'Ouvidoria: Tel. 0800 000 0002   e-mail: ouvidoria@corretora.exemplo', size: 6 },
    { x: 40, y: 755, text: 'Cliente', size: 6 }, { x: 330, y: 755, text: 'C.P.F./C.N.P.J/C.V.M./C.O.B.', size: 6 }, { x: 480, y: 755, text: 'Código cliente', size: 6 },
    { x: 40, y: 746, text: 'FULANO DE TAL' }, { x: 330, y: 746, text: '000.000.000-00' }, { x: 480, y: 746, text: '0000000' },
    { x: 40, y: 735, text: 'Banco', size: 6 }, { x: 90, y: 735, text: 'Agência', size: 6 }, { x: 140, y: 735, text: 'Conta corrente', size: 6 },
    { x: 220, y: 735, text: 'Acionista', size: 6 }, { x: 290, y: 735, text: 'Admin.', size: 6 }, { x: 360, y: 735, text: 'Complemento nome', size: 6 }, { x: 480, y: 735, text: 'P. Vinc', size: 6 },
    { x: 40, y: 726, text: '000' }, { x: 90, y: 726, text: '0000' }, { x: 140, y: 726, text: '00000-0' }, { x: 220, y: 726, text: '0000000' }, { x: 480, y: 726, text: 'N' },
    { x: 40, y: 708, text: 'Negócios realizados', size: 8, font: 'HB' },
    { x: COL.q, y: 697, text: 'Q Negociação', size: 6 }, { x: COL.cv, y: 697, text: 'C/V', size: 6 }, { x: COL.tipo, y: 697, text: 'Tipo mercado', size: 6 },
    { x: COL.prazo, y: 697, text: 'Prazo', size: 6 }, { x: COL.spec, y: 697, text: 'Especificação do título', size: 6 }, { x: COL.obs, y: 697, text: 'Obs. (*)', size: 6 },
    { x: COL.qtyL, y: 697, text: 'Quantidade', size: 6 }, { x: COL.priceL, y: 697, text: 'Preço / Ajuste', size: 6 },
    { x: COL.valL, y: 697, text: 'Valor Operação / Ajuste', size: 6 }, { x: COL.dc + 4, y: 697, text: 'D/C', size: 6 },
  );
  return t;
}

function tradeRow(n: NoteSpec, tr: NoteTrade, y: number): RealText[] {
  const t: RealText[] = [
    { x: COL.q, y, text: n.qNeg }, { x: COL.cv, y, text: tr.side }, { x: COL.tipo, y, text: tr.market }, { x: COL.spec, y, text: tr.spec },
    { x: COL.qtyR, y, text: br(tr.qty, 0), align: 'right' }, { x: COL.priceR, y, text: br(tr.price), align: 'right' },
    { x: COL.valR, y, text: br(r2(tr.qty * tr.price)), align: 'right' }, { x: COL.dc, y, text: tr.side === 'C' ? 'D' : 'C' },
  ];
  if (tr.prazo) t.push({ x: COL.prazo, y, text: tr.prazo });
  if (tr.obs) t.push({ x: COL.obs + 10, y, text: tr.obs });
  return t;
}

function summary(n: NoteSpec, last: boolean, y0: number): RealText[] {
  const tot = noteTotals(n);
  const all = n.pages.flat();
  const v = (x: number) => (last ? br(x) : '');
  const t: RealText[] = [
    { x: 40, y: y0, text: 'Resumo dos Negócios', size: 8, font: 'HB' },
    { x: 310, y: y0, text: 'Resumo Financeiro', size: 8, font: 'HB' },
  ];
  const left: [string, number][] = [
    ['Debêntures', 0], ['Vendas à vista', tot.sells], ['Compras à vista', tot.buys],
    ['Opções - compras', all.filter((x) => x.market.startsWith('OPCAO') && x.side === 'C').reduce((a, x) => a + r2(x.qty * x.price), 0)],
    ['Opções - vendas', 0], ['Operações à termo', 0], ['Valor das oper. c/ títulos públ. (v. nom.)', 0], ['Valor das operações', r2(tot.sells + tot.buys)],
  ];
  const D = (x: number) => (x >= 0 ? 'D' : 'C');
  const netOps = r2(tot.sells - tot.buys);
  const right: [string, string, string?][] = [
    ['Clearing', ''],
    ['Valor líquido das operações', v(Math.abs(netOps)), netOps < 0 ? 'D' : 'C'],
    ['Taxa de liquidação', v(tot.liquidacao), 'D'],
    ['Taxa de Registro', v(0), 'D'],
    ['Total CBLC', v(Math.abs(netOps) + tot.liquidacao), 'D'],
    ['Bolsa', ''],
    ['Taxa de termo/opções', v(n.termo ?? 0), 'D'],
    ['Taxa A.N.A.', v(0), 'D'],
    ['Emolumentos', v(tot.emolumentos), 'D'],
    ['Total Bovespa / Soma', v(tot.emolumentos + (n.termo ?? 0)), 'D'],
    ['Custos Operacionais', ''],
    ...(n.extraCosts ?? []).map((c): [string, string, string] => [c.label, v(c.value), c.dc]),
    ['Execução', v(0)],
    ['Taxa de Custódia', v(0)],
    ['Impostos', v(0)],
    [`I.R.R.F. s/ operações, base R$ ${br(all.filter((x) => x.side === 'V' && !x.obs?.includes('D')).reduce((a, x) => a + r2(x.qty * x.price), 0))}`, v(tot.irrf)],
    ['Outros', v(0), 'D'],
    ['Total Custos / Despesas', v((n.extraCosts ?? []).reduce((a, c) => a + (c.dc === 'C' ? -c.value : c.value), 0)), 'D'],
  ];
  let y = y0 - 11;
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const l = left[i];
    if (l) t.push({ x: 40, y, text: l[0], size: 6 }, { x: 250, y, text: last ? br(l[1]) : '', align: 'right', size: 6 });
    const r = right[i];
    if (r) {
      t.push({ x: 310, y, text: r[0], size: 6, ...(r[1] === '' && !r[2] ? { font: 'HB' as const } : {}) });
      if (r[1]) t.push({ x: 540, y, text: r[1], align: 'right', size: 6 });
      if (r[2] && r[1]) t.push({ x: 546, y, text: r[2], size: 6 });
    }
    y -= 9;
  }
  const dateTxt = n.date;
  t.push({ x: 310, y, text: `Líquido para ${dateTxt.replace(/^(\d{2})/, (d) => String(Number(d) + 2).padStart(2, '0'))}`, size: 7, font: 'HB' });
  t.push(last ? { x: 540, y, text: br(Math.abs(tot.net)), align: 'right', size: 7, font: 'HB' } : { x: 500, y, text: 'CONTINUA...', size: 7, font: 'HB' });
  if (last) t.push({ x: 546, y, text: D(-tot.net), size: 7, font: 'HB' });
  y -= 16;
  t.push({ x: 40, y, text: 'Especificações diversas', size: 7, font: 'HB' });
  y -= 9;
  if (last && n.irrfDayTrade) {
    t.push({ x: 40, y, text: `IRRF Day Trade: Base R$ ${br(n.irrfDayTrade * 100)} Projeção R$ ${br(n.irrfDayTrade)}`, size: 6 });
    y -= 9;
  }
  t.push({ x: 40, y, text: 'A coluna Q indica liquidação no Agente do Qualificado.', size: 5 });
  y -= 12;
  t.push(
    { x: 40, y, text: '(*) Observações', size: 6, font: 'HB' },
    { x: 40, y: y - 8, text: 'A - Posição futuro   T - Liquidação pelo Bruto   C - Clubes e fundos de Ações   2 - Corretora ou pessoa vinculada atuou na contra parte.', size: 5 },
    { x: 40, y: y - 15, text: '# - Negócio direto   8 - Liquidação Institucional   D - Day Trade   F - Cobertura   B - Debêntures   P - Carteira Própria   H - Home Broker', size: 5 },
    { x: 40, y: y - 22, text: 'X - Box   Y - Desmanche de Box   L - Precatório   I - POP   Outros 0,00', size: 5 },
  );
  return t;
}

export function buildNote(n: NoteSpec): Uint8Array {
  const pages: RealPage[] = n.pages.map((trades, pi) => {
    const last = pi === n.pages.length - 1;
    const texts = [...header(n, pi + 1)];
    let y = 686;
    for (const tr of trades) {
      texts.push(...tradeRow(n, tr, y));
      y -= 10;
    }
    const y0 = Math.min(y - 14, 520);
    texts.push(...summary(n, last, y0));
    texts.push({ x: 40, y: 30, text: `${n.broker} - Nota de negociação gerada pelo SINACOR - folha ${pi + 1}`, size: 5 });
    const rules: [number, number, number, number][] = [[35, 702, 585, 702], [35, 692, 585, 692], [35, y0 + 10, 585, y0 + 10], [300, y0 + 10, 300, y0 - 200]];
    return { texts, rules, boxes: [[360, 786, 225, 50]] };
  });
  return writeRealPdf(pages, n.pdf);
}

// ---------------------------------------------------------------------------------------------
// The five brokers

export const XP_NOTE: NoteSpec = {
  broker: 'XP INVESTIMENTOS CCTVM S/A',
  nr: '34567890',
  date: '08/03/2024',
  qNeg: '1-BOVESPA',
  header: 'grid',
  titleOnBrokerLine: true,
  pdf: { mode: 'tj', compress: true, shuffle: 7, producer: 'SINACOR' },
  irrfDayTrade: 0.4,
  pages: [
    [
      { side: 'C', market: 'VISTA', spec: 'PETROBRAS PN N2', qty: 300, price: 37.15, expect: 'BVMF:PETR4' },
      { side: 'C', market: 'VISTA', spec: 'VALE ON NM', qty: 100, price: 66.1, expect: 'BVMF:VALE3' },
      { side: 'C', market: 'VISTA', spec: 'ITAUUNIBANCO PN EJ N1', qty: 200, price: 33.4, expect: 'BVMF:ITUB4' },
      { side: 'V', market: 'VISTA', spec: 'BBSEGURIDADE ON NM', qty: 150, price: 33.02, expect: 'BVMF:BBSE3' },
      { side: 'C', market: 'FRACIONARIO', spec: 'ITAUSA PN N1', qty: 37, price: 10.02, expect: 'BVMF:ITSA4' },
      { side: 'C', market: 'VISTA', spec: 'ISHARES BOVA CI', qty: 20, price: 125.3, expect: 'BVMF:BOVA11' },
      { side: 'C', market: 'VISTA', spec: 'FII XP LOG XPLG11 CI ER', qty: 10, price: 101.5, expect: 'BVMF:XPLG11' },
      { side: 'C', market: 'VISTA', spec: 'WEG ON ED NM', qty: 50, price: 39.8, expect: 'BVMF:WEGE3' },
      { side: 'C', market: 'VISTA', spec: 'EMBRAER ON NM', qty: 100, price: 39.9, expect: 'BVMF:EMBJ3' },
      { side: 'C', market: 'VISTA', spec: 'CCR SA ON NM', qty: 200, price: 12.3, expect: 'BVMF:MOTV3' },
      { side: 'C', market: 'VISTA', spec: 'TRAN PAULIST PN N1', qty: 100, price: 25.4, expect: 'BVMF:ISAE4' },
      { side: 'C', market: 'VISTA', spec: 'GERDAU MET PN N1', qty: 300, price: 10.95, expect: 'BVMF:GOAU4' },
    ],
    [
      { side: 'C', market: 'VISTA', spec: 'SID NACIONAL ON', qty: 100, price: 13.2, expect: 'BVMF:CSNA3' },
      { side: 'C', market: 'VISTA', spec: 'LOCALIZA ON NM', qty: 30, price: 57.1, expect: 'BVMF:RENT3' },
      { side: 'C', market: 'VISTA', spec: 'PETROBRAS PN N2', obs: 'D', qty: 100, price: 37.2, expect: 'BVMF:PETR4' },
      { side: 'V', market: 'VISTA', spec: 'PETROBRAS PN N2', obs: 'D', qty: 100, price: 37.6, expect: 'BVMF:PETR4' },
    ],
  ],
};

export const CLEAR_NOTE: NoteSpec = {
  broker: 'CLEAR CORRETORA - GRUPO XP',
  nr: '77001122',
  date: '10/11/2022',
  qNeg: '1-BOVESPA',
  header: 'grid',
  pdf: { mode: 'word', font: 'C', compress: true, producer: 'Clear SINACOR' },
  termo: 0.13,
  pages: [
    [
      { side: 'C', market: 'VISTA', spec: 'MAGAZ LUIZA ON NM', qty: 500, price: 3.1, expect: 'BVMF:MGLU3' },
      { side: 'V', market: 'VISTA', spec: 'COGNA ON ON NM', qty: 1000, price: 2.45, expect: 'BVMF:COGN3' },
      { side: 'C', market: 'OPCAO DE COMPRA', prazo: '11/22', spec: 'PETRK250 PN', qty: 1000, price: 0.35 },
      { side: 'C', market: 'VISTA', spec: 'FII XP LOG CI ER', qty: 10, price: 100.2, expect: 'BVMF:XPLG11' },
      { side: 'C', market: 'VISTA', spec: 'SANTANDER BR UNT N2', qty: 100, price: 26.5, expect: 'BVMF:SANB11' },
      { side: 'C', market: 'VISTA', spec: 'MARFRIG ON NM', qty: 100, price: 9.8, expect: 'BVMF:MBRF3' },
    ],
  ],
};

export const BTG_NOTE: NoteSpec = {
  broker: 'BTG PACTUAL CTVM S.A.',
  nr: '9988',
  date: '14/05/2024',
  qNeg: 'B3 RV LISTADO',
  header: 'grid',
  pdf: { mode: 'glyph', compress: true, encrypt: { userPassword: '123', aes: true }, producer: 'BTG Pactual' },
  extraCosts: [{ label: 'Taxa Operacional', value: 0, dc: 'D' }],
  pages: [
    [
      { side: 'C', market: 'VISTA', spec: 'MERCADOLIBRE DRN', qty: 5, price: 75.1, expect: 'BVMF:MELI34' },
      { side: 'C', market: 'VISTA', spec: 'ALPHABET DRN C', qty: 10, price: 9.85 },
      { side: 'C', market: 'VISTA', spec: 'ISA ENERGIA PN N1', qty: 100, price: 23.1, expect: 'BVMF:ISAE4' },
      { side: 'C', market: 'VISTA', spec: 'ELETROBRAS ON N1', qty: 100, price: 41.2, expect: 'BVMF:AXIA3' },
      { side: 'V', market: 'VISTA', spec: 'ITAUSA PN N1', obs: '#', qty: 200, price: 10.4, expect: 'BVMF:ITSA4' },
      { side: 'C', market: 'VISTA', spec: 'NU HOLDINGS DR3', qty: 20, price: 13.2, expect: 'BVMF:ROXO34' },
    ],
  ],
};

export const INTER_NOTE: NoteSpec = {
  broker: 'INTER DISTRIBUIDORA DE TITULOS E VALORES MOBILIARIOS LTDA',
  nr: '4455667',
  date: '07/03/2024',
  qNeg: '1-BOVESPA',
  header: 'stacked',
  pdf: { mode: 'tj', font: 'T', compress: false, shuffle: 3, producer: 'Inter' },
  extraCosts: [{ label: 'Taxa Operacional', value: 0.5, dc: 'C' }],
  pages: [
    [
      { side: 'C', market: 'VISTA', spec: 'BRASIL ON NM', qty: 100, price: 27.5, expect: 'BVMF:BBAS3' },
      { side: 'C', market: 'VISTA', spec: 'TAESA UNT N2', qty: 50, price: 35.1, expect: 'BVMF:TAEE11' },
      { side: 'C', market: 'VISTA', spec: 'KLABIN S/A UNT N2', qty: 30, price: 21.4, expect: 'BVMF:KLBN11' },
      { side: 'V', market: 'VISTA', spec: 'RAIADROGASIL ON NM', qty: 20, price: 28.3, expect: 'BVMF:RADL3' },
    ],
  ],
};

export const NU_NOTE: NoteSpec = {
  broker: 'NU INVEST CORRETORA DE VALORES S.A.',
  nr: '223344',
  date: '02/07/2024',
  qNeg: 'B3 RV LISTADO',
  header: 'stacked',
  pdf: { mode: 'cell', compress: true, shuffle: 11, encrypt: { userPassword: '012' }, producer: 'Nu Invest' },
  pages: [
    [
      { side: 'C', market: 'VISTA', spec: 'NATURA ON NM', qty: 50, price: 18.2, expect: 'BVMF:NTCO3' },
      { side: 'C', market: 'VISTA', spec: 'EMPRESA NOVA ON NM', qty: 10, price: 5 },
      { side: 'C', market: 'VISTA', spec: 'FII MXRF11 CI', qty: 100, price: 10.05, expect: 'BVMF:MXRF11' },
      { side: 'C', market: 'VISTA', spec: 'BTGP BANCO UNT N2', qty: 20, price: 33, expect: 'BVMF:BPAC11' },
    ],
  ],
};

/** A Nu note after Natura &Co was merged into Natura Cosméticos: the same name is NATU3 now. */
export const NU_NOTE_2025: NoteSpec = {
  ...NU_NOTE,
  nr: '224455',
  date: '05/08/2025',
  pdf: { mode: 'cell', compress: true, producer: 'Nu Invest' },
  pages: [[{ side: 'C', market: 'VISTA', spec: 'NATURA ON NM', qty: 40, price: 11.5, expect: 'BVMF:NATU3' }]],
};

export const NOTES = { xp: XP_NOTE, clear: CLEAR_NOTE, btg: BTG_NOTE, inter: INTER_NOTE, nu: NU_NOTE, nu2025: NU_NOTE_2025 };
