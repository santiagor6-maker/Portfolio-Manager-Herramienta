/**
 * Interactive Brokers Flex Web Service client (automatic sync, like Sharesight/Snowball).
 *
 * Flow (Flex Web Service v3):
 *   1. GET {base}/SendRequest?t=TOKEN&q=QUERY_ID&v=3  →  <FlexStatementResponse><Status>Success</Status>
 *      <ReferenceCode>…</ReferenceCode><Url>…/GetStatement</Url></FlexStatementResponse>
 *   2. GET {Url}?t=TOKEN&q=REFERENCE_CODE&v=3  →  the Flex XML (<FlexQueryResponse>…) or, while it is
 *      being generated, <FlexStatementResponse><Status>Warn</Status><ErrorCode>1019</ErrorCode>… → retry.
 * The XML sections (Trades, CashTransactions, Transfers, OpenPositions) are converted to the same table
 * shape as a Flex CSV and parsed by the `ibkr-flex` preset, so sync and file import behave identically.
 *
 * Runtime-agnostic: inject `fetch` (browser, Node ≥ 18, Hono server). IBKR does not send CORS headers,
 * so in the web app call this from `apps/server` (the token never needs to reach the browser).
 */
import { finalizeRows } from '../pipeline';
import { ParseContext } from '../presets/common';
import { ibkrFlexPreset } from '../presets/ibkr';
import type { Cell, DetectionInfo, ImportOptions, ImportResult, RawTable } from '../types';

export const FLEX_BASE_URL = 'https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService';

export interface FlexClientOptions {
  /** Flex Web Service token (Portal → Settings → Reporting → Flex Web Service). */
  token: string;
  /** Activity Flex Query id. */
  queryId: string;
  fetch?: (url: string, init?: { headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;
  baseUrl?: string;
  /** Polls of GetStatement while the statement is generated. Default 10. */
  maxAttempts?: number;
  /** Wait between polls in ms. Default 3000 (IBKR asks clients to back off). */
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** IBKR rejects requests without a User-Agent (servers only; browsers set their own). */
  userAgent?: string;
}

/** Spanish messages for the documented Flex Web Service error codes. */
export const FLEX_ERRORS: Record<string, { retry: boolean; message: string }> = {
  '1001': { retry: true, message: 'El extracto no se pudo generar en este momento; reintenta.' },
  '1003': { retry: false, message: 'El extracto no está disponible.' },
  '1004': { retry: true, message: 'El extracto está incompleto en este momento; reintenta.' },
  '1005': { retry: false, message: 'Los datos de liquidación aún no están listos.' },
  '1006': { retry: true, message: 'Los datos FIFO aún no están listos.' },
  '1007': { retry: true, message: 'Los datos MTM aún no están listos.' },
  '1008': { retry: true, message: 'Los datos MTM y FIFO aún no están listos.' },
  '1009': { retry: true, message: 'El servidor está ocupado; reintenta.' },
  '1010': { retry: false, message: 'Consulta Flex antigua: vuelve a crearla en el portal.' },
  '1011': { retry: false, message: 'El servicio de la cuenta no está activo.' },
  '1012': { retry: false, message: 'El token Flex expiró: genera uno nuevo en el portal de IBKR.' },
  '1013': { retry: false, message: 'Restricción de IP: el token no permite esta dirección.' },
  '1014': { retry: false, message: 'Consulta Flex inválida (revisa el Query ID).' },
  '1015': { retry: false, message: 'Token Flex inválido.' },
  '1016': { retry: false, message: 'Cuenta inválida.' },
  '1017': { retry: false, message: 'Código de referencia inválido.' },
  '1018': { retry: true, message: 'Demasiadas solicitudes; espera e inténtalo de nuevo.' },
  '1019': { retry: true, message: 'El extracto se está generando; reintenta en unos segundos.' },
  '1020': { retry: false, message: 'Solicitud inválida o no validada.' },
  '1021': { retry: true, message: 'El extracto no se pudo obtener en este momento; reintenta.' },
};

export class FlexError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
    this.name = 'FlexError';
  }
}

function tag(xml: string, name: string): string | undefined {
  return new RegExp(`<${name}>([\\s\\S]*?)</${name}>`, 'i').exec(xml)?.[1]?.trim();
}

function decodeXml(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&');
}

