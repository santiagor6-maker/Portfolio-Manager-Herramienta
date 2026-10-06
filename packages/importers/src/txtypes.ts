/**
 * Transaction-type vocabulary in Spanish, Portuguese and English (compra/venta/C/V/buy/sell, dividendo,
 * JCP, rendimento, desdobro, bonificación, GMF...). Exact matches first, then ordered keyword rules.
 */
import type { TransactionType } from '@pm/core';
import { normalizeText } from './util';

const EXACT: Record<string, TransactionType> = {
  // buy
  c: 'BUY', compra: 'BUY', compras: 'BUY', comprar: 'BUY', buy: 'BUY', b: 'BUY', bot: 'BUY', bought: 'BUY',
  'market buy': 'BUY', 'limit buy': 'BUY', 'stop buy': 'BUY', 'stop limit buy': 'BUY', aplicacao: 'BUY',
  subscripcion: 'BUY', subscricao: 'BUY', 'compra de acciones': 'BUY', 'compra acciones': 'BUY', 'compra en bolsa': 'BUY',
  'reinvest shares': 'BUY', 'buy to open': 'BUY', 'buy to close': 'BUY',
  // sell
  v: 'SELL', venta: 'SELL', ventas: 'SELL', vender: 'SELL', venda: 'SELL', vendas: 'SELL', sell: 'SELL', s: 'SELL',
  sld: 'SELL', sold: 'SELL', 'market sell': 'SELL', 'limit sell': 'SELL', 'stop sell': 'SELL', 'stop limit sell': 'SELL',
  resgate: 'SELL', 'venta de acciones': 'SELL', 'venta acciones': 'SELL', 'sell to close': 'SELL', 'sell to open': 'SELL',
  vencimento: 'SELL', vencimiento: 'SELL',
  // income
  dividendo: 'DIVIDEND', dividendos: 'DIVIDEND', dividend: 'DIVIDEND', dividends: 'DIVIDEND', div: 'DIVIDEND',
  'cash dividend': 'DIVIDEND', 'qualified dividend': 'DIVIDEND', 'non qualified div': 'DIVIDEND',
  'special dividend': 'DIVIDEND', 'reinvest dividend': 'DIVIDEND', jcp: 'DIVIDEND', jscp: 'DIVIDEND',
  'juros sobre capital proprio': 'DIVIDEND', rendimento: 'DIVIDEND', 'long term cap gain': 'DIVIDEND',
  'short term cap gain': 'DIVIDEND', 'pago de dividendos': 'DIVIDEND', 'abono dividendos': 'DIVIDEND',
  interes: 'INTEREST', intereses: 'INTEREST', interest: 'INTEREST', juros: 'INTEREST', rendimientos: 'INTEREST',
  'credit interest': 'INTEREST', 'bank interest': 'INTEREST', 'bond interest': 'INTEREST', 'interest on cash': 'INTEREST',
  'lending interest': 'INTEREST', 'pagamento de juros': 'INTEREST',
  // cash flows
  'leilao de fracao': 'SELL', 'venta de fracciones': 'SELL',
  deposito: 'DEPOSIT', depositos: 'DEPOSIT', deposit: 'DEPOSIT', aporte: 'DEPOSIT', aportes: 'DEPOSIT',
  consignacion: 'DEPOSIT', ingreso: 'DEPOSIT', 'wire received': 'DEPOSIT', 'funds received': 'DEPOSIT',
  'transferencia recibida': 'DEPOSIT', 'transferencia entrada': 'DEPOSIT', recarga: 'DEPOSIT', abono: 'DEPOSIT',
  retiro: 'WITHDRAWAL', retiros: 'WITHDRAWAL', withdrawal: 'WITHDRAWAL', withdraw: 'WITHDRAWAL', saque: 'WITHDRAWAL',
  retirada: 'WITHDRAWAL', 'wire sent': 'WITHDRAWAL', 'wire funds': 'WITHDRAWAL', 'transferencia enviada': 'WITHDRAWAL',
  'withdraw request': 'WITHDRAWAL', levantamento: 'WITHDRAWAL',
  // costs
  comision: 'FEE', comisiones: 'FEE', fee: 'FEE', fees: 'FEE', tarifa: 'FEE', taxa: 'FEE', custodia: 'FEE',
  'service fee': 'FEE', 'adr mgmt fee': 'FEE', 'cuota de manejo': 'FEE', 'cuota de administracion': 'FEE',
  impuesto: 'TAX', impuestos: 'TAX', tax: 'TAX', imposto: 'TAX', gmf: 'TAX', '4x1000': 'TAX', '4 x 1000': 'TAX',
  iof: 'TAX', irrf: 'TAX', darf: 'TAX', retencion: 'TAX', 'retencion en la fuente': 'TAX', withholding: 'TAX',
  'withholding tax': 'TAX', 'nra tax adj': 'TAX', 'nra withholding': 'TAX', 'foreign tax paid': 'TAX',
  // corporate actions
  split: 'SPLIT', 'stock split': 'SPLIT', desdoblamiento: 'SPLIT', desdobro: 'SPLIT', desdobramento: 'SPLIT',
  grupamento: 'SPLIT', agrupamiento: 'SPLIT', 'reverse split': 'SPLIT', contrasplit: 'SPLIT', 'reverse stock split': 'SPLIT',
  bonificacion: 'STOCK_DIVIDEND', bonificacao: 'STOCK_DIVIDEND', 'bonificacao em ativos': 'STOCK_DIVIDEND',
  'dividendo en acciones': 'STOCK_DIVIDEND', 'stock dividend': 'STOCK_DIVIDEND',
  'transfer in': 'TRANSFER_IN', 'transferencia de entrada': 'TRANSFER_IN', 'entrada de custodia': 'TRANSFER_IN',
  'security transfer in': 'TRANSFER_IN', 'traspaso entrada': 'TRANSFER_IN',
  'transfer out': 'TRANSFER_OUT', 'transferencia de salida': 'TRANSFER_OUT', 'salida de custodia': 'TRANSFER_OUT',
  'traspaso salida': 'TRANSFER_OUT',
  fx: 'FX_CONVERSION', 'currency conversion': 'FX_CONVERSION', 'conversion de divisas': 'FX_CONVERSION',
  cambio: 'FX_CONVERSION', 'cambio de divisas': 'FX_CONVERSION', monetizacion: 'FX_CONVERSION', 'fx conversion': 'FX_CONVERSION',
  'return of capital': 'RETURN_OF_CAPITAL', 'cash in lieu': 'SELL',
  'constitucion cdt': 'BUY', 'apertura cdt': 'BUY', 'redencion cdt': 'SELL', 'cancelacion cdt': 'SELL', 'vencimiento cdt': 'SELL', 'devolucion de capital': 'RETURN_OF_CAPITAL',
  'restitucion de capital': 'RETURN_OF_CAPITAL', 'restituicao de capital': 'RETURN_OF_CAPITAL',
  amortizacao: 'RETURN_OF_CAPITAL', amortizacion: 'RETURN_OF_CAPITAL', 'reducao de capital': 'RETURN_OF_CAPITAL',
};

