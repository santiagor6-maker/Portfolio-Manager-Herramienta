import type { CountryCode, CurrencyCode, Instrument, ISODate, Transaction } from '@pm/core';
import { basisTotalCost, issuerKey, transferBasisOf, type TransferBasisMap } from '../common/basis';
import { CurrencyPool } from '../common/cashPool';
import { addWeekdays, addYears, daysBetween } from '../common/dates';
import { TAX_DISCLAIMER } from '../common/disclaimer';
import type { LocalizedText, ParamMeta, TaxInput, TaxIssue } from '../common/types';
import { displaySymbol, grossAmount, instrumentMap, sortTransactions, sum } from '../common/util';
import { art241TaxCop, colombiaConfig, type ColombiaTaxYearConfig } from './config';

const COP = 'COP';

export interface ColombiaReportOptions {
  /** Año gravable. */
  year: number;
  /** Override the built-in yearly parameters (e.g. after a law change). */
  config?: ColombiaTaxYearConfig;
  /**
   * Outstanding shares of the company, keyed by issuer key (e.g. 'XBOG:BANCOLOMBIA', see
   * `issuerKey`) or by instrument id, to test the Art. 36-1 ET limit (3% from 2023). When missing,
   * the sale is assumed to be below the limit (typical retail investor) and flagged.
   */
  outstandingShares?: Record<string, number>;
  /** Issuer key per instrument id (groups share classes of one company, Art. 36-1 / dividends). */
  issuers?: Record<string, string>;
  /**
   * How to value assets and cash in foreign currency in the patrimonio:
   * - 'initial-recognition' (default): Art. 269 ET (Ley 1819/2016): TRM of initial recognition
   *   (purchase date), with exchange differences taxed only when realized (Art. 288 ET).
   * - 'year-end': historical foreign-currency cost converted at the TRM of Dec 31 (pre-2017
   *   practice; some advisers still use it for persons not keeping books). Informative.
   */
  foreignValuation?: 'initial-recognition' | 'year-end';
  /**
   * Marginal rate of the investor in the cédula general (Art. 241 ET), used to cap the foreign
   * tax credit (Art. 254 ET). When omitted but `otherCedulaGeneralIncomeCop` is given, it is
   * derived from the Art. 241 table.
   */
  marginalRate?: number;
  /**
   * Renta líquida gravable of the cédula general from sources outside this portfolio (salary,
   * fees... after deductions and exempt income). Enables the Art. 241 estimate of the tax
   * attributable to the portfolio.
   */
  otherCedulaGeneralIncomeCop?: number;
  /** Treat withdrawals of foreign currency as a realization of exchange difference. Default false. */
  withdrawalsRealizeFx?: boolean;
  /** Foreign-currency cash counts as "activo en el exterior" (e.g. held at a foreign broker). Default true. */
  foreignCashIsAbroad?: boolean;
  /** Country where foreign cash is held, per currency (Formulario 160). Default USD -> US. */
  foreignCashCountry?: Record<CurrencyCode, CountryCode>;
  /**
   * Apply Art. 36-1 also to foreign shares listed on the BVC's Mercado Global Colombiano (XBOG,
   * country != CO). Default false: DIAN doctrine is not settled; the accountant decides.
   */
  art361IncludeMgc?: boolean;
  /** Original purchase date/cost of securities received by TRANSFER_IN (by transaction id). */
  transferBasis?: TransferBasisMap;
  /**
   * When a sale is realized for income tax: 'settlement' (default; Art. 27 ET — individuals not
   * keeping books realize income when received: T+2 BVC/Europe, T+1 USA since 2024-05-28) or
   * 'trade' (trade date).
   */
  realization?: 'settlement' | 'trade';
}

export type CoSaleClass = 'no_gravada_art_36_1' | 'ganancia_ocasional' | 'renta_ordinaria' | 'pendiente_costo';

export interface CoSaleRow {
  transactionId: string;
  instrumentId: string;
  symbol: string;
  sellDate: ISODate;
  /** Date the sale is realized for income tax (see `realization`). */
  realizationDate: ISODate;
  openDate: ISODate;
  holdingDays: number;
  quantity: number;
  currency: CurrencyCode;
  /** Net of commissions, instrument currency. */
  proceedsLocal: number;
  costLocal: number;
  trmSale: number;
  proceedsCop: number;
  /** Fiscal cost in COP (TRM of the purchase date for foreign shares, Art. 269 ET). */
  costCop: number;
  gainCop: number;
  /** Cost that may be subtracted: the loss part is not deductible (Art. 153 ET). */
  deductibleCostCop: number;
  /** Loss on the sale of shares — not deductible nor offsettable (Art. 153 ET). */
  nonDeductibleLossCop: number;
  classification: CoSaleClass;
  legalBasis: string;
}

export interface CoIncomeRow {
  transactionId: string;
  date: ISODate;
  type: 'dividendo' | 'dividendo_en_acciones' | 'interes';
  source: 'nacional' | 'exterior';
  instrumentId?: string;
  symbol?: string;
  issuer?: string;
  currency: CurrencyCode;
  grossLocal: number;
  withheldLocal: number;
  trm: number;
  grossCop: number;
  /** National: retención en la fuente (anticipo). Foreign: impuesto pagado en el exterior. */
  withheldCop: number;
  /** National dividends: withholding expected under Art. 242 ET / DUR 1.2.4.7.1 (cumulative per company). */
  expectedWithholdingCop?: number;
  /** Foreign only: maximum Art. 254 ET credit for the direct withholding. */
  foreignTaxCreditCapCop?: number;
  /** National interest: componente inflacionario not constituting income (Arts. 38-41 ET). */
  componenteInflacionarioCop?: number;
}

export interface CoFxRow {
  transactionId: string;
  date: ISODate;
  currency: CurrencyCode;
  units: number;
  trm: number;
  /** Historical (initial recognition) cost of the units in COP. */
  costCop: number;
  /** Value at the TRM of the realization date. */
  valueCop: number;
  gainCop: number;
  reason: string;
}

export interface CoLotView {
  openDate: ISODate;
  quantity: number;
  costCop: number;
  /** First sale date that qualifies as ganancia ocasional (Art. 300 ET). */
  gananciaOcasionalFrom: ISODate;
}

