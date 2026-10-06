import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLiveQuery } from 'dexie-react-hooks';
import clsx from 'clsx';
import { CheckCircle2, Sparkles } from 'lucide-react';
import * as core from '@pm/core';
import type { Instrument, TransactionType } from '@pm/core';
import { Banner, Field, Modal } from './ui';
import { InstrumentPicker, type ManualRequest } from './InstrumentPicker';
import { ManualInstrumentEditor, draftFrom, draftToInstrument, type ManualDraft } from './ManualInstrumentEditor';
import { NEEDS_AMOUNT, NEEDS_INSTRUMENT, NEEDS_QTY_PRICE, NEEDS_RATIO, validateTxDraft, type TxDraft, type TxErrors } from './txValidation';
import { CURRENCY_CODES } from '../lib/currencies';
import { parseDecimal, toInputNumber } from '../lib/parse';
import { formatDate, formatFxRate, formatMoney, formatPct, formatPrice } from '../lib/format';
import { addDays, todayIso } from '../lib/ids';
import { useFmt, useApp } from '../store/app';
import { useInstrumentMap, usePortfolios } from '../hooks/useData';
import { createPortfolio, saveTransaction, upsertInstruments } from '../db/repo';
import { db, type StoredTransaction } from '../db/schema';
import { fetchHistory } from '../services/marketData';

const NEW_PORTFOLIO = '__new';
const QUICK: TransactionType[] = ['BUY', 'SELL', 'DIVIDEND', 'DEPOSIT', 'WITHDRAWAL', 'FX_CONVERSION'];
const OTHER: TransactionType[] = ['INTEREST', 'FEE', 'TAX', 'SPLIT', 'STOCK_DIVIDEND', 'TRANSFER_IN', 'TRANSFER_OUT', 'RETURN_OF_CAPITAL'];
/** Tolerances before warning: trade price vs close of the day, FX conversion vs official/market rate. */
export const PRICE_TOLERANCE = 0.05;
export const FX_TOLERANCE = 0.02;

type NumField = 'quantity' | 'price' | 'amount' | 'fees' | 'taxes' | 'toAmount' | 'ratio' | 'fxRateToBase';

/** Name of the reference rate for a pair: TRM for COP, PTAX for BRL, market otherwise. */
export function fxReferenceName(a: string, b: string): 'TRM' | 'PTAX' | 'market' {
  if (a === 'COP' || b === 'COP') return 'TRM';
  if (a === 'BRL' || b === 'BRL') return 'PTAX';
  return 'market';
}