/**
 * Keyword rules for free-text concepts ("Abono dividendos ECOPETROL", "Retención en la fuente dividendos").
 * The rule whose keyword appears EARLIEST in the text wins ("Dividendo neto de retención" → DIVIDEND,
 * "Retención dividendos" → TAX); ties are broken by list order.
 */
const RULES: [RegExp, TransactionType][] = [
  [/\b(juros sobre capital|jcp|jscp)\b/, 'DIVIDEND'],
  [/\b(dividendo en acciones|dividendo em acoes|stock dividend|bonificacion|bonificacao)\b/, 'STOCK_DIVIDEND'],
  [/\b(constitucion|apertura|aplicacao|subscripcion|suscripcion)\b/, 'BUY'],
  [/\b(redencion|cancelacion|vencimiento|vencimento|resgate|rescate|redemption)\b/, 'SELL'],
  [/\b(retencion|withholding|imposto|impuesto|gmf|4 ?x ?1000|iof|irrf|darf|dividend tax|nra tax|gravamen)\b/, 'TAX'],
  [/\b(split|desdobl|desdobr|grupamento|agrupamiento|contrasplit|reverse split)/, 'SPLIT'],
  [/\b(devolucion de capital|restitucion de capital|return of capital|restituicao|amortiza)/, 'RETURN_OF_CAPITAL'],
  [/\b(comision|comissao|corretagem|fee|fees|tarifa|custodia|cuota de manejo|cargo por|administracion)\b/, 'FEE'],
  [/\b(dividend|dividendo|rendimento|participacion|utilidades)/, 'DIVIDEND'],
  [/\b(interes|interest|juros|rendimientos)/, 'INTEREST'],
  [/\b(conversion de divisas|currency conversion|cambio de divisa|monetizacion|fx)\b/, 'FX_CONVERSION'],
  [/\b(compra|buy|bought|purchase)\b/, 'BUY'],
  [/\b(venta|venda|sell|sold|sale)\b/, 'SELL'],
  [/\b(deposito|deposit|aporte|consignacion|ingreso|recarga|wire received)\b/, 'DEPOSIT'],
  [/\b(retiro|withdraw|saque|retirada|levantamento|wire sent)/, 'WITHDRAWAL'],
];

