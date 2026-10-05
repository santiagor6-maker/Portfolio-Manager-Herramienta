/**
 * DEGIRO (flatexDEGIRO) CSV exports, in English, Spanish, Portuguese, Dutch or German:
 *  - Transactions.csv: Date,Time,Product,ISIN,Reference exchange,Venue,Quantity,Price,(ccy),Local value,(ccy),
 *    Value,(ccy),Exchange rate,Transaction and/or third party fees,(ccy),Total,(ccy),Order ID
 *    (unnamed columns after money columns hold the currency; newer files may use "Value EUR" headers).
 *  - Account.csv (Account statement): Date,Time,Value date,Product,ISIN,Description,FX,Change,(amount),
 *    Balance,(amount),Order Id — used for dividends, dividend tax, deposits, withdrawals, interest and fees.
 * DEGIRO files carry no ticker: instruments are identified by ISIN (popular ISINs are mapped to tickers).
 */
import { DEGIRO_EXCHANGES, normalizeExchange } from '../markets';
import type { Cell, DraftTransaction, InstrumentHint, ParsedRow } from '../types';
import { cellToString, isCurrencyCode, normalizeText, round } from '../util';
import { type HeaderIndex, type ParseContext, type PresetDefinition, cell, columnValues, locateHeader, str } from './common';

const A = {
  date: ['Date', 'Fecha', 'Data', 'Datum'],
  time: ['Time', 'Hora', 'Tijd', 'Zeit', 'Uhrzeit'],
  product: ['Product', 'Producto', 'Produto', 'Produkt'],
  isin: ['ISIN'],
  refExchange: ['Reference exchange', 'Bolsa de referencia', 'Bolsa de referência', 'Referentiebeurs', 'Referenzbörse'],
  venue: ['Venue', 'Centro de ejecución', 'Local de execução', 'Uitvoeringsplaats', 'Ausführungsort'],
  quantity: ['Quantity', 'Cantidad', 'Quantidade', 'Aantal', 'Anzahl'],
  price: ['Price', 'Precio', 'Preço', 'Koers', 'Kurs'],
  localValue: ['Local value', 'Valor local', 'Lokale waarde', 'Lokaler Wert', 'Wert in Lokalwährung'],
  value: ['Value', 'Valor', 'Waarde', 'Wert'],
  rate: ['Exchange rate', 'Tipo de cambio', 'Taxa de câmbio', 'Wisselkoers', 'Wechselkurs'],
  fees: ['Transaction and/or third party fees', 'Transaction costs', 'Costes de transacción', 'Custos de transação', 'Transactiekosten', 'Transaktionskosten', 'Transaction'],
  autoFx: ['AutoFX Fee', 'Comisión AutoFX', 'Custo AutoFX'],
  total: ['Total', 'Totaal', 'Gesamt'],
  orderId: ['Order ID', 'ID Orden', 'ID da Ordem', 'Order Id', 'Order-ID'],
  valueDate: ['Value date', 'Fecha valor', 'Data valor', 'Valutadatum', 'Valuta'],
  description: ['Description', 'Descripción', 'Descrição', 'Omschrijving', 'Beschreibung'],
  change: ['Change', 'Variación', 'Variação', 'Mutatie', 'Änderung', 'Mudança'],
  balance: ['Balance', 'Saldo'],
};

const TX_GROUPS = [A.date, A.product, A.isin, [...A.refExchange, ...A.venue], A.quantity, A.price];
const ACC_GROUPS = [A.date, A.product, A.isin, A.description, A.change, A.balance];

