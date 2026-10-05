/**
 * B3 Área do Investidor (investidor.b3.com.br) Excel exports:
 *  - "Negociação" (Extratos → Negociação): one row per executed trade (trade date, no fees).
 *  - "Movimentação" (Extratos → Movimentação): custody & cash events — settlements of trades
 *    ("Transferência - Liquidação"), Dividendo, Juros Sobre Capital Próprio, Rendimento, Desdobro,
 *    Grupamento, Bonificação em Ativos, Amortização, Vencimento/Resgate (Tesouro, CDB), etc.
 */
import type { TransactionType } from '@pm/core';
import { B3_TICKER_RE_STRICT } from '../markets';
import type { DraftTransaction, InstrumentHint, ParsedRow } from '../types';
import { normalizeText } from '../util';
import { type PresetDefinition, cell, columnValues, locateHeader, str } from './common';

const NEG_GROUPS = [
  ['Data do Negócio'], ['Tipo de Movimentação'], ['Mercado'], ['Código de Negociação'], ['Quantidade'], ['Preço'], ['Valor'],
  ['Instituição'], ['Prazo/Vencimento'],
];
const MOV_GROUPS = [
  ['Entrada/Saída'], ['Data'], ['Movimentação'], ['Produto'], ['Instituição'], ['Quantidade'], ['Preço unitário'], ['Valor da Operação'],
];

/** "PETR4 - PETROLEO BRASILEIRO S.A. PETROBRAS" → { symbol: 'PETR4', name: '...' }; Tesouro/CDB → name only. */
export function parseB3Product(product: string): InstrumentHint {
  const p = product.trim();
  const m = /^([A-Z0-9]{4}\d{1,2}F?)\s*-\s*(.+)$/.exec(p);
  if (m && B3_TICKER_RE_STRICT.test(m[1]!)) return { symbol: m[1]!, name: m[2]!.trim(), exchange: 'BVMF', currency: 'BRL' };
  if (B3_TICKER_RE_STRICT.test(p)) return { symbol: p, exchange: 'BVMF', currency: 'BRL' };
  return { name: p, exchange: 'MANUAL', currency: 'BRL', assetClass: /tesouro|cdb|lci|lca|cri|cra|deb/i.test(p) ? 'fixed_income' : 'other' };
}

export const b3NegociacaoPreset: PresetDefinition = {
  id: 'b3-negociacao',
  label: 'B3 Área do Investidor — Negociação (XLSX)',
  broker: 'B3',
  country: 'BR',
  fileKinds: ['xlsx', 'csv'],
  confidence: 'high',
  description: 'Compras y ventas ejecutadas en B3 (mercado a la vista y fraccionario) de todas tus corretoras.',
  exportHelp: 'investidor.b3.com.br → Extratos → Negociação → filtra el periodo (máx. 12 meses por consulta) → Baixar → Excel.',
  detect(table) {
    const h = locateHeader(table, NEG_GROUPS, 0.7, 10);
    return h ? 0.6 + 0.38 * h.coverage : 0;
  },
  parse(table, ctx) {
    const h = locateHeader(table, NEG_GROUPS, 0.5, 10)!;
    const H = h.header;
    const c = {
      date: H.find('Data do Negócio'), side: H.find('Tipo de Movimentação'), market: H.find('Mercado'),
      inst: H.find('Instituição'), code: H.find('Código de Negociação'), qty: H.find('Quantidade'),
      price: H.find('Preço'), value: H.find('Valor'),
    };
    ctx.initDates(columnValues(table, h.index + 1, c.date), 'DMY');
    ctx.initNumbers('comma', columnValues(table, h.index + 1, c.qty, c.price, c.value));
    ctx.fileIssues.push(ctx.issue('B3_NO_FEES', 'info'));
    const rows: ParsedRow[] = [];
    for (let r = h.index + 1; r < table.rows.length; r++) {
      const raw = table.rows[r]!;
      const row = ctx.newRow(r, raw);
      rows.push(row);
      const side = normalizeText(str(raw, c.side));
      const code = str(raw, c.code).toUpperCase();
      const market = normalizeText(str(raw, c.market));
      if (!side && !code) {
        ctx.skip(row, 'SKIPPED_TOTAL');
        continue;
      }
      if (/opcao|opcoes|termo|futuro/.test(market)) {
        ctx.skip(row, 'UNSUPPORTED_ASSET', { value: str(raw, c.market) }, 'warning');
        continue;
      }
      const date = ctx.date(cell(raw, c.date), row);
      const qty = ctx.num(cell(raw, c.qty), row, 'quantity');
      const price = ctx.num(cell(raw, c.price), row, 'price');
      const value = ctx.num(cell(raw, c.value), row, 'amount');
      const type: TransactionType | undefined = side.startsWith('compra') ? 'BUY' : side.startsWith('venda') ? 'SELL' : undefined;
      if (!type) row.issues.push(ctx.issue('UNKNOWN_TYPE', 'error', { value: str(raw, c.side) }, row.line));
      if (!date || !type || qty === undefined) continue;
      const d: DraftTransaction = {
        date, type, currency: 'BRL', quantity: Math.abs(qty),
        instrument: { symbol: code, exchange: 'BVMF', currency: 'BRL' },
      };
      if (price !== undefined) d.price = price;
      if (value !== undefined) d.amount = Math.abs(value);
      const inst = str(raw, c.inst);
      if (inst) d.account = inst;
      row.draft = d;
    }
    return rows;
  },
};

