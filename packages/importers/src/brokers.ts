/**
 * Broker / account labels (W33): "XP", "XP INVESTIMENTOS CCTVM S/A" and "XP Investimentos" are the same
 * institution; "NU INVEST", "Nu Invest Corretora de Valores S.A.", "Nubank" and "Easynvest" too.
 * `normalizeBrokerName` gives a stable `brokerId` and a display name so the web can match the account
 * the user typed during onboarding with the labels importers write; dedup and reconciliation use the
 * same key (`accountKey`). IBKR account numbers (U1234567) are kept apart: two numbers = two accounts.
 */
import { normalizeText } from './util';

const ACCOUNT_NOISE = /\b(cctvm|ctvm|dtvm|s a|sa|s a s|sas|ltda|corretora|corredores|comisionista|de|do|da|del|y|e|valores|investimentos|investimento|invest|banco|bank|llc|inc|plc|grupo|the)\b/g;

/** Same institution under different spellings (after noise removal, first word). */
const INSTITUTION_ALIASES: Record<string, string> = {
  interactive: 'ibkr', ib: 'ibkr', ibkr: 'ibkr',
  nubank: 'nu', nuinvest: 'nu', easynvest: 'nu',
  charles: 'schwab', schwab: 'schwab',
  t212: 'trading212', trading: 'trading212', trading212: 'trading212',
  modalmais: 'modal', btgpactual: 'btg', itau: 'itau', itaú: 'itau', ion: 'itau',
  xpi: 'xp', xpinvestimentos: 'xp', agora: 'agora', valores: 'bancolombia', clearcorretora: 'clear', ricoinvestimentos: 'rico',
  orama: 'orama', bancointer: 'inter', intermedium: 'inter', trii: 'trii', a: 'acciones', av: 'acciones',
};

/** Broker account numbers that identify ONE account (IBKR U1234567 / DU1234567 paper / F-prefixed FA). */
const ACCOUNT_NUMBER_RE = /\b(D?U\d{5,10}|F\d{6,10})\b/i;

/** The broker account number inside an account label ("U1234567", "IBKR U1234567"), upper-cased. */
export function accountNumber(account: string | undefined): string | undefined {
  const m = account ? ACCOUNT_NUMBER_RE.exec(account) : null;
  return m ? m[1]!.toUpperCase() : undefined;
}

/** Normalized institution key: "XP INVESTIMENTOS CCTVM S/A" and "XP" → "xp"; "NU INVEST CORRETORA" → "nu"; "U1234567" → "ibkr". */
export function accountKey(account: string | undefined): string | undefined {
  if (!account) return undefined;
  if (accountNumber(account)) return 'ibkr';
  const n = normalizeText(account);
  const k = n.replace(ACCOUNT_NOISE, ' ').replace(/\s+/g, ' ').trim();
  const first = (k || n).split(' ')[0]!;
  return INSTITUTION_ALIASES[first] ?? first;
}

/**
 * Accounts are compatible when either is unknown, or both are the same institution and they do not
 * carry two different account numbers ("U1111111" vs "U2222222" are two IBKR accounts; "IBKR" is
 * compatible with both).
 */
export function accountsCompatible(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return true;
  if (accountKey(a) !== accountKey(b)) return false;
  const na = accountNumber(a);
  const nb = accountNumber(b);
  return !na || !nb || na === nb;
}


/** Known institutions: brokerId → display name. */
export const BROKERS: Record<string, string> = {
  xp: 'XP Investimentos', clear: 'Clear', rico: 'Rico', btg: 'BTG Pactual', nu: 'Nu Invest', inter: 'Inter Invest',
  itau: 'Itaú Corretora', agora: 'Ágora Investimentos', modal: 'Modal', genial: 'Genial Investimentos', toro: 'Toro Investimentos',
  orama: 'Órama', safra: 'Safra Corretora', bradesco: 'Bradesco Corretora', santander: 'Santander Corretora', avenue: 'Avenue',
  b3: 'B3', tesouro: 'Tesouro Direto',
  trii: 'Trii', tyba: 'tyba', davivienda: 'Davivienda Corredores', acciones: 'Acciones & Valores', credicorp: 'Credicorp Capital',
  casa: 'Casa de Bolsa', bancolombia: 'Valores Bancolombia', global: 'Global Securities', alianza: 'Alianza Valores', hapi: 'Hapi',
  ibkr: 'Interactive Brokers', schwab: 'Charles Schwab', fidelity: 'Fidelity', degiro: 'DEGIRO', trading212: 'Trading 212', etoro: 'eToro',
};

export interface BrokerName {
  /** Stable key ("xp", "nu", "ibkr", "davivienda"…); the normalized first word when unknown. */
  brokerId: string;
  /** Canonical display name for known institutions; the label as given otherwise. */
  displayName: string;
  /** IBKR account number when the label carries one. */
  accountNumber?: string;
  known: boolean;
}

/** "XP INVESTIMENTOS CCTVM S/A" → { brokerId: 'xp', displayName: 'XP Investimentos' }; "U1234567" → ibkr + account number. */
export function normalizeBrokerName(label: string): BrokerName {
  const brokerId = accountKey(label) ?? '';
  const out: BrokerName = { brokerId, displayName: BROKERS[brokerId] ?? label.trim(), known: brokerId in BROKERS };
  const n = accountNumber(label);
  if (n) out.accountNumber = n;
  return out;
}

/** Same institution (and, for numbered accounts, same account) — e.g. the onboarding account vs. an imported label. */
export function sameBroker(a: string | undefined, b: string | undefined): boolean {
  return !!a && !!b && accountsCompatible(a, b);
}