/** Currency of a money column: the unnamed column right after it, or a code in the header ("Value EUR"). */
function moneyWithCurrency(raw: Cell[], H: HeaderIndex, col: number | undefined, ctx: ParseContext, row: ParsedRow, field: string): { value?: number; currency?: string } {
  if (col === undefined) return {};
  const here = cellToString(raw[col] ?? null);
  const next = cellToString(raw[col + 1] ?? null);
  const headerNext = H.norm[col + 1] ?? '';
  // Account statement: "Change" holds the currency and the next (unnamed) column the amount.
  if (isCurrencyCode(here) && headerNext === '') return { currency: here, value: ctx.num(raw[col + 1] ?? null, row, field) };
  const out: { value?: number; currency?: string } = {};
  const v = ctx.num(raw[col] ?? null, row, field);
  if (v !== undefined) out.value = v;
  if (headerNext === '' && isCurrencyCode(next)) out.currency = next;
  else {
    const m = /\b([a-z]{3})$/.exec(H.norm[col] ?? '');
    if (m && isCurrencyCode(m[1]!.toUpperCase())) out.currency = m[1]!.toUpperCase();
  }
  return out;
}

function degiroInstrument(raw: Cell[], c: { product?: number; isin?: number; ref?: number; venue?: number }, currency?: string): InstrumentHint | undefined {
  const isin = str(raw, c.isin).toUpperCase();
  const name = str(raw, c.product);
  if (!isin && !name) return undefined;
  const h: InstrumentHint = {};
  if (isin) h.isin = isin;
  if (name) h.name = name;
  const refCode = str(raw, c.ref).toUpperCase();
  const venue = str(raw, c.venue).toUpperCase();
  const ex = DEGIRO_EXCHANGES[refCode] ?? normalizeExchange(refCode) ?? DEGIRO_EXCHANGES[venue] ?? normalizeExchange(venue);
  if (ex) h.exchange = ex;
  if (currency) h.currency = currency;
  return h;
}

export const degiroTransactionsPreset: PresetDefinition = {
  id: 'degiro-transactions',
  label: 'DEGIRO — Transacciones (CSV)',
  broker: 'DEGIRO',
  country: 'NL',
  fileKinds: ['csv', 'xlsx'],
  confidence: 'medium',
  description: 'Compras y ventas con precio en moneda local y costos de transacción (convertidos a la moneda de la operación).',
  exportHelp: 'DEGIRO web → Bandeja de entrada/Actividad → Transacciones → elige fechas → Exportar → CSV.',
  detect(table) {
    const h = locateHeader(table, TX_GROUPS, 0.84, 5);
    if (!h) return 0;
    return h.header.has(...A.refExchange, ...A.venue) && h.header.has(...A.localValue) ? 0.95 : 0.7;
  },
  parse(table, ctx) {
    const h = locateHeader(table, TX_GROUPS, 0.6, 5)!;
    const H = h.header;
    const c = {
      date: H.find(...A.date), product: H.find(...A.product), isin: H.find(...A.isin), ref: H.find(...A.refExchange),
      venue: H.find(...A.venue), qty: H.find(...A.quantity), price: H.find(...A.price), local: H.find(...A.localValue),
      value: H.find(...A.value), rate: H.find(...A.rate), fees: H.find(...A.fees), autoFx: H.find(...A.autoFx),
      total: H.find(...A.total), orderId: H.find(...A.orderId), time: H.find(...A.time),
    };
    ctx.initDates(columnValues(table, h.index + 1, c.date), 'DMY');
    ctx.initNumbers('dot', columnValues(table, h.index + 1, c.qty, c.price, c.local, c.value, c.rate, c.fees, c.total));
    const rows: ParsedRow[] = [];
    for (let r = h.index + 1; r < table.rows.length; r++) {
      const raw = table.rows[r]!;
      const row = ctx.newRow(r, raw);
      rows.push(row);
      const date = ctx.date(cell(raw, c.date), row);
      const qty = ctx.num(cell(raw, c.qty), row, 'quantity');
      const price = moneyWithCurrency(raw, H, c.price, ctx, row, 'price');
      const local = moneyWithCurrency(raw, H, c.local, ctx, row, 'localValue');
      const fees = moneyWithCurrency(raw, H, c.fees, ctx, row, 'fees');
      const autoFx = moneyWithCurrency(raw, H, c.autoFx, ctx, row, 'autoFx');
      const rate = ctx.num(cell(raw, c.rate), row, 'exchangeRate');
      if (!date || qty === undefined || qty === 0) continue;
      const currency = price.currency ?? local.currency ?? '';
      const d: DraftTransaction = { date, type: qty > 0 ? 'BUY' : 'SELL', currency, quantity: Math.abs(qty) };
      if (price.value !== undefined) d.price = Math.abs(price.value);
      if (local.value !== undefined && local.value !== 0) d.amount = Math.abs(local.value);
      let fee = Math.abs(fees.value ?? 0) + Math.abs(autoFx.value ?? 0);
      const feeCcy = fees.currency ?? autoFx.currency;
      if (fee && feeCcy && currency && feeCcy !== currency) {
        if (rate && rate > 0) {
          // DEGIRO rate = units of local currency per 1 unit of account currency.
          const converted = round(fee * rate, 6);
          row.issues.push(ctx.issue('FEES_CONVERTED', 'info', { from: feeCcy, to: currency, rate }, row.line));
          fee = converted;
        } else {
          d.note = `Costos ${fee} ${feeCcy}`;
          fee = 0;
        }
      }
      if (fee) d.fees = fee;
      const inst = degiroInstrument(raw, c, currency || undefined);
      if (inst) d.instrument = inst;
      const orderId = str(raw, c.orderId);
      if (orderId) d.brokerRef = `${orderId}|${str(raw, c.time)}|${qty}|${price.value ?? ''}`;
      row.draft = d;
    }
    return rows;
  },
};

