/**
 * Interactive Brokers
 *  - Activity Statement CSV (Reports → Statements → Activity → CSV): multi-section file where each row is
 *    `Section,Header|Data|SubTotal|Total,...`. We read Trades, Dividends, Withholding Tax, Payment In Lieu
 *    Of Dividends, Deposits & Withdrawals, Interest, Fees, Corporate Actions (splits) and Financial
 *    Instrument Information (ISIN / listing exchange / type).
 *  - Flex Query CSV (Trades and/or Cash Transactions sections, user-chosen columns, optional BOF/BOS markers).
 */
import type { AssetClass, TransactionType } from '@pm/core';
import { IBKR_EXCHANGES } from '../markets';
import type { Cell, CorporateActionSuggestion, DraftTransaction, InstrumentHint, ParsedRow, RawTable } from '../types';
import { cellToString, normalizeText } from '../util';
import { parseDate } from '../dates';
import { HeaderIndex, type ParseContext, type PresetDefinition } from './common';

interface FinInfo {
  isin?: string;
  exchange?: string;
  name?: string;
  type?: string;
}

function ibkrAssetClass(type?: string, category?: string): AssetClass | undefined {
  const t = (type ?? '').toUpperCase();
  if (t === 'ETF') return 'etf';
  if (t === 'REIT') return 'reit';
  if (t === 'COMMON' || t === 'ADR' || t === 'PREFERRED') return 'equity';
  if (/bond/i.test(category ?? '')) return 'bond';
  if (/crypto/i.test(category ?? '')) return 'crypto';
  return undefined;
}

function ibkrSymbol(s: string): string {
  return s.trim().replace(/\s+/g, '.');
}

const DESC_RE = /^([A-Z0-9][A-Z0-9.\- ]*?)\s?\(([A-Z]{2}[A-Z0-9]{9}\d)\)/;

/** "AAPL(US0378331005) Cash Dividend USD 0.24 per Share" → { symbol, isin } */
export function parseIbkrDescription(desc: string): { symbol?: string; isin?: string } {
  const m = DESC_RE.exec(desc.trim());
  if (m) return { symbol: ibkrSymbol(m[1]!), isin: m[2]! };
  const m2 = /^([A-Z0-9.]+)\s/.exec(desc.trim());
  return m2 ? { symbol: m2[1]! } : {};
}

function hint(symbol: string | undefined, isin: string | undefined, currency: string, info: Map<string, FinInfo>, category?: string): InstrumentHint | undefined {
  if (!symbol && !isin) return undefined;
  const fi = (symbol && info.get(symbol)) || undefined;
  const h: InstrumentHint = { currency };
  if (symbol) h.symbol = symbol;
  const i = isin ?? fi?.isin;
  if (i) h.isin = i;
  if (fi?.name) h.name = fi.name;
  const ex = fi?.exchange ? IBKR_EXCHANGES[fi.exchange.toUpperCase()] ?? fi.exchange : undefined;
  if (ex) h.exchange = ex;
  const ac = ibkrAssetClass(fi?.type, category);
  if (ac) h.assetClass = ac;
  return h;
}

/** Merge withholding-tax drafts into dividends of the same instrument/date/currency. */
function mergeWithholding(
  ctx: ParseContext,
  dividends: { row: ParsedRow; d: DraftTransaction }[],
  taxes: { row: ParsedRow; d: DraftTransaction }[],
): void {
  for (const t of taxes) {
    const key = (x: DraftTransaction) => `${x.date}|${x.instrument?.symbol ?? x.instrument?.isin ?? ''}|${x.currency}`;
    const div = dividends.find((x) => key(x.d) === key(t.d)) ??
      dividends.find((x) => x.d.currency === t.d.currency && (x.d.instrument?.symbol ?? '') === (t.d.instrument?.symbol ?? '') && Math.abs(Date.parse(x.d.date) - Date.parse(t.d.date)) <= 7 * 86400000);
    if (div && t.d.amount !== undefined && t.d.amount > 0) {
      div.d.taxes = (div.d.taxes ?? 0) + t.d.amount;
      t.row.draft = undefined;
      t.row.skipped = true;
      t.row.issues.push(ctx.issue('WITHHOLDING_MERGED', 'info', { amount: t.d.amount, currency: t.d.currency }, t.row.line));
    }
  }
}

// ---------------------------------------------------------------------------
// Activity Statement
// ---------------------------------------------------------------------------

/** Informational sections that never carry transactions (no warning when ignored). */
const META_SECTIONS = new Set([
  'Statement', 'Account Information', 'Financial Instrument Information', 'Codes', 'Notes/Legal Notes', 'Net Asset Value',
  'Change in NAV', 'Mark-to-Market Performance Summary', 'Realized & Unrealized Performance Summary', 'Base Currency Exchange Rate',
  'Location of Customer Assets, Positions and Money', 'Month & Year to Date Performance Summary', 'Disclosures', 'Notes',
]);

