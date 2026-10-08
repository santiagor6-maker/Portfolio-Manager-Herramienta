/**
 * Brazilian "nota de corretagem" PDFs in the SINACOR standard layout (XP, Clear, Rico, BTG, Inter,
 * Nu Invest, Modal, Genial, Ágora...):
 *   header (Nr. nota · Folha · Data pregão, broker name)
 *   "Negócios realizados": Q Negociação · C/V · Tipo mercado · Prazo · Especificação do título · Obs ·
 *                           Quantidade · Preço/Ajuste · Valor Operação/Ajuste · D/C
 *   "Resumo dos Negócios" + "Resumo Financeiro": Taxa de liquidação, Taxa de registro, Taxa de
 *   termo/opções, Taxa A.N.A., Emolumentos, Taxa operacional/Corretagem, Execução, Custódia,
 *   Impostos (ISS), I.R.R.F. s/ operações, Outros, Líquido para DD/MM/AAAA.
 * Costs are allocated pro-rata by trade value; IRRF pro-rata among the note's sales.
 * Tickers: SINACOR prints the security *name* ("PETROBRAS PN N2"); we map name + share class to the
 * ticker with a table of common issuers, accept explicit tickers in the spec, and otherwise ask the
 * user (`securityMap`).
 */
import { parseDate } from '../dates';
import { B3_TICKER_RE_STRICT } from '../markets';
import { parseNumber } from '../numbers';
import type { DraftTransaction, ParsedRow } from '../types';
import { normalizeText, round } from '../util';
import type { ParseContext } from '../presets/common';
import type { PdfDocument, PdfLine } from './extract';

/**
 * B3 "nome de pregão" (as printed by SINACOR in Especificação do título) → ticker root.
 * Matched by EXACT equality of the normalized name (never by prefix: "GERDAU MET" is GOAU, not GGBR).
 */
export const B3_PREGAO_ROOTS: Record<string, string> = {
  petrobras: 'PETR', vale: 'VALE', itausa: 'ITSA', itauunibanco: 'ITUB', bradesco: 'BBDC', brasil: 'BBAS', 'ambev s a': 'ABEV',
  weg: 'WEGE', b3: 'B3SA', 'magaz luiza': 'MGLU', 'suzano s a': 'SUZB', gerdau: 'GGBR', 'gerdau met': 'GOAU', eletrobras: 'ELET',
  petrorio: 'PRIO', prio: 'PRIO', raiadrogasil: 'RADL', 'lojas renner': 'LREN', localiza: 'RENT', 'klabin s a': 'KLBN',
  sanepar: 'SAPR', cemig: 'CMIG', copel: 'CPLE', bbseguridade: 'BBSE', embraer: 'EMBR', jbs: 'JBSS', 'sid nacional': 'CSNA',
  usiminas: 'USIM', natura: 'NTCO', hapvida: 'HAPV', 'rumo s a': 'RAIL', energisa: 'ENGI', equatorial: 'EQTL', sabesp: 'SBSP',
  'btgp banco': 'BPAC', 'santander br': 'SANB', cielo: 'CIEL', tim: 'TIMS', 'telef brasil': 'VIVT', ultrapar: 'UGPA', 'ccr sa': 'CCRO',
  cosan: 'CSAN', 'brf sa': 'BRFS', mrv: 'MRVE', 'cyrela realt': 'CYRE', hypera: 'HYPE', totvs: 'TOTS', multiplan: 'MULT', taesa: 'TAEE',
  alupar: 'ALUP', 'engie brasil': 'EGIE', 'cpfl energia': 'CPFE', 'tran paulist': 'TRPL', bradespar: 'BRAP', petroreconcavo: 'RECV',
  petrorecsa: 'RECV', vibra: 'VBBR', 'caixa seguri': 'CXSE', 'porto seguro': 'PSSA', fleury: 'FLRY', grendene: 'GRND', marcopolo: 'POMO',
  'randon part': 'RAPT', azul: 'AZUL', gol: 'GOLL', 'cvc brasil': 'CVCB', 'yduqs part': 'YDUQ', cogna: 'COGN', assai: 'ASAI',
  'carrefour br': 'CRFB', alpargatas: 'ALPA', 'sao martinho': 'SMTO', 'slc agricola': 'SLCE', '3tentos': 'TTEN', 'irbbrasil re': 'IRBR',
  banrisul: 'BRSR', 'abc brasil': 'ABCB', odontoprev: 'ODPV', dexco: 'DXCO', eztec: 'EZTC', direcional: 'DIRR', tenda: 'TEND',
  iguatemi: 'IGTI', allos: 'ALOS', 'jhsf part': 'JHSF', vamos: 'VAMO', simpar: 'SIMH', ecorodovias: 'ECOR', eneva: 'ENEV',
  'csn mineracao': 'CMIN', braskem: 'BRKM', unipar: 'UNIP', 'positivo tec': 'POSI', lwsa: 'LWSA', 'casas bahia': 'BHIA', petz: 'PETZ',
  smartfit: 'SMFT', 'kepler weber': 'KEPL', tupy: 'TUPY', 'iochp maxion': 'MYPK', 'metal leve': 'LEVE', 'fras le': 'FRAS',
  'santos brp': 'STBP', 'aes brasil': 'AESB', neoenergia: 'NEOE', copasa: 'CSMG', 'grupo mateus': 'GMAT', vulcabras: 'VULC',
  guararapes: 'GUAR', 'c a modas': 'CEAB', 'vivara s a': 'VIVA', 'cury s a': 'CURY', planoeplano: 'PLPL', 'm diasbranco': 'MDIA',
  camil: 'CAML', marfrig: 'MRFG', 'boa safra': 'SOJA', 'p acucar cbd': 'PCAR', 'arezzo co': 'ARZZ', 'sul america': 'SULA',
};

