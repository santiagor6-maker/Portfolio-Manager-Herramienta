import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useLiveQuery } from 'dexie-react-hooks';
import clsx from 'clsx';
import { ArrowLeftRight, CalendarCheck, Check, FileSpreadsheet, PiggyBank, ShieldCheck, Upload, Bell, X } from 'lucide-react';
import type { CostMethod } from '@pm/core';
import { Field, Modal } from './ui';
import { useApp } from '../store/app';
import { CURRENCY_CODES } from '../lib/currencies';
import { createPortfolio, getMeta, removeDemoData, saveTransaction, setMeta } from '../db/repo';
import { db } from '../db/schema';
import { parseDecimal } from '../lib/parse';
import { todayIso } from '../lib/ids';

/**
 * 3-step first-use wizard: (1) portfolio basics — name, base currency, tax residence, cost method,
 * broker; (2) optional initial deposit; (3) next step: add a buy, import a statement or explore.
 */
export function OnboardingWizard() {
  const { t } = useTranslation();
  const open = useApp((s) => s.onboardingOpen);
  const setOpen = useApp((s) => s.setOnboardingOpen);
  const setSetting = useApp((s) => s.setSetting);
  const locale = useApp((s) => s.settings.language);
  const navigate = useNavigate();
  const [step, setStep] = useState(0);
  const [name, setName] = useState(t('portfolio.defaultName'));
  const [ccy, setCcy] = useState(useApp.getState().settings.reportingCurrency);
  const [residence, setResidence] = useState<'CO' | 'BR' | ''>(ccy === 'BRL' ? 'BR' : 'CO');
  const [method, setMethod] = useState<CostMethod>(ccy === 'BRL' ? 'AVERAGE' : 'FIFO');
  const [broker, setBroker] = useState('');
  const [deposit, setDeposit] = useState('');
  const [keepDemo, setKeepDemo] = useState(false);
  const [pid, setPid] = useState<string>();

  const close = () => {
    setOpen(false);
    setStep(0);
  };

  const create = async () => {
    if (!keepDemo) await removeDemoData();
    const p = await createPortfolio({ name: name.trim() || t('portfolio.defaultName'), baseCurrency: ccy, costMethod: method, taxResidence: residence || undefined, createdAt: todayIso() });
    setPid(p.id);
    setSetting('selectedPortfolioId', p.id);
    setSetting('reportingCurrency', ccy);
    setSetting('defaultCostMethod', method);
    setSetting('onboarded', true);
    setStep(1);
  };

  const saveDeposit = async () => {
    const amount = parseDecimal(deposit, locale === 'en' ? 'en-US' : 'es-CO');
    if (pid && amount && amount > 0) {
      await saveTransaction({ portfolioId: pid, date: todayIso(), type: 'DEPOSIT', currency: ccy, amount, account: broker || undefined, note: t('onboarding.initialDeposit') });
    }
    setStep(2);
  };

  return (
    <Modal open={open} onClose={close} title={t('onboarding.title')} wide>
      <ol className="flex gap-2 mb-5 text-xs" aria-label={t('imp.steps')}>
        {[0, 1, 2].map((i) => (
          <li key={i} className={clsx('flex-1 h-1.5 rounded-full', i <= step ? 'bg-accent' : 'bg-surface-3')} aria-current={i === step ? 'step' : undefined}>
            <span className="sr-only">{t(`onboarding.step${i}`)}</span>
          </li>
        ))}
      </ol>
      {step === 0 && (
        <form
          className="grid grid-cols-1 sm:grid-cols-2 gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <p className="sm:col-span-2 text-[13px] text-ink-2">{t('onboarding.intro')}</p>
          <Field label={t('settings.name')} htmlFor="ob-name">
            <input id="ob-name" className="input" value={name} onChange={(e) => setName(e.target.value)} data-autofocus />
          </Field>
          <Field label={t('settings.base')} htmlFor="ob-ccy" hint={t('onboarding.baseHint')}>
            <select
              id="ob-ccy"
              className="select"
              value={ccy}
              onChange={(e) => {
                setCcy(e.target.value);
                if (e.target.value === 'BRL') {
                  setResidence('BR');
                  setMethod('AVERAGE');
                } else if (e.target.value === 'COP') {
                  setResidence('CO');
                  setMethod('FIFO');
                }
              }}
            >
              {CURRENCY_CODES.map((c) => (
                <option key={c}>{c}</option>
              ))}
            </select>
          </Field>
          <Field label={t('settings.taxResidence')} htmlFor="ob-res" hint={t('onboarding.residenceHint')}>
            <select
              id="ob-res"
              className="select"
              value={residence}
              onChange={(e) => {
                const v = e.target.value as 'CO' | 'BR' | '';
                setResidence(v);
                setMethod(v === 'BR' ? 'AVERAGE' : 'FIFO');
              }}
            >
              <option value="CO">Colombia</option>
              <option value="BR">Brasil</option>
              <option value="">{t('onboarding.otherResidence')}</option>
            </select>
          </Field>
          <Field label={t('settings.costMethod')} htmlFor="ob-method">
            <select id="ob-method" className="select" value={method} onChange={(e) => setMethod(e.target.value as CostMethod)}>
              <option value="FIFO">FIFO</option>
              <option value="AVERAGE">{t('settings.average')}</option>
              <option value="LIFO">LIFO</option>
            </select>
          </Field>
          <Field label={t('onboarding.broker')} htmlFor="ob-broker" hint={t('onboarding.brokerHint')}>
            <input id="ob-broker" className="input" value={broker} onChange={(e) => setBroker(e.target.value)} placeholder="Trii, XP, IBKR…" />
          </Field>
          <label className="sm:col-span-2 flex items-center gap-2 text-[13px]">
            <input type="checkbox" checked={keepDemo} onChange={(e) => setKeepDemo(e.target.checked)} /> {t('onboarding.keepDemo')}
          </label>
          <div className="sm:col-span-2 flex justify-end gap-2">
            <button type="button" className="btn" onClick={close}>
              {t('common.cancel')}
            </button>
            <button type="submit" className="btn btn-primary" data-testid="onboarding-create">
              {t('onboarding.create')}
            </button>
          </div>
        </form>
      )}
      {step === 1 && (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void saveDeposit();
          }}
        >
          <p className="text-[13px] text-ink-2">{t('onboarding.depositIntro')}</p>
          <Field label={t('onboarding.depositLabel', { currency: ccy })} htmlFor="ob-dep" hint={t('onboarding.depositHint')}>
            <input id="ob-dep" className="input num" inputMode="decimal" value={deposit} onChange={(e) => setDeposit(e.target.value)} data-autofocus />
          </Field>
          <div className="flex justify-end gap-2">
            <button type="button" className="btn" onClick={() => setStep(2)}>
              {t('onboarding.skip')}
            </button>
            <button type="submit" className="btn btn-primary">
              {t('onboarding.next')}
            </button>
          </div>
        </form>
      )}
      {step === 2 && (
        <div className="flex flex-col gap-3">
          <p className="text-[13px] text-ink-2">{t('onboarding.nextIntro')}</p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <button
              className="card p-4 text-left hover:border-accent"
              onClick={() => {
                close();
                navigate('/movimientos?nuevo=1');
              }}
            >
              <ArrowLeftRight className="text-accent" size={20} />
              <div className="font-semibold mt-2">{t('onboarding.addBuy')}</div>
              <p className="text-xs text-muted mt-1">{t('onboarding.addBuyHint')}</p>
            </button>
            <button
              className="card p-4 text-left hover:border-accent"
              onClick={() => {
                close();
                navigate('/importar');
              }}
            >
              <Upload className="text-accent" size={20} />
              <div className="font-semibold mt-2">{t('onboarding.import')}</div>
              <p className="text-xs text-muted mt-1">{t('onboarding.importHint')}</p>
            </button>
            <button
              className="card p-4 text-left hover:border-accent"
              onClick={() => {
                close();
                navigate('/');
              }}
            >
              <FileSpreadsheet className="text-accent" size={20} />
              <div className="font-semibold mt-2">{t('onboarding.explore')}</div>
              <p className="text-xs text-muted mt-1">{t('onboarding.exploreHint')}</p>
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}

interface ChecklistItem {
  key: string;
  done: boolean;
  icon: React.ReactNode;
  href: string;
}

/** Getting-started checklist on the dashboard (hidden when complete or dismissed). */
export function GettingStarted() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const pid = useApp((s) => s.settings.selectedPortfolioId);
  const data = useLiveQuery(async () => {
    const portfolios = await db.portfolios.toArray();
    const real = portfolios.filter((p) => !p.isDemo);
    if (!real.length) return undefined;
    const ids = new Set(real.map((p) => p.id));
    const txs = (await db.transactions.toArray()).filter((x) => ids.has(x.portfolioId));
    const closed = ((await getMeta<string[]>('closedMonths')) ?? []).length > 0;
    const backup = !!(await getMeta<number>('lastBackup'));
    const alerts = (await db.alerts.filter((a) => !a.id.startsWith('default-')).count()) > 0;
    const dismissed = !!(await getMeta<boolean>('checklistDismissed'));
    return { txs, closed, backup, alerts, dismissed };
  }, [pid]);
  if (!data || data.dismissed) return null;
  const items: ChecklistItem[] = [
    { key: 'deposit', done: data.txs.some((x) => x.type === 'DEPOSIT'), icon: <PiggyBank size={15} />, href: '/movimientos?nuevo=1' },
    { key: 'buy', done: data.txs.some((x) => x.type === 'BUY'), icon: <ArrowLeftRight size={15} />, href: '/movimientos?nuevo=1' },
    { key: 'close', done: data.closed, icon: <CalendarCheck size={15} />, href: '/mensual/cierre' },
    { key: 'alerts', done: data.alerts, icon: <Bell size={15} />, href: '/alertas' },
    { key: 'backup', done: data.backup, icon: <ShieldCheck size={15} />, href: '/ajustes' },
  ];
  const done = items.filter((i) => i.done).length;
  if (done === items.length) return null;
  return (
    <section className="card p-4 mb-3" aria-labelledby="gs-title" data-testid="getting-started">
      <div className="flex items-center justify-between gap-2">
        <h2 id="gs-title" className="font-semibold text-[13.5px]">
          {t('onboarding.checklist', { done, total: items.length })}
        </h2>
        <button className="btn btn-ghost btn-sm btn-icon" aria-label={t('common.close')} onClick={() => void setMeta('checklistDismissed', true)}>
          <X size={14} />
        </button>
      </div>
      <div className="h-1.5 rounded-full bg-surface-3 mt-2 overflow-hidden" aria-hidden>
        <div className="h-full bg-accent" style={{ width: `${(done / items.length) * 100}%` }} />
      </div>
      <ul className="grid grid-cols-1 sm:grid-cols-5 gap-2 mt-3">
        {items.map((i) => (
          <li key={i.key}>
            <button
              className={clsx('w-full text-left rounded-lg border px-3 py-2 text-[12.5px] flex items-center gap-2', i.done ? 'border-pos/30 bg-pos-soft text-ink-2' : 'border-line hover:border-accent')}
              onClick={() => navigate(i.href)}
            >
              <span className={clsx('size-5 rounded-full grid place-items-center shrink-0', i.done ? 'bg-pos text-white' : 'bg-surface-2 text-muted')}>{i.done ? <Check size={12} /> : i.icon}</span>
              <span className={clsx(i.done && 'line-through')}>{t(`onboarding.task.${i.key}`)}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
