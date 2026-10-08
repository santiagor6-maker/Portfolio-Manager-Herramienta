/**
 * PDF parsers: SINACOR notas de corretagem (BR), Colombian brokerage statements (Trii, tyba,
 * Davivienda Corredores, Acciones & Valores, Credicorp...) and Colombian CDT certificates.
 */
import type { AccrualSpec, Instrument } from '@pm/core';
import { parseDate } from '../dates';
import { suggestMappingFromHeaders, findHeaderRow } from '../mapping';
import { parseNumber } from '../numbers';
import type { ParseContext } from '../presets/common';
import { parseWithMapping } from '../presets/generic';
import type { Confidence, DraftTransaction, ParsedRow } from '../types';
import { cellToString, normalizeText, round } from '../util';
import { pdfToTable, type PdfDocument } from './extract';
import { sinacorToRows } from './sinacor';

export interface PdfParser {
  id: string;
  label: string;
  broker: string;
  country: string;
  confidence: Confidence;
  description: string;
  exportHelp: string;
  detect(doc: PdfDocument): number;
  parse(doc: PdfDocument, ctx: ParseContext): ParsedRow[];
}

export const sinacorParser: PdfParser = {
  id: 'nota-sinacor-pdf',
  label: 'Nota de corretagem SINACOR (PDF)',
  broker: 'Corretoras BR (XP, Clear, Rico, BTG, Inter, Nu Invest, Genial, Ágora...)',
  country: 'BR',
  confidence: 'medium',
  description: 'Notas de corretagem en PDF (padrão SINACOR): operaciones, costos (liquidação, registro, emolumentos, corretagem, ISS) prorrateados e IRRF.',
  exportHelp: 'Portal de tu corretora → Notas de corretagem → descarga el PDF (uno o varios días por archivo). Si el PDF tiene contraseña, quítala antes.',
  detect(doc) {
    const t = normalizeText(doc.text);
    let s = 0;
    if (/nota de corretagem/.test(t)) s += 0.4;
    if (/negocios realizados/.test(t)) s += 0.3;
    if (/resumo financeiro/.test(t)) s += 0.2;
    if (/data pregao/.test(t)) s += 0.08;
    return Math.min(s, 0.98);
  },
  parse: (doc, ctx) => sinacorToRows(doc, ctx),
};

const CO_BROKERS: [RegExp, string][] = [
  [/\btrii\b/i, 'Trii'],
  [/\btyba\b/i, 'tyba'],
  [/davivienda corredores/i, 'Davivienda Corredores'],
  [/acciones\s*(&|y)\s*valores/i, 'Acciones & Valores'],
  [/credicorp capital/i, 'Credicorp Capital'],
  [/casa de bolsa/i, 'Casa de Bolsa'],
  [/valores bancolombia/i, 'Valores Bancolombia'],
  [/btg pactual/i, 'BTG Pactual Colombia'],
];

export function coBroker(text: string): string | undefined {
  return CO_BROKERS.find(([re]) => re.test(text))?.[1];
}

export const coStatementParser: PdfParser = {
  id: 'extracto-co-pdf',
  label: 'Extracto de comisionista colombiano (PDF)',
  broker: 'Trii, tyba, Davivienda Corredores, Acciones & Valores, Credicorp, Casa de Bolsa',
  country: 'CO',
  confidence: 'low',
  description: 'Extracto/estado de cuenta en PDF con una tabla de movimientos (Fecha, Operación, Especie, Cantidad, Precio, Valor...). Se reconstruye la tabla por posición del texto.',
  exportHelp: 'App o portal de tu comisionista → Extractos / Estado de cuenta → descarga el PDF del mes.',
  detect(doc) {
    const table = pdfToTable(doc);
    const h = findHeaderRow(table, table.rows.length);
    const headers = (table.rows[h] ?? []).map((c) => cellToString(c));
    const s = suggestMappingFromHeaders(headers);
    const hasTable = s.missing.length === 0 && s.mapping.columns.symbol !== undefined;
    const broker = coBroker(doc.text);
    const spanish = headers.some((x) => /^fecha/i.test(normalizeText(x)));
    if (hasTable && spanish) return broker ? 0.85 : 0.6;
    return 0;
  },
  parse(doc, ctx) {
    const full = pdfToTable(doc);
    const h = findHeaderRow(full, full.rows.length);
    // Holdings section ("Portafolio al cierre", "Posición", "Saldos de títulos"…) is not movements (I29):
    // cut the movements table there and use the holdings for reconciliation.
    const cut = doc.lines.findIndex((l, i) => i > h && HOLDINGS_RE.test(normalizeText(l.text)));
    const table = cut > 0 ? { ...full, rows: full.rows.slice(0, cut), lines: full.lines.slice(0, cut) } : full;
    if (cut > 0) {
      const positions = parseHoldings(doc.lines.slice(cut + 1));
      if (positions.length) {
        const period = /(\d{2}\/\d{2}\/\d{4})\s*[-–a]\s*(\d{2}\/\d{2}\/\d{4})/.exec(doc.text);
        const asOf = ctx.options.asOfDate ?? (period ? parseDate(period[2]!, 'DMY') : undefined);
        ctx.reported = { source: 'extracto-co-pdf', positions, cash: [], ...(asOf ? { asOf } : {}), accountIds: [coBroker(doc.text) ?? ''].filter(Boolean) };
      }
    }
    const s = suggestMappingFromHeaders((table.rows[h] ?? []).map((c) => cellToString(c)));
    const broker = coBroker(doc.text);
    const mapping = { ...s.mapping, headerRow: h, defaultExchange: 'XBOG', defaultCurrency: ctx.options.defaultCurrency ?? 'COP' };
    const opts: Parameters<typeof parseWithMapping>[3] = { numberHint: 'comma' };
    if (broker) opts.account = broker;
    const rows = parseWithMapping(table, ctx, mapping, opts);
    for (const r of rows) r.sheet = `pág. ${doc.lines[r.line - 1]?.page ?? 1}`;
    return rows;
  },
};

