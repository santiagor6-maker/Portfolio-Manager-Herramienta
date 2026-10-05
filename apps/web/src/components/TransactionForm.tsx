import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import type { AssetClass, Instrument, TransactionType } from '@pm/core';
import { Banner, Field, Modal } from './ui';
import { InstrumentPicker } from './InstrumentPicker';
import { NEEDS_AMOUNT, NEEDS_INSTRUMENT, NEEDS_QTY_PRICE, NEEDS_RATIO, validateTxDraft, type TxDraft, type TxErrors } from './txValidation';
import { CURRENCY_CODES } from '../lib/currencies';
import { parseDecimal, toInputNumber } from '../lib/parse';
import { formatMoney } from '../lib/format';
import { todayIso } from '../lib/ids';
import { useFmt, useApp } from '../store/app';
import { useInstrumentMap, usePortfolios } from '../hooks/useData';
import { createPortfolio, saveTransaction, upsertInstruments } from '../db/repo';
import type { StoredTransaction } from '../db/schema';

const NEW_PORTFOLIO = '__new';
const QUICK: TransactionType[] = ['BUY', 'SELL', 'DIVIDEND', 'DEPOSIT', 'WITHDRAWAL', 'FX_CONVERSION'];
const OTHER: TransactionType[] = ['INTEREST', 'FEE', 'TAX', 'SPLIT', 'STOCK_DIVIDEND', 'TRANSFER_IN', 'TRANSFER_OUT', 'RETURN_OF_CAPITAL'];
const MANUAL_CLASSES: AssetClass[] = ['fund', 'fixed_income', 'bond', 'equity', 'etf', 'reit', 'crypto', 'commodity', 'other'];

type NumField = 'quantity' | 'price' | 'amount' | 'fees' | 'taxes' | 'toAmount' | 'ratio' | 'fxRateToBase';

function slug(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 24);
}

