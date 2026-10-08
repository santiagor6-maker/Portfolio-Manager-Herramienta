/**
 * Records the history of a security that no longer trades (review R3, M29) into a frozen JSON
 * file that the server serves from MD_FROZEN_DIR (see src/frozen.ts).
 *
 * Usage (from the repo root, on a machine that can reach the source):
 *   BRAPI_TOKEN=... npx tsx packages/market-data/scripts/record-frozen.ts brapi BVMF:BRFS3 out/
 *   npx tsx packages/market-data/scripts/record-frozen.ts csv BVMF:CPLE6 export.csv out/ [BRL] [DD/MM/YYYY]
 *
 * CSV mode reads a broker or exchange export with a date column (Date/Data/Fecha) and a close
 * column (Close/Fechamento/Último/Cierre); the closes must be as traded (not adjusted).
 * The output is <out>/<EXCHANGE>_<TICKER>.json. Existing files are merged, never shortened.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PricePoint } from '@pm/core';
import { validateFrozen, type FrozenHistory } from '../src/frozen';
import { HttpClient } from '../src/http';
import { BrapiProvider } from '../src/providers/brapi';
import { parseFeedDate, type FeedDateFormat } from '../src/providers/custom';
import { parseCsv } from '../src/providers/ecb';

const DATE_COLS = /^(date|data|fecha|dia|day)$/i;
const CLOSE_COLS = /^(close|fechamento|preco de fechamento|preço de fechamento|ultimo|último|cierre|price|last)$/i;

function parseNumber(s: string): number {
  const t = s.trim().replace(/\s/g, '');
  // 1.234,56 (pt/es) vs 1,234.56 (en): the last separator is the decimal one.
  const norm = t.lastIndexOf(',') > t.lastIndexOf('.') ? t.replace(/\./g, '').replace(',', '.') : t.replace(/,/g, '');
  return Number(norm);
}

export function pointsFromCsv(text: string, fmt: FeedDateFormat = 'iso'): PricePoint[] {
  const sep = text.split('\n')[0]!.includes(';') ? ';' : ',';
  // Semicolon files use decimal commas, so they are split directly (no quoted separators there).
  const rows =
    sep === ';'
      ? text.split(/\r?\n/).filter((l) => l.trim()).map((l) => l.split(';').map((f) => f.trim().replace(/^"(.*)"$/, '$1')))
      : parseCsv(text);
  const header = rows[0]?.map((h) => h.trim()) ?? [];
  const di = header.findIndex((h) => DATE_COLS.test(h));
  const ci = header.findIndex((h) => CLOSE_COLS.test(h));
  if (di < 0 || ci < 0) throw new Error(`CSV needs a date and a close column; header: ${header.join(' | ')}`);
  const out: PricePoint[] = [];
  for (const r of rows.slice(1)) {
    const date = parseFeedDate(r[di]?.trim(), fmt);
    const close = parseNumber(r[ci] ?? '');
    if (date && Number.isFinite(close) && close > 0) out.push({ date, close });
  }
  return out;
}

async function main(argv: string[]): Promise<void> {
  const [mode, instrumentId, a, b, c, d] = argv;
  if (!mode || !instrumentId || !/^[A-Z]{2,8}:[A-Z0-9.-]+$/i.test(instrumentId)) {
    throw new Error('usage: record-frozen.ts brapi <EXCH:TICKER> <outDir> | csv <EXCH:TICKER> <file.csv> <outDir> [currency] [dateFormat]');
  }
  const [exchange, symbol] = instrumentId.toUpperCase().split(':') as [string, string];
  let rec: FrozenHistory;
  let outDir: string;
  if (mode === 'brapi') {
    outDir = a ?? '.';
    const token = process.env.BRAPI_TOKEN;
    if (!token) throw new Error('BRAPI_TOKEN is required (delisted tickers are not in the free tier)');
    const brapi = new BrapiProvider({ http: new HttpClient(), token });
    const t = { instrumentId: `${exchange}:${symbol}`, exchange, symbol, yahoo: `${symbol}.SA` };
    const h = await brapi.dailyHistory(t, '2000-01-01', new Date().toISOString().slice(0, 10));
    rec = { instrumentId: t.instrumentId, currency: h.currency, source: `brapi ${new Date().toISOString().slice(0, 10)}`, points: h.points, dividends: h.dividends };
  } else if (mode === 'csv') {
    if (!a) throw new Error('csv mode needs the CSV file');
    outDir = b ?? '.';
    rec = { instrumentId: `${exchange}:${symbol}`, currency: (c ?? 'BRL').toUpperCase(), source: `csv ${a.split(/[\\/]/).pop()} ${new Date().toISOString().slice(0, 10)}`, points: pointsFromCsv(readFileSync(a, 'utf8'), (d as FeedDateFormat) ?? 'iso') };
  } else {
    throw new Error(`unknown mode ${mode}`);
  }
  const file = join(outDir, `${exchange}_${symbol}.json`);
  if (existsSync(file)) {
    const old = validateFrozen(JSON.parse(readFileSync(file, 'utf8')));
    const have = new Set(rec.points.map((p) => p.date));
    rec.points = [...old.points.filter((p) => !have.has(p.date)), ...rec.points];
    const divs = new Set((rec.dividends ?? []).map((x) => x.date));
    rec.dividends = [...(old.dividends ?? []).filter((x) => !divs.has(x.date)), ...(rec.dividends ?? [])];
    rec.source = `${old.source}; ${rec.source}`;
  }
  const v = validateFrozen(rec);
  if (!v.points.length) throw new Error('no valid points recorded');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(file, `${JSON.stringify(v, null, 1)}\n`);
  console.log(`${file}: ${v.points.length} points ${v.points[0]!.date}..${v.points[v.points.length - 1]!.date}, ${v.dividends?.length ?? 0} dividends`);
}

if (process.argv[1] && /record-frozen\.ts$/.test(process.argv[1])) {
  main(process.argv.slice(2)).catch((e: unknown) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
