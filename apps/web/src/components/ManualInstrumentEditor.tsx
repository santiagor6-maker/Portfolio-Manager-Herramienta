import { useTranslation } from 'react-i18next';
import { AlertTriangle } from 'lucide-react';
import type { AccrualSpec, AssetClass, DayCount, IndexId, Instrument } from '@pm/core';
import { CURRENCY_CODES } from '../lib/currencies';
import { MANUAL_EXCHANGES, exchangeLabel } from '../lib/exchanges';
import { parseDecimal } from '../lib/parse';

export interface ManualDraft {
  name: string;
  symbol: string;
  currency: string;
  exchange: string;
  country: string;
  assetClass: AssetClass;
  /** Accrual (CDT, CDB, LCI/LCA, Tesouro...) — only for fixed income. Rates as typed strings. */
  accrualOn: boolean;
  accrualKind: 'fixed' | 'indexed';
  rate: string;
  index: IndexId;
  percentOfIndex: string;
  spread: string;
  dayCount: DayCount;
  issueDate: string;
  maturity: string;
}

const CLASSES: AssetClass[] = ['fixed_income', 'fund', 'bond', 'equity', 'etf', 'reit', 'crypto', 'commodity', 'other'];
const INDICES: IndexId[] = ['CDI', 'SELIC', 'IPCA', 'IPC_CO', 'IBR', 'UVR'];

export function slug(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 24);
}

export function draftFrom(name: string, ccy: string, template?: Instrument): ManualDraft {
  const a = template?.accrual;
  const pct = (v?: number) => (v === undefined ? '' : String(Math.round(v * 10000) / 100));
  return {
    name: template ? '' : name,
    symbol: template ? '' : slug(name),
    currency: template?.currency ?? ccy,
    exchange: 'MANUAL',
    country: template?.country ?? (ccy === 'BRL' ? 'BR' : 'CO'),
    assetClass: template?.assetClass ?? 'fixed_income',
    accrualOn: !!a || !template,
    accrualKind: a?.kind ?? 'fixed',
    rate: pct(a?.annualRate),
    index: a?.index ?? (ccy === 'BRL' ? 'CDI' : 'IBR'),
    percentOfIndex: a?.percentOfIndex !== undefined ? pct(a.percentOfIndex > 3 ? a.percentOfIndex / 100 : a.percentOfIndex) : '100',
    spread: pct(a?.spread),
    dayCount: a?.dayCount ?? (ccy === 'BRL' ? 'BUS/252' : 'ACT/365'),
    issueDate: '',
    maturity: '',
  };
}

/** Validates and converts the draft into an Instrument (errors are i18n keys per field). */
export function draftToInstrument(d: ManualDraft, locale: string): { instrument?: Instrument; errors: Partial<Record<keyof ManualDraft, string>> } {
  const errors: Partial<Record<keyof ManualDraft, string>> = {};
  if (!d.name.trim()) errors.name = 'validation.required';
  if (!/^[A-Z]{3}$/.test(d.currency)) errors.currency = 'validation.currency';
  if (!/^[A-Z]{2}$/.test(d.country)) errors.country = 'validation.country';
  let accrual: AccrualSpec | undefined;
  const fixedIncome = d.assetClass === 'fixed_income' || d.assetClass === 'bond';
  if (fixedIncome && d.accrualOn) {
    const num = (s: string) => parseDecimal(s, locale);
    if (d.accrualKind === 'fixed') {
      const r = num(d.rate);
      if (r === undefined || r <= 0 || r > 100) errors.rate = 'validation.rate';
      else accrual = { kind: 'fixed', annualRate: r / 100, dayCount: d.dayCount };
    } else {
      const p = num(d.percentOfIndex);
      const s = num(d.spread);
      if ((p === undefined || p <= 0) && (s === undefined || s === 0)) errors.percentOfIndex = 'validation.rate';
      else accrual = { kind: 'indexed', index: d.index, percentOfIndex: p !== undefined ? p / 100 : undefined, spread: s !== undefined ? s / 100 : undefined, dayCount: d.dayCount };
    }
    if (d.maturity && d.issueDate && d.maturity <= d.issueDate) errors.maturity = 'validation.maturity';
    if (accrual) {
      if (d.issueDate) accrual.issueDate = d.issueDate;
      if (d.maturity) accrual.maturity = d.maturity;
    }
  }
  if (Object.keys(errors).length) return { errors };
  const symbol = (d.symbol.trim() || slug(d.name)).toUpperCase();
  return {
    errors,
    instrument: {
      id: `${d.exchange === 'MANUAL' ? 'MANUAL' : d.exchange}:${symbol}`,
      symbol,
      name: d.name.trim(),
      exchange: d.exchange,
      currency: d.currency,
      country: d.country,
      assetClass: d.assetClass,
      pricing: 'manual',
      accrual,
    },
  };
}

