/**
 * Brazilian "nota de corretagem" summarized as a spreadsheet (one row per trade), e.g. produced by
 * note readers or kept by hand. B3 doesn't publish a standard CSV for notes, so this preset documents
 * a flexible layout: Data pregão · Nota · C/V · Código · Quantidade · Preço · Valor · fee columns
 * (Taxa de liquidação, Emolumentos, Taxa de registro, Corretagem, ISS, Outras) · IRRF · Corretora.
 * Fee values repeated identically on every row of the same note are treated as note totals and
 * allocated proportionally to each trade's value.
 */
import type { TransactionType } from '@pm/core';
import type { DraftTransaction, ParsedRow } from '../types';
import { normalizeText, round } from '../util';
import { type PresetDefinition, cell, locateHeader, str } from './common';

const GROUPS = [
  ['Data pregão', 'Data do pregão', 'Data'], ['Nota', 'Nr. nota', 'Nº nota', 'Número da nota', 'Numero nota'], ['C/V', 'Compra/Venda'],
  ['Código', 'Ticker', 'Ativo', 'Código de negociação'], ['Quantidade', 'Qtde'], ['Preço', 'Preço / Ajuste', 'Preço unitário'],
];
const FEE_COLUMNS = ['Taxa de liquidação', 'Emolumentos', 'Taxa de registro', 'Taxa de termo/opções', 'Taxa ANA', 'Corretagem', 'ISS', 'Outras', 'Outros', 'Custos', 'Taxas'];
const NOTE_TOTAL_COLUMNS = ['Total custos nota', 'Total custos', 'Custos da nota', 'Total da nota', 'Taxas da nota'];

/** B3 option tickers: PETRA250, PETRX30, also odd variants such as PETR4E250. */
export function isOptionTicker(code: string): boolean {
  return /^[A-Z]{4}[A-X]\d{2,4}[EW]?$/.test(code) || /^[A-Z]{4}\d[A-X]\d{2,4}$/.test(code);
}

const TAX_COLUMNS = ['IRRF', 'I.R.R.F.', 'IR fonte', 'I.R.R.F. s/ operações'];

