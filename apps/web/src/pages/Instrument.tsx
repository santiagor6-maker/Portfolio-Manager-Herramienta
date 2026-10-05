import { useCallback, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useLiveQuery } from 'dexie-react-hooks';
import { ArrowLeft, Plus } from 'lucide-react';
import { db } from '../db/schema';
import { Card, Delta, EmptyState, Kpi, Money, PageHeader, Pct, Segmented } from '../components/ui';
import { LineChart } from '../components/charts';
import { useAnalysis, type ChartPeriod, periodStart } from '../hooks/useAnalysis';
import { useInstrumentMap, useScopedTransactions } from '../hooks/useData';
import { useFmt } from '../store/app';
import { formatDate, formatMoney, formatPrice, formatQuantity } from '../lib/format';
import { countryName, flagEmoji } from '../lib/labels';
import { TxTypeBadge } from './Transactions';

export default function InstrumentPage() {
  const { id = '' } = useParams();
  const instrumentId = decodeURIComponent(id);
  const { t } = useTranslation();
  const f = useFmt();
  const map = useInstrumentMap();
  const inst = map.get(instrumentId);
  const { analysis: a } = useAnalysis();
  const [period, setPeriod] = useState<ChartPeriod>('1Y');
  const series = useLiveQuery(() => db.priceSeries.get(instrumentId), [instrumentId]);
  const manual = useLiveQuery(() => db.manualPrices.where('instrumentId').equals(instrumentId).sortBy('date'), [instrumentId]);
  const txs = (useScopedTransactions() ?? []).filter((x) => x.instrumentId === instrumentId);
  const holding = a?.valuation?.holdings.find((h) => h.instrumentId === instrumentId);
  const income = (a?.income ?? []).filter((e) => e.instrumentId === instrumentId);
  const realized = (a?.realized ?? []).filter((r) => r.instrumentId === instrumentId);
  const totalIncome = income.reduce((s, e) => s + e.netBase, 0);
  const totalRealized = realized.reduce((s, r) => s + r.gainBase, 0);

  const points = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of series?.points ?? []) m.set(p.date, p.close);
    for (const p of manual ?? []) m.set(p.date, p.close);
    return [...m.entries()].sort((x, y) => (x[0] < y[0] ? -1 : 1));
  }, [series, manual]);
  const from = periodStart(period, a?.asOf ?? new Date().toISOString().slice(0, 10), points[0]?.[0]);
  const visible = points.filter(([d]) => d >= from);
  const ccy = inst?.currency ?? holding?.currency ?? 'USD';
  const priceFmt = useCallback((v: number) => formatPrice(v, ccy, f.locale), [ccy, f.locale]);
  const chartSeries = useMemo(() => [{ name: inst?.symbol ?? instrumentId, data: visible, area: true }], [visible, inst, instrumentId]);
  const periodChange = visible.length > 1 ? visible[visible.length - 1]![1] / visible[0]![1] - 1 : undefined;

  if (!inst && !holding && !txs.length) {
    return (
      <EmptyState
        title={t('instrument.notFound')}
        action={
          <Link className="btn" to="/posiciones">
            <ArrowLeft size={15} /> {t('nav.positions')}
          </Link>
        }
      />
    );
  }

  return (
    <div>
      <Link to="/posiciones" className="btn btn-ghost btn-sm -ml-2 mb-2">
        <ArrowLeft size={14} /> {t('nav.positions')}
      </Link>
      <PageHeader
        title={
          <span className="flex items-center gap-2">
            <span aria-hidden>{flagEmoji(inst?.country ?? '')}</span>
            {inst?.symbol ?? instrumentId}
            <span className="text-ink-2 font-normal text-base truncate">{inst?.name}</span>
          </span>
        }
        subtitle={
          <span className="flex flex-wrap gap-1.5 mt-1">
            {inst && <span className="chip">{inst.exchange}</span>}
            {inst && <span className="chip">{countryName(inst.country, f.locale)}</span>}
            {inst && <span className="chip">{t(`assetClass.${inst.assetClass}`)}</span>}
            {inst?.sector && <span className="chip">{inst.sector}</span>}
            <span className="chip">{ccy}</span>
            {inst?.pricing === 'manual' && <span className="chip">{t('pos.manual')}</span>}
          </span>
        }
        actions={
          <Link className="btn btn-primary" to={`/movimientos?nuevo=1&instrumento=${encodeURIComponent(instrumentId)}`}>
            <Plus size={15} /> {t('tx.add')}
          </Link>
        }
      />

      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
        <Kpi label={t('pos.quantity')} value={formatQuantity(holding?.quantity ?? 0, f.locale, f.privacy)} sub={<span className="text-muted text-xs">{t('pos.avgCost')}: {holding?.quantity ? (f.privacy ? '•••' : formatPrice(holding.costBasis / holding.quantity, ccy, f.locale)) : '—'}</span>} />
        <Kpi label={t('pos.valueBase', { currency: f.currency })} value={<Money value={holding?.marketValueBase ?? 0} />} sub={<Money value={holding?.marketValue} currency={ccy} className="text-muted text-xs" />} />
        <Kpi
          label={t('pos.unrealized')}
          value={<Money value={holding?.unrealizedGainBase ?? 0} signed />}
          sub={
            <span className="text-xs text-muted flex gap-2 flex-wrap">
              <span>
                {t('pos.priceEffect')}: <Money value={holding?.priceGainBase} signed />
              </span>
              <span>
                {t('pos.fxEffect')}: <Money value={holding?.fxGainBase} signed />
              </span>
            </span>
          }
        />
        <Kpi
          label={t('instrument.incomeRealized')}
          value={<Money value={totalIncome + totalRealized} signed />}
          sub={
            <span className="text-xs text-muted">
              {t('nav.dividends')}: <Money value={totalIncome} /> · {t('instrument.realized')}: <Money value={totalRealized} signed />
            </span>
          }
        />
      </div>

      <Card
        className="mt-3"
        title={t('instrument.price', { currency: ccy })}
        subtitle={periodChange !== undefined ? <Delta pct={periodChange} size="sm" /> : undefined}
        actions={
          <Segmented
            label={t('common.period')}
            value={period}
            onChange={setPeriod}
            options={(['MTD', 'YTD', '1Y', '3Y', 'ALL'] as const).map((p) => ({ value: p, label: t(`period.${p}`) }))}
          />
        }
      >
        {visible.length > 1 ? (
          <LineChart series={chartSeries} valueFormat={priceFmt} ariaLabel={t('instrument.priceAria')} height={260} />
        ) : (
          <p className="text-sm text-muted py-12 text-center">{t('instrument.noPrices')}</p>
        )}
      </Card>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-3 mt-3">
        <Card title={t('instrument.lots')} bodyClassName="!p-0">
          <table className="table">
            <thead>
              <tr>
                <th>{t('instrument.openDate')}</th>
                <th className="r">{t('pos.quantity')}</th>
                <th className="r">{t('instrument.unitCost')}</th>
                <th className="r">{t('instrument.unitCostBase', { currency: f.currency })}</th>
                <th className="r">{t('pos.unrealized')}</th>
              </tr>
            </thead>
            <tbody>
              {(holding?.lots ?? []).map((l, i) => {
                const gain = holding?.price !== undefined ? (holding.price - l.unitCost) / (l.unitCost || 1) : undefined;
                return (
                  <tr key={i}>
                    <td>{formatDate(l.openDate, f.locale)}</td>
                    <td className="r num">{formatQuantity(l.quantity, f.locale, f.privacy)}</td>
                    <td className="r num">{formatPrice(l.unitCost, ccy, f.locale)}</td>
                    <td className="r num">{formatMoney(l.unitCostBase, f.currency, f.locale)}</td>
                    <td className="r">
                      <Pct value={gain} signed colored />
                    </td>
                  </tr>
                );
              })}
              {!holding?.lots.length && (
                <tr>
                  <td colSpan={5} className="text-center text-muted !py-6">
                    {t('instrument.noLots')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </Card>

        <Card title={t('nav.transactions')} bodyClassName="!p-0">
          <div className="max-h-[360px] overflow-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('tx.date')}</th>
                  <th>{t('tx.typeLabel')}</th>
                  <th className="r">{t('pos.quantity')}</th>
                  <th className="r">{t('tx.price')}</th>
                  <th className="r">{t('tx.amount')}</th>
                </tr>
              </thead>
              <tbody>
                {txs.map((x) => (
                  <tr key={x.id}>
                    <td>{formatDate(x.date, f.locale, 'short')}</td>
                    <td>
                      <TxTypeBadge type={x.type} />
                    </td>
                    <td className="r num">{x.quantity !== undefined ? formatQuantity(x.quantity, f.locale, f.privacy) : '—'}</td>
                    <td className="r num">{x.price !== undefined ? formatPrice(x.price, x.currency, f.locale) : '—'}</td>
                    <td className="r num">
                      {formatMoney(x.amount ?? (x.quantity ?? 0) * (x.price ?? 0), x.currency, f.locale, { privacy: f.privacy })}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      </div>
    </div>
  );
}
