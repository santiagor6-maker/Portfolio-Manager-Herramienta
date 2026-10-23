/**
 * D22: per-source freshness (prices, FX, each index) — diagnostics, shown in Ajustes rather than on the
 * Resumen, where five "falló" lines for indices of other currencies were noise.
 */
import { useTranslation } from 'react-i18next';
import { useLiveQuery } from 'dexie-react-hooks';
import { Database } from 'lucide-react';
import { Card } from './ui';
import { useApp, useFmt } from '../store/app';
import { useInstrumentMap } from '../hooks/useData';
import { db } from '../db/schema';
import { formatRelative } from '../lib/format';
import { indexName } from '../lib/labels';

export function FreshnessCard() {
  const { t } = useTranslation();
  const market = useApp((s) => s.market);
  const f = useFmt();
  const sources = Object.entries(market.sources);
  const instruments = useInstrumentMap();
  // Market-data R5: series where the server's snapshot covers only part of the range.
  const partial = useLiveQuery(() => db.priceSeries.filter((s) => !!s.partial).primaryKeys(), [], [] as string[]).map(
    (id) => instruments.get(String(id))?.symbol ?? String(id),
  );
  return (
    <Card title={t('dashboard.freshness')} subtitle={t('dashboard.freshnessSub')}>
      <ul className="text-[13px] flex flex-col gap-2">
        <li className="flex items-center gap-2">
          <Database size={14} className="text-muted" aria-hidden />
          <span className="flex-1">{t('dashboard.serverStatus')}</span>
          <span className="chip">{t(`market.status.${market.status}`)}</span>
        </li>
        {sources.map(([name, s]) => (
          <li key={name} className="flex flex-wrap items-center gap-2">
            <span className={`size-2 rounded-full ${s.ok ? 'bg-pos' : 'bg-warn'}`} aria-hidden />
            <span className="flex-1">
              {name.startsWith('idx_') ? `${t('source.index')} ${indexName(name.slice(4))}` : t(`source.${name}`, { defaultValue: name })}
              {s.count ? <span className="text-muted text-xs"> · {s.count}</span> : null}
            </span>
            <span className="text-xs text-muted" title={s.message}>{s.updatedAt ? formatRelative(s.updatedAt, f.locale) : s.ok ? '—' : t('market.failed')}</span>
            {!s.ok && name.startsWith('idx_') && <span className="basis-full text-[11px] text-muted pl-4">{t('dashboard.indexFailedImpact')}</span>}
          </li>
        ))}
        {!sources.length && <li className="text-xs text-muted">{t('dashboard.noSources')}</li>}
        {partial.length > 0 && (
          <li className="text-xs text-warn" data-testid="partial-series">
            {t('md.partialList', { symbols: partial.join(', ') })}
          </li>
        )}

      </ul>
    </Card>
  );
}