export const notaCorretagemPreset: PresetDefinition = {
  id: 'nota-corretagem',
  label: 'Notas de corretagem — planilha resumida (BR)',
  broker: 'Corretoras BR (XP, Clear, Rico, BTG, Inter, Nu...)',
  country: 'BR',
  fileKinds: ['csv', 'xlsx'],
  confidence: 'low',
  description: 'Planilla con una fila por operación de la nota de corretagem, con costos (liquidação, emolumentos, corretagem, ISS) e IRRF; los costos por nota se prorratean.',
  exportHelp: 'Usa un lector de notas (o tu propia planilla) con columnas: Data pregão, Nota, C/V, Código, Quantidade, Preço, Valor, Taxa de liquidação, Emolumentos, Corretagem, ISS, IRRF, Corretora.',
  detect(table) {
    const h = locateHeader(table, GROUPS, 0.8, 10);
    if (!h) return 0;
    const hasNota = h.header.has('Nota', 'Nr. nota', 'Nº nota', 'Número da nota', 'Numero nota');
    const hasCv = h.header.has('C/V', 'Compra/Venda');
    return hasNota && hasCv ? 0.6 + 0.35 * h.coverage : 0;
  },
  parse(table, ctx) {
    const h = locateHeader(table, GROUPS, 0.6, 10)!;
    const H = h.header;
    const c = {
      date: H.find('Data pregão', 'Data do pregão', 'Data'), nota: H.find('Nota', 'Nr. nota', 'Nº nota', 'Número da nota', 'Numero nota'),
      cv: H.find('C/V', 'Compra/Venda'), code: H.find('Código', 'Ticker', 'Ativo', 'Código de negociação'),
      qty: H.find('Quantidade', 'Qtde'), price: H.find('Preço', 'Preço / Ajuste', 'Preço unitário'),
      value: H.find('Valor', 'Valor operação', 'Valor Operação / Ajuste'), broker: H.find('Corretora', 'Instituição'),
    };
    const feeCols = FEE_COLUMNS.map((n) => H.find(n)).filter((i): i is number => i !== undefined);
    const taxCols = TAX_COLUMNS.map((n) => H.find(n)).filter((i): i is number => i !== undefined);
    const marketCol = H.find('Tipo mercado', 'Tipo de mercado', 'Mercado');
    const dcCol = H.find('D/C');
    const noteTotalCols = NOTE_TOTAL_COLUMNS.map((n) => H.find(n)).filter((i): i is number => i !== undefined && !feeCols.includes(i));
    ctx.detectDates([c.date], h.index + 1, 'DMY', { fixed: true });
    ctx.detectNumbers([c.qty, c.price, c.value, ...feeCols, ...taxCols], h.index + 1, 'comma', { fixed: true });
    const mode = ctx.options.notaFeesMode ?? 'auto';

    const rows: ParsedRow[] = [];
    const entries: { row: ParsedRow; d: DraftTransaction; nota: string; fees: (number | undefined)[]; taxes: (number | undefined)[] }[] = [];
    for (let r = h.index + 1; r < table.rows.length; r++) {
      const raw = table.rows[r]!;
      const row = ctx.newRow(r, raw);
      rows.push(row);
      const cv = normalizeText(str(raw, c.cv));
      const dc = normalizeText(str(raw, dcCol));
      const code = str(raw, c.code).toUpperCase();
      if (!cv && !code) {
        ctx.skip(row, 'SKIPPED_TOTAL');
        continue;
      }
      const market = normalizeText(str(raw, marketCol));
      if (/opcao|opcoes|termo|futuro/.test(market) || isOptionTicker(code)) {
        ctx.skip(row, 'UNSUPPORTED_ASSET', { value: market || code }, 'warning');
        continue;
      }
      const type: TransactionType | undefined =
        cv === 'c' || cv.startsWith('compra') ? 'BUY' : cv === 'v' || cv.startsWith('venda') ? 'SELL' : !cv && dc === 'd' ? 'BUY' : !cv && dc === 'c' ? 'SELL' : undefined;
      if (!type) row.issues.push(ctx.issue('UNKNOWN_TYPE', 'error', { value: str(raw, c.cv) }, row.line));
      const date = ctx.date(cell(raw, c.date), row);
      const qty = ctx.num(cell(raw, c.qty), row, 'quantity');
      const price = ctx.num(cell(raw, c.price), row, 'price');
      const value = ctx.num(cell(raw, c.value), row, 'amount');
      const fees = [...feeCols, ...noteTotalCols].map((i) => ctx.num(cell(raw, i), row, 'fees'));
      const taxes = taxCols.map((i) => ctx.num(cell(raw, i), row, 'taxes'));
      if (!type || !date || qty === undefined) continue;
      const d: DraftTransaction = { date, type, currency: 'BRL', quantity: Math.abs(qty), instrument: { symbol: code, exchange: 'BVMF', currency: 'BRL' } };
      if (price !== undefined) d.price = price;
      d.amount = value !== undefined ? Math.abs(value) : price !== undefined ? Math.abs(qty * price) : undefined;
      if (d.amount === undefined) delete d.amount;
      const broker = str(raw, c.broker);
      if (broker) d.account = broker;
      const nota = str(raw, c.nota);
      if (nota) {
        d.note = `Nota ${nota}`;
        d.brokerRef = `nota:${nota}:${code}:${qty}:${price ?? ''}:${r}`;
      }
      row.draft = d;
      entries.push({ row, d, nota: nota || `row${r}`, fees, taxes });
    }

    // Fee columns: per row, or note totals repeated on every row (allocated pro-rata by value).
    // 'auto' treats a repeated value as a note total only when the trades' values differ (costs such as
    // emolumentos are proportional to value, so identical per-row values on different trades are totals);
    // explicit note-total columns ("Total custos nota") are always allocated.
    const byNota = new Map<string, typeof entries>();
    for (const e of entries) byNota.set(e.nota, [...(byNota.get(e.nota) ?? []), e]);
    const width = feeCols.length + noteTotalCols.length;
    for (const [nota, group] of byNota) {
      const totalValue = group.reduce((acc, e) => acc + (e.d.amount ?? 0), 0);
      const valuesDiffer = group.some((e) => Math.abs((e.d.amount ?? 0) - (group[0]!.d.amount ?? 0)) > 0.005);
      // A fee column whose values vary inside the note proves the file is per row (totals repeat every column).
      const anyVaries = feeCols.some((_, k) => group.some((e) => Math.abs((e.fees[k] ?? 0) - (group[0]!.fees[k] ?? 0)) > 1e-9));
      const allocate = (pick: (e: (typeof entries)[number]) => (number | undefined)[], cols: number, forceTotalFrom = Infinity): number[] => {
        const perRow = group.map(() => 0);
        let allocated = false;
        for (let k = 0; k < cols; k++) {
          const vals = group.map((e) => Math.abs(pick(e)[k] ?? 0));
          const repeated = group.length > 1 && vals.every((v) => v === vals[0]) && vals[0]! > 0;
          const asTotal =
            k >= forceTotalFrom ? vals.some((v) => v > 0) : mode === 'per-note' ? repeated : mode === 'per-row' ? false : repeated && valuesDiffer && !anyVaries;
          if (repeated && !valuesDiffer && !anyVaries && mode === 'auto' && k < forceTotalFrom) {
            group[0]!.row.issues.push(ctx.issue('FEES_MODE_AMBIGUOUS', 'warning', { nota }, group[0]!.row.line));
          }
          const total = k >= forceTotalFrom ? Math.max(...vals) : vals[0]!;
          vals.forEach((v, i) => {
            if (asTotal && totalValue > 0) {
              perRow[i]! += round((total * (group[i]!.d.amount ?? 0)) / totalValue, 8);
              allocated = true;
            } else if (!(k >= forceTotalFrom)) perRow[i]! += v;
          });
        }
        if (allocated) group[0]!.row.issues.push(ctx.issue('FEES_ALLOCATED', 'info', { nota }, group[0]!.row.line));
        return perRow;
      };
      const fees = allocate((e) => e.fees, width, feeCols.length);
      const taxes = allocate((e) => e.taxes, taxCols.length);
      group.forEach((e, i) => {
        if (fees[i]) e.d.fees = round(fees[i]!, 8);
        if (taxes[i]) e.d.taxes = round(taxes[i]!, 8);
      });
    }
    return rows;
  },
};
