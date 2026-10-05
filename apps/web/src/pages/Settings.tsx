import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CheckCircle2, Database, Download, Plus, RotateCcw, Server, Trash2, Upload, XCircle } from 'lucide-react';
import type { CostMethod } from '@pm/core';
import { Banner, Card, DemoBadge, Field, Modal, PageHeader, Segmented } from '../components/ui';
import { useApp } from '../store/app';
import { usePortfolios } from '../hooks/useData';
import { CURRENCY_CODES } from '../lib/currencies';
import { BENCHMARKS } from '../lib/benchmarks';
import {
  BackupError,
  createPortfolio,
  deletePortfolio,
  exportBackup,
  parseBackup,
  removeDemoData,
  restoreBackup,
  updatePortfolio,
  wipeAll,
  type ThemePref,
} from '../db/repo';
import { downloadText } from '../lib/export';
import { seedDemo } from '../services/onboarding';
import { getMarketClient, refreshMarketData } from '../services/marketData';
import { parseDecimal } from '../lib/parse';
import { formatPct } from '../lib/format';
import { useFmt } from '../store/app';
import { todayIso } from '../lib/ids';
import type { StoredPortfolio } from '../db/schema';

export default function SettingsPage() {
  const { t } = useTranslation();
  return (
    <div>
      <PageHeader title={t('settings.title')} subtitle={t('settings.subtitle')} />
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
        <Preferences />
        <DataSource />
        <Portfolios />
        <Backup />
      </div>
    </div>
  );
}