const HOLDINGS_RE = /^(portafolio( al cierre| de inversion)?|posicion( al cierre| consolidada)?|saldos? (de )?(titulos|acciones|valores)|composicion del portafolio|resumen (del )?portafolio|tenencias)\b/;

/** Holdings lines after the section title: "<especie> <cantidad> <precio> <valor>" until a total line. */
function parseHoldings(lines: PdfDocument['lines']): NonNullable<ParseContext['reported']>['positions'] {
  const out: NonNullable<ParseContext['reported']>['positions'] = [];
  for (const l of lines) {
    const t = normalizeText(l.text);
    if (/^total/.test(t)) break;
    const cells = l.cells.filter(Boolean);
    const sym = cells.find((c) => /^[A-Z][A-Z0-9]{1,11}$/.test(c));
    if (!sym || /^(ESPECIE|CANTIDAD|PRECIO|VALOR)$/.test(sym)) continue;
    const nums = cells.slice(cells.indexOf(sym) + 1).map((c) => parseNumber(c, 'comma')).filter((n): n is number => n !== undefined && !Number.isNaN(n));
    if (!nums.length) continue;
    const pos: NonNullable<ParseContext['reported']>['positions'][number] = {
      symbol: sym, quantity: nums[0]!, currency: 'COP', hint: { symbol: sym, exchange: 'XBOG', currency: 'COP' },
    };
    if (nums[1] !== undefined) pos.price = nums[1];
    if (nums[2] !== undefined) pos.marketValue = nums[2];
    out.push(pos);
  }
  return out;
}

// ---------------------------------------------------------------------------
// CDT certificates (Colombia)
// ---------------------------------------------------------------------------

export interface CdtInfo {
  issuer?: string;
  number?: string;
  amount?: number;
  issueDate?: string;
  maturity?: string;
  termDays?: number;
  accrual?: AccrualSpec;
  rateText?: string;
  payment?: string;
  /** Nominal rate found and converted to E.A. */
  nominal?: { rate: number; periods: number; anticipated: boolean; effective: number };
  /** Retención en la fuente on interest (decimal). */
  withholdingRate?: number;
}

const DATE_RE = /(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{4}-\d{2}-\d{2}|\d{1,2}\s+de\s+[a-záéíóú]+\s+de\s+\d{4}|\d{1,2}[-\s][a-z]{3}[-\s]\d{4})/i;

function after(text: string, label: RegExp, value: RegExp): RegExpExecArray | undefined {
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = label.exec(lines[i]!);
    if (!m) continue;
    const rest = lines[i]!.slice(m.index + m[0].length);
    const v = value.exec(rest) ?? value.exec(lines[i + 1] ?? '');
    if (v) return v;
  }
  return undefined;
}

