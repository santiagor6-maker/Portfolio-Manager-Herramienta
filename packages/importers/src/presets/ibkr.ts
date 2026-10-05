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
import type { Cell, DraftTransaction, InstrumentHint, ParsedRow, RawTable } from '../types';
import { cellToString, normalizeText } from '../util';
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
    // First pass: instrument information (appears at the end of the statement).
    for (const r of table.rows) {
      const section = cellToString(r[0]);
      const kind = cellToString(r[1]);
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
      const handled = ['Trades', 'Dividends', 'Payment In Lieu Of Dividends', 'Withholding Tax', 'Deposits & Withdrawals', 'Interest', 'Fees', 'Corporate Actions'];
      if (!handled.includes(section)) return;
      const currency = getS('Currency');
      if (/^total/i.test(currency) || /^total/i.test(getS('Asset Category')) || /^total/i.test(getS('Subtitle'))) return;
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
          const commCcy = /comm in ([a-z]{3})/.exec(commHeader)?.[1]?.toUpperCase();
          if (comm && commCcy === d.currency) d.fees = Math.abs(comm);
          else if (comm) d.note = `Comisión ${Math.abs(comm)} ${commCcy ?? ''}`.trim();
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
  return hits >= 4 && (n.includes('currencyprimary') || n.includes('clientaccountid') || n.includes('ibcommission') || n.includes('tradeprice'));
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
    table.rows.forEach((r, idx) => {
      const first = cellToString(r[0]);
      if (FLEX_MARKERS.has(first)) return;
      if (isFlexHeader(r)) {
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
          else d.note = `Comisión ${Math.abs(comm)} ${commCcy}`;
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
    return rows;
  },
};