export interface CoPatrimonioRow {
  kind: 'inversion' | 'efectivo';
  instrumentId?: string;
  symbol?: string;
  name?: string;
  currency: CurrencyCode;
  quantity: number;
  abroad: boolean;
  /** Jurisdiction (Formulario 160). */
  country?: CountryCode;
  /** Fiscal cost in the asset currency. */
  costLocal: number;
  /** Declared (fiscal) value in COP according to `foreignValuation`. */
  fiscalValueCop: number;
  /** Informative: market price at Dec 31 x TRM Dec 31. */
  marketValueCop?: number;
  price?: number;
  trmDec31: number;
  legalBasis: string;
  lots?: CoLotView[];
}

export interface CoF160Line {
  /** 'pais' when aggregated by jurisdiction (<= 3,580 UVT), 'activo' when itemized. */
  level: 'pais' | 'activo';
  country: CountryCode;
  description: string;
  valueCop: number;
}

export interface ColombiaTaxReport {
  country: 'CO';
  year: number;
  generatedFor: 'persona_natural_residente';
  disclaimer: LocalizedText;
  config: ColombiaTaxYearConfig;
  patrimonio: {
    date: ISODate;
    rows: CoPatrimonioRow[];
    patrimonioBrutoCop: number;
    /** Informative: everything at market value and TRM Dec 31. */
    marketValueCop: number;
    foreignAssetsCop: number;
    trmDec31: Record<CurrencyCode, number>;
  };
  formulario160: {
    /** Year in which the declaration is filed (assets held at 1-Jan of that year). */
    filingYear: number;
    uvtUsed: number;
    uvtYear: number;
    uvtIsEstimate: boolean;
    thresholdCop: number;
    foreignAssetsCop: number;
    required: boolean;
    itemizedRequired: boolean;
    /** Lines in the format required: by country, or asset by asset above 3,580 UVT. */
    lines: CoF160Line[];
    note: string;
  };
  ingresos: {
    dividends: CoIncomeRow[];
    interest: CoIncomeRow[];
    totals: {
      nationalDividendsCop: number;
      nationalDividendWithholdingCop: number;
      nationalDividendExpectedWithholdingCop: number;
      /** Art. 254-1 ET: 19% of national dividends above 1,090 UVT. */
      descuentoArt2541Cop: number;
      foreignDividendsCop: number;
      foreignDividendTaxPaidCop: number;
      foreignDividendCreditCapCop?: number;
      nationalInterestCop: number;
      foreignInterestCop: number;
      componenteInflacionarioCop: number;
      interestWithholdingCop: number;
    };
  };
  ventas: {
    rows: CoSaleRow[];
    totals: {
      noGravadaArt361: { ingresosCop: number; costosCop: number; utilidadCop: number; perdidaNoDeducibleCop: number };
      gananciaOcasional: {
        ingresosCop: number;
        /** Deductible costs (loss part excluded, Art. 153 ET). */
        costosCop: number;
        perdidaNoDeducibleCop: number;
        gananciaGravableCop: number;
        rate: number;
        impuestoEstimadoCop: number;
      };
      rentaOrdinaria: { ingresosCop: number; costosCop: number; perdidaNoDeducibleCop: number; rentaLiquidaCop: number };
      /** Sales with missing purchase history: not computed until the cost is supplied. */
      pendienteCosto: { ingresosCop: number; count: number };
    };
  };
  diferenciaEnCambio: { rows: CoFxRow[]; realizedGainCop: number; realizedLossCop: number; netCop: number };
  /** Art. 241 estimate of the cédula general tax attributable to this portfolio (when inputs allow). */
  impuestoEstimado?: {
    otherCedulaGeneralIncomeCop: number;
    portfolioCedulaGeneralCop: number;
    marginalRate: number;
    impuestoCedulaGeneralIncrementalCop: number;
    descuentoArt2541Cop: number;
    descuentoArt254Cop: number;
    impuestoGananciaOcasionalCop: number;
    impuestoTotalEstimadoCop: number;
    retencionesCop: number;
    saldoEstimadoCop: number;
    note: string;
  };
  obligacionDeclarar: {
    patrimonioThresholdCop: number;
    ingresosThresholdCop: number;
    /** Gross income from this portfolio only (dividends, interest, gross sale proceeds). */
    ingresosBrutosPortafolioCop: number;
    /** Deposits into the portfolio (consignaciones/inversiones financieras), Art. 594-3 lit. c. */
    consignacionesCop: number;
    byPatrimonio: boolean;
    byIngresosPortafolio: boolean;
    byConsignaciones: boolean;
    note: string;
  };
  gmf: { rate: number; withdrawalsCop: number; estimatedGmfCop: number; exemptMonthlyCop: number; note: string };
  assumptions: string[];
  issues: TaxIssue[];
}

interface CoLot {
  openDate: ISODate;
  quantity: number;
  costLocal: number;
  costCop: number;
}

/** Shares/funds located abroad from a Colombian perspective (Formulario 160). */
export function isAbroadForColombia(inst: Instrument | undefined): boolean {
  if (!inst) return false;
  if (inst.exchange === 'XBOG') return false;
  if (inst.country === 'CO' && inst.currency === COP) return false;
  return true;
}

function isArt361Eligible(inst: Instrument | undefined, includeMgc: boolean): boolean {
  if (!inst || inst.exchange !== 'XBOG') return false;
  if (inst.assetClass !== 'equity') return false;
  return inst.country === 'CO' || includeMgc;
}

const US_EXCHANGES = new Set(['XNYS', 'XNAS', 'ARCX', 'BATS', 'XASE']);

/** Estimated settlement date of a trade (weekends skipped, holidays ignored). */
export function settlementDate(inst: Instrument | undefined, tradeDate: ISODate): ISODate {
  if (inst && US_EXCHANGES.has(inst.exchange)) return addWeekdays(tradeDate, tradeDate >= '2024-05-28' ? 1 : 2);
  if (inst?.exchange === 'MANUAL' || inst?.exchange === 'OTC') return tradeDate;
  return addWeekdays(tradeDate, 2);
}

/**
 * Builds the Colombian annual tax report (renta y complementarios, persona natural residente)
 * from raw transactions. Lots are FIFO with fiscal cost in COP at the TRM of the purchase date.
 */