export function parseCdt(doc: PdfDocument): CdtInfo {
  const text = doc.text;
  const info: CdtInfo = {};
  const issuer =
    after(text, /(entidad emisora|emisor|entidad)\s*:?/i, /([A-ZÁÉÍÓÚÑ][\wÁÉÍÓÚÑáéíóúñ.&\s-]{3,60}?)(?:\s{2,}|$)/) ??
    /^(?!.*certificado)(.*\b(banco|bancolombia|davivienda|financiera|compañ[ií]a de financiamiento|corporaci[óo]n financiera)\b.*)$/im.exec(text) ??
    undefined;
  if (issuer) info.issuer = issuer[1]!.replace(/\s{2,}.*/, '').trim();
  const nr = after(text, /(n[úu]mero|no\.|n°|nro\.?)\s*(del\s*)?(cdt|t[íi]tulo|certificado)?\s*:?/i, /([A-Z0-9][A-Z0-9-]{3,})/i);
  if (nr) info.number = nr[1];
  const amt = after(text, /(valor\s*(nominal|de la inversi[óo]n|del t[íi]tulo|inicial|invertido)|monto|capital)\s*:?/i, /\$?\s*(\d[\d.,]*\d)/);
  if (amt) info.amount = parseNumber(amt[1]!, /,\d{2}$/.test(amt[1]!) || /\.\d{3}($|\.)/.test(amt[1]!) ? 'comma' : 'dot');
  const issue = after(text, /fecha\s*de\s*(emisi[óo]n|apertura|constituci[óo]n|expedici[óo]n|inicio)\s*:?/i, DATE_RE);
  if (issue) info.issueDate = parseDate(issue[1]!, 'DMY');
  // Only real maturity labels ("Fecha de vencimiento", "Vencimiento:", "Vence"), never phrases such as
  // "intereses al vencimiento".
  const mat = after(text, /fecha\s*de\s*vencimiento\s*:?|(?:^|\s{2,})vencimiento\s*:|\bvence(?:\s+el)?\s*:?/i, DATE_RE);
  if (mat) info.maturity = parseDate(mat[1]!, 'DMY');
  const term = /plazo\s*:?\s*(\d{1,4})\s*d[ií]as/i.exec(text);
  if (term) info.termDays = Number(term[1]);
  if (!info.maturity && info.issueDate && info.termDays) {
    info.maturity = new Date(Date.parse(info.issueDate) + info.termDays * 86400000).toISOString().slice(0, 10);
  }
  const indexed = /\b(IPC|IBR|DTF|UVR)\s*\+\s*(\d+(?:[.,]\d+)?)\s*%/i.exec(text);
  // Nominal rates: N.M.V. / N.T.V. / N.S.V. / N.A.V. (vencido) and N.M.A. / N.T.A. … (anticipado), also
  // written NMV, NATV ("nominal anual trimestre vencido"), "nominal mes vencido".
  const nominal = /(\d+(?:[.,]\d+)?)\s*%\s*(?:N\.?\s?A?\.?\s?([MTSA])\.?\s?([VA])\b\.?|nominal\s+(?:anual\s+)?(mes|trimestre|semestre|a[nñ]o)\s+(vencido|anticipado))/i.exec(text);
  const fixed = /(\d+(?:[.,]\d+)?)\s*%\s*(E\.?\s?A\.?|efectivo anual|EA\b)/i.exec(text) ??
    after(text, /tasa(\s*(de inter[ée]s|efectiva anual|e\.?a\.?))?\s*:?/i, /(\d+(?:[.,]\d+)?)\s*%(?!\s*N)/);
  if (indexed) {
    const index = indexed[1]!.toUpperCase();
    info.accrual = { kind: 'indexed', index: index === 'IPC' ? 'IPC_CO' : index, spread: round(Number(indexed[2]!.replace(',', '.')) / 100, 8), dayCount: 'ACT/365' };
    info.rateText = indexed[0];
  } else if (nominal) {
    const r = Number(nominal[1]!.replace(',', '.')) / 100;
    const periodWord = (nominal[4] ?? '').toLowerCase();
    const p = nominal[2]?.toUpperCase() ?? (periodWord.startsWith('mes') ? 'M' : periodWord.startsWith('tri') ? 'T' : periodWord.startsWith('sem') ? 'S' : 'A');
    const anticipated = (nominal[3]?.toUpperCase() ?? (nominal[5]?.toLowerCase().startsWith('anti') ? 'A' : 'V')) === 'A';
    const m = p === 'M' ? 12 : p === 'T' ? 4 : p === 'S' ? 2 : 1;
    const ea = anticipated ? (1 - r / m) ** -m - 1 : (1 + r / m) ** m - 1;
    info.accrual = { kind: 'fixed', annualRate: round(ea, 8), dayCount: 'ACT/365' };
    info.rateText = `${nominal[1]}% N${p}${anticipated ? 'A' : 'V'} = ${round(ea * 100, 4).toString().replace('.', ',')}% E.A.`;
    info.nominal = { rate: r, periods: m, anticipated, effective: round(ea, 8) };
  } else if (fixed) {
    info.accrual = { kind: 'fixed', annualRate: round(Number(fixed[1]!.replace(',', '.')) / 100, 8), dayCount: 'ACT/365' };
    info.rateText = `${fixed[1]}% E.A.`;
  }
  const wh = /retenci[oó]n(?:\s+en\s+la\s+fuente)?\s*:?\s*(\d+(?:[.,]\d+)?)\s*%/i.exec(text);
  if (wh) info.withholdingRate = round(Number(wh[1]!.replace(',', '.')) / 100, 8);
  if (info.accrual) {
    if (info.issueDate) info.accrual.issueDate = info.issueDate;
    if (info.maturity) info.accrual.maturity = info.maturity;
  }
  const pay = after(text, /(periodicidad(\s+de\s+(pago|intereses))?|pago de intereses|modalidad de pago|forma de pago)(\s+de intereses)?\s*:?/i, /([A-Za-záéíóú][A-Za-záéíóú ]{3,29})/);
  if (pay) info.payment = pay[1]!.trim();
  return info;
}

