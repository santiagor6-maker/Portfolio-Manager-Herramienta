import { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLiveQuery } from 'dexie-react-hooks';
import { Plus, Target, Trash2 } from 'lucide-react';
import * as core from '@pm/core';
import { Banner, Card, EmptyState, Field, Kpi, Money, PageHeader, Pct } from '../components/ui';
import { LineChart, type LineSeries } from '../components/charts';
import { useAnalysis } from '../hooks/useAnalysis';
import { useApp, useFmt } from '../store/app';
import { db, type Goal } from '../db/schema';
import { addMonths, newId, todayIso } from '../lib/ids';
import { formatDate, formatMoney, formatPct } from '../lib/format';
import { parseDecimal, toInputNumber } from '../lib/parse';
import { annualize, yearsOf } from './Performance';

export default function GoalsPage() {
  const { t } = useTranslation();
  const f = useFmt();
  const goals = useLiveQuery(() => db.goals.toArray(), []);
  const { analysis: a } = useAnalysis();
  const [editing, setEditing] = useState<Goal>();
  const si = a?.summaries.SI;
  const histReturn = annualize(si?.twr, yearsOf(si));

  const newGoal = (): Goal => ({
    id: newId('goal'),
    name: t('goals.defaultName'),
    target: Math.round(((a?.valuation?.totalMarketValueBase ?? 100_000_000) * 2) / 1_000_000) * 1_000_000 || 100_000_000,
    currency: f.currency,
    targetDate: `${Number(todayIso().slice(0, 4)) + 10}-12-31`,
    monthlyContribution: Math.max(0, Math.round((si?.netFlowsBase ?? 0) / Math.max(12, (yearsOf(si) ?? 1) * 12))),
    expectedReturn: Math.min(0.15, Math.max(0.03, histReturn ?? 0.08)),
    portfolioId: 'all',
    createdAt: Date.now(),
  });

  return (
    <div>
      <PageHeader
        title={t('goals.title')}
        subtitle={t('goals.subtitle')}
        actions={
          <button className="btn btn-primary" onClick={() => setEditing(newGoal())} data-testid="goal-new">
            <Plus size={15} /> {t('goals.new')}
          </button>
        }
      />
      {editing && <GoalEditor goal={editing} onDone={() => setEditing(undefined)} histReturn={histReturn} />}
      {goals && goals.length === 0 && !editing && (
        <div className="card">
          <EmptyState icon={<Target size={20} />} title={t('goals.emptyTitle')} body={t('goals.emptyBody')} action={<button className="btn btn-primary" onClick={() => setEditing(newGoal())}><Plus size={15} /> {t('goals.new')}</button>} />
        </div>
      )}
      <div className="flex flex-col gap-3">
        {(goals ?? []).map((g) => (
          <GoalCard key={g.id} goal={g} onEdit={() => setEditing(g)} histReturn={histReturn} />
        ))}
      </div>
    </div>
  );
}

function GoalEditor({ goal, onDone, histReturn }: { goal: Goal; onDone: () => void; histReturn?: number }) {
  const { t } = useTranslation();
  const f = useFmt();
  const [name, setName] = useState(goal.name);
  const [target, setTarget] = useState(toInputNumber(goal.target, f.locale));
  const [date, setDate] = useState(goal.targetDate);
  const [contrib, setContrib] = useState(toInputNumber(goal.monthlyContribution, f.locale));
  const [ret, setRet] = useState(toInputNumber(Math.round(goal.expectedReturn * 1000) / 10, f.locale));
  const save = async () => {
    const tg = parseDecimal(target, f.locale);
    const c = parseDecimal(contrib, f.locale) ?? 0;
    const r = parseDecimal(ret, f.locale);
    if (!tg || tg <= 0 || !date || r === undefined) return;
    await db.goals.put({ ...goal, name: name.trim() || t('goals.defaultName'), target: tg, targetDate: date, monthlyContribution: c, expectedReturn: r / 100 });
    onDone();
  };
  return (
    <Card className="mb-3" title={t('goals.edit')}>
      <form
        className="grid grid-cols-1 sm:grid-cols-5 gap-3 items-end"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <Field label={t('settings.name')} htmlFor="g-name">
          <input id="g-name" className="input" value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label={t('goals.target', { currency: goal.currency })} htmlFor="g-target">
          <input id="g-target" className="input num" inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} />
        </Field>
        <Field label={t('goals.date')} htmlFor="g-date">
          <input id="g-date" type="date" className="input" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label={t('goals.monthly', { currency: goal.currency })} htmlFor="g-contrib">
          <input id="g-contrib" className="input num" inputMode="decimal" value={contrib} onChange={(e) => setContrib(e.target.value)} />
        </Field>
        <Field label={t('goals.return')} htmlFor="g-ret" hint={histReturn !== undefined ? t('goals.historical', { value: formatPct(histReturn, f.locale) }) : undefined}>
          <input id="g-ret" className="input num" inputMode="decimal" value={ret} onChange={(e) => setRet(e.target.value)} />
        </Field>
        <div className="sm:col-span-5 flex justify-end gap-2">
          <button type="button" className="btn" onClick={onDone}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn btn-primary" data-testid="goal-save">
            {t('common.save')}
          </button>
        </div>
      </form>
    </Card>
  );
}

