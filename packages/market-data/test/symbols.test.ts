import { describe, expect, it } from 'vitest';
import {
  assetClassFromYahoo,
  instrumentIdFromYahoo,
  looksLikeInstrumentId,
  normalizeCurrency,
  parseYahooSymbol,
  yahooFxSymbol,
  yahooSymbolFromId,
} from '../src/index';

describe('Yahoo symbol <-> instrument id mapping', () => {
  it.each([
    ['ECOPETROL.CL', undefined, 'XBOG:ECOPETROL', 'COP', 'CO'],
    ['PFCIBEST.CL', 'BVC', 'XBOG:PFCIBEST', 'COP', 'CO'],
    ['PETR4.SA', 'SAO', 'BVMF:PETR4', 'BRL', 'BR'],
    ['HGLG11.SA', undefined, 'BVMF:HGLG11', 'BRL', 'BR'],
    ['IBE.MC', 'MCE', 'XMAD:IBE', 'EUR', 'ES'],
    ['SAP.DE', 'GER', 'XETR:SAP', 'EUR', 'DE'],
    ['MC.PA', 'PAR', 'XPAR:MC', 'EUR', 'FR'],
    ['ASML.AS', 'AMS', 'XAMS:ASML', 'EUR', 'NL'],
    ['ENEL.MI', 'MIL', 'XMIL:ENEL', 'EUR', 'IT'],
    ['VOD.L', 'LSE', 'XLON:VOD', 'GBP', 'GB'],
    ['NESN.SW', 'EBS', 'XSWX:NESN', 'CHF', 'CH'],
    ['WALMEX.MX', 'MEX', 'XMEX:WALMEX', 'MXN', 'MX'],
    ['SQM-B.SN', 'SGO', 'XSGO:SQM-B', 'CLP', 'CL'],
    ['ALICORC1.LM', undefined, 'XLIM:ALICORC1', 'PEN', 'PE'],
    ['ECHA.MU', 'MUN', 'XMUN:ECHA', 'EUR', 'DE'],
  ])('%s -> %s', (yahoo, exch, id, currency, country) => {
    expect(instrumentIdFromYahoo(yahoo, exch)).toBe(id);
    const p = parseYahooSymbol(yahoo, exch);
    expect(p.currency).toBe(currency);
    expect(p.country).toBe(country);
  });

  it('maps US listings by Yahoo exchange code (no suffix)', () => {
    expect(instrumentIdFromYahoo('AAPL', 'NMS')).toBe('XNAS:AAPL');
    expect(instrumentIdFromYahoo('QQQ', 'NGM')).toBe('XNAS:QQQ');
    expect(instrumentIdFromYahoo('VOO', 'PCX')).toBe('ARCX:VOO');
    expect(instrumentIdFromYahoo('EC', 'NYQ')).toBe('XNYS:EC');
    expect(instrumentIdFromYahoo('IBDRY', 'PNK')).toBe('OTC:IBDRY');
    expect(instrumentIdFromYahoo('BRK-B', 'NYQ')).toBe('XNYS:BRK-B');
    // unknown exchange: defaults to NYSE, currency USD
    expect(parseYahooSymbol('XYZ').currency).toBe('USD');
  });

  it('maps indices, FX and crypto', () => {
    expect(instrumentIdFromYahoo('^GSPC')).toBe('INDEX:^GSPC');
    expect(instrumentIdFromYahoo('COP=X')).toBe('FX:USDCOP');
    expect(instrumentIdFromYahoo('EURUSD=X')).toBe('FX:EURUSD');
    expect(parseYahooSymbol('BTC-USD', 'CCC').kind).toBe('crypto');
  });

  it('builds Yahoo symbols from ids (round trip)', () => {
    for (const y of ['ECOPETROL.CL', 'PETR4.SA', 'IBE.MC', 'SAP.DE', 'VOD.L', 'NESN.SW', 'WALMEX.MX', 'SQM-B.SN', 'MC.PA', 'ASML.AS', 'ENEL.MI']) {
      expect(yahooSymbolFromId(instrumentIdFromYahoo(y))).toBe(y);
    }
    expect(yahooSymbolFromId('XNAS:AAPL')).toBe('AAPL');
    expect(yahooSymbolFromId('XNYS:BRK.B')).toBe('BRK-B');
    expect(yahooSymbolFromId('INDEX:^BVSP')).toBe('^BVSP');
    expect(yahooSymbolFromId('INDEX:GSPC')).toBe('^GSPC');
    expect(yahooSymbolFromId('FX:USDCOP')).toBe('USDCOP=X');
    expect(yahooSymbolFromId('XBOG:ecopetrol')).toBe('ECOPETROL.CL');
    expect(yahooSymbolFromId('ZZZZ:FOO')).toBeUndefined();
    expect(yahooSymbolFromId('nocolon')).toBeUndefined();
  });

  it('FX symbols', () => {
    expect(yahooFxSymbol('USD', 'COP')).toBe('COP=X');
    expect(yahooFxSymbol('EUR', 'USD')).toBe('EURUSD=X');
    expect(yahooFxSymbol('BRL', 'COP')).toBe('BRLCOP=X');
  });

  it('distinguishes ids from provider symbols', () => {
    expect(looksLikeInstrumentId('BVMF:PETR4')).toBe(true);
    expect(looksLikeInstrumentId('PETR4.SA')).toBe(false);
    expect(looksLikeInstrumentId('^GSPC')).toBe(false);
  });
});

