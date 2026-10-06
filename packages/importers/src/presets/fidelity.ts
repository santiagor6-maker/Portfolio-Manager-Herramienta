/**
 * Fidelity (US) — Activity / "Accounts_History.csv":
 *   Run Date,Action,Symbol,Security Description,Security Type,Quantity,Price ($),Commission ($),Fees ($),
 *   Accrued Interest ($),Amount ($),Settlement Date
 * Actions are sentences ("YOU BOUGHT APPLE INC (AAPL) (Cash)", "DIVIDEND RECEIVED ...", "FOREIGN TAX PAID ...").
 * The file starts with blank lines and ends with disclaimer text.
 */
import type { TransactionType } from '@pm/core';
import type { DraftTransaction, ParsedRow } from '../types';
import { normalizeText, round } from '../util';
import { type PresetDefinition, cell, columnValues, locateHeader, str } from './common';

const GROUPS = [['Run Date'], ['Action'], ['Symbol'], ['Security Description'], ['Quantity'], ['Price ($)', 'Price'], ['Amount ($)', 'Amount'], ['Settlement Date']];

export function fidelityAction(action: string): TransactionType | 'TRANSFER' | 'SKIP' | undefined {
  const a = normalizeText(action);
  if (/^you bought|^reinvestment|^bought/.test(a)) return 'BUY';
  if (/^you sold|^sold/.test(a)) return 'SELL';
  if (/foreign tax|tax withheld|nra withhold/.test(a)) return 'TAX';
  if (/dividend received|long term cap gain|short term cap gain|^dividend/.test(a)) return 'DIVIDEND';
  if (/interest earned|^interest/.test(a)) return 'INTEREST';
  if (/return of capital/.test(a)) return 'RETURN_OF_CAPITAL';
  if (/transfer of assets|journaled|acat/.test(a)) return 'TRANSFER';
  if (/electronic funds transfer received|direct deposit|deposit|wire transfer from|check received/.test(a)) return 'DEPOSIT';
  if (/electronic funds transfer paid|withdrawal|wire transfer to|disbursement/.test(a)) return 'WITHDRAWAL';
  if (/fee|adr fee|margin interest/.test(a)) return 'FEE';
  if (/stock split|distribution/.test(a)) return 'SPLIT';
  if (/expired|assigned|exercise|merger|exchange/.test(a)) return 'SKIP';
  return undefined;
}

export const fidelityPreset: PresetDefinition = {
  id: 'fidelity',
  label: 'Fidelity — Activity / Accounts History (CSV)',
  broker: 'Fidelity',
  country: 'US',
  fileKinds: ['csv'],
  confidence: 'medium',
  description: 'Historial de actividad de una cuenta Fidelity: compras, ventas, reinversiones, dividendos, impuestos extranjeros, intereses, transferencias.',
  exportHelp: 'fidelity.com → Accounts & Trade → Activity & Orders → elige el rango → Download (CSV).',
  detect(table) {
    const h = locateHeader(table, GROUPS, 0.75, 15);
    return h && h.header.has('Run Date') ? 0.6 + 0.38 * h.coverage : 0;
  },
  parse(table, ctx) {
    const h = locateHeader(table, GROUPS, 0.6, 15)!;
    const H = h.header;
    const c = {
      date: H.find('Run Date'), action: H.find('Action'), symbol: H.find('Symbol'), desc: H.find('Security Description'),
      qty: H.find('Quantity'), price: H.find('Price ($)', 'Price'), comm: H.find('Commission ($)', 'Commission'),
      fees: H.find('Fees ($)', 'Fees'), amount: H.find('Amount ($)', 'Amount'),
    };
    ctx.detectDates([c.date], h.index + 1, 'MDY', { fixed: true });
    ctx.initNumbers('dot', columnValues(table, h.index + 1, c.qty, c.price, c.amount));
    const rows: ParsedRow[] = [];
    for (let r = h.index + 1; r < table.rows.length; r++) {
      const raw = table.rows[r]!;
      const row = ctx.newRow(r, raw);
      rows.push(row);
      const action = str(raw, c.action);
      if (!/^\d{1,2}\/\d{1,2}\/\d{4}/.test(str(raw, c.date))) {
        ctx.skip(row, 'SKIPPED_TOTAL'); // disclaimers / footers
        continue;
      }
      const rule = fidelityAction(action);
      if (!rule || rule === 'SKIP') {
        ctx.skip(row, 'SKIPPED_MOVEMENT', { value: action.slice(0, 60), reason: rule ? 'evento de opciones/corporativo: regístralo manualmente.' : 'acción no reconocida.' }, 'warning');
        continue;
      }
      const date = ctx.date(cell(raw, c.date), row);
      const qty = ctx.num(cell(raw, c.qty), row, 'quantity');
      const price = ctx.num(cell(raw, c.price), row, 'price');
      const fees = (Math.abs(ctx.num(cell(raw, c.comm), row, 'fees') ?? 0) + Math.abs(ctx.num(cell(raw, c.fees), row, 'fees') ?? 0)) || undefined;
      const amount = ctx.num(cell(raw, c.amount), row, 'amount');
      if (!date) continue;
      const symbol = str(raw, c.symbol).toUpperCase();
      const d: DraftTransaction = { date, type: 'BUY', currency: 'USD' };
      const inst = symbol && !/^(SPAXX|FDRXX|FZFXX|CORE)\**$/.test(symbol) ? { symbol: symbol.replace(/\*+$/, ''), name: str(raw, c.desc), currency: 'USD', country: 'US' } : undefined;
      if (rule === 'TRANSFER') {
        if (!inst || !qty) continue;
        d.type = qty > 0 ? 'TRANSFER_IN' : 'TRANSFER_OUT';
        d.quantity = Math.abs(qty);
        if (price) d.price = price;
      } else if (rule === 'BUY' || rule === 'SELL') {
        d.type = rule;
        if (qty !== undefined) d.quantity = Math.abs(qty);
        if (price !== undefined) d.price = price;
        if (d.quantity && price !== undefined) d.amount = round(d.quantity * price, 8);
        if (fees) d.fees = fees;
      } else if (rule === 'SPLIT') {
        d.type = 'SPLIT';
        if (qty !== undefined) d.deltaShares = qty;
      } else if (rule === 'TAX' || rule === 'FEE') {
        d.type = rule;
        d.amount = -(amount ?? 0);
      } else {
        d.type = rule;
        d.amount = Math.abs(amount ?? 0);
      }
      if (inst && !(d.type === 'DEPOSIT' || d.type === 'WITHDRAWAL' || (d.type === 'INTEREST' && !symbol))) d.instrument = inst;
      d.note = action;
      row.draft = d;
    }
    return rows;
  },
};
