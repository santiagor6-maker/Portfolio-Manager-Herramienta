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

/** Normalized issuer name (as printed by SINACOR) → ticker root. */
export const B3_ISSUER_ROOTS: [string, string][] = [
  ['petrobras', 'PETR'], ['vale', 'VALE'], ['itausa', 'ITSA'], ['itauunibanco', 'ITUB'], ['itau unibanco', 'ITUB'],
  ['bradesco', 'BBDC'], ['brasil', 'BBAS'], ['banco do brasil', 'BBAS'], ['ambev s a', 'ABEV'], ['ambev', 'ABEV'], ['weg', 'WEGE'],
  ['b3', 'B3SA'], ['magaz luiza', 'MGLU'], ['magazine luiza', 'MGLU'], ['suzano s a', 'SUZB'], ['suzano', 'SUZB'], ['gerdau', 'GGBR'],
  ['met gerdau', 'GOAU'], ['eletrobras', 'ELET'], ['petrorio', 'PRIO'], ['prio', 'PRIO'], ['raiadrogasil', 'RADL'], ['lojas renner', 'LREN'],
  ['localiza', 'RENT'], ['klabin s a', 'KLBN'], ['klabin', 'KLBN'], ['sanepar', 'SAPR'], ['cemig', 'CMIG'], ['copel', 'CPLE'],
  ['bbseguridade', 'BBSE'], ['bb seguridade', 'BBSE'], ['embraer', 'EMBR'], ['jbs', 'JBSS'], ['sid nacional', 'CSNA'], ['usiminas', 'USIM'],
  ['natura', 'NTCO'], ['hapvida', 'HAPV'], ['rumo s a', 'RAIL'], ['energisa', 'ENGI'], ['equatorial', 'EQTL'], ['sabesp', 'SBSP'],
  ['btgp banco', 'BPAC'], ['santander br', 'SANB'], ['cielo', 'CIEL'], ['tim', 'TIMS'], ['telef brasil', 'VIVT'], ['ultrapar', 'UGPA'],
  ['ccr sa', 'CCRO'], ['cosan', 'CSAN'], ['brf sa', 'BRFS'], ['mrv', 'MRVE'], ['cyrela realt', 'CYRE'], ['hypera', 'HYPE'],
  ['totvs', 'TOTS'], ['multiplan', 'MULT'], ['taesa', 'TAEE'], ['alupar', 'ALUP'], ['engie brasil', 'EGIE'], ['cpfl energia', 'CPFE'],
  ['transmissao paulista', 'ISAE'], ['isa cteep', 'ISAE'], ['bradespar', 'BRAP'], ['petroreconcavo', 'RECV'], ['vibra', 'VBBR'],
  ['caixa seguri', 'CXSE'], ['porto seguro', 'PSSA'], ['fleury', 'FLRY'], ['grendene', 'GRND'], ['marcopolo', 'POMO'], ['randon part', 'RAPT'],
];

const CLASS_DIGIT: Record<string, string> = { ON: '3', PN: '4', PNA: '5', PNB: '6', PNC: '7', UNT: '11', UNIT: '11', CI: '11', DRN: '34' };