function GoalCard({ goal, onEdit, histReturn }: { goal: Goal; onEdit: () => void; histReturn?: number }) {
  const { t } = useTranslation();
  const f = useFmt();
  const { analysis: a } = useAnalysis();
  const setSetting = useApp((s) => s.setSetting);
  const vol = a?.risk?.volatility;
  // What-if: live sliders (not saved until "Guardar").
  const [contrib, setContrib] = useState(goal.monthlyContribution);
  const [ret, setRet] = useState(goal.expectedReturn);
  const sameCcy = a?.baseCurrency === goal.currency;
  const current = sameCcy ? (a?.valuation?.totalMarketValueBase ?? 0) : undefined;
  const proj = useMemo(() => {
    if (current === undefined) return undefined;
    try {
      return core.goalProjection({ startValue: current, startDate: a!.asOf, monthlyContribution: contrib, expectedReturn: ret, volatility: vol && vol > 0 ? vol : 0.12, target: goal.target, targetDate: goal.targetDate });
    } catch {
      return undefined;
    }
  }, [current, contrib, ret, vol, goal.target, goal.targetDate, a]);
  const money = useCallback((v: number, axis?: boolean) => (f.privacy ? '•••' : formatMoney(v, f.currency, f.locale, { compact: axis })), [f.currency, f.locale, f.privacy]);
  const series: LineSeries[] = useMemo(() => {
    if (!proj) return [];
    const pts = proj.points;
    return [
      { name: t('goals.expected'), data: pts.map((p) => [p.date, p.expected] as [string, number]), area: true },
      { name: t('goals.optimistic'), colorIndex: 2, dashed: true, data: pts.map((p) => [p.date, p.optimistic] as [string, number]) },
      { name: t('goals.pessimistic'), colorIndex: 1, dashed: true, data: pts.map((p) => [p.date, p.pessimistic] as [string, number]) },
      { name: t('goals.contributed'), colorIndex: 7, data: pts.map((p) => [p.date, p.contributed] as [string, number]) },
      { name: t('goals.targetLine'), colorIndex: 6, dashed: true, data: [[pts[0]!.date, goal.target], [pts[pts.length - 1]!.date, goal.target]] },
    ];
  }, [proj, goal.target, t]);
  const progress = current !== undefined ? Math.min(1, current / goal.target) : undefined;
  const dirty = contrib !== goal.monthlyContribution || ret !== goal.expectedReturn;
  return (
    <Card
      title={
        <span className="flex items-center gap-2">
          <Target size={15} className="text-accent" /> {goal.name}
        </span>
      }
      subtitle={t('goals.summary', { target: formatMoney(goal.target, goal.currency, f.locale, { privacy: f.privacy }), date: formatDate(goal.targetDate, f.locale) })}
      actions={
        <>
          {dirty && (
            <button className="btn btn-sm btn-primary" onClick={() => void db.goals.update(goal.id, { monthlyContribution: contrib, expectedReturn: ret })}>
              {t('goals.saveScenario')}
            </button>
          )}
          <button className="btn btn-sm" onClick={onEdit}>
            {t('tx.edit')}
          </button>
          <button className="btn btn-sm btn-ghost btn-danger" aria-label={t('common.delete')} onClick={() => void db.goals.delete(goal.id)}>
            <Trash2 size={14} />
          </button>
        </>
      }
    >
      {!sameCcy ? (
        <Banner tone="info" action={<button className="btn btn-sm" onClick={() => setSetting('reportingCurrency', goal.currency)}>{t('goals.switchTo', { currency: goal.currency })}</button>}>
          {t('goals.otherCurrency', { currency: goal.currency })}
        </Banner>
      ) : (
        <>
          <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
            <Kpi label={t('goals.progress')} value={<Pct value={progress} decimals={0} />} sub={<Money value={current} className="text-xs text-muted" />} />
            <Kpi label={t('goals.probability')} value={<Pct value={proj?.probabilityOfSuccess} decimals={0} />} sub={<span className="text-xs text-muted">{t('goals.probabilityHint')}</span>} />
            <Kpi label={t('goals.expectedAt', { date: formatDate(goal.targetDate, f.locale) })} value={<Money value={proj?.expectedFinalValue} />} sub={<span className="text-xs text-muted">{proj?.monthsToTarget !== undefined ? t('goals.reachIn', { date: formatDate(`${addMonths(a!.asOf.slice(0, 7), proj.monthsToTarget)}-01`, f.locale) }) : t('goals.notReached')}</span>} />
            <Kpi label={t('goals.required')} value={<Money value={proj?.requiredMonthlyContribution} />} sub={<span className="text-xs text-muted">{t('goals.requiredHint')}</span>} />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 mt-4" data-testid="goal-whatif">
            <label className="text-[13px]">
              <span className="label">
                {t('goals.monthly', { currency: goal.currency })}: <b className="num">{formatMoney(contrib, goal.currency, f.locale, { privacy: f.privacy })}</b>
              </span>
              <input type="range" className="w-full accent-[var(--accent)]" min={0} max={Math.max(goal.monthlyContribution * 3, goal.target / 120, 1)} step={Math.max(1, Math.round(goal.target / 2000))} value={contrib} onChange={(e) => setContrib(Number(e.target.value))} />
            </label>
            <label className="text-[13px]">
              <span className="label">
                {t('goals.return')}: <b className="num">{formatPct(ret, f.locale, { decimals: 1 })}</b>
                {histReturn !== undefined && <span className="text-muted"> · {t('goals.historical', { value: formatPct(histReturn, f.locale, { decimals: 1 }) })}</span>}
              </span>
              <input type="range" className="w-full accent-[var(--accent)]" min={0} max={0.25} step={0.005} value={ret} onChange={(e) => setRet(Number(e.target.value))} />
            </label>
          </div>
          {series.length > 0 && (
            <div className="mt-3">
              <LineChart series={series} valueFormat={money} ariaLabel={t('goals.chart')} height={260} scale={false} />
            </div>
          )}
          <p className="text-xs text-muted mt-2">{t('goals.method', { vol: formatPct(vol && vol > 0 ? vol : 0.12, f.locale, { decimals: 1 }) })}</p>
        </>
      )}
    </Card>
  );
}