/** Neutral leading words that say nothing about the type ("Abono por", "Pago de", "Cargo", "Ingreso por"). */
const NEUTRAL_PREFIX = /^(abono( por| de)?|pago( de| por)?|cargo( por| de)?|ingreso por|liquidacion de|credito( por)?|debito( por)?|nota( credito| debito)?|lancamento( de)?|movimiento( de)?|operacion( de)?)\s+/;

/** Words meaning the movement reverses a previous one (sign flips). */
const REFUND_RE = /\b(devolucion|devolucao|reintegro|reembolso|reversion|reversal|reverso|estorno|refund|rebate|anulacion|cancelacion de cargo)\b/;

/** Words whose direction is given by the sign of quantity/amount. */
const SIGN_BASED: [RegExp, 'trade' | 'transfer' | 'fraction'][] = [
  [/^(liquidacion|liquidacao|settlement)$/, 'trade'],
  [/^(traslado|traspaso|transferencia|transferencias|transfer|transferencia de custodia|journal)$/, 'transfer'],
  [/^(ajuste|adjustment|movimiento|movimentacao)$/, 'transfer'],
  [/\b(cash in lieu|leilao de fracao|fracao|fraccion|fracciones|venta de fracciones)\b/, 'fraction'],
];

export interface TypeClassification {
  type?: TransactionType;
  /** The text announces a refund / reversal (amount sign flips for TAX/FEE/DIVIDEND). */
  refund: boolean;
  /** The direction must be derived from the sign of quantity / amount. */
  signBased?: 'trade' | 'transfer' | 'fraction';
}

export function classifyTypeDetailed(raw: unknown, overrides?: Record<string, TransactionType>): TypeClassification {
  const s = String(raw ?? '').trim();
  if (!s) return { refund: false };
  if (overrides) {
    if (overrides[s]) return { type: overrides[s], refund: false };
    const n = normalizeText(s);
    for (const [k, v] of Object.entries(overrides)) if (normalizeText(k) === n) return { type: v, refund: false };
  }
  const n = normalizeText(s);
  if (EXACT[n]) return { type: EXACT[n], refund: false };
  const upper = s.toUpperCase();
  if (CORE_TYPES.includes(upper)) return { type: upper as TransactionType, refund: false };
  const refund = REFUND_RE.test(n);
  let text = n.replace(REFUND_RE, ' ').replace(/\s+/g, ' ').trim();
  while (NEUTRAL_PREFIX.test(text)) text = text.replace(NEUTRAL_PREFIX, '');
  if (!text) return refund ? { refund } : { refund: false };
  if (EXACT[text] && !SIGN_BASED.some(([re]) => re.test(text))) return { type: EXACT[text], refund };
  for (const [re, kind] of SIGN_BASED) if (re.test(text)) return { refund, signBased: kind };
  let best: { idx: number; order: number; type: TransactionType } | undefined;
  RULES.forEach(([re, t], order) => {
    const m = re.exec(text);
    if (m && (!best || m.index < best.idx)) best = { idx: m.index, order, type: t };
  });
  return best ? { type: best.type, refund } : { refund };
}

const CORE_TYPES = [
  'BUY', 'SELL', 'DIVIDEND', 'INTEREST', 'DEPOSIT', 'WITHDRAWAL', 'FEE', 'TAX', 'SPLIT', 'STOCK_DIVIDEND',
  'TRANSFER_IN', 'TRANSFER_OUT', 'FX_CONVERSION', 'RETURN_OF_CAPITAL',
];

export function classifyType(raw: unknown, overrides?: Record<string, TransactionType>): TransactionType | undefined {
  return classifyTypeDetailed(raw, overrides).type;
}
