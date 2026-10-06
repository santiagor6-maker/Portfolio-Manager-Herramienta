import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useLiveQuery } from 'dexie-react-hooks';
import { Bell, Plus, Star, Trash2 } from 'lucide-react';
import { Banner, Card, EmptyState, PageHeader, Pct } from '../components/ui';
import { InstrumentPicker } from '../components/InstrumentPicker';
import { db } from '../db/schema';
import { upsertInstruments } from '../db/repo';
import { useInstrumentMap } from '../hooks/useData';
import { useFmt } from '../store/app';
import { addDays, todayIso } from '../lib/ids';
import { formatDate, formatPrice } from '../lib/format';
import { exchangeLabel } from '../lib/exchanges';
import { flagEmoji } from '../lib/labels';
import { fetchHistory } from '../services/marketData';

/** Instruments the user follows without holding them: price, changes, 52-week range (W11). */
export default function WatchlistPage() {
  const { t } = useTranslation();
  const f = useFmt();
  const map = useInstrumentMap();
  const items = useLiveQuery(() => db.watchlist.toArray(), []);
  const series = useLiveQuery(async () => {
    const ids = (await db.watchlist.toArray()).map((w) => w.instrumentId);
    return new Map((await db.priceSeries.bulkGet(ids)).filter(Boolean).map((s) => [s!.instrumentId, s!.points]));
  }, [items?.length]);
  const [note, setNote] = useState<string>();

  const add = async (inst: Parameters<typeof upsertInstruments>[0][number]) => {
    if (!map.has(inst.id)) await upsertInstruments([inst]);
    await db.watchlist.put({ instrumentId: inst.id, addedAt: Date.now() });
    const ok = await fetchHistory(inst, addDays(todayIso(), -400));
    setNote(ok ? undefined : t('watch.offline'));
  };

  return (
    <div>
      <PageHeader title={t('watch.title')} subtitle={t('watch.subtitle')} />
      <Card className="mb-3" title={t('watch.add')}>
        <div className="max-w-xl">
          <InstrumentPicker inputId="watch-picker" onChange={(i) => void add(i)} onCreateManual={() => setNote(t('watch.noManual'))} />
        </div>
        {note && (
          <div className="mt-2">
            <Banner tone="info">{note}</Banner>
          </div>
        )}
      </Card>
      <Card bodyClassName="!p-0">
        {items && items.length === 0 ? (
          <EmptyState icon={<Star size={20} />} title={t('watch.emptyTitle')} body={t('watch.emptyBody')} />
        ) : (
          <div className="overflow-x-auto">
            <table className="table" data-testid="watchlist">
              <thead>
                <tr>
                  <th>{t('pos.instrument')}</th>
                  <th className="r">{t('pos.price')}</th>
                  <th className="r">{t('watch.day')}</th>
                  <th className="r">{t('watch.month')}</th>
                  <th className="r">{t('watch.year')}</th>
                  <th className="r hidden md:table-cell">{t('watch.range52')}</th>
                  <th className="w-36">
                    <span className="sr-only">{t('common.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {(items ?? []).map((w) => {
                  const inst = map.get(w.instrumentId);
                  const pts = series?.get(w.instrumentId) ?? [];
                  const last = pts[pts.length - 1];
                  const at = (days: number) => {
                    if (!last) return undefined;
                    const d = addDays(last.date, -days);
                    return [...pts].reverse().find((p) => p.date <= d)?.close;
                  };
                  const prev = pts[pts.length - 2]?.close;
                  const yr = pts.filter((p) => last && p.date >= addDays(last.date, -365)).map((p) => p.close);
                  const ch = (base?: number) => (last && base ? last.close / base - 1 : undefined);
                  const ccy = inst?.currency ?? 'USD';
                  return (
                    <tr key={w.instrumentId}>
                      <td>
                        <Link to={`/posiciones/${encodeURIComponent(w.instrumentId)}`} className="flex items-center gap-2">
                          <span aria-hidden>{flagEmoji(inst?.country ?? '')}</span>
                          <span className="font-semibold">{inst?.symbol ?? w.instrumentId}</span>
                          <span className="text-xs text-muted truncate max-w-[220px]">{inst?.name}</span>
                          <span className="text-[11px] text-muted">{exchangeLabel(inst?.exchange)}</span>
                        </Link>
                      </td>
                      <td className="r num">
                        {last ? formatPrice(last.close, ccy, f.locale) : '—'}
                        {last && <div className="text-[11px] text-muted">{formatDate(last.date, f.locale, 'short')}</div>}
                      </td>
                      <td className="r">
                        <Pct value={ch(prev)} signed colored />
                      </td>
                      <td className="r">
                        <Pct value={ch(at(30))} signed colored />
                      </td>
                      <td className="r">
                        <Pct value={ch(at(365))} signed colored />
                      </td>
                      <td className="r num text-xs text-ink-2 hidden md:table-cell">{yr.length ? `${formatPrice(Math.min(...yr), ccy, f.locale)} – ${formatPrice(Math.max(...yr), ccy, f.locale)}` : '—'}</td>
                      <td>
                        <div className="flex gap-1 justify-end">
                          <Link className="btn btn-sm btn-ghost btn-icon" to={`/alertas?instrumento=${encodeURIComponent(w.instrumentId)}`} aria-label={t('alerts.create')} title={t('alerts.create')}>
                            <Bell size={14} />
                          </Link>
                          <Link className="btn btn-sm" to={`/movimientos?nuevo=1&instrumento=${encodeURIComponent(w.instrumentId)}`}>
                            <Plus size={14} /> {t('tx.type.BUY')}
                          </Link>
                          <button className="btn btn-sm btn-ghost btn-icon btn-danger" aria-label={t('common.delete')} onClick={() => void db.watchlist.delete(w.instrumentId)}>
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
