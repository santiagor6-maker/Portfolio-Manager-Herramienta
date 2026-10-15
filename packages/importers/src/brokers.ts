/**
 * Broker / account labels (W33): "XP", "XP INVESTIMENTOS CCTVM S/A" and "XP Investimentos" are the same
 * institution; "NU INVEST", "Nu Invest Corretora de Valores S.A.", "Nubank" and "Easynvest" too.
 * `normalizeBrokerName` gives a stable `brokerId` and a display name so the web can match the account
 * the user typed during onboarding with the labels importers write; dedup and reconciliation use the
 * same key (`accountKey`). IBKR account numbers (U1234567) are kept apart: two numbers = two accounts.
 */
import { normalizeText } from './util';

const ACCOUNT_NOISE = /\b(cctvm|ctvm|dtvm|s a|sa|s a s|sas|ltda|corretora|corredores|comisionista|de|do|da|del|y|e|valores|investimentos|investimento|invest|banco|bank|llc|inc|plc|grupo|the|ltd|co)\b/g;

/**
 * Known institutions, matched on the WHOLE normalized label (I45 — never on the first word alone: "Global
 * Investimentos" is not "Global Securities", "Casa de Valores" is not "Casa de Bolsa"). Order matters
 * (Clear and Rico before XP — "CLEAR CORRETORA - GRUPO XP"; Interactive before Inter).
 */
const BROKER_PATTERNS: [RegExp, string][] = [
  [/\binteractive brokers?\b|\bibkr\b|^ib$/, 'ibkr'],
  [/\bclear\b/, 'clear'],
  [/\brico\b/, 'rico'],
  [/^xp$|^xp\b|\bxp investimentos\b|\bxpi\b/, 'xp'],
  [/\bnu ?invest\b|\bnubank\b|\beasynvest\b|^nu$|^nu (corretora|dtvm)\b/, 'nu'],
  [/^inter$|^inter (dtvm|invest|distribuidora|co|corretora|de titulos)\b|\bbanco inter\b|\bintermedium\b/, 'inter'],
  [/\bbtg\b.*\bcolombia\b/, 'btg-co'],
  [/\bbtg\b/, 'btg'],
  [/\bitau\b|\bion itau\b/, 'itau'],
  [/\bagora\b/, 'agora'],
  [/\bmodal ?(mais)?\b/, 'modal'],
  [/\bgenial\b/, 'genial'],
  [/^toro\b|\btoro investimentos\b/, 'toro'],
  [/\borama\b/, 'orama'],
  [/\bsafra\b/, 'safra'],
  [/\bbradesco\b/, 'bradesco'],
  [/\bsantander\b/, 'santander'],
  [/\bavenue\b/, 'avenue'],
  [/\bbanco do brasil\b|\bbb (investimentos|dtvm|corretora|banco de investimento)\b|^bb$/, 'bb'],
  [/^b3\b|\bb3 s a\b|\barea do investidor\b/, 'b3'],
  [/\btesouro direto\b/, 'tesouro'],
  [/\btrii\b/, 'trii'],
  [/\btyba\b/, 'tyba'],
  [/\bdavivienda\b/, 'davivienda'],
  [/\bacciones (y |e )?valores\b|^a v$|^a y v$/, 'acciones'],
  [/\bcredicorp\b.*\b(peru|pe)\b/, 'credicorp-pe'],
  [/\bcredicorp\b.*\bchile\b/, 'credicorp-cl'],
  [/\bcredicorp\b/, 'credicorp'],
  [/\bcasa de bolsa\b/, 'casadebolsa'],
  [/\bbancolombia\b|\bcibest\b/, 'bancolombia'],
  [/\bglobal securities\b/, 'global-securities'],
  [/\balianza valores\b|\balianza fiduciaria\b/, 'alianza'],
  [/\bhapi\b/, 'hapi'],
  [/\bschwab\b/, 'schwab'],
  [/\bfidelity\b/, 'fidelity'],
  [/degiro/, 'degiro'],
  [/trading ?212|\bt212\b/, 'trading212'],
  [/\betoro\b/, 'etoro'],
];

/** Broker account numbers that identify ONE account (IBKR U1234567 / DU1234567 paper / F-prefixed FA). */
const ACCOUNT_NUMBER_RE = /\b(D?U\d{5,10}|F\d{6,10})\b/i;

/** The broker account number inside an account label ("U1234567", "IBKR U1234567"), upper-cased. */
export function accountNumber(account: string | undefined): string | undefined {
  const m = account ? ACCOUNT_NUMBER_RE.exec(account) : null;
  return m ? m[1]!.toUpperCase() : undefined;
}

function knownBroker(label: string): string | undefined {
  const n = normalizeText(label);
  return BROKER_PATTERNS.find(([re]) => re.test(n))?.[1];
}

/**
 * Normalized institution key: "XP INVESTIMENTOS CCTVM S/A" and "XP" → "xp"; "NU INVEST CORRETORA" → "nu";
 * "U1234567" → "ibkr". Unknown labels keep ALL their words (legal noise removed): "Foo Corretora" and
 * "Foo" match, "Global Investimentos" and "Global Securities" do not.
 */
export function accountKey(account: string | undefined): string | undefined {
  if (!account) return undefined;
  if (accountNumber(account)) return 'ibkr';
  const known = knownBroker(account);
  if (known) return known;
  const n = normalizeText(account);
  const k = n.replace(ACCOUNT_NOISE, ' ').replace(/\s+/g, ' ').trim();
  return (k || n).replace(/ /g, '-');
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
  bb: 'BB Investimentos', 'btg-co': 'BTG Pactual Colombia', 'credicorp-pe': 'Credicorp Capital Perú', 'credicorp-cl': 'Credicorp Capital Chile',
  'global-securities': 'Global Securities', casadebolsa: 'Casa de Bolsa',
  xp: 'XP Investimentos', clear: 'Clear', rico: 'Rico', btg: 'BTG Pactual', nu: 'Nu Invest', inter: 'Inter Invest',
  itau: 'Itaú Corretora', agora: 'Ágora Investimentos', modal: 'Modal', genial: 'Genial Investimentos', toro: 'Toro Investimentos',
  orama: 'Órama', safra: 'Safra Corretora', bradesco: 'Bradesco Corretora', santander: 'Santander Corretora', avenue: 'Avenue',
  b3: 'B3', tesouro: 'Tesouro Direto',
  trii: 'Trii', tyba: 'tyba', davivienda: 'Davivienda Corredores', acciones: 'Acciones & Valores', credicorp: 'Credicorp Capital',
  bancolombia: 'Valores Bancolombia', alianza: 'Alianza Valores', hapi: 'Hapi',
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