describe('currencies quoted in minor units', () => {
  it('GBp (pence) -> GBP / 100', () => {
    expect(normalizeCurrency('GBp')).toEqual({ currency: 'GBP', divisor: 100 });
    expect(normalizeCurrency('GBX')).toEqual({ currency: 'GBP', divisor: 100 });
    expect(normalizeCurrency('ZAc')).toEqual({ currency: 'ZAR', divisor: 100 });
    expect(normalizeCurrency('ILA')).toEqual({ currency: 'ILS', divisor: 100 });
  });
  it('GBP (pounds, e.g. VWRL.L) and others unchanged', () => {
    expect(normalizeCurrency('GBP')).toEqual({ currency: 'GBP', divisor: 1 });
    expect(normalizeCurrency('USD')).toEqual({ currency: 'USD', divisor: 1 });
    expect(normalizeCurrency(null)).toBeUndefined();
  });
});

describe('asset class inference', () => {
  it('uses Yahoo quoteType', () => {
    expect(assetClassFromYahoo('ETF', 'VOO')).toBe('etf');
    expect(assetClassFromYahoo('EQUITY', 'AAPL')).toBe('equity');
    expect(assetClassFromYahoo('MUTUALFUND', 'VFIAX')).toBe('fund');
    expect(assetClassFromYahoo('CRYPTOCURRENCY', 'BTC-USD')).toBe('crypto');
    expect(assetClassFromYahoo('INDEX', '^GSPC')).toBe('other');
  });
  it('detects B3 FIIs and ETFs that Yahoo reports as EQUITY', () => {
    expect(assetClassFromYahoo('EQUITY', 'HGLG11.SA', 'Cshg Logistica - Fundo De Investimento Imobiliario')).toBe('reit');
    expect(assetClassFromYahoo('EQUITY', 'MXRF11.SA', 'Maxi Renda Fundo De Investimento Imobiliaro - FII')).toBe('reit');
    expect(assetClassFromYahoo('EQUITY', 'BOVA11.SA', 'ISHARES IBOVESPA CLASSE DE ÍNDICE - RESPONSABILIDADE LIMITADA')).toBe('etf');
    expect(assetClassFromYahoo('EQUITY', 'TAEE11.SA', 'Transmissora Aliança de Energia Elétrica S.A.')).toBe('equity');
    // MULT3 has "Imobiliários" in the name but is not a fund (no 11 suffix)
    expect(assetClassFromYahoo('EQUITY', 'MULT3.SA', 'Multiplan Empreendimentos Imobiliários S.A.')).toBe('equity');
  });
});
