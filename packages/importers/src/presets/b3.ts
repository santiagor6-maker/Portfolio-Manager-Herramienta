/**
 * B3 Área do Investidor (investidor.b3.com.br) Excel exports:
 *  - "Negociação" (Extratos → Negociação): one row per executed trade (trade date, no fees).
 *  - "Movimentação" (Extratos → Movimentação): custody & cash events — settlements of trades
 *    ("Transferência - Liquidação"), Dividendo, Juros Sobre Capital Próprio, Rendimento, Desdobro,
 *    Grupamento, Bonificação em Ativos, Amortização, Vencimento/Resgate (Tesouro, CDB), etc.
 */
import type { TransactionType } from '@pm/core';
import { B3_TICKER_RE_STRICT, tesouroId } from '../markets';
import type { DraftTransaction, InstrumentHint, ParsedRow } from '../types';
import { businessDaysBetween } from '../calendars';
import { normalizeText, round } from '../util';
import { type ParseContext, type PresetDefinition, cell, locateHeader, str } from './common';

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
  // Tesouro Direto → the TD:<code>-<maturity> ids that @pm/market-data prices automatically.
  const td = tesouroId(p);
  if (td) {
    return {
      name: p,
      currency: 'BRL',
      create: {
        id: td.id, symbol: `${td.code}-${td.maturity.slice(0, 4)}`, name: `${td.tipo} ${td.maturity.slice(0, 4)}`, exchange: 'TD',
        currency: 'BRL', country: 'BR', assetClass: 'fixed_income', sector: 'Government',
        providerSymbols: { tesouro: `${td.tipo}|${td.maturity}` }, pricing: 'auto',
      },
    };
  }
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
    // B3 always exports DD/MM/AAAA and pt-BR numbers (I19: no ambiguity warnings).
    ctx.detectDates([c.date], h.index + 1, 'DMY', { fixed: true });
    ctx.detectNumbers([c.qty, c.price, c.value], h.index + 1, 'comma', { fixed: true });
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
  | { kind: 'fraction' }
  | { kind: 'auction' }
  | { kind: 'corporate'; action: 'merger' | 'spinoff' | 'conversion' | 'other' }
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
  if (/leilao/.test(m)) return { kind: 'auction' };
  if (/fracao/.test(m)) return { kind: 'fraction' };
  if (/incorporacao/.test(m)) return { kind: 'corporate', action: 'merger' };
  if (/cisao/.test(m)) return { kind: 'corporate', action: 'spinoff' };
  if (/conversao/.test(m)) return { kind: 'corporate', action: 'conversion' };
  if (/resgate de|grupamento de|troca de|atualizacao de codigo/.test(m)) return { kind: 'corporate', action: 'other' };
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
    ctx.detectDates([c.date], h.index + 1, 'DMY', { fixed: true });
    ctx.detectNumbers([c.qty, c.price, c.value], h.index + 1, 'comma', { fixed: true });
    const rows: ParsedRow[] = [];
    let hasTrades = false;
    const settlement = settlementMatcher(ctx);
    const fractions: { row: ParsedRow; d: DraftTransaction; key: string }[] = [];
    const auctions: { row: ParsedRow; d: DraftTransaction; key: string; value?: number }[] = [];
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
      if (rule.kind === 'corporate') {
        // Incorporação / cisão / conversão: collect legs for the corporate-action wizard.
        let ca = ctx.corporateActions.find((x) => x.date === date && x.kind === rule.action);
        if (!ca) {
          ca = { line: row.line, date, kind: rule.action, description: movement, legs: [] };
          ctx.corporateActions.push(ca);
        }
        const leg: (typeof ca.legs)[number] = { direction: credit ? 'in' : 'out' };
        if (instrument.symbol) leg.symbol = instrument.symbol;
        if (instrument.name) leg.name = instrument.name;
        if (qty !== undefined) leg.quantity = Math.abs(qty);
        ca.legs.push(leg);
        ctx.skip(row, 'CORPORATE_ACTION_PENDING', { value: movement }, 'warning');
        continue;
      }
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
        case 'fraction':
        case 'auction':
          d.type = 'SELL';
          if (qty !== undefined) d.quantity = Math.abs(qty);
          d.note = movement;
          break;
      }
      if (rule.kind === 'trade' && settlement.match(row, d)) continue;
      if (rule.kind === 'income' && rule.net && d.amount) {
        // JCP is credited net of 15 % IRRF: record gross + tax (estimated).
        const net = d.amount;
        const gross = round(net / 0.85, 2);
        d.amount = gross;
        d.taxes = round(gross - net, 2);
        row.issues.push(ctx.issue('JCP_GROSS_ESTIMATED', 'info', { net, gross }, row.line));
      }
      row.draft = d;
      const pkey = instrument.symbol ?? instrument.name ?? '';
      if (rule.kind === 'fraction') fractions.push({ row, d, key: pkey });
      if (rule.kind === 'auction') {
        const a: (typeof auctions)[number] = { row, d, key: pkey };
        if (value !== undefined) a.value = Math.abs(value);
        auctions.push(a);
      }
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
    // "Fração em Ativos" (shares removed) + "Leilão de Fração" (cash later) → one SELL of the fraction.
    for (const f of fractions) {
      const idx = auctions.findIndex((a) => a.key === f.key && a.d.date >= f.d.date);
      if (idx >= 0) {
        const a = auctions.splice(idx, 1)[0]!;
        const value = a.value ?? (a.d.amount ?? 0);
        f.d.amount = value;
        f.d.price = f.d.quantity ? round(value / f.d.quantity, 8) : 0;
        f.d.note = `${f.d.note} + ${a.d.note} (${a.d.date})`;
        a.row.draft = undefined;
        a.row.skipped = true;
        a.row.issues.push(ctx.issue('FRACTION_SOLD', 'info', undefined, a.row.line));
      } else {
        f.d.price = 0;
        f.d.amount = 0;
        f.row.issues.push(ctx.issue('FRACTION_PENDING', 'warning', undefined, f.row.line));
      }
    }
    for (const a of auctions) {
      if (a.value !== undefined) {
        a.d.amount = a.value;
        if (a.d.quantity) a.d.price = round(a.value / a.d.quantity, 8);
      }
    }
    if (hasTrades && settlement.matched === 0 && ctx.options.b3SettlementMode !== 'skip') ctx.fileIssues.push(ctx.issue('B3_SETTLEMENT_DATE', 'info'));
    ctx.fileIssues.push(ctx.issue('B3_NO_FEES', 'info'));
    return rows;
  },
};