function Preferences() {
  const { t } = useTranslation();
  const s = useApp((st) => st.settings);
  const set = useApp((st) => st.setSetting);
  const f = useFmt();
  const [rf, setRf] = useState(String((s.riskFreeRate * 100).toFixed(2)).replace('.', f.locale.startsWith('en') ? '.' : ','));
  return (
    <Card title={t('settings.preferences')}>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label={t('settings.language')} htmlFor="s-lang">
          <select id="s-lang" className="select" value={s.language} onChange={(e) => set('language', e.target.value as typeof s.language)}>
            <option value="es">Español</option>
            <option value="pt">Português</option>
            <option value="en">English</option>
          </select>
        </Field>
        <Field label={t('settings.reportingCurrency')} htmlFor="s-ccy" hint={t('settings.reportingCurrencyHint')}>
          <select id="s-ccy" className="select" value={s.reportingCurrency} onChange={(e) => set('reportingCurrency', e.target.value)}>
            {CURRENCY_CODES.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </Field>
        <Field label={t('settings.costMethod')} htmlFor="s-cost" hint={t('settings.costMethodHint')}>
          <select id="s-cost" className="select" value={s.defaultCostMethod} onChange={(e) => set('defaultCostMethod', e.target.value as CostMethod)}>
            <option value="FIFO">FIFO</option>
            <option value="AVERAGE">{t('settings.average')}</option>
            <option value="LIFO">LIFO</option>
          </select>
        </Field>
        <Field label={t('settings.riskFree')} htmlFor="s-rf" hint={t('settings.riskFreeHint', { value: formatPct(s.riskFreeRate, f.locale) })}>
          <input
            id="s-rf"
            className="input num"
            inputMode="decimal"
            value={rf}
            onChange={(e) => setRf(e.target.value)}
            onBlur={() => {
              const v = parseDecimal(rf, f.locale);
              if (v !== undefined && v >= 0 && v < 100) set('riskFreeRate', v / 100);
            }}
          />
        </Field>
        <div className="sm:col-span-2">
          <span className="label">{t('settings.theme')}</span>
          <Segmented<ThemePref>
            label={t('settings.theme')}
            value={s.theme}
            onChange={(v) => set('theme', v)}
            options={[
              { value: 'light', label: t('settings.themeLight') },
              { value: 'dark', label: t('settings.themeDark') },
              { value: 'system', label: t('settings.themeSystem') },
            ]}
          />
        </div>
        <label className="sm:col-span-2 flex items-center gap-2 text-[13px]">
          <input type="checkbox" checked={s.privacy} onChange={(e) => set('privacy', e.target.checked)} />
          {t('settings.privacy')}
        </label>
        <div className="sm:col-span-2">
          <span className="label">{t('settings.benchmarks')}</span>
          <div className="flex flex-wrap gap-3">
            {BENCHMARKS.map((b) => (
              <label key={b.id} className="flex items-center gap-1.5 text-[13px]">
                <input
                  type="checkbox"
                  checked={s.benchmarks.includes(b.id)}
                  onChange={(e) => set('benchmarks', e.target.checked ? [...s.benchmarks, b.id] : s.benchmarks.filter((x) => x !== b.id))}
                />
                {b.name}
              </label>
            ))}
          </div>
        </div>
      </div>
    </Card>
  );
}

function DataSource() {
  const { t } = useTranslation();
  const s = useApp((st) => st.settings);
  const set = useApp((st) => st.setSetting);
  const [url, setUrl] = useState(s.serverUrl);
  const [test, setTest] = useState<{ ok: boolean; msg: string }>();
  const check = async () => {
    set('serverUrl', url.trim());
    setTest(undefined);
    try {
      const h = await getMarketClient().health();
      setTest({ ok: true, msg: `${h.service} ${h.version}` });
      void refreshMarketData({ force: true });
    } catch (e) {
      setTest({ ok: false, msg: e instanceof Error ? e.message : String(e) });
    }
  };
  return (
    <Card title={t('settings.dataSource')} subtitle={t('settings.dataSourceSub')}>
      <div className="flex flex-col gap-3">
        <Field label={t('settings.serverUrl')} htmlFor="s-url" hint={t('settings.serverUrlHint')}>
          <div className="flex gap-2">
            <input id="s-url" className="input" placeholder="http://localhost:8787" value={url} onChange={(e) => setUrl(e.target.value)} />
            <button className="btn" onClick={() => void check()}>
              <Server size={15} /> {t('settings.test')}
            </button>
          </div>
        </Field>
        {test && (
          <div className="flex items-center gap-2 text-[13px]">
            {test.ok ? <CheckCircle2 size={15} className="text-pos" /> : <XCircle size={15} className="text-neg" />}
            {test.ok ? t('settings.connected', { info: test.msg }) : t('settings.notConnected', { info: test.msg })}
          </div>
        )}
        <label className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" checked={s.autoRefresh} onChange={(e) => set('autoRefresh', e.target.checked)} />
          {t('settings.autoRefresh')}
        </label>
        <p className="text-xs text-muted">{t('settings.serverHowTo')}</p>
      </div>
    </Card>
  );
}

function Portfolios() {
  const { t } = useTranslation();
  const portfolios = usePortfolios();
  const set = useApp((st) => st.setSetting);
  const defaults = useApp((st) => st.settings);
  const [confirm, setConfirm] = useState<StoredPortfolio>();
  return (
    <Card
      id="portafolios"
      title={t('settings.portfolios')}
      actions={
        <button
          className="btn btn-sm"
          onClick={async () => {
            const p = await createPortfolio({
              name: t('portfolio.newName', { n: portfolios.length + 1 }),
              baseCurrency: defaults.reportingCurrency,
              costMethod: defaults.defaultCostMethod,
              createdAt: todayIso(),
            });
            set('selectedPortfolioId', p.id);
          }}
        >
          <Plus size={14} /> {t('settings.newPortfolio')}
        </button>
      }
    >
      <ul className="flex flex-col gap-3">
        {portfolios.map((p) => (
          <li key={p.id} className="rounded-lg border border-line p-3">
            <div className="grid grid-cols-2 sm:grid-cols-6 gap-2 items-end">
              <div className="col-span-2 sm:col-span-2">
                <label className="label" htmlFor={`pn-${p.id}`}>
                  {t('settings.name')} {p.isDemo && <DemoBadge />}
                </label>
                <input id={`pn-${p.id}`} className="input" defaultValue={p.name} onBlur={(e) => e.target.value.trim() && void updatePortfolio(p.id, { name: e.target.value.trim() })} />
              </div>
              <div>
                <label className="label" htmlFor={`pc-${p.id}`}>
                  {t('settings.base')}
                </label>
                <select id={`pc-${p.id}`} className="select" value={p.baseCurrency} onChange={(e) => void updatePortfolio(p.id, { baseCurrency: e.target.value })}>
                  {CURRENCY_CODES.map((c) => (
                    <option key={c}>{c}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="label" htmlFor={`pm-${p.id}`}>
                  {t('settings.costMethodShort')}
                </label>
                <select id={`pm-${p.id}`} className="select" value={p.costMethod} onChange={(e) => void updatePortfolio(p.id, { costMethod: e.target.value as CostMethod })}>
                  <option value="FIFO">FIFO</option>
                  <option value="AVERAGE">{t('settings.average')}</option>
                  <option value="LIFO">LIFO</option>
                </select>
              </div>
              <div>
                <label className="label" htmlFor={`pt-${p.id}`}>
                  {t('settings.taxResidence')}
                </label>
                <select id={`pt-${p.id}`} className="select" value={p.taxResidence ?? ''} onChange={(e) => void updatePortfolio(p.id, { taxResidence: e.target.value || undefined })}>
                  <option value="">—</option>
                  <option value="CO">Colombia</option>
                  <option value="BR">Brasil</option>
                </select>
              </div>
              <button className="btn btn-danger btn-sm !h-[34px]" onClick={() => setConfirm(p)} aria-label={t('settings.deletePortfolio', { name: p.name })}>
                <Trash2 size={14} />
              </button>
            </div>
          </li>
        ))}
        {!portfolios.length && <li className="text-sm text-muted">{t('settings.noPortfolios')}</li>}
      </ul>
      <Modal
        open={!!confirm}
        onClose={() => setConfirm(undefined)}
        title={t('settings.deletePortfolio', { name: confirm?.name })}
        footer={
          <>
            <button className="btn" onClick={() => setConfirm(undefined)}>
              {t('common.cancel')}
            </button>
            <button
              className="btn btn-primary !bg-neg !border-neg"
              onClick={async () => {
                await deletePortfolio(confirm!.id);
                set('selectedPortfolioId', 'all');
                setConfirm(undefined);
              }}
            >
              {t('common.delete')}
            </button>
          </>
        }
      >
        <p className="text-[13px] text-ink-2">{t('settings.deletePortfolioBody')}</p>
      </Modal>
    </Card>
  );
}

function Backup() {
  const { t } = useTranslation();
  const fileRef = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<{ tone: 'success' | 'error'; text: string }>();
  const [mode, setMode] = useState<'replace' | 'merge'>('merge');
  const [wipeOpen, setWipeOpen] = useState(false);
  const [wipeText, setWipeText] = useState('');
  const portfolios = usePortfolios();
  const hasDemo = portfolios.some((p) => p.isDemo);
  const set = useApp((st) => st.setSetting);
  const word = t('settings.wipeWord');

  return (
    <Card title={t('settings.backup')} subtitle={t('settings.backupSub')}>
      <div className="flex flex-col gap-3">
        {msg && <Banner tone={msg.tone}>{msg.text}</Banner>}
        <div className="flex flex-wrap gap-2">
          <button
            className="btn"
            onClick={async () => {
              const b = await exportBackup(true);
              downloadText(`portafolio-pro-respaldo-${todayIso()}.json`, JSON.stringify(b), 'application/json');
            }}
          >
            <Download size={15} /> {t('settings.exportJson')}
          </button>
          <button className="btn" onClick={() => fileRef.current?.click()}>
            <Upload size={15} /> {t('settings.importJson')}
          </button>
          <Segmented
            label={t('settings.restoreMode')}
            value={mode}
            onChange={setMode}
            options={[
              { value: 'merge', label: t('settings.merge') },
              { value: 'replace', label: t('settings.replace') },
            ]}
          />
          <input
            ref={fileRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            aria-label={t('settings.importJson')}
            onChange={async (e) => {
              const file = e.target.files?.[0];
              e.target.value = '';
              if (!file) return;
              try {
                const b = parseBackup(await file.text());
                await restoreBackup(b, mode);
                setMsg({ tone: 'success', text: t('settings.restored', { tx: b.transactions.length, pf: b.portfolios.length }) });
              } catch (err) {
                const code = err instanceof BackupError ? err.message : 'invalid_json';
                setMsg({ tone: 'error', text: t(`settings.backupError.${code}`) });
              }
            }}
          />
        </div>
        <div className="border-t border-line pt-3 flex flex-wrap gap-2">
          {hasDemo ? (
            <button
              className="btn"
              onClick={async () => {
                await removeDemoData();
                set('selectedPortfolioId', 'all');
              }}
            >
              <Database size={15} /> {t('settings.removeDemo')}
            </button>
          ) : (
            <button className="btn" onClick={() => void seedDemo()}>
              <RotateCcw size={15} /> {t('settings.loadDemo')}
            </button>
          )}
          <button className="btn btn-danger" onClick={() => setWipeOpen(true)}>
            <Trash2 size={15} /> {t('settings.wipe')}
          </button>
        </div>
      </div>
      <Modal
        open={wipeOpen}
        onClose={() => setWipeOpen(false)}
        title={t('settings.wipeTitle')}
        footer={
          <>
            <button className="btn" onClick={() => setWipeOpen(false)}>
              {t('common.cancel')}
            </button>
            <button
              className="btn btn-primary !bg-neg !border-neg"
              disabled={wipeText.trim().toUpperCase() !== word.toUpperCase()}
              onClick={async () => {
                await wipeAll();
                location.assign('/');
              }}
            >
              {t('settings.wipeConfirm')}
            </button>
          </>
        }
      >
        <p className="text-[13px] text-ink-2 mb-3">{t('settings.wipeBody', { word })}</p>
        <input className="input" aria-label={t('settings.wipeType', { word })} value={wipeText} onChange={(e) => setWipeText(e.target.value)} data-autofocus />
      </Modal>
    </Card>
  );
}