type AccountRule = 'DIVIDEND' | 'TAX' | 'DEPOSIT' | 'WITHDRAWAL' | 'FEE' | 'INTEREST' | 'SKIP_TRADE' | 'SKIP_FX' | 'SKIP_INTERNAL' | 'TRADE_FEE';

export function degiroDescription(desc: string): AccountRule | undefined {
  const d = normalizeText(desc);
  if (/(dividend tax|retencion del dividendo|impuesto sobre dividendo|imposto sobre dividendo|dividendbelasting|dividendensteuer|withholding)/.test(d)) return 'TAX';
  if (/(valuta|cambio de divisa|fx credit|fx debit|currency exchange|conversao|cambio divisas|wahrungswechsel)/.test(d)) return 'SKIP_FX';
  if (/(cash sweep|money market|fondo monetario|geldmarkt|overboeking|internal transfer|transferencia interna|degiro cash|flatex cash sweep|fund conversion)/.test(d)) return 'SKIP_INTERNAL';
  if (/^(buy|sell|compra|venta|venda|koop|verkoop|kauf|verkauf)\b.*@/.test(d) || /@/.test(desc)) return 'SKIP_TRADE';
  if (/(transaction and or third party fees|transaction costs|costes de transaccion|custos de transacao|transactiekosten|transaktionskosten)/.test(d)) return 'TRADE_FEE';
  if (/(connection fee|conectividad|aansluitingskosten|conexao|verbindungskosten|custody|custodia|fee|comision|kosten|gebuhr)/.test(d)) return 'FEE';
  if (/(dividend|dividendo|dividende)/.test(d)) return 'DIVIDEND';
  if (/(interest|interes|rente|juros|zinsen)/.test(d)) return 'INTEREST';
  if (/(withdrawal|retirada|levantamento|terugstorting|auszahlung|retiro)/.test(d)) return 'WITHDRAWAL';
  if (/(deposit|ingreso|deposito|storting|einzahlung|ideal|sofort)/.test(d)) return 'DEPOSIT';
  return undefined;
}

