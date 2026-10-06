/**
 * Charles Schwab — brokerage "Transactions" CSV export:
 *   "Date","Action","Symbol","Description","Quantity","Price","Fees & Comm","Amount"
 * Dates are MM/DD/YYYY (sometimes "02/16/2023 as of 02/15/2023"); money as "$1,250.70" / "-$1,250.70".
 * Older exports add a title line before the header and a "Transactions Total" footer.
 */
import type { TransactionType } from '@pm/core';
import type { DraftTransaction, ParsedRow } from '../types';
import { normalizeText, round } from '../util';
import { type PresetDefinition, TOTAL_ROW_RE, cell, columnValues, locateHeader, str } from './common';

const GROUPS = [['Date'], ['Action'], ['Symbol'], ['Description'], ['Quantity'], ['Price'], ['Fees & Comm', 'Fees & Commissions'], ['Amount']];

type SchwabRule = TransactionType | 'TRANSFER' | 'JOURNAL' | 'SKIP';

export function schwabAction(action: string): SchwabRule | undefined {
  const a = normalizeText(action);
  if (/^(buy|reinvest shares|buy to open|buy to close)$/.test(a)) return 'BUY';
  if (/^(sell|sell short|sell to open|sell to close)$/.test(a)) return 'SELL';
  if (/(cash dividend|qualified dividend|non qualified div|special dividend|special qual div|pr yr div reinvest|pr yr cash div|reinvest dividend|long term cap gain|short term cap gain|cash in lieu)/.test(a)) return 'DIVIDEND';
  if (/(nra tax|withholding|foreign tax)/.test(a)) return 'TAX';
  if (/margin interest/.test(a)) return 'FEE';
  if (/interest/.test(a)) return 'INTEREST';
  if (/(moneylink|wire|funds received|funds paid|deposit|withdrawal|bank transfer|ach)/.test(a)) return 'JOURNAL';
  if (/^journal/.test(a)) return 'JOURNAL';
  if (/(service fee|adr mgmt fee|fee)/.test(a)) return 'FEE';
  if (/stock split|forward split/.test(a)) return 'SPLIT';
  if (/reverse split/.test(a)) return 'SPLIT';
  if (/return of capital/.test(a)) return 'RETURN_OF_CAPITAL';
  if (/security transfer|internal transfer/.test(a)) return 'TRANSFER';
  if (/(expired|assigned|exchange or exercise|spin off|merger)/.test(a)) return 'SKIP';
  return undefined;
}

const OPTION_SYMBOL_RE = /^[A-Z.]+ \d{2}\/\d{2}\/\d{4} [\d.]+ [CP]$/;