const ACTIVITY_SECTIONS = new Set([
  'Statement', 'Account Information', 'Net Asset Value', 'Trades', 'Dividends', 'Withholding Tax', 'Deposits & Withdrawals',
  'Interest', 'Fees', 'Corporate Actions', 'Financial Instrument Information', 'Open Positions', 'Cash Report',
  'Change in NAV', 'Mark-to-Market Performance Summary', 'Realized & Unrealized Performance Summary', 'Codes', 'Notes/Legal Notes',
]);

export const ibkrActivityPreset: PresetDefinition = {
  id: 'ibkr-activity',
  label: 'Interactive Brokers — Activity Statement (CSV)',
  broker: 'Interactive Brokers',
  country: 'INTL',
  fileKinds: ['csv'],
  confidence: 'high',
  description: 'Extracto de actividad en CSV: operaciones, dividendos con retención, depósitos/retiros, intereses, comisiones, splits y conversiones de divisas.',
  exportHelp: 'Portal del Cliente → Rendimiento e Informes → Extractos → Actividad → periodo (p. ej. Anual o Personalizado) → formato CSV → Ejecutar.',
  detect(table) {
    const first = table.rows[0];
    if (first && cellToString(first[0]) === 'Statement' && cellToString(first[1]) === 'Header') return 0.98;
    let hits = 0;
    for (const r of table.rows.slice(0, 200)) {
      const s = cellToString(r[0]);
      const k = cellToString(r[1]);
      if (ACTIVITY_SECTIONS.has(s) && (k === 'Header' || k === 'Data')) hits++;
    }
    return hits >= 3 ? 0.85 : 0;
  },
  parse(table, ctx) {
    ctx.initNumbers('dot', []);
    ctx.dateFormat = ctx.options.dateFormat ?? 'YMD';
    const headers = new Map<string, HeaderIndex>();
    const info = new Map<string, FinInfo>();
    let periodEnd: string | undefined;
    const accountIds: string[] = ['Interactive Brokers'];
    // First pass: instrument information (appears at the end of the statement).
    for (const r of table.rows) {
      const section = cellToString(r[0]);
      const kind = cellToString(r[1]);
      if (section === 'Account Information' && kind === 'Data' && cellToString(r[2]) === 'Account') accountIds.push(cellToString(r[3]));
      if (section === 'Statement' && kind === 'Data' && cellToString(r[2]) === 'Period') {
        const end = cellToString(r[3]).split(/\s+-\s+/).pop();
        const iso = end ? parseDate(end, 'MDY') : undefined;
        if (iso) periodEnd = iso;
      }
      if (section !== 'Financial Instrument Information') continue;
      if (kind === 'Header') headers.set(section, new HeaderIndex(r.slice(2)));
      else if (kind === 'Data') {
        const h = headers.get(section)!;
        const f = r.slice(2);
        const sym = ibkrSymbol(cellToString(f[h.find('Symbol') ?? -1] ?? null));
        const fi: FinInfo = {};
        const isin = cellToString(f[h.find('Security ID') ?? -1] ?? null);
        if (/^[A-Z]{2}[A-Z0-9]{9}\d$/.test(isin)) fi.isin = isin;
        const ex = cellToString(f[h.find('Listing Exch') ?? -1] ?? null);
        if (ex) fi.exchange = ex;
        const name = cellToString(f[h.find('Description') ?? -1] ?? null);
        if (name) fi.name = name;
        const type = cellToString(f[h.find('Type') ?? -1] ?? null);
        if (type) fi.type = type;
        for (const s of sym.split(/,\s*/)) if (s) info.set(s, fi);
      }
    }
    headers.clear();

    const rows: ParsedRow[] = [];
    const dividends: { row: ParsedRow; d: DraftTransaction }[] = [];
    const taxes: { row: ParsedRow; d: DraftTransaction }[] = [];
    const splitsSeen = new Set<string>();
    const unhandled = new Map<string, number>();
    const reported: NonNullable<ParseContext['reported']> = { source: 'ibkr-activity', positions: [], cash: [] };

    table.rows.forEach((r, idx) => {
      const section = cellToString(r[0]);
      const kind = cellToString(r[1]);
      if (kind === 'Header') {
        headers.set(section, new HeaderIndex(r.slice(2)));
        return;
      }
      if (kind !== 'Data') return;
      const h = headers.get(section);
      if (!h) return;
      const f = r.slice(2);
      const get = (...names: string[]): Cell => {
        const i = h.find(...names);
        return i === undefined ? null : f[i] ?? null;
      };
      const getS = (...names: string[]) => cellToString(get(...names));
      const currency = getS('Currency');
      if (/^total/i.test(currency) || /^total/i.test(getS('Asset Category')) || /^total/i.test(getS('Subtitle'))) return;
      if (section === 'Open Positions') {
        if (getS('DataDiscriminator') && getS('DataDiscriminator') !== 'Summary') return;
        const sym = ibkrSymbol(getS('Symbol'));
        const qty = ctx.num(get('Quantity'), { line: 0, issues: [] }, 'quantity');
        if (!sym || qty === undefined) return;
        const pos = { symbol: sym, quantity: qty, currency, hint: hint(sym, undefined, currency, info, getS('Asset Category')) } as NonNullable<typeof reported>['positions'][number];
        const cost = ctx.num(get('Cost Basis'), { line: 0, issues: [] }, 'cost');
        const value = ctx.num(get('Value'), { line: 0, issues: [] }, 'value');
        const close = ctx.num(get('Close Price'), { line: 0, issues: [] }, 'price');
        if (cost !== undefined) pos.costBasis = cost;
        if (value !== undefined) pos.marketValue = value;
        if (close !== undefined) pos.price = close;
        reported.positions.push(pos);
        if (ctx.options.positionsMode === 'opening') {
          const row = ctx.newRow(idx, r);
          rows.push(row);
          const date = ctx.options.asOfDate ?? periodEnd;
          if (!date) {
            row.issues.push(ctx.issue('MISSING_FIELD', 'error', { field: 'asOfDate' }, row.line));
            return;
          }
          const d: DraftTransaction = { date, type: qty >= 0 ? 'TRANSFER_IN' : 'TRANSFER_OUT', currency, quantity: Math.abs(qty), note: 'Posición inicial (Open Positions)' };
          const costPrice = ctx.num(get('Cost Price'), row, 'price');
          if (costPrice !== undefined) d.price = costPrice;
          if (cost !== undefined) d.amount = Math.abs(cost);
          if (pos.hint) d.instrument = pos.hint;
          row.draft = d;
          row.issues.push(ctx.issue('OPENING_POSITION', 'info', undefined, row.line));
        }
        return;
      }
      if (section === 'Cash Report') {
        const kindRow = normalizeText(cellToString(f[0] ?? null));
        if (kindRow === 'ending cash' && /^[A-Z]{3}$/.test(currency)) {
          const total = ctx.num(get('Total'), { line: 0, issues: [] }, 'amount');
          if (total !== undefined) reported.cash.push({ currency, amount: total });
        }
        return;
      }
      const handled = ['Trades', 'Dividends', 'Payment In Lieu Of Dividends', 'Withholding Tax', 'Deposits & Withdrawals', 'Interest', 'Fees', 'Corporate Actions', 'Transfers', 'Transaction Fees'];
      if (!handled.includes(section)) {
        if (!META_SECTIONS.has(section)) unhandled.set(section, (unhandled.get(section) ?? 0) + 1);
        return;
      }
      const row = ctx.newRow(idx, r);
      rows.push(row);

      if (section === 'Trades') {
        const disc = getS('DataDiscriminator');
        if (disc && disc !== 'Order' && disc !== 'Trade') {
          row.skipped = true;
          return;
        }
        const category = getS('Asset Category');
        const date = ctx.date(get('Date/Time', 'TradeDate', 'Date'), row);
        const qty = ctx.num(get('Quantity'), row, 'quantity');
        const price = ctx.num(get('T. Price', 'TradePrice', 'Price'), row, 'price');
        const proceeds = ctx.num(get('Proceeds'), row, 'proceeds');
        const commIdx = h.find('Comm/Fee', 'Comm in');
        const comm = commIdx === undefined ? undefined : ctx.num(f[commIdx] ?? null, row, 'fees');
        if (!date || qty === undefined) return;
        if (/forex/i.test(category)) {
          const [base, quote] = getS('Symbol').split('.');
          if (!base || !quote) return;
          const p = Math.abs(proceeds ?? qty * (price ?? 0));
          const d: DraftTransaction =
            qty > 0
              ? { date, type: 'FX_CONVERSION', currency: quote, amount: p, toCurrency: base, toAmount: Math.abs(qty) }
              : { date, type: 'FX_CONVERSION', currency: base, amount: Math.abs(qty), toCurrency: quote, toAmount: p };
          const commHeader = commIdx !== undefined ? h.norm[commIdx] ?? '' : '';
          const commCcy = /comm in ([a-z]{3})/.exec(commHeader)?.[1]?.toUpperCase() ?? currency;
          if (comm && commCcy === d.currency) d.fees = Math.abs(comm);
          else if (comm) {
            // IBKR charges FX commissions in the base currency: record them as a separate FEE.
            row.extra = [{ date, type: 'FEE', currency: commCcy, amount: Math.abs(comm), note: `Comisión conversión ${getS('Symbol')}` }];
            row.issues.push(ctx.issue('FX_FEE_SEPARATE', 'info', { amount: Math.abs(comm), currency: commCcy }, row.line));
          }
          row.draft = d;
          return;
        }
        if (!/stock|etf|fund/i.test(category)) {
          ctx.skip(row, 'UNSUPPORTED_ASSET', { value: category }, 'warning');
          return;
        }
        const sym = ibkrSymbol(getS('Symbol'));
        const d: DraftTransaction = { date, type: qty >= 0 ? 'BUY' : 'SELL', currency, quantity: Math.abs(qty) };
        if (price !== undefined) d.price = price;
        if (proceeds !== undefined && proceeds !== 0) d.amount = Math.abs(proceeds);
        if (comm) d.fees = Math.abs(comm);
        const ih = hint(sym, undefined, currency, info, category);
        if (ih) d.instrument = ih;
        row.draft = d;
        return;
      }

      const date = ctx.date(get('Date', 'Settle Date', 'Report Date', 'Date/Time'), row);
      const desc = getS('Description');
      const amount = ctx.num(get('Amount', 'Proceeds'), row, 'amount');
      if (!date) return;

      if (section === 'Dividends' || section === 'Payment In Lieu Of Dividends') {
        if (amount === undefined) return;
        const { symbol, isin } = parseIbkrDescription(desc);
        const d: DraftTransaction = { date, type: 'DIVIDEND', currency, amount, note: desc };
        const ih = hint(symbol, isin, currency, info);
        if (ih) d.instrument = ih;
        row.draft = d;
        dividends.push({ row, d });
        return;
      }
      if (section === 'Withholding Tax') {
        if (amount === undefined) return;
        const { symbol, isin } = parseIbkrDescription(desc);
        // Negative = tax withheld; positive = refund (TAX with negative amount).
        const d: DraftTransaction = { date, type: 'TAX', currency, amount: -amount, note: desc };
        const ih = hint(symbol, isin, currency, info);
        if (ih) d.instrument = ih;
        row.draft = d;
        taxes.push({ row, d });
        return;
      }
      if (section === 'Deposits & Withdrawals') {
        if (amount === undefined) return;
        row.draft = { date, type: amount >= 0 ? 'DEPOSIT' : 'WITHDRAWAL', currency, amount: Math.abs(amount), note: desc };
        return;
      }
      if (section === 'Interest') {
        if (amount === undefined) return;
        row.draft = amount >= 0
          ? { date, type: 'INTEREST', currency, amount, note: desc }
          : { date, type: 'FEE', currency, amount: -amount, note: desc };
        return;
      }
      if (section === 'Fees') {
        if (amount === undefined) return;
        row.draft = { date, type: 'FEE', currency, amount: -amount, note: desc };
        if (amount > 0) row.issues.push(ctx.issue('FEE_REFUND', 'info', undefined, row.line));
        return;
      }
      if (section === 'Transfers') {
        const category = getS('Asset Category');
        const tdate = ctx.date(get('Date', 'Settle Date', 'Date/Time'), row);
        const dir = normalizeText(getS('Direction'));
        const qty = ctx.num(get('Qty', 'Quantity'), row, 'quantity');
        const cashAmt = ctx.num(get('Cash Amount'), row, 'amount');
        if (!tdate) return;
        const out = dir.startsWith('out') || (qty !== undefined && qty < 0);
        const what = `${getS('Type')} ${getS('Direction')} ${getS('Xfer Company')}`.trim();
        if (/cash/i.test(category) || (!qty && cashAmt)) {
          if (!cashAmt) return;
          row.draft = { date: tdate, type: cashAmt >= 0 && !out ? 'DEPOSIT' : 'WITHDRAWAL', currency, amount: Math.abs(cashAmt), note: what };
          return;
        }
        if (!qty) return;
        const sym = ibkrSymbol(getS('Symbol'));
        const xprice = ctx.num(get('Xfer Price'), row, 'price');
        const mv = ctx.num(get('Market Value'), row, 'amount');
        const d: DraftTransaction = { date: tdate, type: out ? 'TRANSFER_OUT' : 'TRANSFER_IN', currency, quantity: Math.abs(qty), note: what };
        if (xprice) d.price = xprice;
        else if (mv) {
          d.price = Math.abs(mv) / Math.abs(qty);
          row.issues.push(ctx.issue('TRANSFER_COST_FROM_MARKET', 'warning', undefined, row.line));
        }
        if (mv) d.amount = Math.abs(mv);
        const ih = hint(sym, undefined, currency, info, category);
        if (ih) d.instrument = ih;
        row.draft = d;
        return;
      }
      if (section === 'Transaction Fees') {
        const fdate = ctx.date(get('Date/Time', 'Date'), row);
        const amt = ctx.num(get('Amount'), row, 'amount');
        if (!fdate || amt === undefined) return;
        const sym = ibkrSymbol(getS('Symbol'));
        const d: DraftTransaction = { date: fdate, type: 'FEE', currency, amount: -amt, note: getS('Description') || 'Transaction fee' };
        const ih = hint(sym, undefined, currency, info, getS('Asset Category'));
        if (ih) d.instrument = ih;
        row.draft = d;
        return;
      }
      if (section === 'Corporate Actions') {
        const m = /split (\d+(?:\.\d+)?) for (\d+(?:\.\d+)?)/i.exec(desc);
        const { symbol, isin } = parseIbkrDescription(desc);
        if (m && symbol) {
          const ratio = Number(m[1]) / Number(m[2]);
          const key = `${symbol}|${date}|${ratio}`;
          if (splitsSeen.has(key)) {
            row.skipped = true;
            return;
          }
          splitsSeen.add(key);
          const d: DraftTransaction = { date, type: 'SPLIT', currency, ratio, note: desc };
          const ih = hint(symbol, isin, currency, info);
          if (ih) d.instrument = ih;
          row.draft = d;
          return;
        }
        ctx.skip(row, 'SKIPPED_MOVEMENT', { value: desc.slice(0, 60), reason: 'acción corporativa: regístrala manualmente.' }, 'warning');
      }
    });

    // Net dividend reversals (IBKR re-posts corrected dividends as -X / +Y).
    const groups = new Map<string, { row: ParsedRow; d: DraftTransaction }[]>();
    for (const x of dividends) {
      const k = `${x.d.date}|${x.d.instrument?.symbol ?? ''}|${x.d.currency}`;
      groups.set(k, [...(groups.get(k) ?? []), x]);
    }
    const keptDividends: { row: ParsedRow; d: DraftTransaction }[] = [];
    for (const g of groups.values()) {
      if (g.length === 1 && (g[0]!.d.amount ?? 0) > 0) {
        keptDividends.push(g[0]!);
        continue;
      }
      const total = g.reduce((s, x) => s + (x.d.amount ?? 0), 0);
      const keeper = g.find((x) => (x.d.amount ?? 0) > 0);
      for (const x of g) {
        if (x === keeper && total > 0.000001) {
          x.d.amount = Math.round(total * 1e8) / 1e8;
          keptDividends.push(x);
          if (g.length > 1) x.row.issues.push(ctx.issue('DIVIDEND_REVERSAL', 'info', undefined, x.row.line));
        } else {
          x.row.draft = undefined;
          x.row.skipped = true;
          x.row.issues.push(ctx.issue('DIVIDEND_REVERSAL', 'info', undefined, x.row.line));
        }
      }
    }
    mergeWithholding(ctx, keptDividends, taxes);
    for (const [section, count] of unhandled) ctx.fileIssues.push(ctx.issue('UNHANDLED_SECTION', 'warning', { section, count }));
    if (reported.positions.length || reported.cash.length) {
      const asOf = ctx.options.asOfDate ?? periodEnd;
      if (asOf) reported.asOf = asOf;
      reported.accountIds = accountIds.filter(Boolean);
      ctx.reported = reported;
    }
    return rows;
  },
};

