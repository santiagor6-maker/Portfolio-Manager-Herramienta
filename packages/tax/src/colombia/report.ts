import type { CurrencyCode, Instrument, ISODate, Transaction } from '@pm/core';
import { CurrencyPool } from '../common/cashPool';
import { addYears, daysBetween } from '../common/dates';
import { TAX_DISCLAIMER } from '../common/disclaimer';
import type { LocalizedText, ParamMeta, TaxInput, TaxIssue } from '../common/types';
import { displaySymbol, grossAmount, instrumentMap, sortTransactions, sum } from '../common/util';
import { colombiaConfig, type ColombiaTaxYearConfig } from './config';

const COP = 'COP';

export interface ColombiaReportOptions {
  /** Año gravable. */
  year: number;
  /** Override the built-in yearly parameters (e.g. after a law change). */
  config?: ColombiaTaxYearConfig;
  /**
   * Outstanding shares per instrument id, to test the Art. 36-1 ET limit (3% from 2023). When
   * missing, the sale is assumed to be below the limit (typical retail investor) and flagged.
   */
  outstandingShares?: Record<string, number>;
  /**
   * How to value assets and cash in foreign currency in the patrimonio:
   * - 'initial-recognition' (default): Art. 269 ET (Ley 1819/2016): TRM of initial recognition
   *   (purchase date), with exchange differences taxed only when realized (Art. 288 ET).
   * - 'year-end': historical foreign-currency cost converted at the TRM of Dec 31 (pre-2017
   *   practice; some advisers still use it for persons not keeping books). Informative.
   */
  foreignValuation?: 'initial-recognition' | 'year-end';
  /**
   * Estimated marginal rate of the investor in the cédula general (Art. 241 ET), used only to cap
   * the foreign tax credit (Art. 254 ET). If omitted the cap is left for the accountant.
   */
  marginalRate?: number;
  /** Treat withdrawals of foreign currency as a realization of exchange difference. Default false. */
  withdrawalsRealizeFx?: boolean;
  /** Foreign-currency cash counts as "activo en el exterior" (e.g. held at a foreign broker). Default true. */
  foreignCashIsAbroad?: boolean;
  /**
   * Apply Art. 36-1 also to foreign shares listed on the BVC's Mercado Global Colombiano (XBOG,
   * country != CO). Default false: DIAN doctrine is not settled; the accountant decides.
   */
  art361IncludeMgc?: boolean;
}

export type CoSaleClass = 'no_gravada_art_36_1' | 'ganancia_ocasional' | 'renta_ordinaria';