/**
 * Matches "Transferência - Liquidação" rows (settlement, D+2 business days on the B3 calendar) with
 * trades already imported from Negociação or notas de corretagem, so they are not counted twice.
 */
function settlementMatcher(ctx: ParseContext) {
  const mode = ctx.options.b3SettlementMode ?? 'auto';
  const sources = new Set(['import:b3-negociacao', 'import:nota-corretagem', 'import:nota-sinacor-pdf']);
  const trades = (ctx.options.existingTransactions ?? []).filter((t) => (t.type === 'BUY' || t.type === 'SELL') && sources.has(t.source ?? '') && t.instrumentId);
  const bySymbol = new Map<string, typeof trades>();
  for (const t of trades) {
    const sym = t.instrumentId!.split(':').pop()!.replace(/F$/, '');
    bySymbol.set(sym, [...(bySymbol.get(sym) ?? []), t]);
  }
  const used = new Set<string>();
  const state = {
    matched: 0,
    match(row: ParsedRow, d: DraftTransaction): boolean {
      if (mode === 'include') return false;
      if (mode === 'skip') {
        ctx.skip(row, 'SKIPPED_MOVEMENT', { value: 'Transferência - Liquidação', reason: 'liquidaciones omitidas (b3SettlementMode = skip).' });
        return true;
      }
      const sym = d.instrument?.symbol?.replace(/F$/, '');
      if (!sym) return false;
      const cand = (bySymbol.get(sym) ?? []).find((t) => {
        if (used.has(t.id) || t.type !== d.type || Math.abs((t.quantity ?? 0) - (d.quantity ?? 0)) > 1e-6) return false;
        const bd = businessDaysBetween(t.date, d.date, 'BR');
        return bd >= 0 && bd <= 3;
      });
      if (!cand) return false;
      used.add(cand.id);
      state.matched++;
      ctx.skip(row, 'SETTLEMENT_MATCHED', { date: cand.date });
      return true;
    },
  };
  return state;
}

