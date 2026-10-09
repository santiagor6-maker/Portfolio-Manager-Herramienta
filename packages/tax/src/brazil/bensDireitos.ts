import type { CountryCode, CurrencyCode } from '@pm/core';
import { b3Root, type TransferBasisMap } from '../common/basis';
import { TAX_DISCLAIMER } from '../common/disclaimer';
import type { LocalizedText, ParamMeta, TaxInput, TaxIssue } from '../common/types';
import { instrumentMap, sum } from '../common/util';
import { cryptoInTransitAt, routeCryptoByCustody, type BrCategory, type CryptoCustody, type CryptoTransitPiece } from './classify';
import { B3_CNPJ, BENS_E_DIREITOS_CODES } from './config';
import { brazilCryptoReport } from './crypto';
import { brazilForeignAnnualReport, type PtaxProvider } from './exterior';
import { runBrazilB3Ledger, type BrPosition } from './ledger';
import { brazilRendaFixaReport } from './rendaFixa';

export interface BensDireitosItem {
  grupo: string;
  codigo: string;
  codigoDescricao: string;
  /** 'Brasil' or ISO country of the asset location. */
  localizacao: string;
  /** CNPJ of the issuer/fund when known (built-in table or `cnpjByIssuer`), else blank for the user. */
  cnpj: string;
  cnpjFonte?: 'tabela' | 'usuario';
  instrumentId?: string;
  ticker?: string;
  discriminacao: string;
  quantidade?: number;
  /** "Situação em 31/12" of the previous and current year, at acquisition cost in BRL. */
  situacaoAnterior: number;
  situacaoAtual: number;
  /** Crypto units in transit between custodies at 31/12 (T55). */
  emTransito?: boolean;
  /** Foreign assets (DIRPF 2025+, Lei 14.754): result of the year per asset. */
  exterior?: {
    lucroPrejuizoBrl: number;
    rendimentosBrl: number;
    impostoPagoExteriorBrl: number;
  };
  codeMeta: ParamMeta;
}

export interface BensDireitosReport {
  year: number;
  disclaimer: LocalizedText;
  items: BensDireitosItem[];
  totalAnterior: number;
  totalAtual: number;
  notes: string[];
  issues: TaxIssue[];
}

export interface BensDireitosOptions {
  year: number;
  ptax?: PtaxProvider;
  categoryOverrides?: Record<string, BrCategory>;
  transferBasis?: TransferBasisMap;
  /** Broker name, appended to the description. */
  brokerLabel?: string;
  /** CNPJ by B3 root ticker (e.g. { TAEE: '07.859.971/0001-30' }) or by instrument id. */
  cnpjByIssuer?: Record<string, string>;
  /** Country where foreign cash is held, per currency. Default USD -> US. */
  foreignCashCountry?: Record<CurrencyCode, CountryCode>;
  /** Fixed-income instruments that are exempt (LCI/LCA...). */
  rendaFixaExemptIds?: string[];
  /** Crypto custody per instrument id. */
  cryptoCustody?: Record<string, CryptoCustody>;
  /** Crypto custody per account/broker name. */
  accountCustody?: Record<string, CryptoCustody>;
  /** Apply free-text transfer-cost hints. */
  acceptNoteProposals?: boolean;
  /** Confirmed crypto pairings TRANSFER_IN id -> TRANSFER_OUT id (T58). */
  confirmedTransfers?: Record<string, string>;
  /** Max days between OUT and IN for automatic crypto pairing (default 90, T58). */
  transferMaxLateDays?: number;
}

const fmt = (n: number) => n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 8 });
const fmt2 = (n: number) => n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const STABLE = /^(USDT|USDC|DAI|BUSD|TUSD|FDUSD|PYUSD|BRZ)$/i;

/**
 * DIRPF "Bens e Direitos" helper at acquisition cost — never at market value: B3 positions
 * (preço médio), fixed income, crypto, and foreign positions/cash (BRL cost under Lei 14.754/2023,
 * with the per-asset result of the year).
 */
