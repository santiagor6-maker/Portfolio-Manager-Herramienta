import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Download, Layers, Search } from 'lucide-react';
import type { Holding, Instrument } from '@pm/core';
import { Card, Delta, EmptyState, Money, PageHeader, Pct, Skeleton } from '../components/ui';
import { DataTable, type Column } from '../components/DataTable';
import { useAnalysis } from '../hooks/useAnalysis';
import { useInstrumentMap } from '../hooks/useData';
import { useFmt } from '../store/app';
import { formatDate, formatMoney, formatPrice, formatQuantity } from '../lib/format';
import { countryName, flagEmoji } from '../lib/labels';
import { downloadText, toCsv } from '../lib/export';

interface Row extends Holding {
  inst?: Instrument;
  avgCost: number;
  gainPct?: number;
}

export default function PositionsPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { analysis: a, loading } = useAnalysis();
  const map = useInstrumentMap();
  const f = useFmt();
  const [q, setQ] = useState('');
  const [country, setCountry] = useState('');
  const [cls, setCls] = useState('');
  const [ccy, setCcy] = useState('');

  const rows: Row[] = useMemo(
    () =>
      (a?.valuation?.holdings ?? [])
        .filter((h) => Math.abs(h.quantity) > 1e-9)
        .map((h) => ({
          ...h,
          inst: map.get(h.instrumentId),
          avgCost: h.quantity ? h.costBasis / h.quantity : 0,
          gainPct: h.costBasisBase ? (h.unrealizedGainBase ?? 0) / h.costBasisBase : undefined,
        })),
    [a, map],
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

  const columns: Column<Row>[] = [
    {
      id: 'instrument',
      header: t('pos.instrument'),
      sticky: true,
      sortValue: (r) => r.inst?.symbol ?? r.instrumentId,
      cell: (r) => (
        <div className="flex items-center gap-2.5 min-w-[150px] max-w-[260px]">
          <span className="text-base leading-none" aria-hidden>
            {flagEmoji(r.inst?.country ?? '')}
          </span>
          <div className="min-w-0">
            <div className="font-semibold text-ink">{r.inst?.symbol ?? r.instrumentId}</div>
            <div className="text-xs text-muted truncate">{r.inst?.name}</div>
          </div>
        </div>
      ),
      footer: t('common.total'),
    },
    {
      id: 'qty',
      header: t('pos.quantity'),
      align: 'right',
      sortValue: (r) => r.quantity,
      cell: (r) => formatQuantity(r.quantity, f.locale, f.privacy),
    },
    {
      id: 'avg',
      header: t('pos.avgCost'),
      align: 'right',
      sortValue: (r) => r.avgCost,
      cell: (r) => <span className="text-ink-2">{f.privacy ? '•••' : formatPrice(r.avgCost, r.currency, f.locale)}</span>,
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
            {r.priceDate ? formatDate(r.priceDate, f.locale, 'short') : t('pos.noPrice')}
            {r.inst?.pricing === 'manual' ? ` · ${t('pos.manual')}` : ''}
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
      header: t('pos.unrealized'),
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
      id: 'priceEffect',
      header: t('pos.priceEffect'),
      headerTitle: t('pos.priceEffectHint'),
      align: 'right',
      sortValue: (r) => r.priceGainBase,
      cell: (r) => <Money value={r.priceGainBase} signed className={tone(r.priceGainBase)} />,
      footer: <Money value={sum((r) => r.priceGainBase)} signed />,
    },
    {
      id: 'fxEffect',
      header: t('pos.fxEffect'),
      headerTitle: t('pos.fxEffectHint'),
      align: 'right',
      sortValue: (r) => r.fxGainBase,
      cell: (r) => <Money value={r.fxGainBase} signed className={tone(r.fxGainBase)} />,
      footer: <Money value={sum((r) => r.fxGainBase)} signed />,
    },
    {
      id: 'weight',
      header: t('pos.weight'),
      align: 'right',
      sortValue: (r) => r.weight,
      cell: (r) => (
        <div className="flex items-center justify-end gap-2">
          <div className="w-12 h-1.5 rounded-full bg-surface-3 overflow-hidden hidden md:block" aria-hidden>
            <div className="h-full bg-[var(--series-1)]" style={{ width: `${Math.min(100, (r.weight ?? 0) * 100)}%` }} />
          </div>
          <Pct value={r.weight} decimals={1} />
        </div>
      ),
    },
  ];

  const exportCsv = () => {
    const header = ['symbol', 'name', 'currency', 'quantity', 'avgCost', 'price', 'priceDate', 'valueLocal', `value${f.currency}`, `unrealized${f.currency}`, 'priceEffect', 'fxEffect', 'weight'];
    const body = filtered.map((r) => [
      r.inst?.symbol ?? r.instrumentId,
      r.inst?.name ?? '',
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
          <button className="btn" onClick={exportCsv} disabled={!filtered.length}>
            <Download size={15} /> CSV
          </button>
        }
      />
      <Card bodyClassName="!p-0">
        <div className="flex flex-wrap items-center gap-2 p-3 border-b border-line">
          <div className="relative flex-1 min-w-[180px] max-w-xs">
            <Search size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" aria-hidden />
            <input
              className="input !pl-8"
              placeholder={t('pos.search')}
              aria-label={t('pos.search')}
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
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
          <DataTable
            caption={t('pos.title')}
            testId="positions-table"
            rows={filtered}
            columns={columns}
            rowKey={(r) => r.instrumentId}
            initialSort={{ id: 'value', dir: 'desc' }}
            onRowClick={(r) => navigate(`/posiciones/${encodeURIComponent(r.instrumentId)}`)}
            footer
            empty={t('common.noResults')}
          />
        )}
      </Card>

      {cash.length > 0 && (
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

function tone(v: number | undefined): string {
  if (!v || Math.abs(v) < 1e-9) return 'text-muted';
  return v > 0 ? 'text-pos' : 'text-neg';
}