const POS_GROUPS = [['Produto'], ['Instituição'], ['Código de Negociação'], ['Quantidade'], ['Preço de Fechamento'], ['Valor Atualizado']];

/** B3 Área do Investidor → Extratos → Posição: reconciliation (default) or opening positions. */
export const b3PosicaoPreset: PresetDefinition = {
  id: 'b3-posicao',
  label: 'B3 Área do Investidor — Posição (XLSX)',
  broker: 'B3',
  country: 'BR',
  fileKinds: ['xlsx'],
  confidence: 'medium',
  multiSheet: true,
  description: 'Foto de tus posiciones en B3 (acciones, FII, ETF, BDR). Sirve para conciliar contra lo importado o como posición inicial.',
  exportHelp: 'investidor.b3.com.br → Extratos → Posição → elige la fecha → Baixar → Excel.',
  detect(table) {
    const h = locateHeader(table, POS_GROUPS, 0.8, 10);
    return h ? 0.95 : 0;
  },
  parse(table, ctx) {
    const h = locateHeader(table, POS_GROUPS, 0.6, 10)!;
    const H = h.header;
    const c = {
      product: H.find('Produto'), inst: H.find('Instituição'), code: H.find('Código de Negociação'), isin: H.find('Código ISIN / Distribuição', 'Código ISIN'),
      qty: H.find('Quantidade'), price: H.find('Preço de Fechamento'), value: H.find('Valor Atualizado'),
    };
    ctx.detectNumbers([c.qty, c.price, c.value], h.index + 1, 'comma', { fixed: true });
    const reported: NonNullable<ParseContext['reported']> = { source: 'b3-posicao', positions: [], cash: [] };
    if (ctx.options.asOfDate) reported.asOf = ctx.options.asOfDate;
    const rows: ParsedRow[] = [];
    for (let r = h.index + 1; r < table.rows.length; r++) {
      const raw = table.rows[r]!;
      const code = str(raw, c.code).toUpperCase();
      const qty = ctx.num(cell(raw, c.qty), { line: 0, issues: [] }, 'quantity');
      if (!code || qty === undefined) continue;
      const price = ctx.num(cell(raw, c.price), { line: 0, issues: [] }, 'price');
      const value = ctx.num(cell(raw, c.value), { line: 0, issues: [] }, 'value');
      const hint = { symbol: code, exchange: 'BVMF', currency: 'BRL', name: str(raw, c.product) };
      const pos: NonNullable<ParseContext['reported']>['positions'][number] = { symbol: code, quantity: qty, currency: 'BRL', hint };
      if (price !== undefined) pos.price = price;
      if (value !== undefined) pos.marketValue = value;
      reported.positions.push(pos);
      if (ctx.options.positionsMode === 'opening') {
        const row = ctx.newRow(r, raw);
        rows.push(row);
        if (!ctx.options.asOfDate) {
          row.issues.push(ctx.issue('MISSING_FIELD', 'error', { field: 'asOfDate' }, row.line));
          continue;
        }
        const d: DraftTransaction = { date: ctx.options.asOfDate, type: 'TRANSFER_IN', currency: 'BRL', quantity: qty, instrument: hint, note: 'Posición inicial (B3 Posição)' };
        if (price !== undefined) d.price = price;
        if (value !== undefined) d.amount = value;
        const inst = str(raw, c.inst);
        if (inst) d.account = inst;
        row.draft = d;
        row.issues.push(ctx.issue('TRANSFER_COST_FROM_MARKET', 'warning', undefined, row.line));
      }
    }
    ctx.reported = reported;
    return rows;
  },
};