export function ManualInstrumentEditor({
  draft,
  onChange,
  errors,
  conflict,
  onUseConflict,
  onCancel,
}: {
  draft: ManualDraft;
  onChange: (d: ManualDraft) => void;
  errors: Partial<Record<keyof ManualDraft, string>>;
  conflict?: Instrument;
  onUseConflict: () => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const set = <K extends keyof ManualDraft>(k: K, v: ManualDraft[K]) => onChange({ ...draft, [k]: v });
  const fixedIncome = draft.assetClass === 'fixed_income' || draft.assetClass === 'bond';
  const err = (k: keyof ManualDraft) =>
    errors[k] ? (
      <p className="text-xs text-neg mt-1" role="alert">
        {t(errors[k]!)}
      </p>
    ) : null;
  return (
    <div className="rounded-lg border border-line bg-surface-2/50 p-3 flex flex-col gap-3" data-testid="manual-instrument">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[13px] font-semibold">{t('manual.title')}</div>
        <button type="button" className="btn btn-sm btn-ghost" onClick={onCancel}>
          {t('tx.searchInstead')}
        </button>
      </div>
      {conflict && (
        <div className="flex items-start gap-2 rounded-md bg-warn-soft border border-warn/30 p-2 text-[12.5px]" role="alert">
          <AlertTriangle size={14} className="text-warn mt-0.5 shrink-0" />
          <div className="flex-1">
            {t('manual.conflict', { symbol: conflict.symbol, exchange: exchangeLabel(conflict.exchange), name: conflict.name })}
            <div className="mt-1.5">
              <button type="button" className="btn btn-sm" onClick={onUseConflict}>
                {t('manual.useQuoted', { symbol: conflict.symbol })}
              </button>
            </div>
          </div>
        </div>
      )}
      <div className="grid grid-cols-2 sm:grid-cols-6 gap-2">
        <div className="col-span-2 sm:col-span-3">
          <label className="label" htmlFor="m-name">
            {t('tx.manualName')}
          </label>
          <input id="m-name" className="input" aria-invalid={!!errors.name} value={draft.name} onChange={(e) => onChange({ ...draft, name: e.target.value, symbol: slug(e.target.value) })} placeholder={t('manual.namePlaceholder')} />
          {err('name')}
        </div>
        <div className="sm:col-span-1">
          <label className="label" htmlFor="m-symbol">
            {t('manual.symbol')}
          </label>
          <input id="m-symbol" className="input uppercase" value={draft.symbol} onChange={(e) => set('symbol', e.target.value.toUpperCase())} />
        </div>
        <div>
          <label className="label" htmlFor="m-ccy">
            {t('dim.currency')}
          </label>
          <select id="m-ccy" className="select" value={draft.currency} onChange={(e) => set('currency', e.target.value)}>
            {CURRENCY_CODES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="label" htmlFor="m-country">
            {t('dim.country')}
          </label>
          <input id="m-country" className="input uppercase" maxLength={2} aria-invalid={!!errors.country} value={draft.country} onChange={(e) => set('country', e.target.value.toUpperCase())} />
          {err('country')}
        </div>
        <div className="col-span-1 sm:col-span-3">
          <label className="label" htmlFor="m-class">
            {t('dim.assetClass')}
          </label>
          <select id="m-class" className="select" value={draft.assetClass} onChange={(e) => set('assetClass', e.target.value as AssetClass)}>
            {CLASSES.map((c) => (
              <option key={c} value={c}>
                {t(`assetClass.${c}`)}
              </option>
            ))}
          </select>
        </div>
        <div className="col-span-1 sm:col-span-3">
          <label className="label" htmlFor="m-exchange">
            {t('manual.exchange')}
          </label>
          <select id="m-exchange" className="select" value={draft.exchange} onChange={(e) => set('exchange', e.target.value)}>
            {MANUAL_EXCHANGES.map((x) => (
              <option key={x} value={x}>
                {exchangeLabel(x)}
              </option>
            ))}
          </select>
        </div>
      </div>
      {fixedIncome && (
        <fieldset className="rounded-md border border-line p-2.5 grid grid-cols-2 sm:grid-cols-6 gap-2">
          <legend className="px-1 text-xs font-semibold text-ink-2">
            <label className="flex items-center gap-1.5">
              <input type="checkbox" checked={draft.accrualOn} onChange={(e) => set('accrualOn', e.target.checked)} /> {t('manual.accrual')}
            </label>
          </legend>
          {draft.accrualOn && (
            <>
              <div className="col-span-2 sm:col-span-2">
                <label className="label" htmlFor="m-kind">
                  {t('manual.kind')}
                </label>
                <select id="m-kind" className="select" value={draft.accrualKind} onChange={(e) => set('accrualKind', e.target.value as 'fixed' | 'indexed')}>
                  <option value="fixed">{t('manual.kindFixed')}</option>
                  <option value="indexed">{t('manual.kindIndexed')}</option>
                </select>
              </div>
              {draft.accrualKind === 'fixed' ? (
                <div className="col-span-2 sm:col-span-2">
                  <label className="label" htmlFor="m-rate">
                    {t('manual.rate')}
                  </label>
                  <input id="m-rate" className="input num" inputMode="decimal" aria-invalid={!!errors.rate} value={draft.rate} onChange={(e) => set('rate', e.target.value)} placeholder="12,5" />
                  {err('rate')}
                </div>
              ) : (
                <>
                  <div>
                    <label className="label" htmlFor="m-index">
                      {t('manual.index')}
                    </label>
                    <select id="m-index" className="select" value={draft.index} onChange={(e) => set('index', e.target.value)}>
                      {INDICES.map((i) => (
                        <option key={i} value={i}>
                          {t(`index.${i}`, { defaultValue: i })}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="label" htmlFor="m-pct">
                      {t('manual.percentOfIndex')}
                    </label>
                    <input id="m-pct" className="input num" inputMode="decimal" aria-invalid={!!errors.percentOfIndex} value={draft.percentOfIndex} onChange={(e) => set('percentOfIndex', e.target.value)} placeholder="110" />
                    {err('percentOfIndex')}
                  </div>
                  <div>
                    <label className="label" htmlFor="m-spread">
                      {t('manual.spread')}
                    </label>
                    <input id="m-spread" className="input num" inputMode="decimal" value={draft.spread} onChange={(e) => set('spread', e.target.value)} placeholder="4" />
                  </div>
                </>
              )}
              <div className="col-span-2 sm:col-span-2">
                <label className="label" htmlFor="m-daycount">
                  {t('manual.dayCount')}
                </label>
                <select id="m-daycount" className="select" value={draft.dayCount} onChange={(e) => set('dayCount', e.target.value as DayCount)}>
                  {(['ACT/365', 'BUS/252', 'ACT/360', '30/360'] as DayCount[]).map((d) => (
                    <option key={d}>{d}</option>
                  ))}
                </select>
              </div>
              <div className="col-span-1 sm:col-span-2">
                <label className="label" htmlFor="m-issue">
                  {t('manual.issueDate')}
                </label>
                <input id="m-issue" type="date" className="input" value={draft.issueDate} onChange={(e) => set('issueDate', e.target.value)} />
              </div>
              <div className="col-span-1 sm:col-span-2">
                <label className="label" htmlFor="m-maturity">
                  {t('manual.maturity')}
                </label>
                <input id="m-maturity" type="date" className="input" aria-invalid={!!errors.maturity} value={draft.maturity} onChange={(e) => set('maturity', e.target.value)} />
                {err('maturity')}
              </div>
              <p className="col-span-full text-xs text-muted">{t('manual.accrualHint')}</p>
            </>
          )}
        </fieldset>
      )}
      {!fixedIncome || !draft.accrualOn ? <p className="text-xs text-muted">{t('tx.manualHint')}</p> : null}
    </div>
  );
}
