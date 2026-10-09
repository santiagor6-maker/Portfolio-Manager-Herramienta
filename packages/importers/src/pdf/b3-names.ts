/**
 * B3 "nome de pregão" tables (what SINACOR prints in "Especificação do título") → ticker.
 *
 * Matched by EXACT equality of the normalized name (never by prefix: "GERDAU MET" is GOAU, not GGBR).
 * Nomes de pregão are at most 12 characters ("ITAUUNIBANCO", "BBSEGURIDADE", "MERCADOLIBRE").
 * A name that is right but maps to a wrong ticker would be a silent error, so only names whose ticker
 * is certain are listed; anything else is asked (with fuzzy suggestions, see `suggestB3Names`).
 *
 * Tickers are the ones in force when the name was used; same-security renames (TRPL → ISAE,
 * ELET3 → AXIA3, CCRO3 → MOTV3, EMBR3 → EMBJ3, MRFG3 → MBRF3) are applied afterwards by the
 * instrument resolver (`TICKER_RENAMES`, mirroring @pm/market-data `TICKER_ALIASES`).
 *
 * Coverage: the Ibovespa / IBrX-100 constituents of 2023-2025 and other liquid names, the common ETFs,
 * FIIs and BDRs.
 */
import { normalizeText } from '../util';

/** Shares: normalized nome de pregão → ticker root (class ON/PN/PNA/PNB/UNT gives the digit). */
export const B3_PREGAO_ROOTS: Record<string, string> = {
  // Ibovespa / IBrX-100
  petrobras: 'PETR', vale: 'VALE', itausa: 'ITSA', itauunibanco: 'ITUB', bradesco: 'BBDC', brasil: 'BBAS', 'ambev s a': 'ABEV',
  weg: 'WEGE', b3: 'B3SA', 'magaz luiza': 'MGLU', 'suzano s a': 'SUZB', suzano: 'SUZB', gerdau: 'GGBR', 'gerdau met': 'GOAU',
  eletrobras: 'ELET', 'axia energia': 'AXIA', axia: 'AXIA', petrorio: 'PRIO', prio: 'PRIO', raiadrogasil: 'RADL', 'lojas renner': 'LREN',
  localiza: 'RENT', 'klabin s a': 'KLBN', klabin: 'KLBN', sanepar: 'SAPR', cemig: 'CMIG', copel: 'CPLE', bbseguridade: 'BBSE',
  embraer: 'EMBR', jbs: 'JBSS', 'jbs n v': 'JBSS', 'sid nacional': 'CSNA', usiminas: 'USIM', hapvida: 'HAPV', 'rumo s a': 'RAIL',
  rumo: 'RAIL', energisa: 'ENGI', equatorial: 'EQTL', sabesp: 'SBSP', 'btgp banco': 'BPAC', 'santander br': 'SANB', cielo: 'CIEL',
  tim: 'TIMS', 'telef brasil': 'VIVT', ultrapar: 'UGPA', 'ccr sa': 'CCRO', motiva: 'MOTV', 'motiva sa': 'MOTV', cosan: 'CSAN',
  'brf sa': 'BRFS', mrv: 'MRVE', 'mrv engenharia': 'MRVE', 'cyrela realt': 'CYRE', hypera: 'HYPE', totvs: 'TOTS', multiplan: 'MULT',
  taesa: 'TAEE', alupar: 'ALUP', 'engie brasil': 'EGIE', 'cpfl energia': 'CPFE', 'tran paulist': 'TRPL', 'isa cteep': 'TRPL',
  'isa energia': 'ISAE', bradespar: 'BRAP', petroreconcavo: 'RECV', petrorecsa: 'RECV', vibra: 'VBBR', 'caixa seguri': 'CXSE',
  'porto seguro': 'PSSA', porto: 'PSSA', fleury: 'FLRY', grendene: 'GRND', marcopolo: 'POMO', 'randon part': 'RAPT', azul: 'AZUL',
  gol: 'GOLL', 'cvc brasil': 'CVCB', 'yduqs part': 'YDUQ', cogna: 'COGN', 'cogna on': 'COGN', assai: 'ASAI', 'carrefour br': 'CRFB',
  alpargatas: 'ALPA', 'sao martinho': 'SMTO', 'slc agricola': 'SLCE', '3tentos': 'TTEN', 'irbbrasil re': 'IRBR', irbbrasil: 'IRBR',
  banrisul: 'BRSR', 'abc brasil': 'ABCB', odontoprev: 'ODPV', dexco: 'DXCO', eztec: 'EZTC', direcional: 'DIRR', tenda: 'TEND',
  'iguatemi s a': 'IGTI', iguatemi: 'IGTI', allos: 'ALOS', 'aliansce sonae': 'ALSO', 'jhsf part': 'JHSF', vamos: 'VAMO', simpar: 'SIMH',
  movida: 'MOVI', ecorodovias: 'ECOR', eneva: 'ENEV', 'csn mineracao': 'CMIN', braskem: 'BRKM', unipar: 'UNIP', 'positivo tec': 'POSI',
  lwsa: 'LWSA', locaweb: 'LWSA', 'casas bahia': 'BHIA', petz: 'PETZ', smartfit: 'SMFT', 'kepler weber': 'KEPL', tupy: 'TUPY',
  'iochp maxion': 'MYPK', 'metal leve': 'LEVE', 'fras le': 'FRAS', 'santos brp': 'STBP', 'aes brasil': 'AESB', auren: 'AURE',
  neoenergia: 'NEOE', copasa: 'CSMG', 'grupo mateus': 'GMAT', vulcabras: 'VULC', guararapes: 'GUAR', 'c a modas': 'CEAB',
  'vivara s a': 'VIVA', vivara: 'VIVA', 'cury s a': 'CURY', cury: 'CURY', planoeplano: 'PLPL', 'm diasbranco': 'MDIA', camil: 'CAML',
  marfrig: 'MRFG', mbrf: 'MBRF', minerva: 'BEEF', 'boa safra': 'SOJA', 'p acucar cbd': 'PCAR', gpa: 'PCAR', 'arezzo co': 'ARZZ',
  'grupo soma': 'SOMA', 'azzas 2154': 'AZZA', 'sul america': 'SULA', 'rede d or': 'RDOR', 'raizen': 'RAIZ', brava: 'BRAV',
  cba: 'CBAV', 'light s a': 'LIGT', 'pague menos': 'PGMN', panvel: 'PNVL', dasa: 'DASA', qualicorp: 'QUAL', oncoclinicas: 'ONCO',
  'mater dei': 'MATD', blau: 'BLAU', 'banco pan': 'BPAN', bmg: 'BMGB', 'grupo sbf': 'SBFG', americanas: 'AMER', intelbras: 'INTB',
  meliuz: 'CASH', 'jalles machado': 'JALL', brasilagro: 'AGRO', portobello: 'PTBL', eucatex: 'EUCA', irani: 'RANI', romi: 'ROMI',
  zamp: 'ZAMP', 'log com prop': 'LOGG', armac: 'ARML', ambipar: 'AMBP', orizon: 'ORVR', 'ser educa': 'SEER', anima: 'ANIM',
  trisul: 'TRIS', even: 'EVEN', helbor: 'HBOR', 'mitre realty': 'MTRE', 'moura dubeux': 'MDNE', lavvi: 'LAVV', 'wiz co': 'WIZC',
  'natura': 'NTCO', 'track field': 'TFCO', mobly: 'MBLY', 'intelbras s a': 'INTB', 'sanepar s a': 'SAPR',
  'grupo casas bahia': 'BHIA', 'hidrovias': 'HBSA', 'eletromidia': 'ELMD', 'kora saude': 'KRSA',   'tegma': 'TGMA', 'jsl': 'JSLG', 'priner': 'PRNR', 'valid': 'VLID', 'sequoia log': 'SEQL', 'desktop': 'DESK', 'vittia': 'VITT',
  'mills': 'MILS', 'pardini': 'PARD', 'wilson sons': 'PORT', 'unifique': 'FIQE', 'tres tentos': 'TTEN', 'gerdau s a': 'GGBR',
  'vale s a': 'VALE', 'pdg realt': 'PDGR', 'oi': 'OIBR', 'embraer s a': 'EMBR', 'b3 s a': 'B3SA',
};