type MovRule =
  | { kind: 'trade' }
  | { kind: 'income'; type: TransactionType; net?: boolean }
  | { kind: 'split'; reverse: boolean }
  | { kind: 'bonus' }
  | { kind: 'skip'; reason: string; severity: 'info' | 'warning' };

export function b3MovementRule(movement: string): MovRule | undefined {
  const m = normalizeText(movement);
  if (/^transferencia liquidacao|^compra venda|^compra$|^venda$|^subscricao$|^vencimento|^resgate|^recompra/.test(m)) return { kind: 'trade' };
  if (/juros sobre capital/.test(m)) return { kind: 'income', type: 'DIVIDEND', net: true };
  if (/^dividendo|^rendimento|^dividendos/.test(m)) return { kind: 'income', type: 'DIVIDEND' };
  if (/^pagamento de juros|^juros/.test(m)) return { kind: 'income', type: 'INTEREST' };
  if (/^amortizacao|^restituicao de capital|^reducao de capital/.test(m)) return { kind: 'income', type: 'RETURN_OF_CAPITAL' };
  if (/^desdobro|^desdobramento/.test(m)) return { kind: 'split', reverse: false };
  if (/^grupamento|^agrupamento/.test(m)) return { kind: 'split', reverse: true };
  if (/^bonificacao/.test(m)) return { kind: 'bonus' };
  if (/^atualizacao/.test(m)) return { kind: 'skip', reason: 'actualización de valor (no es un flujo).', severity: 'info' };
  if (/direito|cessao|recibo de subscricao|solicitacao de subscricao/.test(m)) return { kind: 'skip', reason: 'derechos de suscripción: si los ejerces, la suscripción aparece aparte.', severity: 'info' };
  if (/emprestimo/.test(m)) return { kind: 'skip', reason: 'préstamo de acciones (BTC), no cambia tu propiedad.', severity: 'info' };
  if (/^transferencia/.test(m)) return { kind: 'skip', reason: 'transferencia de custodia entre corretoras; no cambia tu posición total.', severity: 'info' };
  if (/fracao|leilao/.test(m)) return { kind: 'skip', reason: 'fracciones/subasta: regístralo manualmente si es relevante.', severity: 'warning' };
  if (/incorporacao|cisao|conversao|resgate de/.test(m)) return { kind: 'skip', reason: 'evento corporativo: regístralo manualmente.', severity: 'warning' };
  return undefined;
}

