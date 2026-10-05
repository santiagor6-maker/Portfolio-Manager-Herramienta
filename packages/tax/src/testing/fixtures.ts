import type { Instrument, Transaction } from '@pm/core';

let seq = 0;

/** Transaction builder for tests. */
export function tx(p: Omit<Transaction, 'id' | 'portfolioId'> & { id?: string }): Transaction {
  return { id: p.id ?? `t${++seq}`, portfolioId: 'p1', ...p };
}

const inst = (
  id: string,
  assetClass: Instrument['assetClass'],
  country: string,
  currency: string,
  name = id,
): Instrument => {
  const [exchange, symbol] = id.split(':') as [string, string];
  return { id, symbol, name, exchange, currency, country, assetClass };
};

export const I = {
  PETR4: inst('BVMF:PETR4', 'equity', 'BR', 'BRL', 'Petrobras PN'),
  VALE3: inst('BVMF:VALE3', 'equity', 'BR', 'BRL', 'Vale ON'),
  ITSA4: inst('BVMF:ITSA4', 'equity', 'BR', 'BRL', 'Itaúsa PN'),
  BOVA11: inst('BVMF:BOVA11', 'etf', 'BR', 'BRL', 'iShares Ibovespa'),
  HGLG11: inst('BVMF:HGLG11', 'reit', 'BR', 'BRL', 'CSHG Logística FII'),
  AAPL34: inst('BVMF:AAPL34', 'equity', 'US', 'BRL', 'Apple BDR'),
  AAPL: inst('XNAS:AAPL', 'equity', 'US', 'USD', 'Apple Inc.'),
  VOO: inst('ARCX:VOO', 'etf', 'US', 'USD', 'Vanguard S&P 500 ETF'),
  ECOPETROL: inst('XBOG:ECOPETROL', 'equity', 'CO', 'COP', 'Ecopetrol'),
  PFBCOLOM: inst('XBOG:PFBCOLOM', 'equity', 'CO', 'COP', 'Bancolombia Pref'),
  SAN: inst('XMAD:SAN', 'equity', 'ES', 'EUR', 'Banco Santander'),
};

export const ALL_INSTRUMENTS = Object.values(I);