/**
 * Names whose ticker depends on the note's date (the same nome de pregão was reused by another listing).
 * Natura &Co Holding (NTCO3) was merged into Natura Cosméticos (NATU3) on 2025-07-02.
 */
export const B3_DATED_ROOTS: Record<string, { from: string; root: string }[]> = {
  natura: [{ from: '0000-00-00', root: 'NTCO' }, { from: '2025-07-02', root: 'NATU' }],
};

/** ETFs (class CI) by nome de pregão → ticker. */
export const B3_ETF_PREGAO: Record<string, string> = {
  'ishares bova': 'BOVA11', 'ishares smal': 'SMAL11', 'ishare sp500': 'IVVB11', 'ishares sp500': 'IVVB11', 'ishares brax': 'BRAX11',
  'ishares ecoo': 'ECOO11', 'it now ibov': 'BOVV11', 'it now idiv': 'DIVO11', 'it now pibb': 'PIBB11', 'it now spxi': 'SPXI11', 'it now ifnc': 'FIND11', 'hashdex nci': 'HASH11', 'trend ouro': 'GOLD11',
};

/** Real estate funds (class CI) by nome de pregão → ticker (most SINACOR notes print the ticker itself). */
export const B3_FII_PREGAO: Record<string, string> = {
  'fii maxi ren': 'MXRF11', 'fii kinea ri': 'KNCR11', 'fii xp log': 'XPLG11', 'fii xp malls': 'XPML11', 'fii cshg log': 'HGLG11',
  'fii vinci sc': 'VISC11', 'fii kinea ip': 'KNIP11', 'fii btlg': 'BTLG11', 'fii hglg': 'HGLG11', 'fii mxrf': 'MXRF11',
  'fii knri': 'KNRI11', 'fii knip': 'KNIP11', 'fii kncr': 'KNCR11', 'fii xplg': 'XPLG11', 'fii xpml': 'XPML11', 'fii visc': 'VISC11',
  'fii hgre': 'HGRE11', 'fii hgbs': 'HGBS11', 'fii hgru': 'HGRU11', 'fii irdm': 'IRDM11', 'fii bcff': 'BCFF11', 'fii rbrf': 'RBRF11',
  'fii hfof': 'HFOF11', 'fii bpff': 'BPFF11', 'fii rbrr': 'RBRR11', 'fii recr': 'RECR11', 'fii cpts': 'CPTS11', 'fii vghf': 'VGHF11',
  'fii trxf': 'TRXF11', 'fii brco': 'BRCO11', 'fii vilg': 'VILG11', 'fii alzr': 'ALZR11', 'fii pvbi': 'PVBI11', 'fii jsre': 'JSRE11',
  'fii gare': 'GARE11', 'fii knsc': 'KNSC11', 'fii mcci': 'MCCI11', 'fii hsml': 'HSML11',
};