/** ETFs (class CI) by nome de pregão → ticker. */
export const B3_ETF_PREGAO: Record<string, string> = {
  'ishares bova': 'BOVA11', 'ishares smal': 'SMAL11', 'ishare sp500': 'IVVB11', 'ishares sp500': 'IVVB11', 'ishares brax': 'BRAX11',
  'ishares ecoo': 'ECOO11', 'it now ibov': 'BOVV11', 'it now idiv': 'DIVO11', 'it now pibb': 'PIBB11', 'it now spxi': 'SPXI11',
  'hashdex nci': 'HASH11',
};

/** BDRs (class DRN) by nome de pregão → ticker (BDR codes do not follow the issuer's US ticker). */
export const B3_BDR_PREGAO: Record<string, string> = {
  apple: 'AAPL34', amazon: 'AMZO34', microsoft: 'MSFT34', alphabet: 'GOGL34', tesla: 'TSLA34', 'tesla inc': 'TSLA34', nvidia: 'NVDC34',
  'nvidia corp': 'NVDC34', netflix: 'NFLX34', 'coca cola': 'COCA34', walmart: 'WALM34', 'walt disney': 'DISB34', disney: 'DISB34',
  mercadolibre: 'MELI34', 'visa inc': 'VISA34', jpmorgan: 'JPMC34', mcdonalds: 'MCDC34', pfizer: 'PFIZ34', nike: 'NIKE34',
  berkshire: 'BERK34', johnson: 'JNJB34', intel: 'ITLC34',
};

const CLASS_DIGIT: Record<string, string> = { ON: '3', PN: '4', PNA: '5', PNB: '6', PNC: '7', UNT: '11', UNIT: '11', CI: '11' };
const BDR_CLASSES = new Set(['DRN', 'DR1', 'DR2', 'DR3']);

/**
 * "PETROBRAS PN N2" → PETR4; "GERDAU MET PN N1" → GOAU4; "ISHARES BOVA CI ER" → BOVA11; "APPLE DRN" → AAPL34;
 * "FII KINEA RI KNCR11 CI ER" → KNCR11 (explicit ticker). Unknown or uncertain → undefined (ask the user).
 */
