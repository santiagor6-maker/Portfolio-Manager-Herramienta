/**
 * Trading 212 (Invest / ISA) history export CSV:
 *   Action,Time,ISIN,Ticker,Name,No. of shares,Price / share,Currency (Price / share),Exchange rate,
 *   Result,Currency (Result),Total,Currency (Total),Withholding tax,Currency (Withholding tax),
 *   Stamp duty reserve tax,Currency (...),Currency conversion fee,Currency (...),Notes,ID,...
 * Older exports use "Total (EUR)" style headers. Columns are optional and vary with the account's history.
 */
import type { Cell, DraftTransaction, InstrumentHint, ParsedRow } from '../types';
import { cellToString, isCurrencyCode, normalizeText, round } from '../util';
import { type HeaderIndex, type ParseContext, type PresetDefinition, cell, columnValues, locateHeader, str } from './common';

const GROUPS = [['Action'], ['Time'], ['ISIN'], ['Ticker'], ['No. of shares'], ['Price / share'], ['Exchange rate']];

/** Value + currency of a T212 money column ("Total" + "Currency (Total)", or "Total (EUR)"). */
function money(raw: Cell[], H: HeaderIndex, ctx: ParseContext, row: ParsedRow, name: string): { value?: number; currency?: string } {
  const col = H.find(name);
  if (col === undefined) return {};
  let currency: string | undefined;
  const n = normalizeText(name);
  const header = H.norm[col] ?? '';
  if (header !== n && /^[a-z]{3}$/.test(header.slice(n.length + 1))) currency = header.slice(-3).toUpperCase();
  const ccyCol = H.find(`Currency (${name})`);
  if (ccyCol !== undefined) currency = cellToString(raw[ccyCol] ?? null).toUpperCase() || currency;
  const value = ctx.num(raw[col] ?? null, row, name);
  const out: { value?: number; currency?: string } = {};
  if (value !== undefined) out.value = value;
  if (currency && isCurrencyCode(currency)) out.currency = currency;
  return out;
}

const FEE_NAMES = ['Stamp duty reserve tax', 'Currency conversion fee', 'Transaction fee', 'Finra fee', 'French transaction tax', 'PTM levy'];

