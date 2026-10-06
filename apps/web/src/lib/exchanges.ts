/** Human exchange names for MIC codes (what investors recognise: BVC, B3, NASDAQ...). */
export const EXCHANGE_LABELS: Record<string, string> = {
  XBOG: 'BVC',
  BVMF: 'B3',
  XNYS: 'NYSE',
  XNAS: 'NASDAQ',
  ARCX: 'NYSE Arca',
  BATS: 'Cboe',
  XMEX: 'BMV',
  XSGO: 'Bolsa de Santiago',
  XLIM: 'BVL',
  XMAD: 'BME',
  XETR: 'Xetra',
  XFRA: 'Fráncfort',
  XPAR: 'Euronext París',
  XAMS: 'Euronext Ámsterdam',
  XBRU: 'Euronext Bruselas',
  XLIS: 'Euronext Lisboa',
  XMIL: 'Borsa Italiana',
  XLON: 'LSE',
  XSWX: 'SIX',
  OTC: 'OTC',
  MANUAL: 'Manual',
  INDEX: 'Índice',
  TEMPLATE: 'Plantilla',
  CRYPTO: 'Cripto',
};

export function exchangeLabel(code: string | undefined): string {
  if (!code) return '—';
  return EXCHANGE_LABELS[code] ?? code;
}

/** Exchanges offered when creating a manual instrument. */
export const MANUAL_EXCHANGES = ['MANUAL', 'OTC', 'XBOG', 'BVMF', 'XNYS', 'XNAS', 'XMAD', 'XETR', 'XPAR', 'XAMS', 'XLON', 'XMEX', 'XSGO', 'XLIM'];