export function sinacorTicker(spec: string): string | undefined {
  const tokens = spec.toUpperCase().split(/\s+/).filter(Boolean);
  const explicit = tokens.find((t) => B3_TICKER_RE_STRICT.test(t));
  if (explicit) return explicit.replace(/F$/, '');
  const clsIdx = tokens.findIndex((t) => CLASS_DIGIT[t] !== undefined || BDR_CLASSES.has(t));
  if (clsIdx <= 0) return undefined;
  const cls = tokens[clsIdx]!;
  const name = normalizeText(tokens.slice(0, clsIdx).join(' '));
  if (BDR_CLASSES.has(cls)) return B3_BDR_PREGAO[name];
  if (cls === 'CI') return B3_ETF_PREGAO[name];
  const root = B3_PREGAO_ROOTS[name];
  return root ? `${root}${CLASS_DIGIT[cls]}` : undefined;
}

/** Candidate tickers to show when a specification is unknown (same first word of the name). */
export function sinacorSuggestions(spec: string): string[] {
  const tokens = spec.toUpperCase().split(/\s+/).filter(Boolean);
  const clsIdx = tokens.findIndex((t) => CLASS_DIGIT[t] !== undefined || BDR_CLASSES.has(t));
  const first = normalizeText(tokens[0] ?? '');
  const digit = clsIdx > 0 ? CLASS_DIGIT[tokens[clsIdx]!] : undefined;
  const out: string[] = [];
  for (const [n, root] of Object.entries(B3_PREGAO_ROOTS)) if (n.split(' ')[0] === first) out.push(digit ? `${root}${digit}` : root);
  for (const [n, t] of Object.entries({ ...B3_ETF_PREGAO, ...B3_BDR_PREGAO })) if (n.split(' ')[0] === first) out.push(t);
  return [...new Set(out)].slice(0, 6);
}

const MARKETS = ['VISTA', 'FRACIONARIO', 'OPCAO DE COMPRA', 'OPCAO DE VENDA', 'EXERC OPC COMPRA', 'EXERC OPC VENDA', 'TERMO', 'LEILAO', 'FUTURO'];

export interface SinacorTrade {
  side: 'C' | 'V';
  market: string;
  spec: string;
  quantity: number;
  price: number;
  value: number;
  dc?: 'D' | 'C';
  /** Obs (*) markers, e.g. "D" = day trade, "#" = negócio direto. */
  obs: string;
  dayTrade: boolean;
  lineIndex: number;
}

