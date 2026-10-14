import { useTranslation } from 'react-i18next';
import { AlertTriangle, Info, Plus, Stethoscope, XCircle } from 'lucide-react';
import type { Diagnostic } from '@pm/core';
import { useAnalysis } from '../hooks/useAnalysis';
import { useFmt } from '../store/app';
import { formatDate, formatMoney, formatPrice } from '../lib/format';
import { db } from '../db/schema';
import { saveTransaction } from '../db/repo';
import type { ImplicitFunding } from '../services/analysis';
import { useLiveQuery } from 'dexie-react-hooks';
import { useInstrumentMap } from '../hooks/useData';
import { describeDiagnostic, splitSuggestion, unitFactor } from '../lib/diagnosticText';

/** Core R7: divides the price by the suspected unit factor (×10, ×100, pence…) and recomputes the amount. */
export async function fixUnit(tx: { id: string; price?: number; quantity?: number }, factor: number): Promise<void> {
  if (tx.price === undefined) return;
  const price = tx.price / factor;
  await db.transactions.update(tx.id, { price, amount: tx.quantity !== undefined ? tx.quantity * price : undefined, priceConfirmed: undefined });
}

/** Core R7: records the split the price history suggests (one transaction, in the affected portfolio). */
export async function recordSplit(sp: { instrumentId: string; ratio: number; date: string }, portfolioId?: string): Promise<void> {
  const inst = await db.instruments.get(sp.instrumentId);
  const pids = portfolioId ? [portfolioId] : [...new Set((await db.transactions.where('instrumentId').equals(sp.instrumentId).toArray()).map((t) => t.portfolioId))];
  for (const pid of pids)
    await saveTransaction({ portfolioId: pid, date: sp.date, type: 'SPLIT', instrumentId: sp.instrumentId, ratio: sp.ratio, currency: inst?.currency ?? 'USD', note: 'Split sugerido por el historial de precios' });
}

/** W33: every transaction of the portfolio under `from` moves to the `to` account (same broker). */
export async function relabelAccount(portfolioId: string, from: string | undefined, to: string): Promise<void> {
  const txs = (await db.transactions.where('portfolioId').equals(portfolioId).toArray()).filter((t) => (t.account ?? '') === (from ?? ''));
  await db.transactions.bulkPut(txs.map((t) => ({ ...t, account: to || undefined })));
}

/** W22: books the deposit the engine had to assume, on the purchase date, in its portfolio. */
export async function createDepositFor(f: ImplicitFunding, note: string): Promise<void> {
  const tx = f.transactionId ? await db.transactions.get(f.transactionId) : undefined;
  if (!tx) return;
  const base = (await db.portfolios.get(tx.portfolioId))?.baseCurrency;
  const rate = base && base !== f.currency ? await fxRateOn(base, f.currency, f.date) : undefined;
  const round = (v: number, ccy: string) => (['COP', 'CLP', 'JPY'].includes(ccy) ? Math.round(v) : Math.round(v * 100) / 100);
  if (base && rate) {
    // W39: the investor deposited in the base currency and converted it (FX effect measured from here).
    const baseAmount = round(f.amount / rate, base);
    await saveTransaction({ portfolioId: tx.portfolioId, date: f.date, type: 'DEPOSIT', currency: base, amount: baseAmount, account: tx.account, note });
    await saveTransaction({
      portfolioId: tx.portfolioId,
      date: f.date,
      type: 'FX_CONVERSION',
      currency: base,
      amount: baseAmount,
      toCurrency: f.currency,
      toAmount: round(f.amount, f.currency),
      account: tx.account,
      note,
    });
    return;
  }
  await saveTransaction({ portfolioId: tx.portfolioId, date: f.date, type: 'DEPOSIT', currency: f.currency, amount: round(f.amount, f.currency), account: tx.account, note });
}