export function TransactionForm({
  open,
  onClose,
  editing,
  duplicateOf,
  presetInstrumentId,
  heldQuantity,
}: {
  open: boolean;
  onClose: () => void;
  editing?: StoredTransaction;
  /** Prefill from an existing row but save as a new transaction. */
  duplicateOf?: StoredTransaction;
  presetInstrumentId?: string;
  heldQuantity?: (instrumentId: string) => number | undefined;
}) {
  const { t } = useTranslation();
  const f = useFmt();
  const portfolios = usePortfolios();
  const instruments = useInstrumentMap();
  const selected = useApp((s) => s.settings.selectedPortfolioId);
  const defaultCostMethod = useApp((s) => s.settings.defaultCostMethod);
  const setSelected = useApp((s) => s.setSetting);
  // With only the sample portfolio present, the first real transaction goes to a new portfolio.
  const defaultPortfolio =
    portfolios.find((p) => p.id === selected && !p.isDemo)?.id ?? portfolios.find((p) => !p.isDemo)?.id ?? NEW_PORTFOLIO;

  const [type, setType] = useState<TransactionType>('BUY');
  const [portfolioChoice, setPortfolioId] = useState(defaultPortfolio);
  const portfolioId =
    portfolioChoice === NEW_PORTFOLIO || portfolios.some((p) => p.id === portfolioChoice) ? portfolioChoice : defaultPortfolio;
  const [date, setDate] = useState(todayIso());
  const [instrument, setInstrument] = useState<Instrument>();
  const [currency, setCurrency] = useState(f.currency);
  const [toCurrency, setToCurrency] = useState('USD');
  const [nums, setNums] = useState<Partial<Record<NumField, string>>>({});
  const [priceAuto, setPriceAuto] = useState(false);
  const [account, setAccount] = useState('');
  const [note, setNote] = useState('');
  const [manual, setManual] = useState<ManualDraft>();
  const [conflict, setConflict] = useState<Instrument>();
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedCount, setSavedCount] = useState(0);
  const fetched = useRef(new Set<string>());
  const firstField = useRef<HTMLDivElement>(null);

  // (Re)initialise when opened.
  useEffect(() => {
    if (!open) return;
    setSubmitted(false);
    setManual(undefined);
    setConflict(undefined);
    setSavedCount(0);
    const src = editing ?? duplicateOf;
    if (src) {
      setType(src.type);
      setPortfolioId(src.portfolioId);
      setDate(duplicateOf ? todayIso() : src.date);
      setInstrument(src.instrumentId ? instruments.get(src.instrumentId) : undefined);
      setCurrency(src.currency);
      setToCurrency(src.toCurrency ?? 'USD');
      const n: Partial<Record<NumField, string>> = {};
      for (const k of ['quantity', 'price', 'amount', 'fees', 'taxes', 'toAmount', 'ratio', 'fxRateToBase'] as NumField[]) {
        const v = src[k];
        if (v !== undefined) n[k] = toInputNumber(v, f.locale);
      }
      setNums(n);
      setPriceAuto(false);
      setAccount(src.account ?? '');
      setNote(src.note ?? '');
    } else {
      setType('BUY');
      setPortfolioId(defaultPortfolio);
      setDate(todayIso());
      const pre = presetInstrumentId ? instruments.get(presetInstrumentId) : undefined;
      setInstrument(pre);
      setCurrency(pre?.currency ?? f.currency);
      setNums({});
      setPriceAuto(false);
      setAccount('');
      setNote('');
    }
  }, [open, editing, duplicateOf]); // eslint-disable-line react-hooks/exhaustive-deps

  const num = (k: NumField) => parseDecimal(nums[k] ?? '', f.locale);
  const manualResult = manual ? draftToInstrument(manual, f.locale) : undefined;
  const draft: TxDraft = {
    portfolioId,
    type,
    date,
    instrument: instrument ?? manualResult?.instrument,
    quantity: num('quantity'),
    price: num('price'),
    amount: num('amount'),
    fees: num('fees'),
    taxes: num('taxes'),
    currency,
    toCurrency,
    toAmount: num('toAmount'),
    ratio: num('ratio'),
    fxRateToBase: num('fxRateToBase'),
    account: account || undefined,
    note: note || undefined,
  };
  const held = draft.instrument ? heldQuantity?.(draft.instrument.id) : undefined;
  const { errors, warnings } = validateTxDraft(draft, { today: todayIso(), heldQuantity: held });

  // ---- Market reference price for the trade date (suggested + sanity check) ----
  const series = useLiveQuery(() => (instrument ? db.priceSeries.get(instrument.id) : undefined), [instrument?.id]);
  const ref = useMemo(() => {
    if (!series || !NEEDS_QTY_PRICE.includes(type)) return undefined;
    let best: { date: string; close: number } | undefined;
    for (const p of series.points) {
      if (p.date > date) break;
      best = p;
    }
    // Too old to be a useful reference.
    return best && best.date >= addDays(date, -10) ? best : undefined;
  }, [series, date, type]);
  useEffect(() => {
    if (!open || !instrument || instrument.pricing === 'manual' || instrument.accrual || !NEEDS_QTY_PRICE.includes(type)) return;
    const key = `${instrument.id}|${date.slice(0, 7)}`;
    const covers = series?.points.some((p) => p.date <= date && p.date >= addDays(date, -10));
    if (covers || fetched.current.has(key)) return;
    fetched.current.add(key);
    void fetchHistory(instrument, addDays(date, -20));
  }, [open, instrument, date, type, series]);
  useEffect(() => {
    if (!ref || !(priceAuto || !nums.price) || editing) return;
    setNums((n) => ({ ...n, price: toInputNumber(ref.close, f.locale) }));
    setPriceAuto(true);
  }, [ref?.date, ref?.close]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---- FX reference for conversions ----
  const fxRows = useLiveQuery(() => (type === 'FX_CONVERSION' ? db.fxSeries.toArray() : []), [type]);
  const fxRef = useMemo(() => {
    if (type !== 'FX_CONVERSION' || !fxRows?.length || currency === toCurrency) return undefined;
    try {
      const m = core.createMarketData({ prices: [], fx: fxRows.map(({ base, quote, points, source }) => ({ base, quote, points, source })) });
      return m.fx(currency, toCurrency, date);
    } catch {
      return undefined;
    }
  }, [type, fxRows, currency, toCurrency, date]);

  const extraWarnings: string[] = [];
  if (ref && draft.price && NEEDS_QTY_PRICE.includes(type)) {
    const diff = draft.price / ref.close - 1;
    if (Math.abs(diff) > PRICE_TOLERANCE)
      extraWarnings.push(t('validation.priceVsMarket', { diff: formatPct(diff, f.locale, { signed: true, decimals: 1 }), close: formatPrice(ref.close, currency, f.locale), date: formatDate(ref.date, f.locale) }));
  }
  const implied = draft.amount && draft.toAmount ? draft.toAmount / draft.amount : undefined;
  const refName = fxReferenceName(currency, toCurrency);
  if (implied && fxRef) {
    const diff = implied / fxRef - 1;
    if (Math.abs(diff) > FX_TOLERANCE)
      extraWarnings.push(
        t('validation.fxVsMarket', {
          diff: formatPct(diff, f.locale, { signed: true, decimals: 1 }),
          ref: t(`tx.fxRef.${refName}`),
          rate: `1 ${currency} = ${formatFxRate(fxRef, f.locale)} ${toCurrency}`,
        }),
      );
  }

  const showErr = (k: keyof TxErrors) => (submitted && errors[k] ? t(errors[k]!) : undefined);
  const total = useMemo(() => {
    if (NEEDS_QTY_PRICE.includes(type)) {
      const g = (draft.quantity ?? 0) * (draft.price ?? 0);
      return type === 'SELL' ? g - (draft.fees ?? 0) - (draft.taxes ?? 0) : g + (draft.fees ?? 0) + (draft.taxes ?? 0);
    }
    if (type === 'DIVIDEND' || type === 'INTEREST') return (draft.amount ?? 0) - (draft.taxes ?? 0);
    return draft.amount;
  }, [type, draft.quantity, draft.price, draft.fees, draft.taxes, draft.amount]);

  const submit = async (again = false) => {
    setSubmitted(true);
    if (Object.keys(errors).length) return;
    if (manual && !manualResult?.instrument) return;
    setSaving(true);
    try {
      const inst = draft.instrument;
      if (inst && !instruments.has(inst.id)) await upsertInstruments([inst]);
      let targetPortfolio = portfolioId;
      if (targetPortfolio === NEW_PORTFOLIO) {
        const p = await createPortfolio({
          name: t('portfolio.defaultName'),
          baseCurrency: f.currency,
          costMethod: defaultCostMethod,
          taxResidence: f.currency === 'BRL' ? 'BR' : 'CO',
          createdAt: date,
        });
        targetPortfolio = p.id;
        setPortfolioId(p.id);
        setSelected('selectedPortfolioId', p.id);
      }
      await saveTransaction({
        id: editing?.id,
        portfolioId: targetPortfolio,
        type,
        date,
        currency,
        instrumentId: NEEDS_INSTRUMENT.includes(type) || (type === 'INTEREST' && inst) ? inst?.id : undefined,
        quantity: NEEDS_QTY_PRICE.includes(type) ? draft.quantity : undefined,
        price: NEEDS_QTY_PRICE.includes(type) ? draft.price : undefined,
        amount: NEEDS_QTY_PRICE.includes(type) ? (draft.quantity ?? 0) * (draft.price ?? 0) : NEEDS_AMOUNT.includes(type) ? draft.amount : undefined,
        fees: draft.fees || undefined,
        taxes: draft.taxes || undefined,
        ratio: NEEDS_RATIO.includes(type) ? draft.ratio : undefined,
        toCurrency: type === 'FX_CONVERSION' ? toCurrency : undefined,
        toAmount: type === 'FX_CONVERSION' ? draft.toAmount : undefined,
        fxRateToBase: draft.fxRateToBase,
        account: draft.account,
        note: draft.note,
        source: editing?.source ?? 'manual',
        createdAt: editing?.createdAt,
      });
      if (again && !editing) {
        // "Agregar y nuevo": keep type, date, portfolio, account and currency.
        setNums({});
        setPriceAuto(false);
        setInstrument(undefined);
        setManual(undefined);
        setNote('');
        setSubmitted(false);
        setSavedCount((c) => c + 1);
        setTimeout(() => firstField.current?.querySelector<HTMLElement>('input, button.input')?.focus(), 0);
      } else onClose();
    } finally {
      setSaving(false);
    }
  };

  const numInput = (k: NumField, label: string, opts: { hint?: React.ReactNode; suffix?: string } = {}) => (
    <Field label={label} htmlFor={`f-${k}`} error={showErr(k as keyof TxErrors)} hint={opts.hint}>
      <div className="relative">
        <input
          id={`f-${k}`}
          inputMode="decimal"
          autoComplete="off"
          className={clsx('input num', opts.suffix && '!pr-12')}
          aria-invalid={!!showErr(k as keyof TxErrors)}
          value={nums[k] ?? ''}
          onChange={(e) => {
            setNums((n) => ({ ...n, [k]: e.target.value }));
            if (k === 'price') setPriceAuto(false);
          }}
        />
        {opts.suffix && <span className="absolute right-2.5 top-1/2 -translate-y-1/2 text-xs text-muted">{opts.suffix}</span>}
      </div>
    </Field>
  );

  const currencySelect = (id: string, value: string, onChange: (v: string) => void, label: string, err?: string) => (
    <Field label={label} htmlFor={id} error={err}>
      <select id={id} className="select" value={value} onChange={(e) => onChange(e.target.value)}>
        {[...new Set([...CURRENCY_CODES, value])].map((c) => (
          <option key={c} value={c}>
            {c}
          </option>
        ))}
      </select>
    </Field>
  );

  const priceHint = ref ? (
    <span className="inline-flex items-center gap-1">
      <Sparkles size={11} aria-hidden /> {t(priceAuto ? 'tx.priceSuggested' : 'tx.priceReference', { date: formatDate(ref.date, f.locale, 'short'), price: formatPrice(ref.close, currency, f.locale) })}
    </span>
  ) : undefined;

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title={editing ? t('tx.edit') : duplicateOf ? t('tx.duplicate') : t('tx.add')}
      footer={
        <>
          {savedCount > 0 && (
            <span className="mr-auto text-xs text-pos inline-flex items-center gap-1" role="status">
              <CheckCircle2 size={13} /> {t('tx.savedCount', { count: savedCount })}
            </span>
          )}
          <button className="btn" onClick={onClose} type="button">
            {savedCount ? t('common.close') : t('common.cancel')}
          </button>
          {!editing && (
            <button className="btn" onClick={() => void submit(true)} disabled={saving} data-testid="tx-save-again">
              {t('tx.addAndNew')}
            </button>
          )}
          <button className="btn btn-primary" onClick={() => void submit()} disabled={saving} data-testid="tx-save">
            {editing ? t('common.save') : t('tx.addShort')}
          </button>
        </>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="flex flex-col gap-4"
        noValidate
      >
        <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={t('tx.typeLabel')}>
          {QUICK.map((ty) => (
            <button
              key={ty}
              type="button"
              role="radio"
              aria-checked={type === ty}
              onClick={() => setType(ty)}
              className={clsx('btn btn-sm', type === ty && '!bg-accent-soft !text-accent !border-accent')}
            >
              {t(`tx.type.${ty}`)}
            </button>
          ))}
          <select
            aria-label={t('tx.moreTypes')}
            className={clsx('select !h-7 !w-auto !text-xs', OTHER.includes(type) && '!border-accent !text-accent')}
            value={OTHER.includes(type) ? type : ''}
            onChange={(e) => e.target.value && setType(e.target.value as TransactionType)}
          >
            <option value="">{t('tx.moreTypes')}…</option>
            {OTHER.map((ty) => (
              <option key={ty} value={ty}>
                {t(`tx.type.${ty}`)}
              </option>
            ))}
          </select>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Field label={t('tx.portfolio')} htmlFor="f-portfolio" error={showErr('portfolioId')}>
            <select id="f-portfolio" className="select" value={portfolioId} onChange={(e) => setPortfolioId(e.target.value)}>
              {portfolios.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.isDemo ? ` (${t('demo.badge')})` : ''}
                </option>
              ))}
              <option value={NEW_PORTFOLIO}>+ {t('tx.newPortfolio', { name: t('portfolio.defaultName') })}</option>
            </select>
          </Field>
          <Field label={t('tx.date')} htmlFor="f-date" error={showErr('date')}>
            <input id="f-date" type="date" className="input" value={date} max="2100-12-31" onChange={(e) => setDate(e.target.value)} />
          </Field>
        </div>

        {(NEEDS_INSTRUMENT.includes(type) || type === 'INTEREST') && (
          <div ref={firstField}>
            {manual ? (
              <ManualInstrumentEditor
                draft={manual}
                onChange={(d) => {
                  setManual(d);
                  setCurrency(d.currency);
                }}
                errors={submitted ? (manualResult?.errors ?? {}) : {}}
                conflict={conflict}
                onUseConflict={() => {
                  if (conflict) {
                    setInstrument(conflict);
                    setCurrency(conflict.currency);
                  }
                  setManual(undefined);
                  setConflict(undefined);
                }}
                onCancel={() => {
                  setManual(undefined);
                  setConflict(undefined);
                }}
              />
            ) : (
              <Field label={t('tx.instrument') + (type === 'INTEREST' ? ` (${t('common.optional')})` : '')} htmlFor="f-instrument" error={showErr('instrument')}>
                <InstrumentPicker
                  inputId="f-instrument"
                  value={instrument}
                  invalid={!!showErr('instrument')}
                  onChange={(i) => {
                    setInstrument(i);
                    setCurrency(i.currency);
                    setPriceAuto(false);
                    setNums((n) => ({ ...n, price: '' }));
                  }}
                  onCreateManual={(req: ManualRequest) => {
                    setInstrument(undefined);
                    setConflict(req.conflict);
                    const d = draftFrom(req.name, f.currency, req.template);
                    setManual(d);
                    setCurrency(d.currency);
                  }}
                />
              </Field>
            )}
            {held !== undefined && (type === 'SELL' || type === 'TRANSFER_OUT') && <p className="text-xs text-muted mt-1">{t('tx.held', { qty: held })}</p>}
          </div>
        )}

        {NEEDS_QTY_PRICE.includes(type) && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {numInput('quantity', t('tx.quantity'))}
            {numInput('price', t('tx.price'), { suffix: currency, hint: priceHint })}
            {numInput('fees', t('tx.fees'), { suffix: currency })}
            {currencySelect('f-ccy', currency, setCurrency, t('dim.currency'), showErr('currency'))}
          </div>
        )}

        {(type === 'DIVIDEND' || type === 'INTEREST') && (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            {numInput('amount', t('tx.grossAmount'), { suffix: currency })}
            {numInput('taxes', t('tx.withholding'), { suffix: currency, hint: t('tx.withholdingHint') })}
            {currencySelect('f-ccy', currency, setCurrency, t('dim.currency'), showErr('currency'))}
          </div>
        )}

        {['DEPOSIT', 'WITHDRAWAL', 'FEE', 'TAX', 'RETURN_OF_CAPITAL'].includes(type) && (
          <div className="grid grid-cols-2 gap-3">
            {numInput('amount', t('tx.amount'), { suffix: currency })}
            {currencySelect('f-ccy', currency, setCurrency, t('dim.currency'), showErr('currency'))}
          </div>
        )}

        {type === 'FX_CONVERSION' && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {currencySelect('f-ccy', currency, setCurrency, t('tx.fromCurrency'), showErr('currency'))}
            {numInput('amount', t('tx.fromAmount'), { suffix: currency })}
            {currencySelect('f-toccy', toCurrency, setToCurrency, t('tx.toCurrency'), showErr('toCurrency'))}
            {numInput('toAmount', t('tx.toAmount'), { suffix: toCurrency })}
            <div className="col-span-full text-xs text-muted num flex flex-wrap gap-x-4 gap-y-1">
              {implied ? (
                <span>
                  {t('tx.impliedRate')}: 1 {currency} = {formatFxRate(implied, f.locale)} {toCurrency} · 1 {toCurrency} = {formatFxRate(1 / implied, f.locale)} {currency}
                </span>
              ) : null}
              {fxRef ? (
                <span data-testid="fx-reference">
                  {t(`tx.fxRef.${refName}`)} {formatDate(date, f.locale, 'short')}: 1 {toCurrency} = {formatFxRate(1 / fxRef, f.locale)} {currency}
                </span>
              ) : null}
            </div>
          </div>
        )}

        {NEEDS_RATIO.includes(type) && <div className="grid grid-cols-2 gap-3">{numInput('ratio', t('tx.ratio'), { hint: t('tx.ratioHint') })}</div>}

        <details className="group">
          <summary className="cursor-pointer text-xs font-medium text-ink-2 select-none">{t('tx.more')}</summary>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-3">
            <Field label={t('tx.account')} htmlFor="f-account">
              <input id="f-account" className="input" value={account} onChange={(e) => setAccount(e.target.value)} placeholder="Trii, XP, IBKR…" />
            </Field>
            {NEEDS_QTY_PRICE.includes(type) && numInput('taxes', t('tx.taxes'), { suffix: currency })}
            {numInput('fxRateToBase', t('tx.fxRateToBase'), { hint: t('tx.fxRateToBaseHint') })}
            <Field label={t('tx.note')} htmlFor="f-note" className="sm:col-span-3">
              <input id="f-note" className="input" value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>
          </div>
        </details>

        {total !== undefined && Number.isFinite(total) && total !== 0 && (
          <div className="flex items-center justify-between rounded-lg bg-surface-2 px-3 py-2 text-[13px]">
            <span className="text-ink-2">{type === 'SELL' ? t('tx.netProceeds') : NEEDS_QTY_PRICE.includes(type) ? t('tx.totalCost') : t('tx.net')}</span>
            <span className="num font-semibold">{formatMoney(total, currency, f.locale)}</span>
          </div>
        )}

        {[...warnings.map((w) => t(w, { qty: held })), ...extraWarnings].map((w) => (
          <Banner key={w} tone="warn">
            {w}
          </Banner>
        ))}
        <button type="submit" className="hidden" />
      </form>
    </Modal>
  );
}