const OBS_RE = /\s+(#|D|F|T|@|2|8|B|C|H|X|P|Y|L|A|I)$/i;

/** Parse one "Negócios realizados" line; undefined when it is not a trade line. */
export function parseTradeLine(text: string, lineIndex: number): SinacorTrade | undefined {
  const t = normalizeText(text).toUpperCase();
  const raw = text.trim();
  const m = /^(?:(?:\d+\s+)?BOVESPA\s+|B3 RV LISTADO\s+)?([CV])\s+(.*)$/.exec(t);
  if (!m) return undefined;
  const rest = m[2]!;
  const market = MARKETS.find((mk) => rest.startsWith(mk));
  if (!market) return undefined;
  // Numbers come from the original text (normalizeText removes separators).
  const nums = /(\d[\d.]*)\s+(\d[\d.]*,\d+)\s+(\d[\d.]*,\d{2})\s*([DC])?\s*$/.exec(raw);
  if (!nums) return undefined;
  const quantity = parseNumber(nums[1]!, 'comma');
  const price = parseNumber(nums[2]!, 'comma');
  const value = parseNumber(nums[3]!, 'comma');
  if (quantity === undefined || price === undefined || value === undefined) return undefined;
  // Specification: text between the market (and optional prazo) and the numbers, minus Obs markers.
  const head = raw.slice(0, nums.index).replace(/\s+/g, ' ').trim();
  const marketWords = market.split(' ').length;
  const words = head.toUpperCase().split(/\s+/);
  let wi = words.findIndex((w) => w === 'C' || w === 'V') + 1 + marketWords;
  if (/^\d{2}\/\d{2}$/.test(words[wi] ?? '')) wi++;
  let spec = head.slice(words.slice(0, wi).join(' ').length).trim();
  let obs = '';
  let mo: RegExpExecArray | null;
  while ((mo = OBS_RE.exec(spec))) {
    obs = mo[1]!.toUpperCase() + obs;
    spec = spec.slice(0, mo.index).trim();
  }
  const r: SinacorTrade = { side: m[1] as 'C' | 'V', market, spec, quantity, price, value, obs, dayTrade: obs.includes('D'), lineIndex };
  if (nums[4]) r.dc = nums[4] as 'D' | 'C';
  return r;
}

const FEE_LABELS: [RegExp, string][] = [
  [/taxa de liquida[cç][aã]o/i, 'liquidacao'],
  [/taxa de registro/i, 'registro'],
  [/taxa de termo\/op[cç][oõ]es/i, 'termo'],
  [/taxa a\.?n\.?a\.?/i, 'ana'],
  [/emolumentos/i, 'emolumentos'],
  [/taxa operacional|corretagem/i, 'corretagem'],
  [/execu[cç][aã]o(?! casa)/i, 'execucao'],
  [/taxa de cust[oó]dia/i, 'custodia'],
  [/impostos|\biss\b/i, 'iss'],
  [/\boutros\b|\boutras\b/i, 'outros'],
];

const BROKER_RE = /(CCTVM|CTVM|DTVM|CORRETORA|DISTRIBUIDORA|INVESTIMENTOS|BANCO DE INVESTIMENTO)/i;

const MONEY = /(\d[\d.]*,\d{2})\s*([DC])?/;

/** Find "label  1,23 D" pairs inside a (possibly two-column) line. "C" (credit / rebate) is negative. */
function labelValues(line: string): { key: string; value: number }[] {
  const out: { key: string; value: number }[] = [];
  for (const [re, key] of FEE_LABELS) {
    const m = re.exec(line);
    if (!m) continue;
    const after = line.slice(m.index + m[0].length);
    const v = MONEY.exec(after);
    if (v && v.index < 40) out.push({ key, value: (parseNumber(v[1]!, 'comma') ?? 0) * (v[2] === 'C' ? -1 : 1) });
  }
  return out;
}

export interface SinacorNote {
  number: string;
  date?: string;
  broker?: string;
  trades: SinacorTrade[];
  fees: Map<string, number>;
  /** IRRF s/ operações (swing trade, "dedo-duro"). */
  irrf: number;
  /** IRRF day trade. */
  irrfDayTrade: number;
  net?: number;
  firstLine: number;
}

const DATE_RE = /(\d{2}\/\d{2}\/\d{4})/;

export function parseSinacor(doc: PdfDocument): SinacorNote[] {
  const notes = new Map<string, SinacorNote>();
  let current: SinacorNote | undefined;
  let inTrades = false;
  let broker: string | undefined;
  const lines = doc.lines;
  const open = (nr: string, i: number, date: string | undefined) => {
    current = notes.get(nr);
    if (!current) {
      current = { number: nr, trades: [], fees: new Map(), irrf: 0, irrfDayTrade: 0, firstLine: i };
      notes.set(nr, current);
    }
    if (date && !current.date) current.date = parseDate(date, 'DMY');
    // The broker name is printed just below the header block on each page.
    const below = lines.slice(i + 1, i + 10).find((x) => BROKER_RE.test(x.text) && !/nota/i.test(x.text));
    if (below) current.broker = below.text.replace(/\s{2,}.*/, '').trim();
    else if (broker && !current.broker) current.broker = broker;
    inTrades = false;
  };
  for (let i = 0; i < lines.length; i++) {
    const l: PdfLine = lines[i]!;
    const text = l.text;
    if (BROKER_RE.test(text) && !/nota/i.test(text) && text.length < 90) {
      broker = text.replace(/\s{2,}.*/, '').trim();
      if (current && !current.broker) current.broker = broker;
    }
    if (/nr\.?\s*(da\s*)?nota/i.test(text) && !/neg[oó]cios/i.test(text)) {
      // Layout A: labels on one line ("Nr. nota  Folha  Data pregão"), values on the next.
      // Layout B (stacked, Nu/Inter): "Nr. nota 11223344" / "Folha 1" / "Data pregão 07/03/2024".
      const sameLine = /nr\.?\s*(?:da\s*)?nota\s*:?\s*(\d{1,12})/i.exec(text)?.[1];
      if (sameLine) {
        const window = lines.slice(i, i + 5).map((x) => x.text);
        const dl = window.find((x) => /data\s*preg/i.test(x) && DATE_RE.test(x));
        open(sameLine, i, dl ? DATE_RE.exec(dl)![1] : undefined);
        continue;
      }
      if (/data\s*preg/i.test(text)) {
        const next = lines[i + 1]?.text ?? '';
        const nr = /(\d{1,12})/.exec(next)?.[1] ?? `nota${i}`;
        open(nr, i, DATE_RE.exec(next)?.[1]);
        i++;
        continue;
      }
    }
    if (current && !current.date && /data\s*preg/i.test(text) && DATE_RE.test(text)) current.date = parseDate(DATE_RE.exec(text)![1]!, 'DMY');
    if (!current) continue;
    if (/neg[oó]cios realizados/i.test(text)) {
      inTrades = true;
      continue;
    }
    if (/resumo dos neg[oó]cios|resumo financeiro/i.test(text)) inTrades = false;
    if (inTrades) {
      const tr = parseTradeLine(text, i);
      if (tr) current.trades.push(tr);
      continue;
    }
    for (const { key, value } of labelValues(text)) current.fees.set(key, value);
    if (/I\.?\s?R\.?\s?R\.?\s?F/i.test(text)) {
      const last = /(\d[\d.]*,\d{2})\s*$/.exec(text);
      const v = last ? parseNumber(last[1]!, 'comma') ?? 0 : 0;
      if (/day\s*trade/i.test(text)) current.irrfDayTrade = v;
      else if (/base/i.test(text)) current.irrf = v;
    }
    const liq = /l[ií]quido para\s+\d{2}\/\d{2}\/\d{4}\s+(\d[\d.]*,\d{2})\s*([DC])?/i.exec(text);
    if (liq) current.net = (parseNumber(liq[1]!, 'comma') ?? 0) * (liq[2] === 'D' ? -1 : 1);
  }
  return [...notes.values()];
}

/** Allocate `total` over items by weight; the last item absorbs rounding. */
function allocate(total: number, weights: number[]): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (!sum || !total) return weights.map(() => 0);
  let left = round(total, 8);
  return weights.map((w, i) => {
    if (i === weights.length - 1) return left;
    const v = round((total * w) / sum, 8);
    left = round(left - v, 8);
    return v;
  });
}

