import { useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import { Download, Layers, Search } from 'lucide-react';
import type { AllocationDimension, Holding, Instrument, PositionPerformance } from '@pm/core';
import { Card, Delta, EmptyState, Money, PageHeader, Pct, Segmented, Skeleton } from '../components/ui';
import { DataTable, type Column } from '../components/DataTable';
import { useAnalysis } from '../hooks/useAnalysis';
import { useInstrumentMap } from '../hooks/useData';
import { useApp, useFmt } from '../store/app';
import { formatDate, formatMoney, formatPct, formatPrice, formatQuantity } from '../lib/format';
import { countryName, flagEmoji, useSliceLabel } from '../lib/labels';
import { exchangeLabel } from '../lib/exchanges';
import { downloadText, toCsv } from '../lib/export';
import { parseDecimal, toInputNumber } from '../lib/parse';
import { rebalance } from '../lib/rebalance';

interface Row extends Holding {
  inst?: Instrument;
  avgCost: number;
  gainPct?: number;
  perf?: PositionPerformance;
}

type View = 'value' | 'performance' | 'targets';

export default function PositionsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { analysis: a, loading } = useAnalysis();
  const map = useInstrumentMap();
  const f = useFmt();
  const [view, setView] = useState<View>('value');
  const [perfPeriod, setPerfPeriod] = useState<'SI' | 'YTD'>('SI');
  const [q, setQ] = useState('');
  const [country, setCountry] = useState('');
  const [cls, setCls] = useState('');
  const [ccy, setCcy] = useState('');

  const perfById = useMemo(() => new Map((perfPeriod === 'SI' ? a?.positions : a?.positionsYtd)?.map((p) => [p.instrumentId, p]) ?? []), [a, perfPeriod]);
  const rows: Row[] = useMemo(
    () =>
      (a?.valuation?.holdings ?? [])
        .filter((h) => Math.abs(h.quantity) > 1e-9)
        .map((h) => ({
          ...h,
          inst: map.get(h.instrumentId),
          avgCost: h.quantity ? h.costBasis / h.quantity : 0,
          gainPct: h.costBasisBase ? (h.unrealizedGainBase ?? 0) / h.costBasisBase : undefined,
          perf: perfById.get(h.instrumentId),
        })),
    [a, map, perfById],
  );

  const filtered = rows.filter((r) => {
    const needle = q.trim().toLowerCase();
    if (needle && !`${r.inst?.symbol} ${r.inst?.name}`.toLowerCase().includes(needle)) return false;
    if (country && r.inst?.country !== country) return false;
    if (cls && r.inst?.assetClass !== cls) return false;
    if (ccy && r.currency !== ccy) return false;
    return true;
  });

  const countries = [...new Set(rows.map((r) => r.inst?.country).filter(Boolean))] as string[];
  const classes = [...new Set(rows.map((r) => r.inst?.assetClass).filter(Boolean))] as string[];
  const currencies = [...new Set(rows.map((r) => r.currency))];

  const sum = (fn: (r: Row) => number | undefined) => filtered.reduce((s, r) => s + (fn(r) ?? 0), 0);
  const totalValue = sum((r) => r.marketValueBase);
  const totalCost = sum((r) => r.costBasisBase);
  const totalGain = sum((r) => r.unrealizedGainBase);

  const instrumentCol: Column<Row> = {
    id: 'instrument',
    header: t('pos.instrument'),
    sticky: true,
    sortValue: (r) => r.inst?.symbol ?? r.instrumentId,
    cell: (r) => (
      <div className="flex items-center gap-2.5 min-w-[150px] max-w-[230px]">
        <span className="text-base leading-none" aria-hidden>
          {flagEmoji(r.inst?.country ?? '')}
        </span>
        <div className="min-w-0">
          <div className="font-semibold text-ink">
            {r.inst?.symbol ?? r.instrumentId}
            <span className="ml-1.5 text-[11px] font-normal text-muted">{exchangeLabel(r.inst?.exchange)}</span>
          </div>
          <div className="text-xs text-muted truncate">{r.inst?.name}</div>
        </div>
      </div>
    ),
    footer: t('common.total'),
  };

  const valueColumns: Column<Row>[] = [
    instrumentCol,
    {
      id: 'qty',
      header: t('pos.quantity'),
      align: 'right',
      sortValue: (r) => r.quantity,
      cell: (r) => (
        <div>
          <div>{formatQuantity(r.quantity, f.locale, f.privacy)}</div>
          <div className="text-[11px] text-muted" title={t('pos.avgCost')}>
            {f.privacy ? '•••' : formatPrice(r.avgCost, r.currency, f.locale)}
          </div>
        </div>
      ),
    },
    {
      id: 'price',
      header: t('pos.price'),
      align: 'right',
      sortValue: (r) => r.price,
      cell: (r) => (
        <div>
          <div>{formatPrice(r.price, r.currency, f.locale)}</div>
          <div className="text-[11px] text-muted">
            {r.priceSource === 'accrual' ? t('pos.accrual') : r.priceDate ? formatDate(r.priceDate, f.locale, 'short') : t('pos.noPrice')}
            {r.inst?.pricing === 'manual' && !r.inst.accrual ? ` · ${t('pos.manual')}` : ''}
          </div>
        </div>
      ),
    },
    {
      id: 'value',
      header: t('pos.valueBase', { currency: f.currency }),
      align: 'right',
      sortValue: (r) => r.marketValueBase,
      cell: (r) => (
        <div>
          <Money value={r.marketValueBase} className="font-semibold" />
          {r.currency !== f.currency && (
            <div className="text-[11px] text-muted">
              <Money value={r.marketValue} currency={r.currency} />
            </div>
          )}
        </div>
      ),
      footer: <Money value={totalValue} />,
    },
    {
      id: 'gain',
      header: t('pos.unrealizedShort'),
      headerTitle: t('pos.unrealized'),
      align: 'right',
      sortValue: (r) => r.unrealizedGainBase,
      cell: (r) => (
        <div className="flex flex-col items-end">
          <Delta amount={r.unrealizedGainBase} size="sm" />
          <Pct value={r.gainPct} signed className="text-[11px] text-muted" />
        </div>
      ),
      footer: <Delta amount={totalGain} pct={totalCost ? totalGain / totalCost : undefined} size="sm" />,
    },
    {
      id: 'effects',
      header: t('pos.effects'),
      headerTitle: `${t('pos.priceEffectHint')} / ${t('pos.fxEffectHint')}`,
      align: 'right',
      sortValue: (r) => r.fxGainBase,
      cell: (r) => (
        <div className="text-[12px] leading-snug">
          <div>
            <span className="text-muted mr-1">{t('pos.priceAbbr')}</span>
            <Money value={r.priceGainBase} signed className={tone(r.priceGainBase)} />
          </div>
          <div>
            <span className="text-muted mr-1">{t('pos.fxAbbr')}</span>
            <Money value={r.fxGainBase} signed className={tone(r.fxGainBase)} />
          </div>
        </div>
      ),
      footer: (
        <div className="text-[12px] leading-snug">
          <div>
            {t('pos.priceAbbr')} <Money value={sum((r) => r.priceGainBase)} signed />
          </div>
          <div>
            {t('pos.fxAbbr')} <Money value={sum((r) => r.fxGainBase)} signed />
          </div>
        </div>
      ),
    },
    {
      id: 'weight',
      header: t('pos.weight'),
      align: 'right',
      sortValue: (r) => r.weight,
      cell: (r) => (
        <div className="flex items-center justify-end gap-2">
          <div className="w-10 h-1.5 rounded-full bg-surface-3 overflow-hidden hidden xl:block" aria-hidden>
            <div className="h-full bg-[var(--series-1)]" style={{ width: `${Math.min(100, (r.weight ?? 0) * 100)}%` }} />
          </div>
          <Pct value={r.weight} decimals={1} />
        </div>
      ),
    },
  ];

  const perfColumns: Column<Row>[] = [
    instrumentCol,
    { id: 'invested', header: t('perf.pos.invested'), align: 'right', sortValue: (r) => r.perf?.investedBase, cell: (r) => <Money value={r.perf?.investedBase} />, footer: <Money value={sum((r) => r.perf?.investedBase)} /> },
    { id: 'proceeds', header: t('perf.pos.proceeds'), align: 'right', sortValue: (r) => r.perf?.proceedsBase, cell: (r) => <Money value={r.perf?.proceedsBase} className="text-ink-2" />, footer: <Money value={sum((r) => r.perf?.proceedsBase)} /> },
    { id: 'income', header: t('perf.pos.income'), align: 'right', sortValue: (r) => r.perf?.incomeBase, cell: (r) => <Money value={r.perf?.incomeBase} className={r.perf?.incomeBase ? 'text-pos' : 'text-muted'} />, footer: <Money value={sum((r) => r.perf?.incomeBase)} /> },
    { id: 'realized', header: t('perf.pos.realized'), align: 'right', sortValue: (r) => r.perf?.realizedGainBase, cell: (r) => <Money value={r.perf?.realizedGainBase} signed className={tone(r.perf?.realizedGainBase)} />, footer: <Money value={sum((r) => r.perf?.realizedGainBase)} signed /> },
    {
      id: 'total',
      header: t('perf.pos.total'),
      headerTitle: t('perf.pos.totalHint'),
      align: 'right',
      sortValue: (r) => r.perf?.totalReturnBase,
      cell: (r) => (
        <div className="flex flex-col items-end">
          <Delta amount={r.perf?.totalReturnBase} size="sm" />
          <Pct value={r.perf?.simpleReturn} signed className="text-[11px] text-muted" />
        </div>
      ),
      footer: <Delta amount={sum((r) => r.perf?.totalReturnBase)} size="sm" />,
    },
    {
      id: 'twr',
      header: 'TWR',
      headerTitle: t('perf.twrHint'),
      align: 'right',
      sortValue: (r) => r.perf?.twr,
      cell: (r) => (
        <div className="flex flex-col items-end">
          <Pct value={r.perf?.twr} signed colored />
          {r.perf?.twrAnnualized !== undefined && <span className="text-[11px] text-muted">{formatPct(r.perf.twrAnnualized, f.locale, { signed: true })} {t('perf.perYear')}</span>}
        </div>
      ),
    },
    {
      id: 'irr',
      header: t('perf.mwrShort'),
      headerTitle: t('perf.mwrHint'),
      align: 'right',
      sortValue: (r) => r.perf?.irr ?? r.perf?.irrPeriod,
      cell: (r) => <IrrCell perf={r.perf} />,
    },
  ];

  const exportCsv = () => {
    const header = ['symbol', 'name', 'exchange', 'currency', 'quantity', 'avgCost', 'price', 'priceDate', 'valueLocal', `value${f.currency}`, `unrealized${f.currency}`, 'priceEffect', 'fxEffect', 'weight', 'totalReturn', 'twr', 'irr'];
    const body = filtered.map((r) => [
      r.inst?.symbol ?? r.instrumentId,
      r.inst?.name ?? '',
      r.inst?.exchange ?? '',
      r.currency,
      r.quantity,
      r.avgCost,
      r.price ?? '',
      r.priceDate ?? '',
      r.marketValue ?? '',
      r.marketValueBase ?? '',
      r.unrealizedGainBase ?? '',
      r.priceGainBase ?? '',
      r.fxGainBase ?? '',
      r.weight ?? '',
      r.perf?.totalReturnBase ?? '',
      r.perf?.twr ?? '',
      r.perf?.irr ?? '',
    ]);
    downloadText(`posiciones-${a?.asOf ?? ''}.csv`, toCsv([header, ...body]), 'text/csv');
  };

  const cash = a?.valuation?.cash.filter((c) => Math.abs(c.amount) > 0.005) ?? [];

  return (
    <div>
      <PageHeader
        title={t('pos.title')}
        subtitle={t('pos.subtitle', { count: rows.length })}
        actions={
          <>
            <Segmented<View>
              label={t('pos.view')}
              value={view}
              onChange={setView}
              options={[
                { value: 'value', label: t('pos.viewValue') },
                { value: 'performance', label: t('pos.viewPerformance') },
                { value: 'targets', label: t('pos.viewTargets') },
              ]}
            />
            <button className="btn" onClick={exportCsv} disabled={!filtered.length}>
              <Download size={15} /> CSV
            </button>
          </>
        }
      />
      {view === 'targets' ? (
        <TargetsView />
      ) : (
        <Card bodyClassName="!p-0">
          <div className="flex flex-wrap items-center gap-2 p-3 border-b border-line print:hidden">
            <div className="relative flex-1 min-w-[180px] max-w-xs">
              <Search size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" aria-hidden />
              <input className="input !pl-8" placeholder={t('pos.search')} aria-label={t('pos.search')} value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            <select className="select !w-auto" aria-label={t('dim.country')} value={country} onChange={(e) => setCountry(e.target.value)}>
              <option value="">{t('pos.allCountries')}</option>
              {countries.map((c) => (
                <option key={c} value={c}>
                  {flagEmoji(c)} {countryName(c, f.locale)}
                </option>
              ))}
            </select>
            <select className="select !w-auto" aria-label={t('dim.assetClass')} value={cls} onChange={(e) => setCls(e.target.value)}>
              <option value="">{t('pos.allClasses')}</option>
              {classes.map((c) => (
                <option key={c} value={c}>
                  {t(`assetClass.${c}`)}
                </option>
              ))}
            </select>
            <select className="select !w-auto" aria-label={t('dim.currency')} value={ccy} onChange={(e) => setCcy(e.target.value)}>
              <option value="">{t('pos.allCurrencies')}</option>
              {currencies.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
            {view === 'performance' && (
              <Segmented<'SI' | 'YTD'>
                className="ml-auto"
                label={t('common.period')}
                value={perfPeriod}
                onChange={setPerfPeriod}
                options={[
                  { value: 'SI', label: t('period.ALL') },
                  { value: 'YTD', label: t('period.YTD') },
                ]}
              />
            )}
          </div>
          {loading ? (
            <div className="p-4 flex flex-col gap-2">
              {[0, 1, 2, 3, 4, 5].map((i) => (
                <Skeleton key={i} className="h-10" />
              ))}
            </div>
          ) : rows.length === 0 ? (
            <EmptyState icon={<Layers size={20} />} title={t('pos.emptyTitle')} body={t('pos.emptyBody')} />
          ) : (
            <>
              <div className="hidden md:block print:block">
                <DataTable
                  caption={t('pos.title')}
                  testId="positions-table"
                  rows={filtered}
                  columns={view === 'value' ? valueColumns : perfColumns}
                  rowKey={(r) => r.instrumentId}
                  initialSort={{ id: view === 'value' ? 'value' : 'total', dir: 'desc' }}
                  onRowClick={(r) => navigate(`/posiciones/${encodeURIComponent(r.instrumentId)}`)}
                  footer
                  empty={t('common.noResults')}
                />
              </div>
              <ul className="md:hidden print:hidden divide-y divide-line" data-testid="positions-cards">
                {[...filtered]
                  .sort((x, y) => (y.marketValueBase ?? 0) - (x.marketValueBase ?? 0))
                  .map((r) => (
                    <li key={r.instrumentId}>
                      <Link to={`/posiciones/${encodeURIComponent(r.instrumentId)}`} className="flex items-center gap-3 px-4 py-3">
                        <span aria-hidden>{flagEmoji(r.inst?.country ?? '')}</span>
                        <div className="flex-1 min-w-0">
                          <div className="font-semibold">{r.inst?.symbol ?? r.instrumentId}</div>
                          <div className="text-xs text-muted truncate">
                            {formatQuantity(r.quantity, f.locale, f.privacy)} · {formatPrice(r.price, r.currency, f.locale)}
                          </div>
                        </div>
                        <div className="text-right">
                          <Money value={r.marketValueBase} className="font-semibold block" />
                          {view === 'value' ? (
                            <span className="text-xs">
                              <Pct value={r.gainPct} signed colored /> · <Pct value={r.weight} decimals={1} className="text-muted" />
                            </span>
                          ) : (
                            <span className="text-xs">
                              TWR <Pct value={r.perf?.twr} signed colored />
                            </span>
                          )}
                        </div>
                      </Link>
                    </li>
                  ))}
              </ul>
            </>
          )}
        </Card>
      )}

      {cash.length > 0 && view !== 'targets' && (
        <Card title={t('pos.cash')} className="mt-3" bodyClassName="!p-0">
          <table className="table">
            <thead>
              <tr>
                <th>{t('dim.currency')}</th>
                <th className="r">{t('pos.balance')}</th>
                <th className="r">{t('pos.valueBase', { currency: f.currency })}</th>
              </tr>
            </thead>
            <tbody>
              {cash.map((c) => (
                <tr key={c.currency}>
                  <td className="font-medium">{c.currency}</td>
                  <td className="r num">{formatMoney(c.amount, c.currency, f.locale, { privacy: f.privacy })}</td>
                  <td className="r">
                    <Money value={c.amountBase} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </div>
  );
}

export function IrrCell({ perf }: { perf?: PositionPerformance }) {
  const { t } = useTranslation();
  if (!perf) return <span className="text-muted">—</span>;
  const years = (Date.parse(perf.to) - Date.parse(perf.from)) / (365.25 * 86_400_000);
  // Never annualize periods shorter than a year (W9).
  if (years < 1 || perf.irr === undefined)
    return (
      <span title={t('perf.notAnnualized')}>
        <Pct value={perf.irrPeriod} signed colored /> <span className="text-[10px] text-muted">{t('perf.inPeriod')}</span>
      </span>
    );
  return (
    <span>
      <Pct value={perf.irr} signed colored /> <span className="text-[10px] text-muted">{t('perf.perYear')}</span>
    </span>
  );
}

function tone(v: number | undefined): string {
  if (!v || Math.abs(v) < 1e-9) return 'text-muted';
  return v > 0 ? 'text-pos' : 'text-neg';
}

/** Rebalancing: target weights per dimension, deviations and amounts to buy/sell (W11). */
function TargetsView() {
  const { t } = useTranslation();
  const f = useFmt();
  const { analysis: a } = useAnalysis();
  const targets = useApp((s) => s.settings.targets);
  const setSetting = useApp((s) => s.setSetting);
  const [dim, setDim] = useState<AllocationDimension>('assetClass');
  const [contribution, setContribution] = useState('');
  const label = useSliceLabel(dim);
  const slices = a?.allocations[dim] ?? [];
  const current = targets[dim] ?? {};
  const keys = [...new Set([...slices.map((s) => s.key), ...Object.keys(current)])];
  const totalTarget = keys.reduce((s, k) => s + (current[k] ?? 0), 0);
  const contrib = parseDecimal(contribution, f.locale) ?? 0;
  const plan = rebalance(
    keys.map((k) => ({ key: k, value: slices.find((s) => s.key === k)?.valueBase ?? 0, target: current[k] ?? 0 })),
    contrib,
  );
  const setTarget = (k: string, v: string) => {
    const n = parseDecimal(v, f.locale);
    const next = { ...current };
    if (n === undefined || n <= 0) delete next[k];
    else next[k] = n / 100;
    setSetting('targets', { ...targets, [dim]: next });
  };
  return (
    <Card
      title={t('targets.title')}
      subtitle={t('targets.subtitle')}
      actions={
        <Segmented<AllocationDimension>
          label={t('dashboard.allocationBy')}
          value={dim}
          onChange={setDim}
          options={(['assetClass', 'country', 'currency', 'sector'] as AllocationDimension[]).map((d) => ({ value: d, label: t(`dim.${d}`) }))}
        />
      }
      bodyClassName="!p-0"
    >
      <div className="flex flex-wrap items-end gap-3 px-4 py-3 border-b border-line">
        <label className="text-[13px]">
          <span className="label">{t('targets.contribution', { currency: f.currency })}</span>
          <input className="input num !w-48" inputMode="decimal" value={contribution} onChange={(e) => setContribution(e.target.value)} placeholder="0" data-testid="rebalance-contribution" />
        </label>
        <p className="text-xs text-muted flex-1 min-w-[200px]">{t('targets.hint')}</p>
        <span className={clsx('chip', Math.abs(totalTarget - 1) > 0.001 && totalTarget > 0 && '!text-warn !border-warn/40')}>
          {t('targets.sum')}: {formatPct(totalTarget, f.locale, { decimals: 1 })}
        </span>
      </div>
      <div className="overflow-x-auto">
        <table className="table" data-testid="targets-table">
          <thead>
            <tr>
              <th>{t(`dim.${dim}`)}</th>
              <th className="r">{t('targets.value')}</th>
              <th className="r">{t('targets.current')}</th>
              <th className="r">{t('targets.target')}</th>
              <th className="r">{t('targets.deviation')}</th>
              <th className="r">{t('targets.toRebalance')}</th>
              {contrib > 0 && <th className="r">{t('targets.withContribution')}</th>}
            </tr>
          </thead>
          <tbody>
            {plan.rows.map((r) => {
              const s = slices.find((x) => x.key === r.key);
              return (
                <tr key={r.key}>
                  <td className="font-medium">{s ? label(s) : r.key}</td>
                  <td className="r">
                    <Money value={r.value} />
                  </td>
                  <td className="r">
                    <Pct value={r.weight} decimals={1} />
                  </td>
                  <td className="r">
                    <span className="inline-flex items-center gap-1">
                      <input
                        className="input num !w-20 !h-8 text-right"
                        inputMode="decimal"
                        aria-label={t('targets.targetFor', { key: s ? label(s) : r.key })}
                        defaultValue={current[r.key] !== undefined ? toInputNumber(Math.round(current[r.key]! * 1000) / 10, f.locale) : ''}
                        onBlur={(e) => setTarget(r.key, e.target.value)}
                      />
                      %
                    </span>
                  </td>
                  <td className="r">{r.target ? <Pct value={r.weight - r.target} signed colored decimals={1} /> : <span className="text-muted">—</span>}</td>
                  <td className="r">{r.target ? <Money value={r.trade} signed className={tone(r.trade)} /> : <span className="text-muted">—</span>}</td>
                  {contrib > 0 && <td className="r">{r.target ? <Money value={r.contribution} className={r.contribution ? 'text-pos font-semibold' : 'text-muted'} /> : '—'}</td>}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}