export const b3MovimentacaoPreset: PresetDefinition = {
  id: 'b3-movimentacao',
  label: 'B3 Área do Investidor — Movimentação (XLSX)',
  broker: 'B3',
  country: 'BR',
  fileKinds: ['xlsx', 'csv'],
  confidence: 'medium',
  description: 'Movimientos de custodia en B3: liquidaciones de compras/ventas, dividendos, JCP, rendimientos de FII, desdobros, grupamentos, bonificaciones, amortizaciones y vencimientos.',
  exportHelp: 'investidor.b3.com.br → Extratos → Movimentação → filtra el periodo → Baixar → Excel.',
  detect(table) {
    const h = locateHeader(table, MOV_GROUPS, 0.7, 10);
    return h ? 0.6 + 0.38 * h.coverage : 0;
  },
  parse(table, ctx) {
    const h = locateHeader(table, MOV_GROUPS, 0.5, 10)!;
    const H = h.header;
    const c = {
      dir: H.find('Entrada/Saída'), date: H.find('Data'), mov: H.find('Movimentação'), product: H.find('Produto'),
      inst: H.find('Instituição'), qty: H.find('Quantidade'), price: H.find('Preço unitário'), value: H.find('Valor da Operação'),
    };
    ctx.initDates(columnValues(table, h.index + 1, c.date), 'DMY');
    ctx.initNumbers('comma', columnValues(table, h.index + 1, c.qty, c.price, c.value));
    const rows: ParsedRow[] = [];
    let hasTrades = false;
    const transferred: { row: ParsedRow; d: DraftTransaction; base: string }[] = [];
    const incomes: DraftTransaction[] = [];
    for (let r = h.index + 1; r < table.rows.length; r++) {
      const raw = table.rows[r]!;
      const row = ctx.newRow(r, raw);
      rows.push(row);
      const movement = str(raw, c.mov);
      const dir = normalizeText(str(raw, c.dir));
      if (!movement && !str(raw, c.product)) {
        ctx.skip(row, 'SKIPPED_TOTAL');
        continue;
      }
      const isTransferred = /\s-\s*transferido$/i.test(movement);
      const baseMovement = movement.replace(/\s-\s*transferido$/i, '');
      const rule = b3MovementRule(baseMovement);
      if (!rule) {
        ctx.skip(row, 'SKIPPED_MOVEMENT', { value: movement, reason: 'tipo desconocido; regístralo manualmente si aplica.' }, 'warning');
        continue;
      }
      if (rule.kind === 'skip') {
        ctx.skip(row, 'SKIPPED_MOVEMENT', { value: movement, reason: rule.reason }, rule.severity);
        continue;
      }
      const date = ctx.date(cell(raw, c.date), row);
      const qty = ctx.num(cell(raw, c.qty), row, 'quantity');
      const price = ctx.num(cell(raw, c.price), row, 'price');
      const value = ctx.num(cell(raw, c.value), row, 'amount');
      if (!date) continue;
      const instrument = parseB3Product(str(raw, c.product));
      const credit = dir.startsWith('credito') || dir.startsWith('entrada');
      const d: DraftTransaction = { date, type: 'BUY', currency: 'BRL', instrument };
      const inst = str(raw, c.inst);
      if (inst) d.account = inst;
      switch (rule.kind) {
        case 'trade':
          hasTrades = true;
          d.type = credit ? 'BUY' : 'SELL';
          if (qty !== undefined) d.quantity = Math.abs(qty);
          if (price !== undefined) d.price = price;
          if (value !== undefined) d.amount = Math.abs(value);
          d.note = movement;
          break;
        case 'income':
          d.type = rule.type;
          if (value !== undefined) d.amount = Math.abs(value);
          else if (qty !== undefined && price !== undefined) d.amount = Math.abs(qty * price);
          d.note = movement;
          if (rule.net) row.issues.push(ctx.issue('NET_AMOUNT', 'info', undefined, row.line));
          break;
        case 'split':
          d.type = 'SPLIT';
          if (qty !== undefined) d.deltaShares = rule.reverse || !credit ? -Math.abs(qty) : Math.abs(qty);
          d.note = movement;
          break;
        case 'bonus':
          d.type = 'STOCK_DIVIDEND';
          if (qty !== undefined) d.deltaShares = Math.abs(qty);
          if (price !== undefined) d.price = price;
          d.note = movement;
          break;
      }
      row.draft = d;
      const key = `${d.date}|${instrument.symbol ?? instrument.name}|${d.type}|${d.amount ?? ''}`;
      if (isTransferred) transferred.push({ row, d, base: key });
      else if (rule.kind === 'income') incomes.push(d);
    }
    // "Dividendo - Transferido" mirrors a "Dividendo" line of the same event: keep only one.
    const incomeKeys = new Set(incomes.map((d) => `${d.date}|${d.instrument?.symbol ?? d.instrument?.name}|${d.type}|${d.amount ?? ''}`));
    for (const t of transferred) {
      if (incomeKeys.has(t.base)) {
        t.row.draft = undefined;
        t.row.skipped = true;
        t.row.issues.push(ctx.issue('SKIPPED_MOVEMENT', 'info', { value: 'Transferido', reason: 'duplicado del provento original.' }, t.row.line));
      }
    }
    if (hasTrades) ctx.fileIssues.push(ctx.issue('B3_SETTLEMENT_DATE', 'info'));
    ctx.fileIssues.push(ctx.issue('B3_NO_FEES', 'info'));
    return rows;
  },
};