export function sinacorToRows(doc: PdfDocument, ctx: ParseContext): ParsedRow[] {
  ctx.dateFormat = 'DMY';
  ctx.numberFormat = 'comma';
  const rows: ParsedRow[] = [];
  const map = new Map(Object.entries(ctx.options.securityMap ?? {}).map(([k, v]) => [normalizeText(k), v]));
  const notes = parseSinacor(doc);
  if (!notes.length) ctx.fileIssues.push(ctx.issue('NOTE_WITHOUT_TRADES', 'warning', { nota: '?' }));
  for (const note of notes) {
    if (!note.trades.length) {
      ctx.fileIssues.push(ctx.issue('NOTE_WITHOUT_TRADES', 'warning', { nota: note.number }));
      continue;
    }
    type Item = { row: ParsedRow; tr: SinacorTrade; d?: DraftTransaction; derivative: boolean };
    const items: Item[] = [];
    for (const tr of note.trades) {
      const row = ctx.newRow(tr.lineIndex);
      row.sheet = `pág. ${doc.lines[tr.lineIndex]?.page ?? 1}`;
      row.raw = [doc.lines[tr.lineIndex]?.text ?? ''];
      rows.push(row);
      const derivative = /OPCAO|TERMO|FUTURO/.test(tr.market);
      const item: Item = { row, tr, derivative };
      items.push(item);
      if (derivative) {
        ctx.skip(row, 'UNSUPPORTED_ASSET', { value: tr.market.toLowerCase() }, 'warning');
        continue;
      }
      if (!note.date) {
        row.issues.push(ctx.issue('INVALID_DATE', 'error', { value: '' }, row.line));
        continue;
      }
      const mapped = map.get(normalizeText(tr.spec));
      const ticker = mapped ? undefined : sinacorTicker(tr.spec);
      if (!mapped && !ticker) {
        row.issues.push(ctx.issue('UNKNOWN_SECURITY', 'error', { spec: tr.spec }, row.line));
        ctx.askSecurity(tr.spec, row.line, sinacorSuggestions(tr.spec));
        continue;
      }
      const d: DraftTransaction = {
        date: note.date,
        type: tr.side === 'C' ? 'BUY' : 'SELL',
        currency: 'BRL',
        quantity: tr.quantity,
        price: tr.price,
        amount: tr.value,
        instrument: mapped
          ? { ...(mapped.includes(':') ? { id: mapped } : { symbol: mapped, exchange: 'BVMF' }), name: tr.spec, currency: 'BRL' }
          : { symbol: ticker!, exchange: 'BVMF', currency: 'BRL', name: tr.spec },
        note: `Nota ${note.number}${tr.dayTrade ? ' · day trade' : ''}`,
        // Two notes may contain identical trades: the note number makes them distinct.
        brokerRef: `nota:${note.number}:${tr.lineIndex}`,
      };
      if (note.broker) d.account = note.broker;
      row.draft = d;
      item.d = d;
      if (tr.dayTrade) row.issues.push(ctx.issue('DAY_TRADE', 'info', undefined, row.line));
    }
    // Costs: every cost is spread over ALL trades of the note by value (options included, so their
    // share is not loaded onto the spot trades); Taxa de termo/opções only over options/termo trades.
    // Credited costs ("C") are negative. The shares of skipped trades are dropped (info).
    const termo = note.fees.get('termo') ?? 0;
    const general = [...note.fees.entries()].filter(([k]) => k !== 'termo').reduce((a, [, v]) => a + v, 0);
    const gen = allocate(general, items.map((x) => x.tr.value));
    const ter = allocate(termo, items.map((x) => (x.derivative ? x.tr.value : 0)));
    // IRRF: s/ operações → swing-trade sales; day trade → day-trade sales.
    const swingSells = items.map((x) => (x.tr.side === 'V' && !x.tr.dayTrade ? x.tr.value : 0));
    const dtSells = items.map((x) => (x.tr.side === 'V' && x.tr.dayTrade ? x.tr.value : 0));
    const irrfSwing = allocate(note.irrf, swingSells.some(Boolean) ? swingSells : items.map((x) => (x.tr.side === 'V' ? x.tr.value : 0)));
    const irrfDt = allocate(note.irrfDayTrade, dtSells.some(Boolean) ? dtSells : items.map((x) => (x.tr.side === 'V' ? x.tr.value : 0)));
    let dropped = 0;
    items.forEach((x, i) => {
      const fee = round(gen[i]! + ter[i]!, 8);
      const tax = round(irrfSwing[i]! + irrfDt[i]!, 8);
      if (!x.d) {
        dropped += fee;
        return;
      }
      if (fee) x.d.fees = fee;
      if (tax) x.d.taxes = tax;
    });
    const firstKept = items.find((x) => x.d);
    if (firstKept && (general || termo || note.irrf || note.irrfDayTrade)) {
      firstKept.row.issues.push(ctx.issue('FEES_ALLOCATED', 'info', { nota: note.number }, firstKept.row.line));
      if (dropped) firstKept.row.issues.push(ctx.issue('FEES_OF_SKIPPED', 'info', { amount: round(dropped, 2) }, firstKept.row.line));
    }
    // Consistency check against "Líquido para" over every trade of the note.
    if (note.net !== undefined) {
      const sells = items.filter((x) => x.tr.side === 'V').reduce((a, x) => a + x.tr.value, 0);
      const buys = items.filter((x) => x.tr.side === 'C').reduce((a, x) => a + x.tr.value, 0);
      const expected = round(sells - buys - general - termo - note.irrf - note.irrfDayTrade, 2);
      if (Math.abs(expected - note.net) > 0.05) {
        const x = items.find((y) => y.d) ?? items[0]!;
        x.row.issues.push(ctx.issue('NOTA_TOTALS_MISMATCH', 'warning', { nota: note.number, expected, actual: note.net }, x.row.line));
      }
    }
  }
  return rows;
}