export function brazilBensDireitos(input: TaxInput, opts: BensDireitosOptions): BensDireitosReport {
  const { year } = opts;
  const instruments = instrumentMap(input.instruments);
  const issues: TaxIssue[] = [];
  const lo = { categoryOverrides: opts.categoryOverrides, transferBasis: opts.transferBasis, acceptNoteProposals: opts.acceptNoteProposals };
  const cur = runBrazilB3Ledger(input, { until: `${year}-12-31`, ...lo });
  const prev = runBrazilB3Ledger(input, { until: `${year - 1}-12-31`, ...lo });
  issues.push(...cur.issues);
  if (cur.openShorts.length) {
    issues.push({
      level: 'warning',
      code: 'SHORT_NOT_IN_BENS',
      message: 'Posições vendidas a descoberto em aberto não são bens: confira se falta registrar compras antes de declarar.',
    });
  }
  const prevMap = new Map(prev.positions.map((p) => [p.instrumentId, p]));
  const curMap = new Map(cur.positions.map((p) => [p.instrumentId, p]));
  const ids = new Set([...curMap.keys(), ...prevMap.keys()]);
  const items: BensDireitosItem[] = [];

  const cnpjOf = (id: string, symbol: string): { cnpj: string; fonte?: 'tabela' | 'usuario' } => {
    const root = b3Root(symbol);
    const user = opts.cnpjByIssuer?.[id] ?? opts.cnpjByIssuer?.[root];
    if (user) return { cnpj: user, fonte: 'usuario' };
    const t = B3_CNPJ[root];
    return t ? { cnpj: t.cnpj, fonte: 'tabela' } : { cnpj: '' };
  };

  const codeFor = (c: BrCategory) =>
    c === 'FII'
      ? BENS_E_DIREITOS_CODES.FII
      : c === 'ETF'
        ? BENS_E_DIREITOS_CODES.ETF
        : c === 'ETF_RF'
          ? BENS_E_DIREITOS_CODES.ETF_RF
          : c === 'BDR'
            ? BENS_E_DIREITOS_CODES.BDR
            : c === 'OPCAO'
              ? BENS_E_DIREITOS_CODES.OPCAO
              : c === 'DIREITO'
                ? BENS_E_DIREITOS_CODES.DIREITO
                : BENS_E_DIREITOS_CODES.ACAO;
  const noun = (c: BrCategory) =>
    c === 'FII' ? 'cotas' : c === 'ETF' || c === 'ETF_RF' ? 'cotas do ETF' : c === 'BDR' ? 'BDRs' : c === 'OPCAO' ? 'opções' : c === 'DIREITO' ? 'direitos' : 'ações';

  for (const id of ids) {
    const c = curMap.get(id);
    const p = prevMap.get(id);
    const ref = (c ?? p) as BrPosition;
    if (ref.category === 'FUTURO') continue; // futures are not assets (only daily adjustments)
    const code = codeFor(ref.category);
    const inst = instruments.get(id);
    const cn = ref.category === 'ACAO' || ref.category === 'DIREITO' ? cnpjOf(id, ref.symbol) : { cnpj: opts.cnpjByIssuer?.[id] ?? '' };
    const desc = c
      ? `${fmt(c.quantity)} ${noun(ref.category)} ${ref.symbol}${inst?.name ? ` (${inst.name})` : ''}, preço médio R$ ${fmt2(c.averageCost)}${opts.brokerLabel ? `, custodiadas na ${opts.brokerLabel}` : ''}.`
      : `${ref.symbol}${inst?.name ? ` (${inst.name})` : ''}: posição totalmente vendida em ${year}.`;
    items.push({
      grupo: code.grupo,
      codigo: code.codigo,
      codigoDescricao: code.descricao,
      localizacao: 'Brasil',
      cnpj: cn.cnpj,
      cnpjFonte: 'fonte' in cn ? cn.fonte : cn.cnpj ? 'usuario' : undefined,
      instrumentId: id,
      ticker: ref.symbol,
      discriminacao: desc,
      quantidade: c?.quantity ?? 0,
      situacaoAnterior: p?.totalCost ?? 0,
      situacaoAtual: c?.totalCost ?? 0,
      codeMeta: code.meta,
    });
  }
  if (items.some((i) => i.cnpjFonte === 'tabela')) {
    issues.push({
      level: 'info',
      code: 'CNPJ_FROM_TABLE',
      message: 'CNPJ preenchido a partir da tabela interna para algumas empresas: confira com o informe de rendimentos da corretora.',
    });
  }

  // Fixed income
  const rf = brazilRendaFixaReport(input, { year, categoryOverrides: opts.categoryOverrides, exemptIds: opts.rendaFixaExemptIds });
  issues.push(...rf.issues.filter((i) => i.level === 'error'));
  const rfPrev = new Map(rf.positionsPrevYear.map((p) => [p.instrumentId, p]));
  const rfCur = new Map(rf.positions.map((p) => [p.instrumentId, p]));
  for (const id of new Set([...rfCur.keys(), ...rfPrev.keys()])) {
    const c = rfCur.get(id);
    const p = rfPrev.get(id);
    const ref = (c ?? p)!;
    const code = ref.exempt ? BENS_E_DIREITOS_CODES.RENDA_FIXA_ISENTA : BENS_E_DIREITOS_CODES.RENDA_FIXA_TRIBUTAVEL;
    items.push({
      grupo: code.grupo,
      codigo: code.codigo,
      codigoDescricao: code.descricao,
      localizacao: 'Brasil',
      cnpj: opts.cnpjByIssuer?.[id] ?? '',
      instrumentId: id,
      discriminacao: c ? `${ref.name}: valor aplicado.` : `${ref.name}: resgatado em ${year}.`,
      quantidade: c?.quantity ?? 0,
      situacaoAnterior: p?.cost ?? 0,
      situacaoAtual: c?.cost ?? 0,
      codeMeta: code.meta,
    });
  }

  // Crypto
  const cx = {
    cryptoCustody: opts.cryptoCustody,
    accountCustody: opts.accountCustody,
    transferBasis: opts.transferBasis,
    acceptNoteProposals: opts.acceptNoteProposals,
    confirmedTransfers: opts.confirmedTransfers,
    transferMaxLateDays: opts.transferMaxLateDays,
  };
  const cryptoRouting = routeCryptoByCustody(input, cx);
  const cr = brazilCryptoReport(input, { year, categoryOverrides: opts.categoryOverrides, ...cx });
  const crPrev = new Map(cr.positionsPrevYear.map((p) => [p.instrumentId, p]));
  const crCur = new Map(cr.positions.map((p) => [p.instrumentId, p]));
  for (const id of new Set([...crCur.keys(), ...crPrev.keys()])) {
    const c = crCur.get(id);
    const p = crPrev.get(id);
    const ref = (c ?? p)!;
    const code = /^BTC$/i.test(ref.symbol)
      ? BENS_E_DIREITOS_CODES.CRYPTO_BTC
      : STABLE.test(ref.symbol)
        ? BENS_E_DIREITOS_CODES.CRYPTO_STABLE
        : BENS_E_DIREITOS_CODES.CRYPTO_ALT;
    const custodyHere = cryptoRouting.custody[id] ?? 'desconhecida';
    if (custodyHere !== 'brasil') {
      issues.push({
        level: 'warning',
        code: 'CRYPTO_LOCATION_UNKNOWN',
        instrumentId: id,
        message: `Custódia de ${ref.symbol} não confirmada (carteira própria ou conta não reconhecida): informe o país/local em Bens e Direitos.`,
      });
    }
    items.push({
      grupo: code.grupo,
      codigo: code.codigo,
      codigoDescricao: code.descricao,
      localizacao: custodyHere === 'brasil' ? 'Brasil' : '',
      cnpj: '',
      instrumentId: id,
      ticker: ref.symbol,
      discriminacao: c
        ? `${fmt(c.quantity)} ${ref.symbol}${custodyHere === 'brasil' ? '' : ' (custódia não confirmada)'}, custo médio de aquisição.`
        : `${ref.symbol}: alienado em ${year}.`,
      quantidade: c?.quantity ?? 0,
      situacaoAnterior: p?.costBrl ?? 0,
      situacaoAtual: c?.costBrl ?? 0,
      codeMeta: code.meta,
    });
  }

  // Foreign
  const foreign = brazilForeignAnnualReport(input, {
    year,
    ptax: opts.ptax,
    categoryOverrides: opts.categoryOverrides,
    transferBasis: opts.transferBasis,
    cryptoCustody: opts.cryptoCustody,
    accountCustody: opts.accountCustody,
    acceptNoteProposals: opts.acceptNoteProposals,
    confirmedTransfers: opts.confirmedTransfers,
    transferMaxLateDays: opts.transferMaxLateDays,
  });
  issues.push(...foreign.issues.filter((i) => i.code !== 'PRE_LEI_14754'));
  const fPrev = new Map(foreign.positionsPrevYear.map((p) => [p.instrumentId, p]));
  const fCur = new Map(foreign.positions.map((p) => [p.instrumentId, p]));
  const soldIds = new Set(foreign.sales.map((s) => s.instrumentId));
  for (const id of new Set([...fCur.keys(), ...fPrev.keys(), ...soldIds])) {
    const c = fCur.get(id);
    const p = fPrev.get(id);
    const inst = instruments.get(id);
    const symbol = c?.symbol ?? p?.symbol ?? inst?.symbol ?? id;
    const assetClass = c?.assetClass ?? p?.assetClass ?? inst?.assetClass;
    const isFund = assetClass === 'etf' || assetClass === 'fund' || assetClass === 'reit';
    const isCrypto = assetClass === 'crypto';
    const code = isCrypto
      ? /^BTC$/i.test(symbol)
        ? BENS_E_DIREITOS_CODES.CRYPTO_BTC
        : STABLE.test(symbol)
          ? BENS_E_DIREITOS_CODES.CRYPTO_STABLE
          : BENS_E_DIREITOS_CODES.CRYPTO_ALT
      : isFund
        ? BENS_E_DIREITOS_CODES.FOREIGN_FUND
        : BENS_E_DIREITOS_CODES.FOREIGN_STOCK;
    const sales = foreign.sales.filter((s) => s.instrumentId === id);
    const loc = c?.country ?? p?.country ?? inst?.country ?? '';
    if (isCrypto && !loc) {
      issues.push({
        level: 'warning',
        code: 'CRYPTO_LOCATION_UNKNOWN',
        instrumentId: id,
        message: `Informe o país da exchange/custodiante de ${symbol} (Bens e Direitos): a exchange tem várias entidades ou não foi reconhecida.`,
      });
    }
    const income = foreign.income.filter((i) => i.instrumentId === id);
    items.push({
      grupo: code.grupo,
      codigo: code.codigo,
      codigoDescricao: code.descricao,
      localizacao: loc,
      cnpj: '',
      instrumentId: id,
      ticker: symbol,
      discriminacao: c
        ? `${fmt(c.quantity)} ${isCrypto ? 'unidades de' : isFund ? 'cotas' : 'ações'} ${symbol}${c.name ? ` (${c.name})` : ''}, custo ${c.currency} ${fmt2(c.costFx)} convertido pela PTAX de compra das datas de aquisição${opts.brokerLabel ? `, custodiadas na ${opts.brokerLabel}` : ''}.`
        : `${symbol}: posição totalmente vendida em ${year}.`,
      quantidade: c?.quantity ?? 0,
      situacaoAnterior: p?.costBrl ?? 0,
      situacaoAtual: c?.costBrl ?? 0,
      exterior: {
        lucroPrejuizoBrl: sum(sales.map((s) => s.gainBrl)),
        rendimentosBrl: sum(income.map((i) => i.grossBrl)),
        impostoPagoExteriorBrl: sum(income.map((i) => i.foreignTaxBrl)),
      },
      codeMeta: code.meta,
    });
  }

  // T55: crypto units in transit at 31/12 (left a custody, arrival recorded only later) are still owned.
  const routing = cryptoRouting;
  const transitAt = (d: string) => {
    const m = new Map<string, { units: number; brl: number; piece: CryptoTransitPiece }>();
    for (const x of cryptoInTransitAt(routing, d)) {
      const k = `${x.piece.instrumentId}|${x.piece.bucket}`;
      const cur = m.get(k);
      m.set(k, { units: (cur?.units ?? 0) + x.units, brl: (cur?.brl ?? 0) + x.brl, piece: cur?.piece ?? x.piece });
    }
    return m;
  };
  const tCur = transitAt(`${year}-12-31`);
  const tPrev = transitAt(`${year - 1}-12-31`);
  for (const k of new Set([...tCur.keys(), ...tPrev.keys()])) {
    const c = tCur.get(k);
    const p = tPrev.get(k);
    const piece = (c ?? p)!.piece;
    const code = /^BTC/i.test(piece.symbol)
      ? BENS_E_DIREITOS_CODES.CRYPTO_BTC
      : STABLE.test(piece.symbol)
        ? BENS_E_DIREITOS_CODES.CRYPTO_STABLE
        : BENS_E_DIREITOS_CODES.CRYPTO_ALT;
    const loc = piece.bucket === 'brasil' ? 'Brasil' : piece.country;
    if (!loc) {
      issues.push({
        level: 'warning',
        code: 'CRYPTO_LOCATION_UNKNOWN',
        instrumentId: piece.instrumentId,
        message: `Informe o país da custódia de origem de ${piece.symbol} em trânsito (Bens e Direitos).`,
      });
    }
    items.push({
      grupo: code.grupo,
      codigo: code.codigo,
      codigoDescricao: code.descricao,
      localizacao: loc,
      cnpj: '',
      instrumentId: piece.sourceId,
      ticker: piece.symbol,
      discriminacao: c
        ? `${fmt(c.units)} ${piece.symbol} EM TRÂNSITO em 31/12/${year}: saída da custódia ${piece.bucket} em ${piece.outDate}, entrada no destino registrada depois (ou ainda não registrada). Custo de aquisição.`
        : `${piece.symbol}: em trânsito em 31/12/${year - 1}, recebido no destino em ${year}.`,
      quantidade: c?.units ?? 0,
      situacaoAnterior: p?.brl ?? 0,
      situacaoAtual: c?.brl ?? 0,
      emTransito: true,
      codeMeta: code.meta,
    });
  }

  const cashCountry = { USD: 'US', ...(opts.foreignCashCountry ?? {}) } as Record<string, string>;
  const cashPrev = new Map<CurrencyCode, number>(foreign.cashPrevYear.map((b) => [b.currency, b.cost]));
  const cashCur = new Map<CurrencyCode, { units: number; cost: number }>(foreign.cash.map((b) => [b.currency, b]));
  const brokerInterest = foreign.income.filter((i) => !i.instrumentId);
  for (const ccy of new Set([...cashCur.keys(), ...cashPrev.keys()])) {
    const c = cashCur.get(ccy);
    const code = BENS_E_DIREITOS_CODES.FOREIGN_CASH;
    const loc = cashCountry[ccy] ?? '';
    if (!loc) {
      issues.push({
        level: 'warning',
        code: 'CASH_LOCATION_UNKNOWN',
        message: `Informe o país da conta em ${ccy} no exterior (opção foreignCashCountry) para a ficha Bens e Direitos.`,
      });
    }
    const inc = brokerInterest.filter((i) => i.currency === ccy);
    items.push({
      grupo: code.grupo,
      codigo: code.codigo,
      codigoDescricao: code.descricao,
      localizacao: loc,
      cnpj: '',
      discriminacao: `Saldo de ${ccy} ${fmt2(c?.units ?? 0)} em conta no exterior${opts.brokerLabel ? ` (${opts.brokerLabel})` : ''}, ao custo de aquisição em reais.`,
      situacaoAnterior: cashPrev.get(ccy) ?? 0,
      situacaoAtual: c?.cost ?? 0,
      exterior: {
        lucroPrejuizoBrl: 0,
        rendimentosBrl: sum(inc.map((i) => i.grossBrl)),
        impostoPagoExteriorBrl: sum(inc.map((i) => i.foreignTaxBrl)),
      },
      codeMeta: code.meta,
    });
  }

  return {
    year,
    disclaimer: TAX_DISCLAIMER,
    items,
    totalAnterior: sum(items.map((i) => i.situacaoAnterior)),
    totalAtual: sum(items.map((i) => i.situacaoAtual)),
    notes: [
      'Valores pelo custo de aquisição em reais (não pelo valor de mercado), conforme instruções da DIRPF.',
      'CNPJ: preenchido quando conhecido (tabela interna a conferir ou informado pelo usuário); nos demais casos, consulte o informe da corretora.',
      'Ativos no exterior: informe país, lucro/prejuízo, rendimentos e imposto pago no exterior de cada bem (campos "exterior"), conforme a DIRPF desde 2025 (Lei 14.754/2023).',
      'Saldo em moeda estrangeira: custo em reais efetivamente pago na remessa (IN RFB 2.180/2024).',
    ],
    issues,
  };
}
