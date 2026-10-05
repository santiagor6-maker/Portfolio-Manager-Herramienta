/**
 * eToro "Account Statement" XLSX, sheet "Account Activity":
 *   Date | Type | Details | Amount | Units | Realized Equity Change | Realized Equity | Balance | Position ID | Asset type | NWA
 * Amounts are in USD (account currency). Details look like "AAPL/USD", "SAP.DE/EUR", "BTC/USD".
 */
import type { DraftTransaction, InstrumentHint, ParsedRow } from '../types';
import { normalizeText, round } from '../util';
import { type PresetDefinition, cell, columnValues, locateHeader, str } from './common';

const GROUPS = [['Date'], ['Type'], ['Details'], ['Amount'], ['Units'], ['Position ID'], ['Asset type']];

export const etoroPreset: PresetDefinition = {
  id: 'etoro',
  label: 'eToro — Account Statement (XLSX)',
  broker: 'eToro',
  country: 'INTL',
  fileKinds: ['xlsx', 'csv'],
  confidence: 'low',
  description: 'Hoja "Account Activity": aperturas/cierres de posiciones reales (no CFD), dividendos, depósitos, retiros y comisiones, en USD.',
  exportHelp: 'eToro → Configuración → Cuenta → Estado de cuenta → elige fechas → Crear → descarga XLSX.',
  detect(table) {
    const h = locateHeader(table, GROUPS, 0.84, 5);
    return h ? 0.6 + 0.35 * h.coverage : 0;
  },
  parse(table, ctx) {
    const h = locateHeader(table, GROUPS, 0.6, 5)!;
    const H = h.header;
    const c = {
      date: H.find('Date'), type: H.find('Type'), details: H.find('Details'), amount: H.find('Amount'),
      units: H.find('Units'), pos: H.find('Position ID'), asset: H.find('Asset type'),
    };
    ctx.initDates(columnValues(table, h.index + 1, c.date), 'DMY');
    ctx.initNumbers('dot', columnValues(table, h.index + 1, c.amount, c.units));
    const rows: ParsedRow[] = [];
    for (let r = h.index + 1; r < table.rows.length; r++) {
      const raw = table.rows[r]!;
      const row = ctx.newRow(r, raw);
      rows.push(row);
      const type = normalizeText(str(raw, c.type));
      const asset = normalizeText(str(raw, c.asset));
      const date = ctx.date(cell(raw, c.date), row);
      const amount = ctx.num(cell(raw, c.amount), row, 'amount');
      const units = ctx.num(cell(raw, c.units), row, 'units');
      if (!date) continue;
      const details = str(raw, c.details);
      const [symRaw, quote] = details.split('/');
      const inst: InstrumentHint | undefined = symRaw ? { symbol: symRaw.trim().toUpperCase() } : undefined;
      if (inst) {
        if (asset === 'crypto') {
          inst.exchange = 'CRYPTO';
          inst.assetClass = 'crypto';
          inst.currency = 'USD';
        } else {
          if (quote && /^[A-Z]{3}$/.test(quote.trim())) inst.currency = quote.trim();
          if (asset === 'etf') inst.assetClass = 'etf';
        }
      }
      const posId = str(raw, c.pos);
      let d: DraftTransaction | undefined;
      if (type === 'open position' || type === 'position closed') {
        if (asset === 'cfd') {
          ctx.skip(row, 'UNSUPPORTED_ASSET', { value: 'CFD' }, 'warning');
          continue;
        }
        if (units === undefined || amount === undefined || !inst) continue;
        d = {
          date, type: type === 'open position' ? 'BUY' : 'SELL', currency: 'USD', quantity: Math.abs(units),
          amount: Math.abs(amount), price: units ? round(Math.abs(amount) / Math.abs(units), 10) : 0, instrument: inst,
        };
        if (inst.currency && inst.currency !== 'USD') {
          row.issues.push(ctx.issue('CURRENCY_MISMATCH', 'warning', { currency: 'USD', instrumentCurrency: inst.currency }, row.line));
        }
        if (posId) d.brokerRef = `${posId}|${type}`;
      } else if (type === 'dividend') {
        if (amount === undefined) continue;
        d = { date, type: 'DIVIDEND', currency: 'USD', amount: Math.abs(amount) };
        if (inst) d.instrument = inst;
      } else if (type === 'deposit') {
        if (amount === undefined) continue;
        d = { date, type: 'DEPOSIT', currency: 'USD', amount: Math.abs(amount) };
      } else if (type === 'withdraw request' || type === 'withdrawal') {
        if (amount === undefined) continue;
        d = { date, type: 'WITHDRAWAL', currency: 'USD', amount: Math.abs(amount) };
      } else if (/fee/.test(type)) {
        if (amount === undefined) continue;
        d = { date, type: 'FEE', currency: 'USD', amount: Math.abs(amount), note: str(raw, c.type) };
      } else if (/interest/.test(type)) {
        if (amount === undefined) continue;
        d = { date, type: 'INTEREST', currency: 'USD', amount: Math.abs(amount) };
      } else {
        ctx.skip(row, 'SKIPPED_MOVEMENT', { value: str(raw, c.type), reason: 'tipo no soportado.' }, 'warning');
        continue;
      }
      row.draft = d;
    }
    return rows;
  },
};