export const degiroAccountPreset: PresetDefinition = {
  id: 'degiro-account',
  label: 'DEGIRO — Estado de cuenta (CSV)',
  broker: 'DEGIRO',
  country: 'NL',
  fileKinds: ['csv', 'xlsx'],
  confidence: 'medium',
  description: 'Dividendos (con su retención), depósitos, retiros, intereses y comisiones de conectividad. Las compras/ventas se importan del archivo de Transacciones.',
  exportHelp: 'DEGIRO web → Bandeja de entrada/Actividad → Estado de cuenta → elige fechas → Exportar → CSV.',
  detect(table) {
    const h = locateHeader(table, ACC_GROUPS, 0.84, 5);
    return h ? 0.93 : 0;
  },
  parse(table, ctx) {
    const h = locateHeader(table, ACC_GROUPS, 0.6, 5)!;
    const H = h.header;
    const c = {
      date: H.find(...A.date), valueDate: H.find(...A.valueDate), product: H.find(...A.product), isin: H.find(...A.isin),
      desc: H.find(...A.description), change: H.find(...A.change), orderId: H.find(...A.orderId),
    };
    ctx.initDates(columnValues(table, h.index + 1, c.date, c.valueDate), 'DMY');
    const changeCells: Cell[] = [];
    if (c.change !== undefined) for (const r of table.rows.slice(h.index + 1)) changeCells.push(r[c.change] ?? null, r[c.change + 1] ?? null);
    ctx.initNumbers('dot', changeCells);
    const rows: ParsedRow[] = [];
    const dividends: { row: ParsedRow; d: DraftTransaction }[] = [];
    const taxes: { row: ParsedRow; d: DraftTransaction }[] = [];
    for (let r = h.index + 1; r < table.rows.length; r++) {
      const raw = table.rows[r]!;
      const row = ctx.newRow(r, raw);
      rows.push(row);
      const desc = str(raw, c.desc);
      const rule = degiroDescription(desc);
      if (!rule) {
        ctx.skip(row, 'SKIPPED_MOVEMENT', { value: desc.slice(0, 60), reason: 'concepto no reconocido.' }, 'warning');
        continue;
      }
      if (rule === 'SKIP_TRADE' || rule === 'SKIP_FX' || rule === 'SKIP_INTERNAL' || (rule === 'TRADE_FEE' && str(raw, c.orderId))) {
        const reason = rule === 'SKIP_FX' ? 'conversión automática de divisas ligada a una operación.' : rule === 'SKIP_INTERNAL' ? 'movimiento interno.' : 'se importa desde el archivo de Transacciones.';
        ctx.skip(row, 'SKIPPED_MOVEMENT', { value: desc.slice(0, 60), reason });
        continue;
      }
      const date = ctx.date(cell(raw, c.date), row);
      const change = moneyWithCurrency(raw, H, c.change, ctx, row, 'amount');
      if (!date || change.value === undefined || !change.currency) {
        if (date && change.value === undefined) row.issues.push(ctx.issue('MISSING_FIELD', 'error', { field: 'amount' }, row.line));
        continue;
      }
      const v = change.value;
      const currency = change.currency;
      let d: DraftTransaction;
      switch (rule) {
        case 'DIVIDEND':
          d = { date, type: v >= 0 ? 'DIVIDEND' : 'TAX', currency, amount: Math.abs(v) };
          break;
        case 'TAX':
          d = { date, type: 'TAX', currency, amount: -v };
          break;
        case 'DEPOSIT':
        case 'WITHDRAWAL':
          d = { date, type: v >= 0 ? 'DEPOSIT' : 'WITHDRAWAL', currency, amount: Math.abs(v) };
          break;
        case 'INTEREST':
          d = v >= 0 ? { date, type: 'INTEREST', currency, amount: v } : { date, type: 'FEE', currency, amount: -v };
          break;
        default:
          d = { date, type: 'FEE', currency, amount: -v };
      }
      d.note = desc;
      if (d.type === 'DIVIDEND' || d.type === 'TAX') {
        const inst = degiroInstrument(raw, c);
        if (inst) d.instrument = inst;
      }
      row.draft = d;
      if (d.type === 'DIVIDEND') dividends.push({ row, d });
      else if (rule === 'TAX') taxes.push({ row, d });
    }
    for (const t of taxes) {
      const div = dividends.find((x) => x.d.date === t.d.date && x.d.currency === t.d.currency && (x.d.instrument?.isin ?? '') === (t.d.instrument?.isin ?? ''));
      if (div && (t.d.amount ?? 0) > 0) {
        div.d.taxes = (div.d.taxes ?? 0) + t.d.amount!;
        t.row.draft = undefined;
        t.row.skipped = true;
        t.row.issues.push(ctx.issue('WITHHOLDING_MERGED', 'info', { amount: t.d.amount!, currency: t.d.currency }, t.row.line));
      }
    }
    return rows;
  },
};