/** BDRs (class DRN / DR1-3) by nome de pregão → ticker (BDR codes do not follow the issuer's US ticker). */
export const B3_BDR_PREGAO: Record<string, string> = {
  apple: 'AAPL34', amazon: 'AMZO34', microsoft: 'MSFT34', tesla: 'TSLA34', 'tesla inc': 'TSLA34', nvidia: 'NVDC34',
  'nvidia corp': 'NVDC34', netflix: 'NFLX34', 'coca cola': 'COCA34', walmart: 'WALM34', 'walt disney': 'DISB34', disney: 'DISB34',
  mercadolibre: 'MELI34', 'visa inc': 'VISA34', jpmorgan: 'JPMC34', mcdonalds: 'MCDC34', pfizer: 'PFIZ34', nike: 'NIKE34',
  berkshire: 'BERK34', johnson: 'JNJB34', intel: 'ITLC34', 'meta platfor': 'M1TA34', 'meta platforms': 'M1TA34', mastercard: 'MSCD34',
  'bank america': 'BOAC34', 'goldman sachs': 'GSGI34', citigroup: 'CTGP34', 'exxon mobil': 'EXXO34', chevron: 'CHVX34',
  'procter gamble': 'PGCO34', oracle: 'ORCL34', paypal: 'PYPL34', starbucks: 'SBUB34', boeing: 'BOEI34', pepsico: 'PEPB34',
  'home depot': 'HOME34', ibm: 'IBMB34', cisco: 'CSCO34', qualcomm: 'QCOM34', broadcom: 'AVGO34', 'advanced mic': 'A1MD34',
  uber: 'U1BE34', airbnb: 'AIRB34', abbvie: 'ABBV34', unitedhealth: 'UNHH34', 'nu holdings': 'ROXO34', 'xp inc': 'XPBR31',
  'inter co': 'INBR32', pagseguro: 'PAGS34', alibaba: 'BABA34',
};

/**
 * BDR names with several share classes listed in Brazil: the letter after DRN decides, and without
 * a certain letter → ask. (Alphabet: GOGL34 and GOGL35.)
 */