export const trading212Preset: PresetDefinition = {
  id: 'trading212',
  label: 'Trading 212 — Historial (CSV)',
  broker: 'Trading 212',
  country: 'GB',
  fileKinds: ['csv'],
  confidence: 'medium',
  description: 'Compras, ventas, dividendos (con retención), depósitos, retiros, intereses sobre efectivo y conversiones de divisas.',
  exportHelp: 'App/web Trading 212 → Menú → Historial → icono de exportar → elige periodo (máx. 12 meses) y todas las casillas → Exportar CSV.',
  detect(table) {
    const h = locateHeader(table, GROUPS, 0.7, 3);
    return h ? 0.6 + 0.38 * h.coverage : 0;
  },
  parse(table, ctx) {
    const h = locateHeader(table, GROUPS, 0.5, 3)!;
    const H = h.header;
    const c = {
      action: H.find('Action'), time: H.find('Time'), isin: H.find('ISIN'), ticker: H.find('Ticker'), name: H.find('Name'),
      qty: H.find('No. of shares'), rate: H.find('Exchange rate'), id: H.find('ID'), notes: H.find('Notes'),
    };
    ctx.initDates(columnValues(table, h.index + 1, c.time), 'YMD');
    ctx.initNumbers('dot', []);
    const rows: ParsedRow[] = [];
    const splits = new Map<string, { open?: { row: ParsedRow; qty: number }; close?: { row: ParsedRow; qty: number } }>();
    for (let r = h.index + 1; r < table.rows.length; r++) {
      const raw = table.rows[r]!;
      const row = ctx.newRow(r, raw);
      rows.push(row);
      const action = str(raw, c.action);
      const a = normalizeText(action);
      const date = ctx.date(cell(raw, c.time), row);
      if (!date) continue;
      const qty = ctx.num(cell(raw, c.qty), row, 'quantity');
      const price = money(raw, H, ctx, row, 'Price / share');
      const total = money(raw, H, ctx, row, 'Total');
      const wht = money(raw, H, ctx, row, 'Withholding tax');
      let rate = ctx.num(cell(raw, c.rate), row, 'exchangeRate');
      const ticker = str(raw, c.ticker).toUpperCase();
      const isin = str(raw, c.isin).toUpperCase();
      const ref = str(raw, c.id);
      let priceCcy = price.currency;
      let priceVal = price.value;
      if (priceCcy === 'GBX') {
        priceCcy = 'GBP';
        if (priceVal !== undefined) priceVal = priceVal / 100;
        if (rate) rate = rate / 100;
        row.issues.push(ctx.issue('GBX_CONVERTED', 'info', undefined, row.line));
      }
      const inst: InstrumentHint | undefined = ticker || isin ? {} : undefined;
      if (inst) {
        if (ticker) inst.symbol = ticker;
        if (isin) inst.isin = isin;
        const name = str(raw, c.name);
        if (name) inst.name = name;
        if (priceCcy) inst.currency = priceCcy;
      }
      let d: DraftTransaction | undefined;
      if (/\b(buy|sell)\b/.test(a)) {
        if (qty === undefined || !priceCcy) continue;
        d = { date, type: /\bsell\b/.test(a) ? 'SELL' : 'BUY', currency: priceCcy, quantity: Math.abs(qty) };
        if (priceVal !== undefined) {
          d.price = priceVal;
          d.amount = round(Math.abs(qty) * priceVal, 8);
        }
        let fees = 0;
        for (const n of FEE_NAMES) {
          const f = money(raw, H, ctx, row, n);
          if (!f.value) continue;
          const v = Math.abs(f.value);
          if (!f.currency || f.currency === priceCcy) fees += v;
          else if (rate && rate > 0) {
            fees += v * rate;
            row.issues.push(ctx.issue('FEES_CONVERTED', 'info', { from: f.currency, to: priceCcy, rate }, row.line));
          } else d.note = `${d.note ? `${d.note}; ` : ''}${n} ${v} ${f.currency}`;
        }
        if (fees) d.fees = round(fees, 8);
      } else if (/dividend/.test(a)) {
        const ccy = total.currency ?? priceCcy;
        if (total.value === undefined || !ccy) continue;
        let tax = Math.abs(wht.value ?? 0);
        if (tax && wht.currency && wht.currency !== ccy) {
          const wCcy = wht.currency === 'GBX' ? 'GBP' : wht.currency;
          if (wht.currency === 'GBX') tax = tax / 100;
          if (wCcy === priceCcy && rate && rate > 0) tax = tax / rate;
          else if (wCcy !== ccy) tax = 0;
        }
        d = {
          date, type: /return of capital/.test(a) ? 'RETURN_OF_CAPITAL' : 'DIVIDEND', currency: ccy,
          amount: round(Math.abs(total.value) + tax, 8), note: action,
        };
        if (tax && d.type === 'DIVIDEND') d.taxes = round(tax, 8);
      } else if (/^deposit/.test(a) || /^withdrawal/.test(a)) {
        if (total.value === undefined || !total.currency) continue;
        d = { date, type: /^deposit/.test(a) ? 'DEPOSIT' : 'WITHDRAWAL', currency: total.currency, amount: Math.abs(total.value) };
      } else if (/interest/.test(a)) {
        if (total.value === undefined || !total.currency) continue;
        d = { date, type: 'INTEREST', currency: total.currency, amount: Math.abs(total.value), note: action };
      } else if (/currency conversion/.test(a)) {
        const from = money(raw, H, ctx, row, 'Currency conversion from amount');
        const to = money(raw, H, ctx, row, 'Currency conversion to amount');
        if (from.value === undefined || to.value === undefined || !from.currency || !to.currency) {
          ctx.skip(row, 'SKIPPED_MOVEMENT', { value: action, reason: 'faltan los montos de la conversión.' }, 'warning');
          continue;
        }
        d = { date, type: 'FX_CONVERSION', currency: from.currency, amount: Math.abs(from.value), toCurrency: to.currency, toAmount: Math.abs(to.value) };
        const fxFee = money(raw, H, ctx, row, 'Currency conversion fee');
        if (fxFee.value && (!fxFee.currency || fxFee.currency === from.currency)) d.fees = Math.abs(fxFee.value);
      } else if (/stock split (open|close)/.test(a)) {
        const key = `${date}|${ticker || isin}`;
        const s = splits.get(key) ?? {};
        if (qty !== undefined) s[/open/.test(a) ? 'open' : 'close'] = { row, qty: Math.abs(qty) };
        splits.set(key, s);
        if (inst) row.draft = { date, type: 'SPLIT', currency: priceCcy ?? 'USD', instrument: inst, note: action };
        continue;
      } else if (/cashback|card debit|card credit|spending/.test(a)) {
        ctx.skip(row, 'SKIPPED_MOVEMENT', { value: action, reason: 'movimiento de tarjeta.' });
        continue;
      } else {
        ctx.skip(row, 'SKIPPED_MOVEMENT', { value: action, reason: 'tipo no soportado.' }, 'warning');
        continue;
      }
      if (inst && d.type !== 'DEPOSIT' && d.type !== 'WITHDRAWAL' && d.type !== 'FX_CONVERSION' && !(d.type === 'INTEREST' && !ticker)) d.instrument = inst;
      if (ref) d.brokerRef = ref;
      const notes = str(raw, c.notes);
      if (notes) d.note = d.note ? `${d.note} — ${notes}` : notes;
      row.draft = d;
    }
    for (const s of splits.values()) {
      if (s.open && s.close && s.close.qty > 0 && s.open.row.draft) {
        s.open.row.draft.ratio = round(s.open.qty / s.close.qty, 10);
        s.close.row.draft = undefined;
        s.close.row.skipped = true;
      } else {
        for (const x of [s.open, s.close]) if (x) ctx.skip(x.row, 'SKIPPED_MOVEMENT', { value: 'Stock split', reason: 'falta la pareja open/close.' }, 'warning');
        if (s.open) s.open.row.draft = undefined;
        if (s.close) s.close.row.draft = undefined;
      }
    }
    return rows;
  },
};