export function TransactionForm({
  open,
  onClose,
  editing,
  presetInstrumentId,
  heldQuantity,
}: {
  open: boolean;
  onClose: () => void;
  editing?: StoredTransaction;
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
  // The live query may resolve after the form opens: fall back to the default until the choice is valid.
  const portfolioId =
    portfolioChoice === NEW_PORTFOLIO || portfolios.some((p) => p.id === portfolioChoice) ? portfolioChoice : defaultPortfolio;
  const [date, setDate] = useState(todayIso());
  const [instrument, setInstrument] = useState<Instrument>();
  const [currency, setCurrency] = useState(f.currency);
  const [toCurrency, setToCurrency] = useState('USD');
  const [nums, setNums] = useState<Partial<Record<NumField, string>>>({});
  const [account, setAccount] = useState('');
  const [note, setNote] = useState('');
  const [manual, setManual] = useState<{ name: string; symbol: string; currency: string; country: string; assetClass: AssetClass }>();
  const [submitted, setSubmitted] = useState(false);
  const [saving, setSaving] = useState(false);

  // (Re)initialise when opened.
  useEffect(() => {
    if (!open) return;
    setSubmitted(false);
    setManual(undefined);
    if (editing) {
      setType(editing.type);
      setPortfolioId(editing.portfolioId);
      setDate(editing.date);
      setInstrument(editing.instrumentId ? instruments.get(editing.instrumentId) : undefined);
      setCurrency(editing.currency);
      setToCurrency(editing.toCurrency ?? 'USD');
      const n: Partial<Record<NumField, string>> = {};
      for (const k of ['quantity', 'price', 'amount', 'fees', 'taxes', 'toAmount', 'ratio', 'fxRateToBase'] as NumField[]) {
        const v = editing[k];
        if (v !== undefined) n[k] = toInputNumber(v, f.locale);
      }
      setNums(n);
      setAccount(editing.account ?? '');
      setNote(editing.note ?? '');
    } else {
      setType('BUY');
      setPortfolioId(defaultPortfolio);
      setDate(todayIso());
      const pre = presetInstrumentId ? instruments.get(presetInstrumentId) : undefined;
      setInstrument(pre);
      setCurrency(pre?.currency ?? f.currency);
      setNums({});
      setAccount('');
      setNote('');
    }
  }, [open, editing]); // eslint-disable-line react-hooks/exhaustive-deps

  const num = (k: NumField) => parseDecimal(nums[k] ?? '', f.locale);
  const draft: TxDraft = {
    portfolioId,
    type,
    date,
    instrument: instrument ?? (manual ? manualInstrument(manual) : undefined),
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
  const showErr = (k: keyof TxErrors) => (submitted && errors[k] ? t(errors[k]!) : undefined);
  const total = useMemo(() => {
    if (NEEDS_QTY_PRICE.includes(type)) {
      const g = (draft.quantity ?? 0) * (draft.price ?? 0);
      return type === 'SELL' ? g - (draft.fees ?? 0) - (draft.taxes ?? 0) : g + (draft.fees ?? 0) + (draft.taxes ?? 0);
    }
    if (type === 'DIVIDEND' || type === 'INTEREST') return (draft.amount ?? 0) - (draft.taxes ?? 0);
    return draft.amount;
  }, [type, draft.quantity, draft.price, draft.fees, draft.taxes, draft.amount]);

  const submit = async () => {
    setSubmitted(true);
    if (Object.keys(errors).length) return;
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
        setSelected('selectedPortfolioId', p.id);
      }
      const row: Omit<StoredTransaction, 'id'> & { id?: string } = {
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
      };
      await saveTransaction(row);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const numInput = (k: NumField, label: string, opts: { hint?: string; suffix?: string; autoFocus?: boolean } = {}) => (
    <Field label={label} htmlFor={`f-${k}`} error={showErr(k as keyof TxErrors)} hint={opts.hint}>
      <div className="relative">
        <input
          id={`f-${k}`}
          inputMode="decimal"
          autoComplete="off"
          className={clsx('input num', opts.suffix && '!pr-12')}
          aria-invalid={!!showErr(k as keyof TxErrors)}
          value={nums[k] ?? ''}
          data-autofocus={opts.autoFocus ? '' : undefined}
          onChange={(e) => setNums((n) => ({ ...n, [k]: e.target.value }))}
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

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title={editing ? t('tx.edit') : t('tx.add')}
      footer={
        <>
          <button className="btn" onClick={onClose} type="button">
            {t('common.cancel')}
          </button>
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
          <div>
            <Field label={t('tx.instrument') + (type === 'INTEREST' ? ` (${t('common.optional')})` : '')} htmlFor="f-instrument" error={showErr('instrument')}>
              {manual ? (
                <div className="card !shadow-none p-3 grid grid-cols-2 sm:grid-cols-5 gap-2">
                  <div className="col-span-2">
                    <label className="label" htmlFor="m-name">
                      {t('tx.manualName')}
                    </label>
                    <input id="m-name" className="input" value={manual.name} onChange={(e) => setManual({ ...manual, name: e.target.value, symbol: slug(e.target.value) })} />
                  </div>
                  <div>
                    <label className="label" htmlFor="m-ccy">
                      {t('dim.currency')}
                    </label>
                    <select id="m-ccy" className="select" value={manual.currency} onChange={(e) => { setManual({ ...manual, currency: e.target.value }); setCurrency(e.target.value); }}>
                      {CURRENCY_CODES.map((c) => (
                        <option key={c}>{c}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="label" htmlFor="m-class">
                      {t('dim.assetClass')}
                    </label>
                    <select id="m-class" className="select" value={manual.assetClass} onChange={(e) => setManual({ ...manual, assetClass: e.target.value as AssetClass })}>
                      {MANUAL_CLASSES.map((c) => (
                        <option key={c} value={c}>
                          {t(`assetClass.${c}`)}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="label" htmlFor="m-country">
                      {t('dim.country')}
                    </label>
                    <input id="m-country" className="input uppercase" maxLength={2} value={manual.country} onChange={(e) => setManual({ ...manual, country: e.target.value.toUpperCase() })} />
                  </div>
                  <p className="col-span-full text-xs text-muted">{t('tx.manualHint')}</p>
                  <button type="button" className="btn btn-sm col-span-full sm:col-span-1" onClick={() => setManual(undefined)}>
                    {t('tx.searchInstead')}
                  </button>
                </div>
              ) : (
                <InstrumentPicker
                  inputId="f-instrument"
                  value={instrument}
                  invalid={!!showErr('instrument')}
                  onChange={(i) => {
                    setInstrument(i);
                    setCurrency(i.currency);
                  }}
                  onCreateManual={(name) => {
                    setInstrument(undefined);
                    setManual({ name, symbol: slug(name), currency: f.currency, country: f.currency === 'BRL' ? 'BR' : 'CO', assetClass: 'fund' });
                    setCurrency(f.currency);
                  }}
                />
              )}
            </Field>
            {held !== undefined && (type === 'SELL' || type === 'TRANSFER_OUT') && (
              <p className="text-xs text-muted mt-1">{t('tx.held', { qty: held })}</p>
            )}
          </div>
        )}

        {NEEDS_QTY_PRICE.includes(type) && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            {numInput('quantity', t('tx.quantity'))}
            {numInput('price', t('tx.price'), { suffix: currency })}
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
            {draft.amount && draft.toAmount ? (
              <p className="col-span-full text-xs text-muted num">
                {t('tx.impliedRate')}: 1 {toCurrency} = {formatMoney(draft.amount / draft.toAmount, currency, f.locale, { decimals: 4 })} · 1 {currency} ={' '}
                {formatMoney(draft.toAmount / draft.amount, toCurrency, f.locale, { decimals: 6 })}
              </p>
            ) : null}
          </div>
        )}

        {NEEDS_RATIO.includes(type) && (
          <div className="grid grid-cols-2 gap-3">{numInput('ratio', t('tx.ratio'), { hint: t('tx.ratioHint') })}</div>
        )}

        <details className="group">
          <summary className="cursor-pointer text-xs font-medium text-ink-2 select-none">{t('tx.more')}</summary>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-3">
            <Field label={t('tx.account')} htmlFor="f-account">
              <input id="f-account" className="input" list="accounts" value={account} onChange={(e) => setAccount(e.target.value)} placeholder="Trii, XP, IBKR…" />
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

        {warnings.map((w) => (
          <Banner key={w} tone="warn">
            {t(w, { qty: held })}
          </Banner>
        ))}
        <button type="submit" className="hidden" />
      </form>
    </Modal>
  );
}

function manualInstrument(m: { name: string; symbol: string; currency: string; country: string; assetClass: AssetClass }): Instrument {
  const symbol = m.symbol || slug(m.name) || 'MANUAL';
  return {
    id: `MANUAL:${symbol}`,
    symbol,
    name: m.name || symbol,
    exchange: 'MANUAL',
    currency: m.currency,
    country: m.country || 'CO',
    assetClass: m.assetClass,
    pricing: 'manual',
  };
}
