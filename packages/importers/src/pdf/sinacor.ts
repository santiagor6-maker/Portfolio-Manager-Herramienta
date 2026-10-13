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
import type { PdfDocument, PdfItem, PdfLine } from './extract';
import { B3_BDR_MULTICLASS, B3_BDR_PREGAO, B3_DATED_ROOTS, B3_ETF_PREGAO, B3_FII_PREGAO, B3_PREGAO_ROOTS, BDR_CLASSES, CLASS_DIGIT, SPEC_MARKS, normName, suggestB3Names } from './b3-names';

export { B3_PREGAO_ROOTS, B3_ETF_PREGAO, B3_FII_PREGAO, B3_BDR_PREGAO, B3_BDR_MULTICLASS } from './b3-names';

/** Outcome of reading a specification: a certain ticker, or why it must be asked (with candidates). */
export interface SpecResolution {
  ticker?: string;
  /** Candidates for the user, best first. */
  suggestions: string[];
  /** Why it is not certain: unknown name, a BDR class letter, or a multi-class BDR without class. */
  reason?: 'unknown' | 'bdr_class' | 'multiclass';
}

function splitSpec(spec: string): { tokens: string[]; clsIdx: number } {
  const tokens = spec.toUpperCase().replace(/[./&'-]/g, ' ').split(/\s+/).filter(Boolean);
  // The class is the first class token after at least one name token ("COGNA ON ON NM" → first ON at 1).
  const clsIdx = tokens.findIndex((t, i) => i > 0 && (CLASS_DIGIT[t] !== undefined || BDR_CLASSES.has(t)));
  return { tokens, clsIdx };
}

/**
 * Read a SINACOR specification. Explicit tickers win ("FII KINEA RI KNCR11 CI ER" → KNCR11). Otherwise
 * the nome de pregão must match a table exactly, and for BDRs any letter after DRN that is not a known
 * mark ("ALPHABET DRN C") makes it uncertain. `date` (ISO) selects dated names (NATURA).
 * `extra` adds catalog names for the suggestions.
 */
export function resolveSpec(spec: string, date?: string, extra?: { name: string; ticker: string }[]): SpecResolution {
  const { tokens, clsIdx } = splitSpec(spec);
  const explicit = tokens.find((t) => B3_TICKER_RE_STRICT.test(t));
  if (explicit) return { ticker: explicit.replace(/F$/, ''), suggestions: [] };
  if (clsIdx <= 0) {
    const name = normName(tokens.join(' '));
    return { suggestions: suggestB3Names(name, { extra }).slice(0, 5).map((c) => c.ticker), reason: 'unknown' };
  }
  const cls = tokens[clsIdx]!;
  const name = normName(tokens.slice(0, clsIdx).join(' '));
  const after = tokens.slice(clsIdx + 1);
  if (BDR_CLASSES.has(cls)) {
    const letters = after.filter((t) => !SPEC_MARKS.has(t));
    const multi = B3_BDR_MULTICLASS[name];
    const single = B3_BDR_PREGAO[name];
    const sugg = () => [...(multi ?? []), ...(single ? [single] : []), ...suggestB3Names(name, { kind: 'bdr', extra }).map((c) => c.ticker)];
    if (letters.length) return { suggestions: [...new Set(sugg())].slice(0, 5), reason: 'bdr_class' };
    if (multi) return { suggestions: multi, reason: 'multiclass' };
    if (single) return { ticker: single, suggestions: [] };
    return { suggestions: [...new Set(sugg())].slice(0, 5), reason: 'unknown' };
  }
  if (cls === 'CI') {
    const t = B3_ETF_PREGAO[name] ?? B3_FII_PREGAO[name];
    if (t) return { ticker: t, suggestions: [] };
    return { suggestions: suggestB3Names(name, { kind: 'ci', extra }).slice(0, 5).map((c) => c.ticker), reason: 'unknown' };
  }
  const dated = B3_DATED_ROOTS[name];
  const root = dated ? [...dated].reverse().find((d) => !date || d.from <= date)?.root : B3_PREGAO_ROOTS[name];
  if (root) return { ticker: `${root}${CLASS_DIGIT[cls]}`, suggestions: [] };
  const digit = CLASS_DIGIT[cls];
  return { suggestions: suggestB3Names(name, { kind: 'share', digit, extra }).slice(0, 5).map((c) => c.ticker), reason: 'unknown' };
}

/**
 * "PETROBRAS PN N2" → PETR4; "GERDAU MET PN N1" → GOAU4; "ISHARES BOVA CI ER" → BOVA11; "APPLE DRN" → AAPL34;
 * "FII KINEA RI KNCR11 CI ER" → KNCR11 (explicit ticker). Unknown or uncertain → undefined (ask the user).
 */
export function sinacorTicker(spec: string, date?: string): string | undefined {
  return resolveSpec(spec, date).ticker;
}

/** Candidate tickers to show when a specification is unknown (fuzzy match over the tables). */
export function sinacorSuggestions(spec: string, extra?: { name: string; ticker: string }[]): string[] {
  const r = resolveSpec(spec, undefined, extra);
  return r.ticker ? [r.ticker] : r.suggestions;
}

/**
 * Catalog instruments (e.g. @pm/market-data `CATALOG.instruments`) as extra names for suggestions:
 * "Petrobras PN" → name "petrobras", ticker PETR4.
 */
export function catalogNames(catalog: { exchange: string; symbol: string; name: string }[] | undefined): { name: string; ticker: string }[] {
  return (catalog ?? [])
    .filter((i) => i.exchange === 'BVMF')
    .map((i) => ({ name: normName(i.name.replace(/\b(ON|PN|PNA|PNB|UNT|UNIT|CI|S\.?A\.?)\b|\(.*?\)/gi, ' ')), ticker: i.symbol }))
    .filter((x) => x.name);
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
export function parseTradeLine(text: string, lineIndex: number, columnObs?: string): SinacorTrade | undefined {
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
  let obs = columnObs ?? '';
  let mo: RegExpExecArray | null;
  // Without the Obs column position, trailing single markers are stripped by pattern.
  while (columnObs === undefined && (mo = OBS_RE.exec(spec))) {
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

/** Broker name: a cell of the line that names a brokerage (not the "NOTA DE NEGOCIAÇÃO" title beside it). */
function brokerCell(l: PdfLine | undefined): string | undefined {
  if (!l) return undefined;
  const c = l.cells.find((x) => BROKER_RE.test(x) && !/nota|ouvidoria|sac\b|e-mail|internet/i.test(x) && x.length < 90);
  return c?.trim();
}
const OBS_ITEM_RE = /^[#DFTC@28BHXPYLAI]{1,3}$/i;

/** Join items like itemsToLines does (space when there is a gap). */
function joinItems(items: { x: number; w: number; str: string }[]): string {
  let text = '';
  let prevEnd = -Infinity;
  for (const it of items) {
    const s = it.str.trim();
    if (!s) continue;
    const gap = it.x - prevEnd;
    text += text ? (gap > 12 ? `  ${s}` : gap > 1 ? ` ${s}` : s) : s;
    prevEnd = it.x + it.w;
  }
  return text;
}

/**
 * Trade line with the Obs (*) column taken by position when the column header was seen: a letter
 * printed in the specification column ("ALPHABET DRN C") stays in the specification.
 */
function tradeFromLine(l: PdfLine, i: number, obsRange: [number, number] | undefined): SinacorTrade | undefined {
  if (!obsRange) return parseTradeLine(l.text, i);
  const inObs = (it: PdfItem) => it.x >= obsRange[0] && it.x < obsRange[1] && OBS_ITEM_RE.test(it.str.trim());
  const obs = l.items.filter(inObs).map((it) => it.str.trim().toUpperCase()).join('');
  return parseTradeLine(joinItems(l.items.filter((it) => !inObs(it))), i, obs);
}

export function parseSinacor(doc: PdfDocument): SinacorNote[] {
  const notes = new Map<string, SinacorNote>();
  let current: SinacorNote | undefined;
  let inTrades = false;
  let obsRange: [number, number] | undefined;
  let broker: string | undefined;
  const lines = doc.lines;
  const open = (nr: string, i: number, date: string | undefined) => {
    current = notes.get(nr);
    if (!current) {
      current = { number: nr, trades: [], fees: new Map(), irrf: 0, irrfDayTrade: 0, firstLine: i };
      notes.set(nr, current);
    }
    if (date && !current.date) current.date = parseDate(date, 'DMY');
    // The broker name is printed beside / below the header block on each page.
    const near = lines.slice(Math.max(0, i - 4), i + 10).map(brokerCell).find(Boolean);
    if (near) current.broker = near;
    else if (broker && !current.broker) current.broker = broker;
    inTrades = false;
  };
  for (let i = 0; i < lines.length; i++) {
    const l: PdfLine = lines[i]!;
    const text = l.text;
    const bc = brokerCell(l);
    if (bc) {
      broker = bc;
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
        // Values sit under their labels: match by x position (other text may share the lines).
        const nrLabel = l.items.find((it) => /^nr\.?/i.test(it.str.trim()));
        const dtLabel = l.items.find((it) => /^data\s*preg/i.test(it.str.trim()) || /preg[aã]o/i.test(it.str));
        const under = (label: PdfItem | undefined, re: RegExp) => {
          if (!label) return undefined;
          for (const nl of lines.slice(i + 1, i + 4)) {
            const hit = nl.items.find((it) => Math.abs(it.x - label.x) <= 20 && re.test(it.str.trim()));
            if (hit) return re.exec(hit.str.trim())![1];
          }
          return undefined;
        };
        const nr = under(nrLabel, /^(\d{1,12})$/) ?? /(\d{1,12})/.exec(lines[i + 1]?.text ?? '')?.[1] ?? `nota${i}`;
        const date = under(dtLabel, /^(\d{2}\/\d{2}\/\d{4})$/) ?? DATE_RE.exec(lines[i + 1]?.text ?? '')?.[1];
        open(nr, i, date);
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
      // Column header: remember where the Obs (*) column sits.
      if (/especifica/i.test(text) && /obs/i.test(text)) {
        const obsItem = l.items.find((it) => /^obs/i.test(it.str.trim()));
        const qtyItem = l.items.find((it) => /^quantidade/i.test(it.str.trim()));
        obsRange = obsItem && qtyItem && qtyItem.x > obsItem.x ? [obsItem.x - 3, qtyItem.x - 2] : undefined;
        continue;
      }
      const tr = tradeFromLine(l, i, obsRange);
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

const NOTE_PREFIX = /^Nota \S+$/;

/**
 * Specification → instrument id learned from the user's earlier SINACOR imports (I30): every imported
 * trade keeps its specification in the note ("Nota 123 · GERDAU MET PN N1"), so an answer given once
 * (securityMap) is reused by every later note without storing anything else. Conflicting answers and
 * dated names (NATURA) are not learned.
 */
export function securityMapFromTransactions(transactions: { note?: string; instrumentId?: string; source?: string }[]): Record<string, string> {
  const seen = new Map<string, Set<string>>();
  for (const t of transactions) {
    if (!t.instrumentId || !t.note || (t.source && !/nota/.test(t.source))) continue;
    const parts = t.note.split(' · ');
    if (parts.length < 2 || !NOTE_PREFIX.test(parts[0]!)) continue;
    const spec = parts[1]!;
    if (!spec || spec === 'day trade') continue;
    const k = normalizeText(spec);
    const { tokens, clsIdx } = splitSpec(spec);
    if (clsIdx > 0 && B3_DATED_ROOTS[normName(tokens.slice(0, clsIdx).join(' '))]) continue;
    seen.set(k, (seen.get(k) ?? new Set()).add(t.instrumentId));
  }
  const out: Record<string, string> = {};
  for (const [k, ids] of seen) if (ids.size === 1) out[k] = [...ids][0]!;
  return out;
}

export function sinacorToRows(doc: PdfDocument, ctx: ParseContext): ParsedRow[] {
  ctx.dateFormat = 'DMY';
  ctx.numberFormat = 'comma';
  const rows: ParsedRow[] = [];
  const map = new Map(Object.entries(ctx.options.securityMap ?? {}).map(([k, v]) => [normalizeText(k), v]));
  const learned = new Map(Object.entries(securityMapFromTransactions(ctx.options.existingTransactions ?? [])));
  const extra = catalogNames(ctx.options.catalog);
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
      // Order: the user's explicit answers, the certain tables, then what was learned from earlier notes.
      const specKey = normalizeText(tr.spec);
      const res = map.has(specKey) ? undefined : resolveSpec(tr.spec, note.date, extra);
      const mapped = map.get(specKey) ?? (res?.ticker ? undefined : learned.get(specKey));
      const ticker = mapped ? undefined : res?.ticker;
      if (!mapped && !ticker) {
        const code = res?.reason === 'bdr_class' || res?.reason === 'multiclass' ? 'BDR_CLASS_UNCERTAIN' : 'UNKNOWN_SECURITY';
        row.issues.push(ctx.issue(code, 'error', { spec: tr.spec }, row.line));
        ctx.askSecurity(tr.spec, row.line, res?.suggestions ?? []);
        continue;
      }
      if (mapped && learned.get(specKey) === mapped && !map.has(specKey)) row.issues.push(ctx.issue('SECURITY_LEARNED', 'info', { spec: tr.spec, id: mapped }, row.line));
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
        note: `Nota ${note.number} · ${tr.spec}${tr.dayTrade ? ' · day trade' : ''}`,
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