export const B3_BDR_MULTICLASS: Record<string, string[]> = {
  alphabet: ['GOGL34', 'GOGL35'],
};

export const CLASS_DIGIT: Record<string, string> = { ON: '3', PN: '4', PNA: '5', PNB: '6', PNC: '7', UNT: '11', UNIT: '11', CI: '11' };
export const BDR_CLASSES = new Set(['DRN', 'DR1', 'DR2', 'DR3', 'DRE']);

/**
 * Tokens that may follow the class in a specification without changing the security: governance
 * levels (N1, N2, NM, MA, MB, M2), "ex" markers (EJ ex-juros, ED ex-dividendo, EDJ, ER ex-rendimento,
 * EB ex-bonificação, ES ex-subscrição, EG ex-grupamento, EC ex-direito, EX), "ATZ", "REC", and a
 * redemption "R" mark.
 */
export const SPEC_MARKS = new Set([
  'N1', 'N2', 'NM', 'MA', 'MB', 'M2', 'EJ', 'ED', 'EDJ', 'EDR', 'ER', 'EB', 'ES', 'EG', 'EC', 'EX', 'EJB', 'EBR', 'ATZ', 'BDR', 'INT',
]);

/** Lowercase name without accents, punctuation turned into spaces ("AMBEV S/A" → "ambev s a"). */
export function normName(s: string): string {
  return normalizeText(s.replace(/[./&\-']/g, ' '));
}

// ---------------------------------------------------------------------------------------------
// Fuzzy suggestions

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let diag = prev[0]!;
    prev[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = prev[j]!;
      prev[j] = Math.min(prev[j]! + 1, prev[j - 1]! + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1));
      diag = tmp;
    }
  }
  return prev[b.length]!;
}

/** 0..1 similarity of two normalized names (shared words, prefixes, and edit distance). */
export function nameSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const ta = a.split(' ').filter(Boolean);
  const tb = b.split(' ').filter(Boolean);
  let shared = 0;
  for (const x of ta) {
    if (tb.some((y) => y === x || (x.length >= 3 && y.length >= 3 && (y.startsWith(x) || x.startsWith(y))))) shared++;
  }
  const tokenScore = shared / Math.max(ta.length, tb.length);
  const ca = a.replace(/ /g, '');
  const cb = b.replace(/ /g, '');
  const charScore = 1 - levenshtein(ca, cb) / Math.max(ca.length, cb.length);
  // One name containing the other ("isa energia" in "isa energia brasil").
  const contains = ca.length >= 4 && cb.length >= 4 && (ca.includes(cb) || cb.includes(ca)) ? 0.75 : 0;
  return Math.max(tokenScore, charScore * 0.9, contains);
}

export interface NameCandidate {
  name: string;
  ticker: string;
  score: number;
}

/**
 * Best candidates for an unknown name (already normalized, without class tokens). `digit` is the class
 * digit for share tables; `extra` adds catalog names (e.g. @pm/market-data instruments "Petrobras PN").
 */
export function suggestB3Names(name: string, opts: { digit?: string; kind?: 'share' | 'ci' | 'bdr'; extra?: { name: string; ticker: string }[] } = {}): NameCandidate[] {
  const out: NameCandidate[] = [];
  const add = (n: string, ticker: string) => {
    const score = nameSimilarity(name, n);
    if (score >= 0.5) out.push({ name: n, ticker, score });
  };
  const kind = opts.kind;
  if (!kind || kind === 'share') {
    for (const [n, root] of Object.entries(B3_PREGAO_ROOTS)) add(n, opts.digit ? `${root}${opts.digit}` : root);
  }
  if (!kind || kind === 'ci') for (const [n, t] of Object.entries({ ...B3_ETF_PREGAO, ...B3_FII_PREGAO })) add(n, t);
  if (!kind || kind === 'bdr') {
    for (const [n, t] of Object.entries(B3_BDR_PREGAO)) add(n, t);
    for (const [n, ts] of Object.entries(B3_BDR_MULTICLASS)) for (const t of ts) add(n, t);
  }
  for (const e of opts.extra ?? []) add(e.name, e.ticker);
  out.sort((a, b) => b.score - a.score || a.ticker.localeCompare(b.ticker));
  const seen = new Set<string>();
  return out.filter((c) => (seen.has(c.ticker) ? false : (seen.add(c.ticker), true)));
}