export const schwabPreset: PresetDefinition = {
  id: 'schwab',
  label: 'Charles Schwab — Transactions (CSV)',
  broker: 'Charles Schwab',
  country: 'US',
  fileKinds: ['csv'],
  confidence: 'high',
  description: 'Historial de transacciones de una cuenta de corretaje Schwab: compras, ventas, dividendos, retenciones NRA, intereses, transferencias y splits.',
  exportHelp: 'schwab.com → Accounts → History → Transactions → elige la cuenta y el rango de fechas → Export (CSV).',
  detect(table) {
    const h = locateHeader(table, GROUPS, 0.85, 6);
    return h && h.header.has('Fees & Comm', 'Fees & Commissions') ? 0.95 : h ? 0.7 : 0;
  },
  parse(table, ctx) {
    const h = locateHeader(table, GROUPS, 0.7, 6)!;
    const H = h.header;
    const c = {
      date: H.find('Date'), action: H.find('Action'), symbol: H.find('Symbol'), desc: H.find('Description'),
      qty: H.find('Quantity'), price: H.find('Price'), fees: H.find('Fees & Comm', 'Fees & Commissions'), amount: H.find('Amount'),
    };
    ctx.detectDates([c.date], h.index + 1, 'MDY', { fixed: true }); // Schwab (US) always MM/DD/YYYY
    ctx.initNumbers('dot', columnValues(table, h.index + 1, c.qty, c.price, c.fees, c.amount));
    const rows: ParsedRow[] = [];
    const dividends: DraftTransaction[] = [];
    const taxes: { row: ParsedRow; d: DraftTransaction }[] = [];
    const splitLegs: { row: ParsedRow; d: DraftTransaction; qty: number }[] = [];
    for (let r = h.index + 1; r < table.rows.length; r++) {
      const raw = table.rows[r]!;
      const row = ctx.newRow(r, raw);
      rows.push(row);
      const dateText = str(raw, c.date);
      if (TOTAL_ROW_RE.test(dateText) || (!dateText && !str(raw, c.action))) {
        ctx.skip(row, 'SKIPPED_TOTAL');
        continue;
      }
      const action = str(raw, c.action);
      const rule = schwabAction(action);
      const symbol = str(raw, c.symbol).toUpperCase();
      if (!rule) {
        ctx.skip(row, 'SKIPPED_MOVEMENT', { value: action, reason: 'acción no reconocida; regístrala manualmente si aplica.' }, 'warning');
        continue;
      }
      if (rule === 'SKIP') {
        ctx.skip(row, 'SKIPPED_MOVEMENT', { value: action, reason: 'evento de opciones/corporativo: regístralo manualmente.' }, 'warning');
        continue;
      }
      if (OPTION_SYMBOL_RE.test(symbol)) {
        ctx.skip(row, 'UNSUPPORTED_ASSET', { value: 'option' }, 'warning');
        continue;
      }
      const date = ctx.date(cell(raw, c.date), row);
      const qty = ctx.num(cell(raw, c.qty), row, 'quantity');
      const price = ctx.num(cell(raw, c.price), row, 'price');
      const fees = ctx.num(cell(raw, c.fees), row, 'fees');
      const amount = ctx.num(cell(raw, c.amount), row, 'amount');
      if (!date) continue;
      const desc = str(raw, c.desc);
      const d: DraftTransaction = { date, type: 'BUY', currency: 'USD' };
      if (symbol) d.instrument = { symbol, name: desc, currency: 'USD', country: 'US' };
      if (rule === 'JOURNAL' || rule === 'TRANSFER') {
        if (symbol && qty !== undefined && (amount === undefined || amount === 0)) {
          d.type = qty >= 0 ? 'TRANSFER_IN' : 'TRANSFER_OUT';
          d.quantity = Math.abs(qty);
        } else if (amount !== undefined) {
          d.type = amount >= 0 ? 'DEPOSIT' : 'WITHDRAWAL';
          d.amount = Math.abs(amount);
          delete d.instrument;
        } else continue;
      } else {
        d.type = rule;
        if (rule === 'BUY' || rule === 'SELL') {
          if (qty !== undefined) d.quantity = Math.abs(qty);
          if (price !== undefined) d.price = price;
          if (fees) d.fees = Math.abs(fees);
          if (d.quantity !== undefined && price !== undefined) d.amount = round(d.quantity * price, 8);
          else if (amount !== undefined) d.amount = Math.abs(amount) + (rule === 'SELL' ? Math.abs(fees ?? 0) : -Math.abs(fees ?? 0));
        } else if (rule === 'SPLIT') {
          if (qty !== undefined) d.deltaShares = qty < 0 ? qty : /reverse/i.test(action) && !splitLegs.some((x) => x.d.date === date && x.d.instrument?.symbol === symbol) ? -Math.abs(qty) : qty;
          splitLegs.push({ row, d, qty: qty ?? 0 });
        } else if (rule === 'TAX') {
          d.amount = -(amount ?? 0); // negative amount in file = tax paid
        } else if (rule === 'FEE') {
          d.amount = -(amount ?? 0);
          if (!symbol) delete d.instrument;
        } else {
          if (amount !== undefined) d.amount = Math.abs(amount);
          if (rule === 'INTEREST' && !symbol) delete d.instrument;
        }
      }
      if (desc) d.note = `${action}: ${desc}`;
      row.draft = d;
      if (d.type === 'DIVIDEND') dividends.push(d);
      if (d.type === 'TAX') taxes.push({ row, d });
    }
    // Reverse splits come as two rows (old shares removed, new shares added): ratio = new / old.
    const groups = new Map<string, typeof splitLegs>();
    for (const l of splitLegs) {
      const k = `${l.d.date}|${l.d.instrument?.symbol ?? ''}`;
      groups.set(k, [...(groups.get(k) ?? []), l]);
    }
    for (const g of groups.values()) {
      const out = g.find((l) => l.qty < 0);
      const inn = g.find((l) => l.qty > 0);
      if (g.length === 2 && out && inn) {
        inn.d.ratio = round(inn.qty / Math.abs(out.qty), 10);
        delete inn.d.deltaShares;
        out.row.draft = undefined;
        out.row.skipped = true;
        out.row.issues.push(ctx.issue('SPLIT_PAIR_MERGED', 'info', { ratio: inn.d.ratio }, out.row.line));
      }
    }
    // Attach NRA withholding to the dividend of the same symbol and date.
    for (const t of taxes) {
      const near = (x: DraftTransaction) => Math.abs(Date.parse(x.date) - Date.parse(t.d.date)) <= 7 * 86400000;
      const div =
        dividends.find((x) => x.date === t.d.date && x.instrument?.symbol === t.d.instrument?.symbol) ??
        dividends.find((x) => near(x) && x.instrument?.symbol === t.d.instrument?.symbol && !x.taxes);
      if (div && (t.d.amount ?? 0) > 0) {
        div.taxes = (div.taxes ?? 0) + t.d.amount!;
        t.row.draft = undefined;
        t.row.skipped = true;
        t.row.issues.push(ctx.issue('WITHHOLDING_MERGED', 'info', { amount: t.d.amount!, currency: 'USD' }, t.row.line));
      }
    }
    return rows;
  },
};