// ---------------------------------------------------------------------------
// Flex Query
// ---------------------------------------------------------------------------

const FLEX_MARKERS = new Set(['BOF', 'BOA', 'BOS', 'EOS', 'EOA', 'EOF', 'MSG']);

function isFlexHeader(r: Cell[]): boolean {
  const n = r.map((c) => normalizeText(cellToString(c)).replace(/ /g, ''));
  const hits = ['clientaccountid', 'currencyprimary', 'assetclass', 'symbol', 'tradedate', 'quantity', 'tradeprice', 'ibcommission', 'buysell', 'type', 'amount', 'datetime', 'settledate', 'listingexchange', 'isin', 'transactionid', 'tradeid']
    .filter((k) => n.includes(k)).length;
  const extra = ['position', 'markprice', 'positionvalue', 'direction', 'transfercompany'].filter((k) => n.includes(k)).length;
  return hits + extra >= 4 && (n.includes('currencyprimary') || n.includes('clientaccountid') || n.includes('ibcommission') || n.includes('tradeprice'));
}

export const ibkrFlexPreset: PresetDefinition = {
  id: 'ibkr-flex',
  label: 'Interactive Brokers — Flex Query (CSV)',
  broker: 'Interactive Brokers',
  country: 'INTL',
  fileKinds: ['csv'],
  confidence: 'medium',
  description: 'Flex Query de operaciones (Trades) y/o movimientos de efectivo (Cash Transactions) en CSV.',
  exportHelp: 'Portal del Cliente → Rendimiento e Informes → Consultas Flex → crear consulta de actividad con las secciones "Trades" y "Cash Transactions" (incluir Symbol, ISIN, ListingExchange, CurrencyPrimary, TradeDate, Quantity, TradePrice, IBCommission, Buy/Sell, TransactionID, Type, Amount, DateTime) → formato CSV.',
  detect(table) {
    for (const r of table.rows.slice(0, 10)) if (isFlexHeader(r)) return 0.9;
    return 0;
  },
  parse(table, ctx) {
    ctx.initNumbers('dot', []);
    let h: HeaderIndex | undefined;
    // Detect date order from all date-like columns once.
    const dateVals: Cell[] = [];
    let tmp: HeaderIndex | undefined;
    for (const r of table.rows) {
      if (isFlexHeader(r)) {
        tmp = new HeaderIndex(r);
        continue;
      }
      if (!tmp) continue;
      for (const k of ['TradeDate', 'DateTime', 'SettleDate', 'ReportDate']) {
        const i = tmp.find(k);
        if (i !== undefined) dateVals.push(r[i] ?? null);
      }
    }
    ctx.initDates(dateVals, 'YMD');

    const rows: ParsedRow[] = [];
    const dividends: { row: ParsedRow; d: DraftTransaction }[] = [];
    const taxes: { row: ParsedRow; d: DraftTransaction }[] = [];
    const flexReported: NonNullable<ParseContext['reported']> = { source: 'ibkr-flex', positions: [], cash: [] };
    const corpSeen = new Set<string>();
    const hasExecutions = table.rows.some((r) => r.some((c) => cellToString(c).toUpperCase() === 'EXECUTION'));
    table.rows.forEach((r, idx) => {
      const first = cellToString(r[0]);
      if (FLEX_MARKERS.has(first)) return;
      if (first === 'FlexSection' || isFlexHeader(r)) {
        h = new HeaderIndex(r);
        return;
      }
      if (!h) return;
      const get = (...names: string[]): Cell => {
        const i = h!.find(...names);
        return i === undefined ? null : r[i] ?? null;
      };
      const getS = (...names: string[]) => cellToString(get(...names));
      const row = ctx.newRow(idx, r);
      rows.push(row);
      const currency = getS('CurrencyPrimary', 'Currency');
      const symbol = ibkrSymbol(getS('Symbol'));
      const isin = getS('ISIN', 'SecurityID');
      const exCode = getS('ListingExchange');
      const assetClass = getS('AssetClass');
      const ih: InstrumentHint | undefined = symbol || isin ? { currency } : undefined;
      if (ih) {
        if (symbol) ih.symbol = symbol;
        if (/^[A-Z]{2}[A-Z0-9]{9}\d$/.test(isin)) ih.isin = isin;
        const ex = IBKR_EXCHANGES[exCode.toUpperCase()];
        if (ex) ih.exchange = ex;
      }
      const ref = getS('TransactionID', 'TradeID', 'IBExecID', 'ActionID');
      const section = getS('FlexSection');
      // Summary rows duplicate the detail rows (I22): keep the most granular level only.
      const lod = getS('LevelOfDetail').toUpperCase();
      if (lod === 'SUMMARY' && !h.has('MarkPrice', 'PositionValue')) {
        row.skipped = true;
        return;
      }
      if (lod && ['SYMBOL_SUMMARY', 'ASSET_SUMMARY', 'CLOSED_LOT'].includes(lod)) {
        row.skipped = true;
        return;
      }
      if (lod === 'ORDER' && hasExecutions) {
        row.skipped = true;
        return;
      }
      if (section === 'SalesTax' || (!section && h.has('SalesTax') && !h.has('TradePrice'))) {
        const tdate = ctx.date(get('Date', 'DateTime', 'ReportDate'), row);
        const v = ctx.num(get('SalesTax', 'Amount'), row, 'amount');
        if (!tdate || v === undefined) return;
        row.draft = { date: tdate, type: 'TAX', currency, amount: -v, note: getS('Description') || 'Sales tax' };
        if (ref) row.draft.brokerRef = ref;
        return;
      }
      if (section === 'CorporateAction' || (!section && h.has('ActionID') && h.has('Type') && h.has('Description') && !h.has('Amount'))) {
        const cdate = ctx.date(get('DateTime', 'ReportDate', 'Date'), row);
        if (!cdate) return;
        const desc = getS('Description');
        const code = getS('Type').toUpperCase();
        const qty = ctx.num(get('Quantity'), row, 'quantity');
        const split = /split\s+(\d+(?:\.\d+)?)\s+for\s+(\d+(?:\.\d+)?)/i.exec(desc);
        if (code === 'FS' || code === 'RS' || split) {
          const ratio = split ? Number(split[1]) / Number(split[2]) : undefined;
          const key = `${symbol}|${cdate}|${ratio ?? qty}`;
          if (corpSeen.has(key) || !ih) {
            row.skipped = true;
            return;
          }
          corpSeen.add(key);
          const d: DraftTransaction = { date: cdate, type: 'SPLIT', currency, instrument: ih, note: desc };
          if (ratio) d.ratio = ratio;
          else if (qty !== undefined) d.deltaShares = code === 'RS' ? -Math.abs(qty) : qty;
          if (ref) d.brokerRef = ref;
          row.draft = d;
          return;
        }
        if ((code === 'SD' || /stock dividend/i.test(desc)) && qty && ih) {
          row.draft = { date: cdate, type: 'STOCK_DIVIDEND', currency, instrument: ih, deltaShares: Math.abs(qty), note: desc, ...(ref ? { brokerRef: ref } : {}) };
          return;
        }
        const kind = code === 'SO' ? 'spinoff' : code === 'TC' || code === 'TO' || code === 'TM' ? 'merger' : code === 'IC' ? 'symbol_change' : 'other';
        const leg: CorporateActionSuggestion['legs'][number] = { direction: (qty ?? 0) < 0 ? 'out' : 'in' };
        if (symbol) leg.symbol = symbol;
        if (qty !== undefined) leg.quantity = Math.abs(qty);
        if (desc) leg.name = desc;
        ctx.corporateActions.push({ line: row.line, date: cdate, kind, description: desc || code, legs: [leg] });
        ctx.skip(row, 'CORPORATE_ACTION_PENDING', { value: (desc || code).slice(0, 60) }, 'warning');
        return;
      }
      if (h.has('MarkPrice', 'PositionValue') && h.has('Position')) {
        // Open positions (reconciliation / opening snapshot).
        const qty = ctx.num(get('Position', 'Quantity'), row, 'quantity');
        if (qty === undefined || !ih) {
          row.skipped = true;
          return;
        }
        const pos = { symbol, quantity: qty, currency, hint: ih } as NonNullable<ParseContext['reported']>['positions'][number];
        const mv = ctx.num(get('PositionValue'), row, 'value');
        const cb = ctx.num(get('CostBasisMoney', 'CostBasis'), row, 'cost');
        if (mv !== undefined) pos.marketValue = mv;
        if (cb !== undefined) pos.costBasis = cb;
        flexReported.positions.push(pos);
        const rd = cellToString(get('ReportDate'));
        if (rd) flexReported.asOf = parseDate(rd, 'YMD') ?? flexReported.asOf;
        if (ctx.options.positionsMode === 'opening') {
          const date = ctx.options.asOfDate ?? flexReported.asOf;
          if (!date) {
            row.issues.push(ctx.issue('MISSING_FIELD', 'error', { field: 'asOfDate' }, row.line));
            return;
          }
          const d: DraftTransaction = { date, type: qty >= 0 ? 'TRANSFER_IN' : 'TRANSFER_OUT', currency, quantity: Math.abs(qty), instrument: ih, note: 'Posición inicial (Flex)' };
          const cp = ctx.num(get('CostBasisPrice'), row, 'price');
          if (cp !== undefined) d.price = cp;
          if (cb !== undefined) d.amount = Math.abs(cb);
          row.draft = d;
        } else row.skipped = true;
        return;
      }
      if (h.has('Direction') && h.has('TransferCompany', 'Type')) {
        const tdate = ctx.date(get('Date', 'DateTime', 'SettleDate', 'ReportDate'), row);
        const qty = ctx.num(get('Quantity'), row, 'quantity');
        if (!tdate || !qty || !ih) {
          if (!qty) row.skipped = true;
          return;
        }
        const out = /^out/i.test(getS('Direction')) || qty < 0;
        const d: DraftTransaction = { date: tdate, type: out ? 'TRANSFER_OUT' : 'TRANSFER_IN', currency, quantity: Math.abs(qty), instrument: ih, note: `${getS('Type')} ${getS('Direction')} ${getS('TransferCompany')}`.trim() };
        const xp = ctx.num(get('TransferPrice', 'Price'), row, 'price');
        const mv = ctx.num(get('PositionAmount', 'PositionAmountInBase', 'MarketValue'), row, 'amount');
        if (xp) d.price = xp;
        else if (mv) {
          d.price = Math.abs(mv) / Math.abs(qty);
          row.issues.push(ctx.issue('TRANSFER_COST_FROM_MARKET', 'warning', undefined, row.line));
        }
        if (mv) d.amount = Math.abs(mv);
        if (ref) d.brokerRef = ref;
        row.draft = d;
        return;
      }
      const isTrade = h.has('TradePrice', 'Buy/Sell', 'IBCommission');
      if (ih && isTrade && getS('Description')) ih.name = getS('Description');
      if (isTrade) {
        const date = ctx.date(get('TradeDate', 'DateTime', 'Date/Time'), row);
        const qty = ctx.num(get('Quantity'), row, 'quantity');
        const price = ctx.num(get('TradePrice', 'Price'), row, 'price');
        const comm = ctx.num(get('IBCommission', 'Commission'), row, 'fees');
        const proceeds = ctx.num(get('Proceeds'), row, 'proceeds');
        if (!date || qty === undefined) return;
        if (assetClass === 'CASH') {
          const [base, quote] = symbol.split('.');
          if (!base || !quote) return;
          const p = Math.abs(proceeds ?? qty * (price ?? 0));
          row.draft = qty > 0
            ? { date, type: 'FX_CONVERSION', currency: quote, amount: p, toCurrency: base, toAmount: Math.abs(qty) }
            : { date, type: 'FX_CONVERSION', currency: base, amount: Math.abs(qty), toCurrency: quote, toAmount: p };
          const fxCommCcy = getS('IBCommissionCurrency') || currency;
          if (comm && fxCommCcy === row.draft.currency) row.draft.fees = Math.abs(comm);
          else if (comm) {
            row.extra = [{ date, type: 'FEE', currency: fxCommCcy, amount: Math.abs(comm), note: `Comisión conversión ${symbol}`, ...(ref ? { brokerRef: `${ref}-fee` } : {}) }];
            row.issues.push(ctx.issue('FX_FEE_SEPARATE', 'info', { amount: Math.abs(comm), currency: fxCommCcy }, row.line));
          }
          if (ref) row.draft.brokerRef = ref;
          return;
        }
        if (assetClass && !['STK', 'ETF', 'FUND'].includes(assetClass)) {
          ctx.skip(row, 'UNSUPPORTED_ASSET', { value: assetClass }, 'warning');
          return;
        }
        const side = getS('Buy/Sell').toUpperCase();
        const type: TransactionType = side.startsWith('SELL') ? 'SELL' : side.startsWith('BUY') ? 'BUY' : qty >= 0 ? 'BUY' : 'SELL';
        const d: DraftTransaction = { date, type, currency, quantity: Math.abs(qty) };
        if (price !== undefined) d.price = price;
        if (proceeds) d.amount = Math.abs(proceeds);
        const commCcy = getS('IBCommissionCurrency');
        if (comm) {
          if (!commCcy || commCcy === currency) d.fees = Math.abs(comm);
          else row.extra = [{ date, type: 'FEE', currency: commCcy, amount: Math.abs(comm), note: `Comisión ${symbol}`, ...(ref ? { brokerRef: `${ref}-fee` } : {}) }];
        }
        if (ih) d.instrument = ih;
        if (ref) d.brokerRef = ref;
        row.draft = d;
        return;
      }
      // Cash transactions
      const typeText = getS('Type');
      const date = ctx.date(get('DateTime', 'SettleDate', 'ReportDate', 'Date'), row);
      const amount = ctx.num(get('Amount'), row, 'amount');
      if (!date || amount === undefined) return;
      const t = normalizeText(typeText);
      let d: DraftTransaction | undefined;
      if (/withholding/.test(t)) {
        d = { date, type: 'TAX', currency, amount: -amount };
        taxes.push({ row, d });
      } else if (/dividend/.test(t)) {
        d = { date, type: 'DIVIDEND', currency, amount };
        dividends.push({ row, d });
      } else if (/deposit|withdraw/.test(t)) d = { date, type: amount >= 0 ? 'DEPOSIT' : 'WITHDRAWAL', currency, amount: Math.abs(amount) };
      else if (/interest/.test(t)) d = amount >= 0 ? { date, type: 'INTEREST', currency, amount } : { date, type: 'FEE', currency, amount: -amount };
      else if (/fee|commission/.test(t)) d = { date, type: 'FEE', currency, amount: -amount };
      else {
        ctx.skip(row, 'SKIPPED_MOVEMENT', { value: typeText, reason: 'tipo no soportado.' }, 'warning');
        return;
      }
      const desc = getS('Description');
      if (desc) d.note = desc;
      if (ih && d.type !== 'DEPOSIT' && d.type !== 'WITHDRAWAL') {
        const parsed = parseIbkrDescription(desc);
        d.instrument = { ...ih, ...(ih.symbol ? {} : parsed) };
      }
      if (ref) d.brokerRef = ref;
      row.draft = d;
    });
    mergeWithholding(ctx, dividends, taxes);
    if (flexReported.positions.length) {
      if (ctx.options.asOfDate) flexReported.asOf = ctx.options.asOfDate;
      const ids = new Set(['Interactive Brokers']);
      for (const r of table.rows) for (const c of r) if (/^U\d{5,10}$/.test(cellToString(c))) ids.add(cellToString(c));
      flexReported.accountIds = [...ids];
      ctx.reported = flexReported;
    }
    return rows;
  },
};