/** "PETROBRAS PN N2" → PETR4; "HGLG11 CI" / "FII CSHG LOG HGLG11" → HGLG11; unknown → undefined. */
export function sinacorTicker(spec: string): string | undefined {
  const tokens = spec.toUpperCase().split(/\s+/);
  const explicit = tokens.find((t) => B3_TICKER_RE_STRICT.test(t));
  if (explicit) return explicit.replace(/F$/, '');
  const clsIdx = tokens.findIndex((t) => CLASS_DIGIT[t.replace(/[^A-Z]/g, '')] !== undefined);
  if (clsIdx <= 0) return undefined;
  const cls = CLASS_DIGIT[tokens[clsIdx]!.replace(/[^A-Z]/g, '')]!;
  const name = normalizeText(tokens.slice(0, clsIdx).join(' '));
  const hit = B3_ISSUER_ROOTS.filter(([n]) => name === n || name.startsWith(`${n} `)).sort((a, b) => b[0].length - a[0].length)[0];
  return hit ? `${hit[1]}${cls}` : undefined;
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
  lineIndex: number;
}

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
  const head = raw.slice(0, nums.index).trim();
  const upperHead = head.toUpperCase();
  let specStart = 0;
  const marketWords = market.split(' ').length;
  const words = upperHead.split(/\s+/);
  let wi = words.findIndex((w) => w === 'C' || w === 'V') + 1 + marketWords;
  if (/^\d{2}\/\d{2}$/.test(words[wi] ?? '')) wi++;
  specStart = words.slice(0, wi).join(' ').length;
  let spec = head.slice(specStart).trim();
  spec = spec.replace(/\s+(#|D|F|T|@|2|8|B|C|H|X|P|Y|L|A|I)$/i, '').trim();
  const r: SinacorTrade = { side: m[1] as 'C' | 'V', market, spec, quantity, price, value, lineIndex };
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

const MONEY = /(\d[\d.]*,\d{2})\s*([DC])?/;

/** Find "label  1,23 D" pairs inside a (possibly two-column) line. */
function labelValues(line: string): { key: string; value: number }[] {
  const out: { key: string; value: number }[] = [];
  for (const [re, key] of FEE_LABELS) {
    const m = re.exec(line);
    if (!m) continue;
    const after = line.slice(m.index + m[0].length);
    const v = MONEY.exec(after);
    if (v && v.index < 40) out.push({ key, value: parseNumber(v[1]!, 'comma') ?? 0 });
  }
  return out;
}

interface Note {
  number: string;
  date?: string;
  broker?: string;
  trades: SinacorTrade[];
  fees: Map<string, number>;
  irrf: number;
  net?: number;
  firstLine: number;
}

export function parseSinacor(doc: PdfDocument): Note[] {
  const notes = new Map<string, Note>();
  let current: Note | undefined;
  let inTrades = false;
  let broker: string | undefined;
  const lines = doc.lines;
  for (let i = 0; i < lines.length; i++) {
    const l: PdfLine = lines[i]!;
    const text = l.text;
    if (/(CCTVM|CTVM|DTVM|CORRETORA|DISTRIBUIDORA)/i.test(text) && !/nota/i.test(text) && text.length < 90) broker = text.replace(/\s{2,}.*/, '').trim();
    if (/nr\.?\s*nota/i.test(text) && /data\s*preg/i.test(text)) {
      // Values on the next line: Nr. nota · Folha · Data pregão
      const next = lines[i + 1]?.text ?? '';
      const nr = /(\d{1,12})/.exec(next)?.[1] ?? `nota${i}`;
      const date = /(\d{2}\/\d{2}\/\d{4})/.exec(next)?.[1];
      current = notes.get(nr);
      if (!current) {
        current = { number: nr, trades: [], fees: new Map(), irrf: 0, firstLine: i };
        notes.set(nr, current);
      }
      if (date) current.date = parseDate(date, 'DMY');
      if (broker) current.broker = broker;
      inTrades = false;
      i++;
      continue;
    }
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
    const irrf = /I\.?\s?R\.?\s?R\.?\s?F\.?[^]*?(?:base\s*R?\$?\s*[\d.]+,\d{2}\s+)?(\d[\d.]*,\d{2})\s*$/i.exec(text);
    if (irrf && /I\.?\s?R\.?\s?R\.?\s?F/i.test(text) && /base/i.test(text)) current.irrf = parseNumber(irrf[1]!, 'comma') ?? 0;
    const liq = /l[ií]quido para\s+\d{2}\/\d{2}\/\d{4}\s+(\d[\d.]*,\d{2})\s*([DC])?/i.exec(text);
    if (liq) current.net = (parseNumber(liq[1]!, 'comma') ?? 0) * (liq[2] === 'D' ? -1 : 1);
  }
  return [...notes.values()];
}

export function sinacorToRows(doc: PdfDocument, ctx: ParseContext): ParsedRow[] {
  ctx.dateFormat = 'DMY';
  ctx.numberFormat = 'comma';
  const rows: ParsedRow[] = [];
  const map = new Map(Object.entries(ctx.options.securityMap ?? {}).map(([k, v]) => [normalizeText(k), v]));
  for (const note of parseSinacor(doc)) {
    const kept: { row: ParsedRow; tr: SinacorTrade; d: DraftTransaction }[] = [];
    for (const tr of note.trades) {
      const row = ctx.newRow(tr.lineIndex);
      row.sheet = `pág. ${doc.lines[tr.lineIndex]?.page ?? 1}`;
      row.raw = [doc.lines[tr.lineIndex]?.text ?? ''];
      rows.push(row);
      if (/OPCAO|TERMO|FUTURO/.test(tr.market)) {
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
        note: `Nota ${note.number}`,
      };
      if (note.broker) d.account = note.broker;
      row.draft = d;
      kept.push({ row, tr, d });
    }
    const totalFees = [...note.fees.values()].reduce((a, b) => a + b, 0);
    const totalValue = kept.reduce((a, k) => a + k.tr.value, 0);
    const sellValue = kept.filter((k) => k.tr.side === 'V').reduce((a, k) => a + k.tr.value, 0);
    if (kept.length && (totalFees || note.irrf)) {
      let feesLeft = round(totalFees, 2);
      let irrfLeft = round(note.irrf, 2);
      const sells = kept.filter((k) => k.tr.side === 'V');
      kept.forEach((k, idx) => {
        const last = idx === kept.length - 1;
        const fee = last ? feesLeft : round((totalFees * k.tr.value) / (totalValue || 1), 8);
        feesLeft = round(feesLeft - fee, 8);
        if (fee) k.d.fees = fee;
        if (k.tr.side === 'V' && note.irrf) {
          const lastSell = k === sells[sells.length - 1];
          const tax = lastSell ? irrfLeft : round((note.irrf * k.tr.value) / (sellValue || 1), 8);
          irrfLeft = round(irrfLeft - tax, 8);
          if (tax) k.d.taxes = tax;
        }
      });
      kept[0]!.row.issues.push(ctx.issue('FEES_ALLOCATED', 'info', { nota: note.number }, kept[0]!.row.line));
    }
    // Consistency check against "Líquido para".
    if (note.net !== undefined && kept.length === note.trades.length && kept.length) {
      const expected = round(sellValue - (totalValue - sellValue) - totalFees - note.irrf, 2);
      if (Math.abs(expected - note.net) > 0.05) {
        kept[0]!.row.issues.push(ctx.issue('NOTA_TOTALS_MISMATCH', 'warning', { nota: note.number, expected, actual: note.net }, kept[0]!.row.line));
      }
    }
  }
  return rows;
}
