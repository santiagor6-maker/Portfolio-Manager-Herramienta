/**
 * Versioned JSON backup of a user's data (portfolios + instruments + transactions + manual prices),
 * with structural validation on import. Schema version 1.
 */
import type { Instrument, Portfolio, PriceSeries, Transaction, TransactionType } from '@pm/core';

export const BACKUP_FORMAT = 'portafolio-pro-backup';
export const BACKUP_SCHEMA_VERSION = 1;

export interface PortfolioBackup {
  format: typeof BACKUP_FORMAT;
  schemaVersion: number;
  /** ISO timestamp. */
  exportedAt: string;
  generator?: string;
  portfolios: Portfolio[];
  instruments: Instrument[];
  transactions: Transaction[];
  /** User-entered prices (unlisted funds, CDTs, private assets). */
  manualPrices: PriceSeries[];
  /** Free-form app settings (base currency view, locale...). */
  settings?: Record<string, unknown>;
}

export interface BackupProblem {
  path: string;
  message: string;
}

export interface BackupValidation {
  ok: boolean;
  backup?: PortfolioBackup;
  errors: BackupProblem[];
  warnings: BackupProblem[];
}

const TX_TYPES: TransactionType[] = [
  'BUY', 'SELL', 'DIVIDEND', 'INTEREST', 'DEPOSIT', 'WITHDRAWAL', 'FEE', 'TAX', 'SPLIT', 'STOCK_DIVIDEND',
  'TRANSFER_IN', 'TRANSFER_OUT', 'FX_CONVERSION', 'RETURN_OF_CAPITAL',
];
const ASSET_CLASSES = ['equity', 'etf', 'fund', 'reit', 'bond', 'fixed_income', 'cash', 'crypto', 'commodity', 'other'];
const COST_METHODS = ['FIFO', 'AVERAGE', 'LIFO'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CCY_RE = /^[A-Z]{3}$/;

export function createBackup(data: {
  portfolios: Portfolio[];
  instruments: Instrument[];
  transactions: Transaction[];
  manualPrices?: PriceSeries[];
  settings?: Record<string, unknown>;
  exportedAt?: string;
}): PortfolioBackup {
  const b: PortfolioBackup = {
    format: BACKUP_FORMAT,
    schemaVersion: BACKUP_SCHEMA_VERSION,
    exportedAt: data.exportedAt ?? new Date().toISOString(),
    generator: 'Portafolio Pro',
    portfolios: data.portfolios,
    instruments: data.instruments,
    transactions: data.transactions,
    manualPrices: data.manualPrices ?? [],
  };
  if (data.settings) b.settings = data.settings;
  return b;
}

export function serializeBackup(backup: PortfolioBackup, pretty = true): string {
  return JSON.stringify(backup, null, pretty ? 2 : undefined);
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Upgrade older schema versions in place (none yet; hook for future migrations). */
function migrate(obj: Record<string, unknown>): Record<string, unknown> {
  if (obj.schemaVersion === 0) {
    // v0 (pre-release) used `prices` instead of `manualPrices`.
    obj.manualPrices = obj.manualPrices ?? obj.prices ?? [];
    delete obj.prices;
    obj.schemaVersion = 1;
  }
  return obj;
}

export function validateBackup(input: unknown): BackupValidation {
  const errors: BackupProblem[] = [];
  const warnings: BackupProblem[] = [];
  const err = (path: string, message: string) => errors.push({ path, message });
  if (!isObj(input)) return { ok: false, errors: [{ path: '', message: 'El respaldo no es un objeto JSON.' }], warnings };
  if (input.format !== BACKUP_FORMAT) err('format', `Formato desconocido (se esperaba "${BACKUP_FORMAT}").`);
  if (!isNum(input.schemaVersion)) err('schemaVersion', 'Falta la versión del esquema.');
  else if (input.schemaVersion > BACKUP_SCHEMA_VERSION) {
    err('schemaVersion', `El respaldo es de una versión más nueva (${input.schemaVersion}); actualiza la aplicación.`);
  }
  if (errors.length) return { ok: false, errors, warnings };
  const obj = migrate({ ...input });
  for (const key of ['portfolios', 'instruments', 'transactions'] as const) {
    if (!Array.isArray(obj[key])) err(key, 'Debe ser una lista.');
  }
  if (obj.manualPrices !== undefined && !Array.isArray(obj.manualPrices)) err('manualPrices', 'Debe ser una lista.');
  if (errors.length) return { ok: false, errors, warnings };

  const portfolios = obj.portfolios as unknown[];
  const instruments = obj.instruments as unknown[];
  const transactions = obj.transactions as unknown[];
  const manualPrices = (obj.manualPrices as unknown[] | undefined) ?? [];

  const portfolioIds = new Set<string>();
  portfolios.forEach((p, i) => {
    const path = `portfolios[${i}]`;
    if (!isObj(p)) return err(path, 'Debe ser un objeto.');
    if (typeof p.id !== 'string' || !p.id) err(`${path}.id`, 'Falta el id.');
    else if (portfolioIds.has(p.id)) err(`${path}.id`, `Id duplicado "${p.id}".`);
    else portfolioIds.add(p.id);
    if (typeof p.name !== 'string') err(`${path}.name`, 'Falta el nombre.');
    if (typeof p.baseCurrency !== 'string' || !CCY_RE.test(p.baseCurrency)) err(`${path}.baseCurrency`, 'Moneda base inválida.');
    if (!COST_METHODS.includes(String(p.costMethod))) err(`${path}.costMethod`, 'Método de costo inválido (FIFO, AVERAGE, LIFO).');
    if (typeof p.createdAt !== 'string' || !DATE_RE.test(p.createdAt)) err(`${path}.createdAt`, 'Fecha inválida (AAAA-MM-DD).');
  });

  const instrumentIds = new Set<string>();
  instruments.forEach((x, i) => {
    const path = `instruments[${i}]`;
    if (!isObj(x)) return err(path, 'Debe ser un objeto.');
    if (typeof x.id !== 'string' || !x.id) err(`${path}.id`, 'Falta el id.');
    else if (instrumentIds.has(x.id)) err(`${path}.id`, `Id duplicado "${x.id}".`);
    else instrumentIds.add(x.id);
    for (const k of ['symbol', 'name', 'exchange', 'country'] as const) if (typeof x[k] !== 'string') err(`${path}.${k}`, `Falta "${k}".`);
    if (typeof x.currency !== 'string' || !CCY_RE.test(x.currency)) err(`${path}.currency`, 'Moneda inválida.');
    if (!ASSET_CLASSES.includes(String(x.assetClass))) err(`${path}.assetClass`, 'Clase de activo inválida.');
  });

  const txIds = new Set<string>();
  transactions.forEach((t, i) => {
    const path = `transactions[${i}]`;
    if (!isObj(t)) return err(path, 'Debe ser un objeto.');
    if (typeof t.id !== 'string' || !t.id) err(`${path}.id`, 'Falta el id.');
    else if (txIds.has(t.id)) err(`${path}.id`, `Id duplicado "${t.id}".`);
    else txIds.add(t.id);
    if (typeof t.portfolioId !== 'string' || !portfolioIds.has(t.portfolioId)) err(`${path}.portfolioId`, 'Portafolio inexistente.');
    if (typeof t.date !== 'string' || !DATE_RE.test(t.date)) err(`${path}.date`, 'Fecha inválida (AAAA-MM-DD).');
    if (!TX_TYPES.includes(t.type as TransactionType)) err(`${path}.type`, `Tipo inválido "${String(t.type)}".`);
    if (typeof t.currency !== 'string' || !CCY_RE.test(t.currency)) err(`${path}.currency`, 'Moneda inválida.');
    if (t.instrumentId !== undefined && (typeof t.instrumentId !== 'string' || !instrumentIds.has(t.instrumentId))) {
      err(`${path}.instrumentId`, `Activo inexistente "${String(t.instrumentId)}".`);
    }
    for (const k of ['quantity', 'price', 'amount', 'fees', 'taxes', 'ratio', 'toAmount', 'fxRateToBase'] as const) {
      if (t[k] !== undefined && !isNum(t[k])) err(`${path}.${k}`, 'Debe ser un número.');
    }
    if (['BUY', 'SELL'].includes(String(t.type)) && (!isNum(t.quantity) || !t.instrumentId)) err(path, 'Compra/venta sin cantidad o activo.');
    if (t.type === 'SPLIT' && !isNum(t.ratio)) err(`${path}.ratio`, 'Split sin proporción.');
  });

  manualPrices.forEach((s, i) => {
    const path = `manualPrices[${i}]`;
    if (!isObj(s)) return err(path, 'Debe ser un objeto.');
    if (typeof s.instrumentId !== 'string' || !instrumentIds.has(s.instrumentId)) warnings.push({ path: `${path}.instrumentId`, message: 'Precio de un activo inexistente.' });
    if (!Array.isArray(s.points)) return err(`${path}.points`, 'Debe ser una lista.');
    s.points.forEach((p, j) => {
      if (!isObj(p) || typeof p.date !== 'string' || !DATE_RE.test(p.date) || !isNum(p.close)) err(`${path}.points[${j}]`, 'Punto inválido (date, close).');
    });
  });

  if (errors.length) return { ok: false, errors, warnings };
  return { ok: true, backup: obj as unknown as PortfolioBackup, errors, warnings };
}

/** Parse + validate a backup JSON string. */
export function parseBackup(text: string): BackupValidation {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.replace(/^﻿/, ''));
  } catch (e) {
    return { ok: false, errors: [{ path: '', message: `JSON inválido: ${e instanceof Error ? e.message : String(e)}` }], warnings: [] };
  }
  return validateBackup(parsed);
}