export interface CoSaleRow {
  transactionId: string;
  instrumentId: string;
  symbol: string;
  sellDate: ISODate;
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
  currency: CurrencyCode;
  grossLocal: number;
  withheldLocal: number;
  trm: number;
  grossCop: number;
  /** National: retención en la fuente (anticipo). Foreign: impuesto pagado en el exterior. */
  withheldCop: number;
  /** Foreign only: maximum Art. 254 ET credit for the direct withholding (needs marginalRate). */
  foreignTaxCreditCapCop?: number;
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

export interface CoPatrimonioRow {
  kind: 'inversion' | 'efectivo';
  instrumentId?: string;
  symbol?: string;
  name?: string;
  currency: CurrencyCode;
  quantity: number;
  abroad: boolean;
  /** Fiscal cost in the asset currency. */
  costLocal: number;
  /** Declared (fiscal) value in COP according to `foreignValuation`. */
  fiscalValueCop: number;
  /** Informative: market price at Dec 31 x TRM Dec 31. */
  marketValueCop?: number;
  price?: number;
  trmDec31: number;
  legalBasis: string;
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
    note: string;
  };
  ingresos: {
    dividends: CoIncomeRow[];
    interest: CoIncomeRow[];
    totals: {
      nationalDividendsCop: number;
      nationalDividendWithholdingCop: number;
      foreignDividendsCop: number;
      foreignDividendTaxPaidCop: number;
      foreignDividendCreditCapCop?: number;
      nationalInterestCop: number;
      foreignInterestCop: number;
      interestWithholdingCop: number;
    };
  };
  ventas: {
    rows: CoSaleRow[];
    totals: {
      noGravadaArt361: { ingresosCop: number; costosCop: number; utilidadCop: number };
      gananciaOcasional: {
        ingresosCop: number;
        costosCop: number;
        gananciaGravableCop: number;
        rate: number;
        impuestoEstimadoCop: number;
      };
      rentaOrdinaria: { ingresosCop: number; costosCop: number; rentaLiquidaCop: number };
    };
  };
  diferenciaEnCambio: { rows: CoFxRow[]; realizedGainCop: number; realizedLossCop: number; netCop: number };
  obligacionDeclarar: {
    patrimonioThresholdCop: number;
    ingresosThresholdCop: number;
    /** Gross income from this portfolio only (dividends, interest, gross sale proceeds). */
    ingresosBrutosPortafolioCop: number;
    byPatrimonio: boolean;
    byIngresosPortafolio: boolean;
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
  const instruments = instrumentMap(input.instruments);
  const issues: TaxIssue[] = [];
  const missingTrm = new Set<string>();

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
  const soldInYear = new Map<string, number>();
  let withdrawalsCop = 0;
  let poolShortfallWarned = false;

  const txs = sortTransactions(input.transactions).filter((t) => t.date <= yearEnd);
  const inYear = (t: Transaction) => t.date >= yearStart && t.date <= yearEnd;

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
      case 'DEPOSIT':
        cashIn(tx, ccy, grossAmount(tx));
        break;
      case 'WITHDRAWAL': {
        const amt = grossAmount(tx);
        if (inYear(tx)) withdrawalsCop += amt * trm(ccy, tx.date);
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
      case 'BUY':
      case 'TRANSFER_IN': {
        const qty = tx.quantity ?? 0;
        const costLocal = grossAmount(tx) + fees;
        const rate = trm(ccy, tx.date);
        const list = lots.get(id) ?? [];
        list.push({ openDate: tx.date, quantity: qty, costLocal, costCop: costLocal * rate });
        lots.set(id, list);
        if (tx.type === 'BUY') cashOut(tx, ccy, costLocal, true, `Compra de ${displaySymbol(id, inst)} con divisas`);
        break;
      }
      case 'SELL':
      case 'TRANSFER_OUT': {
        let remaining = tx.quantity ?? 0;
        const totalQty = remaining;
        const proceedsLocal = tx.type === 'SELL' ? grossAmount(tx) - fees : 0;
        const rate = trm(ccy, tx.date);
        const list = lots.get(id) ?? [];
        if (tx.type === 'SELL' && inYear(tx)) soldInYear.set(id, (soldInYear.get(id) ?? 0) + totalQty);
        while (remaining > 1e-12) {
          const lot = list[0];
          if (!lot) {
            issues.push({
              level: 'error',
              code: 'OVERSELL',
              transactionId: tx.id,
              instrumentId: id,
              message: `Venta de ${remaining} unidades de ${displaySymbol(id, inst)} sin compras registradas; costo fiscal asumido 0.`,
            });
            if (tx.type === 'SELL' && inYear(tx)) {
              sales.push(saleRow(tx, inst, id, { openDate: tx.date, quantity: remaining, costLocal: 0, costCop: 0 }, remaining, totalQty, proceedsLocal, rate));
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
          if (tx.type === 'SELL' && inYear(tx)) {
            sales.push(saleRow(tx, inst, id, slice, take, totalQty, proceedsLocal, rate));
          }
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
        for (const lot of lots.get(id) ?? []) lot.quantity *= ratio;
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
  ): CoSaleRow {
    const proceedsLocal = totalQty > 0 ? (proceedsLocalTotal * qty) / totalQty : 0;
    const proceedsCop = proceedsLocal * rate;
    const longTerm = tx.date >= addYears(slice.openDate, config.gananciaOcasionalMinYears);
    return {
      transactionId: tx.id,
      instrumentId: id,
      symbol: displaySymbol(id, inst),
      sellDate: tx.date,
      openDate: slice.openDate,
      holdingDays: daysBetween(slice.openDate, tx.date),
      quantity: qty,
      currency: tx.currency,
      proceedsLocal,
      costLocal: slice.costLocal,
      trmSale: rate,
      proceedsCop,
      costCop: slice.costCop,
      gainCop: proceedsCop - slice.costCop,
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
    const row: CoIncomeRow = {
      transactionId: tx.id,
      date: tx.date,
      type,
      source: national ? 'nacional' : 'exterior',
      instrumentId: tx.instrumentId,
      symbol: tx.instrumentId ? displaySymbol(tx.instrumentId, inst) : undefined,
      currency: tx.currency,
      grossLocal: gross,
      withheldLocal: withheld,
      trm: rate,
      grossCop: gross * rate,
      withheldCop: withheld * rate,
    };
    if (!national && opts.marginalRate !== undefined) {
      row.foreignTaxCreditCapCop = Math.min(row.withheldCop, row.grossCop * opts.marginalRate);
    }
    return row;
  }

  // --- Art. 36-1 classification -------------------------------------------------------------
  for (const row of sales) {
    const inst = instruments.get(row.instrumentId);
    if (!isArt361Eligible(inst, opts.art361IncludeMgc ?? false)) continue;
    const outstanding = opts.outstandingShares?.[row.instrumentId];
    const sold = soldInYear.get(row.instrumentId) ?? 0;
    if (outstanding === undefined) {
      if (!issues.some((i) => i.code === 'ART_36_1_ASSUMED' && i.instrumentId === row.instrumentId)) {
        issues.push({
          level: 'info',
          code: 'ART_36_1_ASSUMED',
          instrumentId: row.instrumentId,
          message:
            `Se asume que las ventas de ${row.symbol} en ${year} no superan el ` +
            `${(config.art361MaxShareOfOutstanding * 100).toFixed(0)}% de las acciones en circulación (Art. 36-1 ET).`,
        });
      }
    } else if (sold / outstanding > config.art361MaxShareOfOutstanding) {
      issues.push({
        level: 'warning',
        code: 'ART_36_1_LIMIT_EXCEEDED',
        instrumentId: row.instrumentId,
        message: `Las ventas de ${row.symbol} superan el límite del Art. 36-1 ET; la utilidad no es exenta.`,
      });
      continue;
    }
    row.classification = 'no_gravada_art_36_1';
    row.legalBasis = 'Art. 36-1 ET (acciones inscritas en bolsa colombiana)';
  }
  dedupeIssues(issues);

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
    });
  }
  if (copCash > 1e-6) {
    patrimonioRows.push({
      kind: 'efectivo',
      currency: COP,
      quantity: copCash,
      abroad: false,
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
  for (const b of pool.snapshot()) {
    const rateEnd = trmEnd(b.currency);
    patrimonioRows.push({
      kind: 'efectivo',
      currency: b.currency,
      quantity: b.units,
      abroad: foreignCashIsAbroad,
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
  const formulario160 = {
    filingYear,
    uvtUsed,
    uvtYear: nextCfg ? filingYear : year,
    uvtIsEstimate: !nextCfg,
    thresholdCop: f160Threshold,
    foreignAssetsCop,
    required: foreignAssetsCop > f160Threshold,
    itemizedRequired: foreignAssetsCop > config.foreignAssetsItemizedUvt * uvtUsed,
    note:
      `Art. 607 ET: declaración anual de activos en el exterior (Formulario 160) en ${filingYear} si el valor ` +
      `patrimonial de los activos en el exterior al 1-ene-${filingYear} supera ${config.foreignAssetsDeclarationUvt} UVT. ` +
      `Por encima de ${config.foreignAssetsItemizedUvt} UVT deben discriminarse activo por activo.` +
      (nextCfg ? '' : ` La UVT de ${filingYear} no está en la tabla: se usó la de ${year} (estimado).`),
  };

  // --- totals ---------------------------------------------------------------------------------
  const nat = dividends.filter((d) => d.source === 'nacional');
  const ext = dividends.filter((d) => d.source === 'exterior');
  const capKnown = opts.marginalRate !== undefined;
  const ingresosTotals = {
    nationalDividendsCop: sum(nat.map((d) => d.grossCop)),
    nationalDividendWithholdingCop: sum(nat.map((d) => d.withheldCop)),
    foreignDividendsCop: sum(ext.map((d) => d.grossCop)),
    foreignDividendTaxPaidCop: sum(ext.map((d) => d.withheldCop)),
    foreignDividendCreditCapCop: capKnown ? sum(ext.map((d) => d.foreignTaxCreditCapCop ?? 0)) : undefined,
    nationalInterestCop: sum(interest.filter((i) => i.source === 'nacional').map((i) => i.grossCop)),
    foreignInterestCop: sum(interest.filter((i) => i.source === 'exterior').map((i) => i.grossCop)),
    interestWithholdingCop: sum(interest.map((i) => i.withheldCop)),
  };

  const by = (c: CoSaleClass) => sales.filter((s) => s.classification === c);
  const totalsOf = (rows: CoSaleRow[]) => ({
    ingresosCop: sum(rows.map((r) => r.proceedsCop)),
    costosCop: sum(rows.map((r) => r.costCop)),
  });
  const ex = totalsOf(by('no_gravada_art_36_1'));
  const go = totalsOf(by('ganancia_ocasional'));
  const ro = totalsOf(by('renta_ordinaria'));
  const goGravable = Math.max(0, go.ingresosCop - go.costosCop);

  const fxGain = sum(fxRows.filter((r) => r.gainCop > 0).map((r) => r.gainCop));
  const fxLoss = sum(fxRows.filter((r) => r.gainCop < 0).map((r) => -r.gainCop));

  const ingresosBrutos =
    ingresosTotals.nationalDividendsCop +
    ingresosTotals.foreignDividendsCop +
    ingresosTotals.nationalInterestCop +
    ingresosTotals.foreignInterestCop +
    ex.ingresosCop +
    go.ingresosCop +
    ro.ingresosCop +
    fxGain;

  const assumptions = [
    'Costo fiscal de acciones por lotes PEPS/FIFO, incluyendo comisiones (Arts. 69 y 72 ET); no se aplican reajustes fiscales opcionales (Arts. 70 y 73 ET).',
    foreignValuation === 'initial-recognition'
      ? 'Activos y efectivo en moneda extranjera a la TRM del reconocimiento inicial (Art. 269 ET); la diferencia en cambio solo se reconoce al realizarse (Art. 288 ET).'
      : 'Activos y efectivo en moneda extranjera a la TRM del 31 de diciembre (criterio alternativo seleccionado por el usuario).',
    'Venta de acciones con tenencia >= 2 años: ganancia ocasional (Art. 300 ET); < 2 años: renta ordinaria en la cédula general.',
    'Art. 36-1 ET solo para acciones inscritas en la BVC (XBOG) de emisores colombianos, salvo que se active la opción MGC.',
    'Fuente nacional/extranjera de dividendos e intereses según el país del emisor (instrument.country).',
    'Diferencia en cambio realizada: al usar divisas para comprar activos, pagar comisiones/impuestos o convertir a otra moneda, frente a su costo promedio en COP.' +
      (opts.withdrawalsRealizeFx ? ' También en retiros de divisas.' : ' Los retiros de divisas se asumen como traslados a otra cuenta propia (no realizan).'),
    'Dividendos nacionales: se asume que la parte gravada/no gravada (Art. 49 ET) la certifica la sociedad; el reporte presenta el valor bruto y la retención.',
    'Dividendos del exterior: el descuento del Art. 254 ET se calcula solo sobre la retención directa; el descuento indirecto (impuesto de la sociedad extranjera) no se estima.',
  ];

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
        noGravadaArt361: { ...ex, utilidadCop: ex.ingresosCop - ex.costosCop },
        gananciaOcasional: {
          ...go,
          gananciaGravableCop: goGravable,
          rate: config.gananciaOcasionalRate,
          impuestoEstimadoCop: goGravable * config.gananciaOcasionalRate,
        },
        rentaOrdinaria: { ...ro, rentaLiquidaCop: ro.ingresosCop - ro.costosCop },
      },
    },
    diferenciaEnCambio: { rows: fxRows, realizedGainCop: fxGain, realizedLossCop: fxLoss, netCop: fxGain - fxLoss },
    obligacionDeclarar: {
      patrimonioThresholdCop: config.filingPatrimonioUvt * config.uvt,
      ingresosThresholdCop: config.filingIngresosUvt * config.uvt,
      ingresosBrutosPortafolioCop: ingresosBrutos,
      byPatrimonio: patrimonioBrutoCop > config.filingPatrimonioUvt * config.uvt,
      byIngresosPortafolio: ingresosBrutos >= config.filingIngresosUvt * config.uvt,
      note:
        'Solo considera este portafolio. Otros activos, ingresos, consumos con tarjeta, compras y consignaciones ' +
        'también determinan la obligación de declarar (Arts. 592-594-3 ET).',
    },
    gmf: {
      rate: config.gmfRate,
      withdrawalsCop,
      estimatedGmfCop: withdrawalsCop * config.gmfRate,
      exemptMonthlyCop: config.gmfExemptMonthlyUvt * config.uvt,
      note:
        'GMF (4x1000, Arts. 871-881 ET): lo cobra la entidad financiera en cada retiro; no se declara en renta. ' +
        `Una cuenta de ahorros marcada como exenta no paga GMF hasta ${config.gmfExemptMonthlyUvt} UVT al mes ` +
        '(Art. 879 num. 1 ET). El 50% del GMF efectivamente pagado y certificado es deducible (Art. 115 ET). Estimación informativa.',
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
    const key = `${it.code}|${it.instrumentId ?? ''}|${it.transactionId ?? ''}`;
    if (seen.has(key)) issues.splice(i, 1);
    else seen.add(key);
  }
}

/** Parameter provenance flattened for UIs ("needs verification" badges). */
export function colombiaParamsNeedingVerification(config: ColombiaTaxYearConfig): [string, ParamMeta][] {
  return Object.entries(config.meta).filter(([, m]) => m.status === 'needs-verification');
}