/** Run the SendRequest + GetStatement flow and return the Flex XML. */
export async function fetchFlexStatement(opts: FlexClientOptions): Promise<string> {
  const doFetch = opts.fetch ?? (globalThis.fetch as unknown as FlexClientOptions['fetch']);
  if (!doFetch) throw new FlexError('No hay fetch disponible.');
  const base = opts.baseUrl ?? FLEX_BASE_URL;
  const headers: Record<string, string> = {};
  if (opts.userAgent) headers['User-Agent'] = opts.userAgent;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const q = (s: string) => encodeURIComponent(s);
  const call = async (url: string) => {
    const res = await doFetch(url, { headers });
    const text = await res.text();
    if (!res.ok) throw new FlexError(`HTTP ${res.status}`, String(res.status));
    return text;
  };
  const errorOf = (xml: string) => {
    const code = tag(xml, 'ErrorCode');
    const msg = tag(xml, 'ErrorMessage');
    return { code, message: (code && FLEX_ERRORS[code]?.message) || msg || 'Error de Flex Web Service', retry: !!(code && FLEX_ERRORS[code]?.retry) };
  };

  const maxAttempts = opts.maxAttempts ?? 10;
  let send = '';
  for (let attempt = 1; ; attempt++) {
    send = await call(`${base}/SendRequest?t=${q(opts.token)}&q=${q(opts.queryId)}&v=3`);
    if (/<Status>\s*Success\s*<\/Status>/i.test(send)) break;
    const e = errorOf(send);
    if (!e.retry || attempt >= maxAttempts) throw new FlexError(e.message, e.code);
    await sleep(opts.delayMs ?? 3000);
  }
  const ref = tag(send, 'ReferenceCode');
  const url = tag(send, 'Url') ?? `${base}/GetStatement`;
  if (!ref) throw new FlexError('Respuesta sin código de referencia.');
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const xml = await call(`${decodeXml(url)}?t=${q(opts.token)}&q=${q(ref)}&v=3`);
    if (/<FlexQueryResponse/i.test(xml)) return xml;
    const e = errorOf(xml);
    if (!e.retry) throw new FlexError(e.message, e.code);
    await sleep(opts.delayMs ?? 3000);
  }
  throw new FlexError(FLEX_ERRORS['1019']!.message, '1019');
}

/** XML attribute names → the Flex CSV column names our parser understands. */
const ATTR_TO_COLUMN: Record<string, string> = {
  accountId: 'ClientAccountID',
  currency: 'CurrencyPrimary',
  assetCategory: 'AssetClass',
  buySell: 'Buy/Sell',
  company: 'TransferCompany',
};

const SECTIONS = ['Trade', 'CashTransaction', 'Transfer', 'OpenPosition'];

/** Convert a Flex XML statement to a CSV-like table (header row per section, like a multi-section Flex CSV). */
export function flexXmlToTable(xml: string): RawTable {
  const rows: Cell[][] = [];
  const lines: number[] = [];
  let line = 0;
  for (const el of SECTIONS) {
    const re = new RegExp(`<${el}\\s([^>]*?)/?>`, 'g');
    const records: Record<string, string>[] = [];
    let m: RegExpExecArray | null;
    while ((m = re.exec(xml))) {
      const attrs: Record<string, string> = {};
      const ar = /(\w+)="([^"]*)"/g;
      let a: RegExpExecArray | null;
      while ((a = ar.exec(m[1]!))) attrs[a[1]!] = decodeXml(a[2]!);
      // Open positions: keep summary rows only.
      if (el === 'OpenPosition' && attrs.levelOfDetail && attrs.levelOfDetail !== 'SUMMARY') continue;
      records.push(attrs);
    }
    if (!records.length) continue;
    const keys = [...new Set(records.flatMap((r) => Object.keys(r)))];
    if (!keys.includes('accountId')) keys.unshift('accountId');
    rows.push(keys.map((k) => ATTR_TO_COLUMN[k] ?? k));
    lines.push(++line);
    for (const r of records) {
      rows.push(keys.map((k) => r[k] ?? ''));
      lines.push(++line);
    }
  }
  return { name: 'flex.xml', rows, lines };
}

/** Import an already-downloaded Flex XML statement. */
export async function importFlexXml(xml: string, options: ImportOptions): Promise<ImportResult> {
  const table = flexXmlToTable(xml);
  const detection: DetectionInfo = {
    fileKind: 'unknown', presetId: 'ibkr-flex-sync', presetLabel: 'Interactive Brokers — Flex Web Service', presetConfidence: 'medium', score: 1,
  };
  const ctx = new ParseContext(table, { account: 'Interactive Brokers', ...options }, 'ibkr-flex');
  const rows = ibkrFlexPreset.parse(table, ctx);
  detection.dateFormat = ctx.dateFormat;
  detection.numberFormat = ctx.numberFormat;
  // Same source id as the Flex CSV so a CSV import and a sync de-duplicate exactly.
  return finalizeRows(rows, ctx, 'import:ibkr-flex', detection);
}

/** Full sync: fetch the statement with the token/query and import it (pass existing transactions to de-duplicate). */
export async function syncIbkrFlex(client: FlexClientOptions, options: ImportOptions): Promise<ImportResult> {
  const xml = await fetchFlexStatement(client);
  return importFlexXml(xml, options);
}