export function buildColombiaTaxReport(input: TaxInput, opts: ColombiaReportOptions): ColombiaTaxReport {
  const year = opts.year;
  const config = opts.config ?? colombiaConfig(year);
  const yearStart = `${year}-01-01`;
  const yearEnd = `${year}-12-31`;
  const foreignValuation = opts.foreignValuation ?? 'initial-recognition';
  const foreignCashIsAbroad = opts.foreignCashIsAbroad ?? true;
  const realization = opts.realization ?? 'settlement';
  const instruments = instrumentMap(input.instruments);
  const issues: TaxIssue[] = [];
  const missingTrm = new Set<string>();
  const issuerOf = (id: string) => issuerKey(instruments.get(id), id, opts.issuers);

  const trm = (currency: CurrencyCode, date: ISODate): number => {
    if (currency === COP) return 1;
    const r = input.market.fx(currency, COP, date);
    if (r === undefined || !Number.isFinite(r) || r <= 0) {
      const key = `${currency}@${date}`;
      if (!missingTrm.has(key)) {
        missingTrm.add(key);
        issues.push({
          level: 'error',
          code: 'MISSING_TRM',
          message: `No hay TRM ${currency}/COP para ${date}; los valores en COP de ese movimiento quedan en 0.`,
        });
      }
      return 0;
    }
    return r;
  };

  if (Object.values(config.meta).some((m) => m.status === 'needs-verification')) {
    issues.push({
      level: 'warning',
      code: 'PARAMS_NEED_VERIFICATION',
      message: `Algunos parámetros del año ${year} están marcados para verificación (ver config.meta).`,
    });
  }

  const lots = new Map<string, CoLot[]>();
  const pool = new CurrencyPool();
  let copCash = 0;
  const sales: CoSaleRow[] = [];
  const dividends: CoIncomeRow[] = [];
  const interest: CoIncomeRow[] = [];
  const fxRows: CoFxRow[] = [];
  const soldInYearByIssuer = new Map<string, number>();
  let withdrawalsCop = 0;
  let depositsCop = 0;
  let poolShortfallWarned = false;

  const txs = sortTransactions(input.transactions).filter((t) => t.date <= yearEnd);
  const inYear = (t: Transaction) => t.date >= yearStart && t.date <= yearEnd;
  const realizationOf = (t: Transaction, inst: Instrument | undefined) =>
    realization === 'settlement' ? settlementDate(inst, t.date) : t.date;
  const realizedInYear = (d: ISODate) => d >= yearStart && d <= yearEnd;

  // --- cash helpers -------------------------------------------------------------------------
  const cashIn = (tx: Transaction, currency: CurrencyCode, units: number, costCop?: number) => {
    if (units <= 0) return;
    if (currency === COP) {
      copCash += units;
      return;
    }
    pool.add(currency, units, costCop ?? units * trm(currency, tx.date));
  };
  const cashOut = (tx: Transaction, currency: CurrencyCode, units: number, realize: boolean, reason: string, valueCop?: number) => {
    if (units <= 0) return;
    if (currency === COP) {
      copCash -= units;
      return;
    }
    const rate = trm(currency, tx.date);
    const r = pool.remove(currency, units);
    if (r.uncovered > 0 && !poolShortfallWarned) {
      poolShortfallWarned = true;
      issues.push({
        level: 'info',
        code: 'FOREIGN_CASH_NOT_RECORDED',
        transactionId: tx.id,
        message:
          `Salida de ${currency} sin saldo suficiente registrado (faltan depósitos). Se asume que la parte ` +
          'faltante se compró el mismo día a la TRM del día (sin diferencia en cambio).',
      });
    }
    if (realize && r.covered > 0 && inYear(tx)) {
      const value = valueCop !== undefined ? (valueCop * r.covered) / units : r.covered * rate;
      fxRows.push({
        transactionId: tx.id,
        date: tx.date,
        currency,
        units: r.covered,
        trm: rate,
        costCop: r.costRemoved,
        valueCop: value,
        gainCop: value - r.costRemoved,
        reason,
      });
    }
  };

  // --- main loop ----------------------------------------------------------------------------
  for (const tx of txs) {
    const inst = tx.instrumentId ? instruments.get(tx.instrumentId) : undefined;
    const id = tx.instrumentId ?? '';
    const ccy = tx.currency;
    const fees = tx.fees ?? 0;
    const taxes = tx.taxes ?? 0;
    switch (tx.type) {
      case 'DEPOSIT': {
        const amt = grossAmount(tx);
        if (inYear(tx)) depositsCop += amt * trm(ccy, tx.date);
        cashIn(tx, ccy, amt);
        break;
      }
      case 'WITHDRAWAL': {
        const amt = grossAmount(tx);
        if (inYear(tx) && ccy === COP) withdrawalsCop += amt;
        cashOut(tx, ccy, amt, opts.withdrawalsRealizeFx ?? false, 'Retiro de divisas');
        break;
      }
      case 'FEE':
      case 'TAX':
        cashOut(tx, ccy, grossAmount(tx), true, tx.type === 'FEE' ? 'Pago de comisión en divisas' : 'Pago de impuesto en divisas');
        break;
      case 'FX_CONVERSION': {
        const amt = grossAmount(tx);
        const to = tx.toCurrency;
        const toAmt = tx.toAmount ?? 0;
        const outUnits = amt + fees;
        if (ccy === COP) {
          copCash -= outUnits;
          if (to) cashIn(tx, to, toAmt, outUnits);
          break;
        }
        const rate = trm(ccy, tx.date);
        // COP value of what leaves: the actual COP received when converting to pesos, else TRM.
        const outValueCop = to === COP ? toAmt + fees * rate : outUnits * rate;
        cashOut(tx, ccy, outUnits, true, `Conversión ${ccy}→${to ?? '?'}`, outValueCop);
        if (to) cashIn(tx, to, toAmt, to === COP ? undefined : amt * rate);
        break;
      }
      case 'BUY': {
        const qty = tx.quantity ?? 0;
        const costLocal = grossAmount(tx) + fees;
        const list = lots.get(id) ?? [];
        list.push({ openDate: tx.date, quantity: qty, costLocal, costCop: costLocal * trm(ccy, tx.date) });
        lots.set(id, list);
        cashOut(tx, ccy, costLocal, true, `Compra de ${displaySymbol(id, inst)} con divisas`);
        break;
      }
      case 'TRANSFER_IN': {
        const qty = tx.quantity ?? 0;
        const basis = transferBasisOf(tx, opts.transferBasis);
        const list = lots.get(id) ?? [];
        if (basis) {
          const costLocal = basisTotalCost(basis, qty) ?? grossAmount(tx) + fees;
          const costCop = costLocal * (basis.fxRate ?? trm(ccy, basis.openDate));
          list.push({ openDate: basis.openDate, quantity: qty, costLocal, costCop });
        } else {
          const costLocal = grossAmount(tx) + fees;
          list.push({ openDate: tx.date, quantity: qty, costLocal, costCop: costLocal * trm(ccy, tx.date) });
          issues.push({
            level: 'warning',
            code: 'TRANSFER_COST_UNKNOWN',
            transactionId: tx.id,
            instrumentId: id,
            message:
              `Traslado de ${displaySymbol(id, inst)} sin fecha y costo de compra originales: se usó la fecha y el valor ` +
              'del traslado, lo que puede cambiar la clasificación (2 años) y el costo fiscal. Indique el costo original ' +
              '(opción transferBasis o nota "[costo: AAAA-MM-DD @ precio]").',
          });
        }
        lots.set(id, list);
        break;
      }
      case 'SELL':
      case 'TRANSFER_OUT': {
        let remaining = tx.quantity ?? 0;
        const totalQty = remaining;
        const proceedsLocal = tx.type === 'SELL' ? grossAmount(tx) - fees : 0;
        const rate = trm(ccy, tx.date);
        const list = lots.get(id) ?? [];
        const realDate = realizationOf(tx, inst);
        const isSaleInYear = tx.type === 'SELL' && realizedInYear(realDate);
        if (isSaleInYear) {
          const iss = issuerOf(id);
          soldInYearByIssuer.set(iss, (soldInYearByIssuer.get(iss) ?? 0) + totalQty);
        }
        while (remaining > 1e-12) {
          const lot = list[0];
          if (!lot) {
            issues.push({
              level: 'error',
              code: 'OVERSELL',
              transactionId: tx.id,
              instrumentId: id,
              message:
                `Venta de ${remaining} unidades de ${displaySymbol(id, inst)} sin compras registradas: esa parte queda ` +
                '"pendiente de costo" y no se calcula impuesto hasta registrar la compra o el traslado con su costo.',
            });
            if (isSaleInYear) {
              const row = saleRow(tx, inst, id, { openDate: tx.date, quantity: remaining, costLocal: 0, costCop: 0 }, remaining, totalQty, proceedsLocal, rate, realDate);
              row.classification = 'pendiente_costo';
              row.legalBasis = 'Costo fiscal desconocido';
              sales.push(row);
            }
            break;
          }
          const take = Math.min(lot.quantity, remaining);
          const slice: CoLot = {
            openDate: lot.openDate,
            quantity: take,
            costLocal: (lot.costLocal * take) / lot.quantity,
            costCop: (lot.costCop * take) / lot.quantity,
          };
          lot.costLocal -= slice.costLocal;
          lot.costCop -= slice.costCop;
          lot.quantity -= take;
          if (lot.quantity <= 1e-12) list.shift();
          remaining -= take;
          if (isSaleInYear) sales.push(saleRow(tx, inst, id, slice, take, totalQty, proceedsLocal, rate, realDate));
        }
        lots.set(id, list);
        if (tx.type === 'SELL') {
          cashIn(tx, ccy, proceedsLocal);
          if (taxes > 0) cashOut(tx, ccy, taxes, false, 'Retención');
        }
        break;
      }
      case 'SPLIT': {
        const ratio = tx.ratio ?? 1;
        const list = lots.get(id) ?? [];
        for (const lot of list) lot.quantity *= ratio;
        const total = sum(list.map((l) => l.quantity));
        const frac = total - Math.floor(total + 1e-9);
        if (frac > 1e-6 && inst?.assetClass !== 'crypto' && inst?.assetClass !== 'fund') {
          issues.push({
            level: 'warning',
            code: 'SPLIT_FRACTION',
            transactionId: tx.id,
            instrumentId: id,
            message: `El ajuste de ${displaySymbol(id, inst)} deja una fracción de ${frac.toFixed(4)} acciones; registre su venta o liquidación en efectivo.`,
          });
        }
        break;
      }
      case 'STOCK_DIVIDEND': {
        const list = lots.get(id) ?? [];
        const held = sum(list.map((l) => l.quantity));
        const newQty = tx.quantity ?? held * (tx.ratio ?? 0);
        const unit = tx.price ?? 0;
        if (tx.price === undefined) {
          issues.push({
            level: 'warning',
            code: 'STOCK_DIVIDEND_NO_VALUE',
            transactionId: tx.id,
            instrumentId: id,
            message: `Dividendo en acciones de ${displaySymbol(id, inst)} sin valor por acción: costo fiscal 0 y no se reporta como ingreso.`,
          });
        }
        const rate = trm(ccy, tx.date);
        list.push({ openDate: tx.date, quantity: newQty, costLocal: newQty * unit, costCop: newQty * unit * rate });
        lots.set(id, list);
        if (inYear(tx) && unit > 0) {
          dividends.push(incomeRow(tx, inst, 'dividendo_en_acciones', newQty * unit, 0, rate));
        }
        break;
      }
      case 'RETURN_OF_CAPITAL': {
        const amt = grossAmount(tx);
        const list = lots.get(id) ?? [];
        const totalLocal = sum(list.map((l) => l.costLocal));
        if (totalLocal > 0) {
          const f = Math.min(1, amt / totalLocal);
          for (const lot of list) {
            lot.costLocal *= 1 - f;
            lot.costCop *= 1 - f;
          }
        }
        cashIn(tx, ccy, amt);
        break;
      }
      case 'DIVIDEND':
      case 'INTEREST': {
        const gross = grossAmount(tx);
        const rate = trm(ccy, tx.date);
        if (inYear(tx)) {
          const row = incomeRow(tx, inst, tx.type === 'DIVIDEND' ? 'dividendo' : 'interes', gross, taxes, rate);
          (tx.type === 'DIVIDEND' ? dividends : interest).push(row);
        }
        cashIn(tx, ccy, gross - taxes);
        break;
      }
    }
  }

  // --- helpers that need closure state ----------------------------------------------------
  function saleRow(
    tx: Transaction,
    inst: Instrument | undefined,
    id: string,
    slice: CoLot,
    qty: number,
    totalQty: number,
    proceedsLocalTotal: number,
    rate: number,
    realDate: ISODate,
  ): CoSaleRow {
    const proceedsLocal = totalQty > 0 ? (proceedsLocalTotal * qty) / totalQty : 0;
    const proceedsCop = proceedsLocal * rate;
    const longTerm = tx.date >= addYears(slice.openDate, config.gananciaOcasionalMinYears);
    const gainCop = proceedsCop - slice.costCop;
    return {
      transactionId: tx.id,
      instrumentId: id,
      symbol: displaySymbol(id, inst),
      sellDate: tx.date,
      realizationDate: realDate,
      openDate: slice.openDate,
      holdingDays: daysBetween(slice.openDate, tx.date),
      quantity: qty,
      currency: tx.currency,
      proceedsLocal,
      costLocal: slice.costLocal,
      trmSale: rate,
      proceedsCop,
      costCop: slice.costCop,
      gainCop,
      deductibleCostCop: slice.costCop,
      nonDeductibleLossCop: 0,
      classification: longTerm ? 'ganancia_ocasional' : 'renta_ordinaria',
      legalBasis: longTerm ? 'Arts. 300 y 314 ET' : 'Arts. 26, 330 y 241 ET (cédula general)',
    };
  }

  function incomeRow(
    tx: Transaction,
    inst: Instrument | undefined,
    type: CoIncomeRow['type'],
    gross: number,
    withheld: number,
    rate: number,
  ): CoIncomeRow {
    const national = inst ? inst.country === 'CO' : tx.currency === COP;
    return {
      transactionId: tx.id,
      date: tx.date,
      type,
      source: national ? 'nacional' : 'exterior',
      instrumentId: tx.instrumentId,
      symbol: tx.instrumentId ? displaySymbol(tx.instrumentId, inst) : undefined,
      issuer: tx.instrumentId ? issuerOf(tx.instrumentId) : undefined,
      currency: tx.currency,
      grossLocal: gross,
      withheldLocal: withheld,
      trm: rate,
      grossCop: gross * rate,
      withheldCop: withheld * rate,
    };
  }

  // --- Art. 36-1 classification (per issuer) ----------------------------------------------
  for (const row of sales) {
    if (row.classification === 'pendiente_costo') continue;
    const inst = instruments.get(row.instrumentId);
    if (!isArt361Eligible(inst, opts.art361IncludeMgc ?? false)) continue;
    const iss = issuerOf(row.instrumentId);
    const outstanding = opts.outstandingShares?.[iss] ?? opts.outstandingShares?.[row.instrumentId];
    const sold = soldInYearByIssuer.get(iss) ?? 0;
    if (outstanding === undefined) {
      issues.push({
        level: 'info',
        code: 'ART_36_1_ASSUMED',
        instrumentId: row.instrumentId,
        message:
          `Se asume que las ventas de acciones de ${iss.replace('XBOG:', '')} en ${year} no superan el ` +
          `${(config.art361MaxShareOfOutstanding * 100).toFixed(0)}% de las acciones en circulación (Art. 36-1 ET).`,
      });
    } else if (sold / outstanding > config.art361MaxShareOfOutstanding) {
      issues.push({
        level: 'warning',
        code: 'ART_36_1_LIMIT_EXCEEDED',
        instrumentId: row.instrumentId,
        message: `Las ventas de acciones de ${iss.replace('XBOG:', '')} superan el límite del Art. 36-1 ET; la utilidad no es exenta.`,
      });
      continue;
    }
    row.classification = 'no_gravada_art_36_1';
    row.legalBasis = 'Art. 36-1 ET (acciones inscritas en bolsa colombiana)';
  }

  // --- Art. 153 ET: losses on the sale of shares are not deductible ------------------------
  // Netting is allowed only within one sale (same transaction and classification); a net loss
  // cannot reduce other gains.
  const groups = new Map<string, CoSaleRow[]>();
  for (const r of sales) {
    if (r.classification === 'pendiente_costo') continue;
    const k = `${r.transactionId}|${r.classification}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  for (const rows of groups.values()) {
    const net = sum(rows.map((r) => r.gainCop));
    if (net >= 0) continue;
    const totalLoss = sum(rows.filter((r) => r.gainCop < 0).map((r) => -r.gainCop));
    for (const r of rows) {
      if (r.gainCop >= 0) continue;
      const share = (-net * -r.gainCop) / totalLoss;
      r.nonDeductibleLossCop = share;
      r.deductibleCostCop = r.costCop - share;
    }
  }
  if (sales.some((r) => r.nonDeductibleLossCop > 0)) {
    issues.push({
      level: 'info',
      code: 'ART_153_LOSS_NOT_DEDUCTIBLE',
      message: 'Hay pérdidas en venta de acciones: no son deducibles ni compensables con otras ganancias (Art. 153 ET).',
    });
  }
  dedupeIssues(issues);

  // --- expected withholding on national dividends (per company, cumulative in the year) -----
  const uvt = config.uvt;
  const dwThreshold = config.dividendWithholding.exemptUpToUvt * uvt;
  const cumByIssuer = new Map<string, { gross: number; withheld: number; expected: number; symbol?: string }>();
  for (const d of dividends) {
    if (d.source !== 'nacional') continue;
    const key = d.issuer ?? d.instrumentId ?? '?';
    const acc = cumByIssuer.get(key) ?? { gross: 0, withheld: 0, expected: 0, symbol: d.symbol };
    const before = Math.max(0, acc.gross - dwThreshold) * config.dividendWithholding.rate;
    acc.gross += d.grossCop;
    const after = Math.max(0, acc.gross - dwThreshold) * config.dividendWithholding.rate;
    d.expectedWithholdingCop = after - before;
    acc.withheld += d.withheldCop;
    acc.expected += d.expectedWithholdingCop;
    cumByIssuer.set(key, acc);
  }
  for (const [key, acc] of cumByIssuer) {
    if (Math.abs(acc.withheld - acc.expected) > Math.max(1000, acc.expected * 0.01)) {
      issues.push({
        level: 'warning',
        code: 'CO_DIVIDEND_WITHHOLDING_MISMATCH',
        message:
          `Dividendos de ${acc.symbol ?? key}: retención registrada ${acc.withheld.toFixed(0)} COP vs. esperada ` +
          `${acc.expected.toFixed(0)} COP (15% sobre el exceso de ${config.dividendWithholding.exemptUpToUvt} UVT, Art. 242 ET). ` +
          'Revise el certificado de la sociedad (la parte gravada del Art. 49 tiene otra retención).',
      });
    }
  }

  // --- interest: componente inflacionario ---------------------------------------------------
  if (config.componenteInflacionario !== undefined) {
    for (const i of interest) {
      if (i.source === 'nacional') i.componenteInflacionarioCop = i.grossCop * config.componenteInflacionario;
    }
  }

  // --- patrimonio at Dec 31 -------------------------------------------------------------
  const trmDec31: Record<CurrencyCode, number> = {};
  const trmEnd = (c: CurrencyCode) => (trmDec31[c] ??= trm(c, yearEnd));
  const patrimonioRows: CoPatrimonioRow[] = [];
  for (const [id, list] of lots) {
    const quantity = sum(list.map((l) => l.quantity));
    if (quantity <= 1e-9) continue;
    const inst = instruments.get(id);
    const currency = inst?.currency ?? COP;
    const costLocal = sum(list.map((l) => l.costLocal));
    const costCop = sum(list.map((l) => l.costCop));
    const rateEnd = trmEnd(currency);
    const price = input.market.price(id, yearEnd);
    const mult = inst?.priceMultiplier ?? 1;
    if (price === undefined) {
      issues.push({
        level: 'warning',
        code: 'MISSING_PRICE',
        instrumentId: id,
        message: `Sin precio de ${displaySymbol(id, inst)} al ${yearEnd}; valor de mercado no disponible.`,
      });
    }
    const fiscalValueCop = currency !== COP && foreignValuation === 'year-end' ? costLocal * rateEnd : costCop;
    patrimonioRows.push({
      kind: 'inversion',
      instrumentId: id,
      symbol: displaySymbol(id, inst),
      name: inst?.name,
      currency,
      quantity,
      abroad: isAbroadForColombia(inst),
      country: inst?.country,
      costLocal,
      fiscalValueCop,
      marketValueCop: price !== undefined ? (quantity * price * rateEnd) / mult : undefined,
      price,
      trmDec31: rateEnd,
      legalBasis:
        currency === COP
          ? 'Arts. 267 y 272 ET (costo fiscal)'
          : foreignValuation === 'year-end'
            ? 'Costo en divisa a TRM 31-dic (criterio alternativo)'
            : 'Arts. 267, 269 y 272 ET (costo fiscal a TRM de reconocimiento inicial)',
      lots: list
        .filter((l) => l.quantity > 1e-9)
        .map((l) => ({
          openDate: l.openDate,
          quantity: l.quantity,
          costCop: l.costCop,
          gananciaOcasionalFrom: addYears(l.openDate, config.gananciaOcasionalMinYears),
        })),
    });
  }
  if (copCash > 1e-6) {
    patrimonioRows.push({
      kind: 'efectivo',
      currency: COP,
      quantity: copCash,
      abroad: false,
      country: 'CO',
      costLocal: copCash,
      fiscalValueCop: copCash,
      marketValueCop: copCash,
      trmDec31: 1,
      legalBasis: 'Art. 267 ET',
    });
  } else if (copCash < -1e-6) {
    issues.push({
      level: 'warning',
      code: 'NEGATIVE_CASH',
      message: 'El saldo de efectivo en COP es negativo (faltan depósitos registrados); no se incluye en el patrimonio.',
    });
  }
  const cashCountry = { USD: 'US', ...(opts.foreignCashCountry ?? {}) } as Record<string, string>;
  for (const b of pool.snapshot()) {
    const rateEnd = trmEnd(b.currency);
    patrimonioRows.push({
      kind: 'efectivo',
      currency: b.currency,
      quantity: b.units,
      abroad: foreignCashIsAbroad,
      country: foreignCashIsAbroad ? cashCountry[b.currency] : 'CO',
      costLocal: b.units,
      fiscalValueCop: foreignValuation === 'year-end' ? b.units * rateEnd : b.cost,
      marketValueCop: b.units * rateEnd,
      trmDec31: rateEnd,
      legalBasis:
        foreignValuation === 'year-end'
          ? 'Divisas a TRM 31-dic (criterio alternativo)'
          : 'Art. 269 ET (divisas a TRM de reconocimiento inicial, costo promedio)',
    });
  }
  const patrimonioBrutoCop = sum(patrimonioRows.map((r) => r.fiscalValueCop));
  const marketValueCop = sum(patrimonioRows.map((r) => r.marketValueCop ?? r.fiscalValueCop));
  const foreignAssetsCop = sum(patrimonioRows.filter((r) => r.abroad).map((r) => r.fiscalValueCop));

  // --- Formulario 160 -------------------------------------------------------------------------
  const filingYear = year + 1;
  const nextCfg = colombiaConfigIfKnown(filingYear);
  const uvtUsed = nextCfg?.uvt ?? config.uvt;
  const f160Threshold = config.foreignAssetsDeclarationUvt * uvtUsed;
  const itemizedRequired = foreignAssetsCop > config.foreignAssetsItemizedUvt * uvtUsed;
  const abroadRows = patrimonioRows.filter((r) => r.abroad);
  let f160Lines: CoF160Line[];
  if (itemizedRequired) {
    f160Lines = abroadRows.map((r) => ({
      level: 'activo',
      country: r.country ?? '',
      description: r.kind === 'inversion' ? `${r.quantity} ${r.symbol ?? ''} ${r.name ?? ''}`.trim() : `Efectivo ${r.currency}`,
      valueCop: r.fiscalValueCop,
    }));
  } else {
    const byCountry = new Map<string, number>();
    for (const r of abroadRows) byCountry.set(r.country ?? '', (byCountry.get(r.country ?? '') ?? 0) + r.fiscalValueCop);
    f160Lines = [...byCountry.entries()].map(([country, valueCop]) => ({
      level: 'pais',
      country,
      description: `Activos en ${country || 'jurisdicción sin identificar'}`,
      valueCop,
    }));
  }
  if (abroadRows.some((r) => !r.country)) {
    issues.push({
      level: 'warning',
      code: 'F160_COUNTRY_UNKNOWN',
      message: 'Hay activos en el exterior sin jurisdicción identificada (Formulario 160); indíquela (foreignCashCountry o instrument.country).',
    });
  }
  const formulario160 = {
    filingYear,
    uvtUsed,
    uvtYear: nextCfg ? filingYear : year,
    uvtIsEstimate: !nextCfg,
    thresholdCop: f160Threshold,
    foreignAssetsCop,
    required: foreignAssetsCop > f160Threshold,
    itemizedRequired,
    lines: f160Lines,
    note:
      `Art. 607 ET: declaración anual de activos en el exterior (Formulario 160) en ${filingYear} si el valor ` +
      `patrimonial de los activos en el exterior al 1-ene-${filingYear} supera ${config.foreignAssetsDeclarationUvt} UVT. ` +
      `Por encima de ${config.foreignAssetsItemizedUvt} UVT deben discriminarse activo por activo; por debajo, de forma agregada por jurisdicción.` +
      (nextCfg ? '' : ` La UVT de ${filingYear} no está en la tabla: se usó la de ${year} (estimado).`),
  };

  // --- totals ---------------------------------------------------------------------------------
  const nat = dividends.filter((d) => d.source === 'nacional');
  const ext = dividends.filter((d) => d.source === 'exterior');
  const nationalDividendsCop = sum(nat.map((d) => d.grossCop));
  const discount = config.dividendDiscount;
  const descuentoArt2541Cop = discount ? Math.max(0, nationalDividendsCop - discount.fromUvt * uvt) * discount.rate : 0;
  const nationalInterestCop = sum(interest.filter((i) => i.source === 'nacional').map((i) => i.grossCop));
  const foreignInterestCop = sum(interest.filter((i) => i.source === 'exterior').map((i) => i.grossCop));
  const componenteInflacionarioCop = sum(interest.map((i) => i.componenteInflacionarioCop ?? 0));

  const by = (c: CoSaleClass) => sales.filter((s) => s.classification === c);
  const totalsOf = (rows: CoSaleRow[]) => ({
    ingresosCop: sum(rows.map((r) => r.proceedsCop)),
    costosCop: sum(rows.map((r) => r.deductibleCostCop)),
    perdidaNoDeducibleCop: sum(rows.map((r) => r.nonDeductibleLossCop)),
  });
  const ex = totalsOf(by('no_gravada_art_36_1'));
  const go = totalsOf(by('ganancia_ocasional'));
  const ro = totalsOf(by('renta_ordinaria'));
  const pend = by('pendiente_costo');
  const goGravable = Math.max(0, go.ingresosCop - go.costosCop);
  const roLiquida = Math.max(0, ro.ingresosCop - ro.costosCop);

  const fxGain = sum(fxRows.filter((r) => r.gainCop > 0).map((r) => r.gainCop));
  const fxLoss = sum(fxRows.filter((r) => r.gainCop < 0).map((r) => -r.gainCop));
  const foreignDividendsCop = sum(ext.map((d) => d.grossCop));

  // Marginal rate for the foreign credit cap and the Art. 241 estimate.
  const portfolioCedula = Math.max(
    0,
    nationalDividendsCop + foreignDividendsCop + nationalInterestCop - componenteInflacionarioCop + foreignInterestCop + roLiquida + (fxGain - fxLoss),
  );
  let marginalRate = opts.marginalRate;
  let impuestoEstimado: ColombiaTaxReport['impuestoEstimado'];
  const other = opts.otherCedulaGeneralIncomeCop;
  if (other !== undefined) {
    const withP = art241TaxCop(other + portfolioCedula, uvt);
    const without = art241TaxCop(other, uvt);
    marginalRate ??= withP.marginalRate;
    impuestoEstimado = {
      otherCedulaGeneralIncomeCop: other,
      portfolioCedulaGeneralCop: portfolioCedula,
      marginalRate: withP.marginalRate,
      impuestoCedulaGeneralIncrementalCop: withP.taxCop - without.taxCop,
      descuentoArt2541Cop,
      descuentoArt254Cop: 0,
      impuestoGananciaOcasionalCop: goGravable * config.gananciaOcasionalRate,
      impuestoTotalEstimadoCop: 0,
      retencionesCop: 0,
      saldoEstimadoCop: 0,
      note:
        'Estimación incremental con la tabla del Art. 241 ET: impuesto(otras rentas + portafolio) − impuesto(otras rentas). ' +
        'No considera el límite de rentas exentas y deducciones (Art. 336), el límite de descuentos (Art. 259) ni la renta presuntiva.',
    };
  }
  if (marginalRate !== undefined) {
    for (const d of ext) d.foreignTaxCreditCapCop = Math.min(d.withheldCop, d.grossCop * marginalRate);
    for (const i of interest) if (i.source === 'exterior') i.foreignTaxCreditCapCop = Math.min(i.withheldCop, i.grossCop * marginalRate);
  }
  const foreignCreditCap =
    marginalRate !== undefined
      ? sum([...ext, ...interest.filter((i) => i.source === 'exterior')].map((d) => d.foreignTaxCreditCapCop ?? 0))
      : undefined;
  const ingresosTotals = {
    nationalDividendsCop,
    nationalDividendWithholdingCop: sum(nat.map((d) => d.withheldCop)),
    nationalDividendExpectedWithholdingCop: sum(nat.map((d) => d.expectedWithholdingCop ?? 0)),
    descuentoArt2541Cop,
    foreignDividendsCop,
    foreignDividendTaxPaidCop: sum(ext.map((d) => d.withheldCop)),
    foreignDividendCreditCapCop: marginalRate !== undefined ? sum(ext.map((d) => d.foreignTaxCreditCapCop ?? 0)) : undefined,
    nationalInterestCop,
    foreignInterestCop,
    componenteInflacionarioCop,
    interestWithholdingCop: sum(interest.map((i) => i.withheldCop)),
  };
  if (impuestoEstimado) {
    const incremental = impuestoEstimado.impuestoCedulaGeneralIncrementalCop;
    const d2541 = Math.min(descuentoArt2541Cop, incremental);
    const d254 = Math.min(foreignCreditCap ?? 0, Math.max(0, incremental - d2541));
    impuestoEstimado.descuentoArt2541Cop = d2541;
    impuestoEstimado.descuentoArt254Cop = d254;
    impuestoEstimado.impuestoTotalEstimadoCop = incremental - d2541 - d254 + impuestoEstimado.impuestoGananciaOcasionalCop;
    impuestoEstimado.retencionesCop =
      ingresosTotals.nationalDividendWithholdingCop + sum(interest.filter((i) => i.source === 'nacional').map((i) => i.withheldCop));
    impuestoEstimado.saldoEstimadoCop = impuestoEstimado.impuestoTotalEstimadoCop - impuestoEstimado.retencionesCop;
  }

  const ingresosBrutos =
    nationalDividendsCop + foreignDividendsCop + nationalInterestCop + foreignInterestCop + ex.ingresosCop + go.ingresosCop + ro.ingresosCop + fxGain;

  const assumptions = [
    'Costo fiscal de acciones por lotes PEPS/FIFO, incluyendo comisiones (Arts. 69 y 72 ET); no se aplican reajustes fiscales opcionales (Arts. 70 y 73 ET).',
    foreignValuation === 'initial-recognition'
      ? 'Activos y efectivo en moneda extranjera a la TRM del reconocimiento inicial (Art. 269 ET); la diferencia en cambio solo se reconoce al realizarse (Art. 288 ET).'
      : 'Activos y efectivo en moneda extranjera a la TRM del 31 de diciembre (criterio alternativo seleccionado por el usuario).',
    'Venta de acciones con tenencia >= 2 años: ganancia ocasional (Art. 300 ET); < 2 años: renta ordinaria en la cédula general.',
    'Pérdidas en venta de acciones: no deducibles ni compensables (Art. 153 ET); solo se netean lotes de una misma venta.',
    realization === 'settlement'
      ? 'Las ventas se imputan al año en que se cumplen (liquidación T+2 BVC/Europa, T+1 EE.UU. desde 28-may-2024), Art. 27 ET.'
      : 'Las ventas se imputan al año de la fecha de negociación.',
    'Art. 36-1 ET solo para acciones inscritas en la BVC (XBOG) de emisores colombianos, salvo que se active la opción MGC; el 3% se mide por sociedad (todas sus clases de acciones).',
    'Fuente nacional/extranjera de dividendos e intereses según el país del emisor (instrument.country).',
    'Diferencia en cambio realizada: al usar divisas para comprar activos, pagar comisiones/impuestos o convertir a otra moneda, frente a su costo promedio en COP.' +
      (opts.withdrawalsRealizeFx ? ' También en retiros de divisas.' : ' Los retiros de divisas se asumen como traslados a otra cuenta propia (no realizan).'),
    'Dividendos nacionales: se asume que son no gravados en cabeza de la sociedad (Art. 49 ET num. 3); la parte gravada debe tomarse del certificado.',
    'Dividendos del exterior: el descuento del Art. 254 ET se calcula solo sobre la retención directa; el descuento indirecto (impuesto de la sociedad extranjera) no se estima.',
    config.componenteInflacionario !== undefined
      ? `Componente inflacionario de intereses nacionales: ${(config.componenteInflacionario * 100).toFixed(2)}% (Arts. 38-41 ET).`
      : 'No se aplicó el componente inflacionario de los intereses (Arts. 38-41 ET): indique el porcentaje del decreto del año en config.componenteInflacionario.',
  ];

  const consignacionesThreshold = config.filingIngresosUvt * uvt;
  return {
    country: 'CO',
    year,
    generatedFor: 'persona_natural_residente',
    disclaimer: TAX_DISCLAIMER,
    config,
    patrimonio: { date: yearEnd, rows: patrimonioRows, patrimonioBrutoCop, marketValueCop, foreignAssetsCop, trmDec31 },
    formulario160,
    ingresos: { dividends, interest, totals: ingresosTotals },
    ventas: {
      rows: sales,
      totals: {
        noGravadaArt361: { ...ex, utilidadCop: Math.max(0, ex.ingresosCop - ex.costosCop) },
        gananciaOcasional: {
          ...go,
          gananciaGravableCop: goGravable,
          rate: config.gananciaOcasionalRate,
          impuestoEstimadoCop: goGravable * config.gananciaOcasionalRate,
        },
        rentaOrdinaria: { ...ro, rentaLiquidaCop: roLiquida },
        pendienteCosto: { ingresosCop: sum(pend.map((r) => r.proceedsCop)), count: pend.length },
      },
    },
    diferenciaEnCambio: { rows: fxRows, realizedGainCop: fxGain, realizedLossCop: fxLoss, netCop: fxGain - fxLoss },
    impuestoEstimado,
    obligacionDeclarar: {
      patrimonioThresholdCop: config.filingPatrimonioUvt * uvt,
      ingresosThresholdCop: config.filingIngresosUvt * uvt,
      ingresosBrutosPortafolioCop: ingresosBrutos,
      consignacionesCop: depositsCop,
      byPatrimonio: patrimonioBrutoCop > config.filingPatrimonioUvt * uvt,
      byIngresosPortafolio: ingresosBrutos >= config.filingIngresosUvt * uvt,
      byConsignaciones: depositsCop > consignacionesThreshold,
      note:
        'Solo considera este portafolio. Otros activos, ingresos, consumos con tarjeta, compras y consignaciones ' +
        'también determinan la obligación de declarar (Arts. 592-594-3 ET).',
    },
    gmf: {
      rate: config.gmfRate,
      withdrawalsCop,
      estimatedGmfCop: withdrawalsCop * config.gmfRate,
      exemptMonthlyCop: config.gmfExemptMonthlyUvt * uvt,
      note:
        'GMF (4x1000, Arts. 871-881 ET): lo cobra la entidad financiera en cada retiro; no se declara en renta. Cota máxima ' +
        'informativa sobre retiros en COP del portafolio: los traslados entre cuentas del mismo titular en la misma entidad ' +
        `y los retiros de una cuenta de ahorros marcada como exenta (hasta ${config.gmfExemptMonthlyUvt} UVT/mes, Art. 879 num. 1 ET) ` +
        'no pagan GMF. El 50% del GMF efectivamente pagado y certificado es deducible (Art. 115 ET).',
    },
    assumptions,
    issues,
  };
}

function colombiaConfigIfKnown(year: number): ColombiaTaxYearConfig | undefined {
  const c = colombiaConfig(year);
  return Object.values(c.meta).some((m) => m.source.startsWith('Copiado del año')) ? undefined : c;
}

function dedupeIssues(issues: TaxIssue[]): void {
  const seen = new Set<string>();
  for (let i = issues.length - 1; i >= 0; i--) {
    const it = issues[i]!;
    const key = `${it.code}|${it.instrumentId ?? ''}|${it.transactionId ?? ''}|${it.code.startsWith('ART_36_1') ? it.message : ''}`;
    if (seen.has(key)) issues.splice(i, 1);
    else seen.add(key);
  }
}

/** Parameter provenance flattened for UIs ("needs verification" badges). */
export function colombiaParamsNeedingVerification(config: ColombiaTaxYearConfig): [string, ParamMeta][] {
  return Object.entries(config.meta).filter(([, m]) => m.status === 'needs-verification');
}