/** Units of `to` per unit of `from` on or before `date`, from the cached FX series (direct or inverse). */
export async function fxRateOn(from: string, to: string, date: string): Promise<number | undefined> {
  const pick = (pts: { date: string; rate: number }[]) => {
    let best: number | undefined;
    for (const p of pts) if (p.date <= date) best = p.rate;
    return best;
  };
  const direct = await db.fxSeries.get(`${from}/${to}`);
  const d = direct ? pick(direct.points) : undefined;
  if (d) return d;
  const inv = await db.fxSeries.get(`${to}/${from}`);
  const i = inv ? pick(inv.points) : undefined;
  if (i) return 1 / i;
  // Cross through USD (e.g. BRL → EUR).
  if (from !== 'USD' && to !== 'USD') {
    const a = await fxRateOn(from, 'USD', date);
    const b = await fxRateOn('USD', to, date);
    if (a && b) return a * b;
  }
  return undefined;
}

/**
 * Engine diagnostics (core `ledgerDiagnostics`): negative cash, oversells, unknown instruments,
 * missing FX, implicit FX conversions, maturity redemptions... Each row opens its transaction.
 */
export function DiagnosticsPanel({ onOpen }: { onOpen: (transactionId: string) => void }) {
  const { t } = useTranslation();
  const f = useFmt();
  const { analysis } = useAnalysis();
  const list = analysis?.diagnostics ?? [];
  const implicit = analysis?.implicitFunding ?? [];
  const instruments = useInstrumentMap();
  const txIds = [...list.map((d) => d.transactionId), ...implicit.map((x) => x.transactionId)].filter((x): x is string => !!x);
  // W33: deposits recorded under another account label of the same portfolio (e.g. "XP" vs
  // "XP INVESTIMENTOS CCTVM S/A"): offer to use that account instead of inventing a deposit.
  const deposits = useLiveQuery(() => db.transactions.where('type').equals('DEPOSIT').toArray(), [], []);
  const txs = useLiveQuery(async () => new Map((await db.transactions.bulkGet(txIds)).filter((x) => !!x).map((x) => [x!.id, x!])), [txIds.join('|')]);
  if (!list.length && !implicit.length) return null;
  const errors = list.filter((d) => d.severity === 'error').length;
  const warnings = list.filter((d) => d.severity === 'warning').length + implicit.length;
  const sorted = [...list].sort((a, b) => rank(a) - rank(b) || (a.date < b.date ? 1 : -1));
  return (
    <details className="card mb-3 group" open={errors > 0 || implicit.length > 0} data-testid="diagnostics">
      <summary className="flex items-center gap-2 px-4 py-3 cursor-pointer list-none">
        <Stethoscope size={15} className="text-accent" aria-hidden />
        <span className="font-semibold text-[13.5px] flex-1">{t('diag.title')}</span>
        {errors > 0 && <span className="chip !text-neg !border-neg/30">{t('diag.errors', { count: errors })}</span>}
        {warnings > 0 && <span className="chip !text-warn !border-warn/30">{t('diag.warnings', { count: warnings })}</span>}
        <span className="chip">{t('diag.total', { count: list.length + implicit.length })}</span>
      </summary>
      <p className="px-4 -mt-1 pb-2 text-xs text-muted">{t('diag.subtitle')}</p>
      <ul className="max-h-[280px] overflow-auto border-t border-line divide-y divide-line text-[13px]">
        {implicit.map((x, i) => (
          <li key={`imp-${i}`} className="flex items-start gap-2 px-4 py-2" data-testid="implicit-funding">
            <AlertTriangle size={14} className="text-warn mt-0.5 shrink-0" aria-label={t('diag.warning')} />
            <span className="num text-xs text-muted w-24 shrink-0">{formatDate(x.date, f.locale, 'short')}</span>
            <span className="flex-1">
              <span className="font-medium">{t('diag.code.IMPLICIT_DEPOSIT')}</span>{' '}
              <span className="text-ink-2 text-xs">{t('diag.implicitText', { amount: formatMoney(x.amount, x.currency, f.locale) })}</span>
            </span>
            {x.transactionId && (
              <button className="btn btn-sm btn-ghost" onClick={() => onOpen(x.transactionId!)}>
                {t('diag.open')}
              </button>
            )}
            {(() => {
              const tx = x.transactionId ? txs?.get(x.transactionId) : undefined;
              const other = tx
                ? [...new Set(deposits.filter((d) => d.portfolioId === tx.portfolioId && d.date <= x.date && (d.account ?? '') !== (tx.account ?? '')).map((d) => d.account ?? ''))][0]
                : undefined;
              return other !== undefined && tx ? (
                <button
                  className="btn btn-sm btn-primary"
                  data-testid="use-account"
                  title={t('diag.useAccountHint', { from: tx.account || '—', to: other || '—' })}
                  onClick={() => void relabelAccount(tx.portfolioId, tx.account, other)}
                >
                  {t('diag.useAccount', { account: other || t('diag.noAccount') })}
                </button>
              ) : null;
            })()}
            <button className="btn btn-sm" onClick={() => void createDepositFor(x, t('diag.implicitNote'))} data-testid="create-deposit">
              <Plus size={13} /> {t('diag.createDeposit')}
            </button>
          </li>
        ))}
        {sorted.slice(0, 200).map((d, i) => (
          <li key={i} className="flex items-start gap-2 px-4 py-2">
            {d.severity === 'error' ? <XCircle size={14} className="text-neg mt-0.5 shrink-0" aria-label={t('diag.error')} /> : d.severity === 'warning' ? <AlertTriangle size={14} className="text-warn mt-0.5 shrink-0" aria-label={t('diag.warning')} /> : <Info size={14} className="text-info mt-0.5 shrink-0" aria-label={t('diag.info')} />}
            <span className="num text-xs text-muted w-24 shrink-0">{formatDate(d.date, f.locale, 'short')}</span>
            <span className="flex-1">
              <span className="font-medium">{t(`diag.code.${d.code}`, { defaultValue: d.code })}</span>{' '}
              <span className="text-ink-2 text-xs" title={`${t('diag.details')}: ${d.message}`} data-testid="diag-text">
                {describeDiagnostic(d, { tx: d.transactionId ? txs?.get(d.transactionId) : undefined, instruments, locale: f.locale, t })}
              </span>
            </span>
            {(d.code === 'TRADE_PRICE_UNIT_SUSPECT' || d.code === 'TRADE_PRICE_CONFIRMED_BY_RUN') && d.transactionId && txs?.get(d.transactionId) && !txs.get(d.transactionId)!.priceConfirmed && (
              <>
                {d.code === 'TRADE_PRICE_UNIT_SUSPECT' && unitFactor(d.message) && (
                  <button
                    className="btn btn-sm btn-primary"
                    data-testid="fix-unit"
                    title={t('diag.fixUnitHint')}
                    onClick={() => void fixUnit(txs.get(d.transactionId!)!, unitFactor(d.message)!)}
                  >
                    {t('diag.fixUnit', { price: formatPrice((txs.get(d.transactionId)!.price ?? 0) / unitFactor(d.message)!, txs.get(d.transactionId)!.currency, f.locale) })}
                  </button>
                )}
                <button className="btn btn-sm" data-testid="confirm-price-diag" onClick={() => void db.transactions.update(d.transactionId!, { priceConfirmed: true })}>
                  {t('pw.confirm')}
                </button>
              </>
            )}
            {(d.code === 'POSSIBLE_UNRECORDED_SPLIT' || d.code === 'POSSIBLE_REDENOMINATION') &&
              (() => {
                const sp = splitSuggestion(d.message, d.data);
                if (!sp) return null;
                const ratio = sp.ratio >= 1 ? `${Math.round(sp.ratio)}:1` : `1:${Math.round(1 / sp.ratio)}`;
                return (
                  <button className="btn btn-sm btn-primary" data-testid="record-split" onClick={() => void recordSplit(sp, d.transactionId ? txs?.get(d.transactionId)?.portfolioId : undefined)}>
                    {t('diag.recordSplit', { ratio })}
                  </button>
                );
              })()}
            {d.code === 'INTEREST_POSSIBLY_NET' && d.transactionId && !txs?.get(d.transactionId)?.amountIsNet && (
              <button className="btn btn-sm" data-testid="mark-net" onClick={() => void db.transactions.update(d.transactionId!, { amountIsNet: true })}>
                {t('diag.markNet')}
              </button>
            )}
            {d.transactionId && (
              <button className="btn btn-sm btn-ghost" onClick={() => onOpen(d.transactionId!)}>
                {t('diag.open')}
              </button>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

function rank(d: Diagnostic): number {
  return d.severity === 'error' ? 0 : d.severity === 'warning' ? 1 : 2;
}