export const cdtParser: PdfParser = {
  id: 'cdt-pdf',
  label: 'Certificado de CDT (PDF)',
  broker: 'Bancos y compañías de financiamiento de Colombia',
  country: 'CO',
  confidence: 'low',
  description: 'Certificado o constancia de un CDT: emisor, valor, tasa E.A. (o IPC/IBR + spread), fecha de emisión y vencimiento → activo de renta fija con causación automática.',
  exportHelp: 'Descarga la constancia/certificado del CDT en la app o portal de tu banco (o el PDF que te enviaron al abrirlo).',
  detect(doc) {
    const t = normalizeText(doc.text);
    let s = 0;
    if (/certificado de deposito a termino|\bcdt\b/.test(t)) s += 0.5;
    if (/vencimiento/.test(t)) s += 0.2;
    if (/tasa|e a\b|efectivo anual/.test(t)) s += 0.2;
    if (/negocios realizados/.test(t)) s = 0;
    return s;
  },
  parse(doc, ctx) {
    ctx.dateFormat = 'DMY';
    ctx.numberFormat = 'comma';
    const info = parseCdt(doc);
    const row = ctx.newRow(0);
    row.raw = [doc.lines[0]?.text ?? ''];
    const missing = !info.amount ? 'amount' : !info.issueDate ? 'issueDate' : !info.maturity ? 'maturity' : !info.accrual ? 'rate' : undefined;
    if (missing) {
      row.issues.push(ctx.issue('MISSING_FIELD', 'error', { field: missing }, row.line));
      return [row];
    }
    if (info.maturity! <= info.issueDate!) {
      row.issues.push(ctx.issue('CDT_INVALID_DATES', 'error', { issueDate: info.issueDate!, maturity: info.maturity! }, row.line));
      return [row];
    }
    if (info.nominal) row.issues.push(ctx.issue('CDT_RATE_NOMINAL', 'info', { rate: info.rateText! }, row.line));
    if (info.withholdingRate !== undefined) {
      row.issues.push(ctx.issue('CDT_WITHHOLDING', 'info', { rate: round(info.withholdingRate * 100, 4) }, row.line));
    }
    const issuer = info.issuer ?? 'Emisor';
    const short = normalizeText(issuer).split(' ').filter((w) => !['banco', 'de', 'del', 's', 'a', 'sa', 'compania', 'financiamiento'].includes(w))[0] ?? 'cdt';
    const symbol = `CDT-${short.toUpperCase()}-${info.number ?? info.maturity!.replace(/-/g, '')}`;
    const instrument: Instrument = {
      id: `MANUAL:${symbol}`,
      symbol,
      name: `CDT ${issuer} ${info.rateText ?? ''} vence ${info.maturity}`.replace(/\s+/g, ' ').trim(),
      exchange: 'MANUAL',
      currency: 'COP',
      country: 'CO',
      assetClass: 'fixed_income',
      pricing: 'manual',
      accrual: info.accrual!,
    };
    const d: DraftTransaction = {
      date: info.issueDate!,
      type: 'BUY',
      currency: 'COP',
      quantity: 1,
      price: info.amount!,
      amount: info.amount!,
      instrument: { create: instrument, name: instrument.name },
      note: [
        `CDT ${issuer}`, info.number ? `No. ${info.number}` : '', info.payment ? `intereses: ${info.payment}` : '',
        info.withholdingRate !== undefined ? `retención ${round(info.withholdingRate * 100, 4)}%` : '',
      ].filter(Boolean).join(' · '),
    };
    row.draft = d;
    row.issues.push(ctx.issue('CDT_IMPORTED', 'info', { issuer, rate: info.rateText ?? '', maturity: info.maturity! }, row.line));
    return [row];
  },
};

export const PDF_PARSERS: PdfParser[] = [sinacorParser, cdtParser, coStatementParser];
