import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { useLiveQuery } from 'dexie-react-hooks';
import { AlertTriangle, Check } from 'lucide-react';
import type { Diagnostic } from '@pm/core';
import { db, type StoredTransaction } from '../db/schema';
import { useAnalysis } from '../hooks/useAnalysis';
import { useInstrumentMap } from '../hooks/useData';
import { useFmt } from '../store/app';
import { formatDate, formatPrice } from '../lib/format';

export type PriceWarningCode = 'TRADE_PRICE_OUTLIER' | 'TRADE_PRICE_UNCONFIRMED';
const CODES: PriceWarningCode[] = ['TRADE_PRICE_OUTLIER', 'TRADE_PRICE_UNCONFIRMED'];

/** Parses core `warnings` entries such as "TRADE_PRICE_OUTLIER:XNAS:MSFT,XBOG:ISA". */
export function parsePriceWarnings(warnings: string[] | undefined): { code: PriceWarningCode; instrumentIds: string[] }[] {
  const out: { code: PriceWarningCode; instrumentIds: string[] }[] = [];
  for (const w of warnings ?? []) {
    const code = CODES.find((c) => w === c || w.startsWith(`${c}:`));
    if (!code) continue;
    const ids = w.slice(code.length + 1).split(',').map((s) => s.trim()).filter(Boolean);
    out.push({ code, instrumentIds: ids });
  }
  return out;
}

/**
 * Transactions behind a price warning: the engine diagnostics of that code whose trade is on one of
 * the flagged instruments, dated up to the period end (preferring trades inside the period).
 */
export function flaggedTransactionIds(
  diagnostics: Diagnostic[],
  code: PriceWarningCode,
  instrumentOf: (txId: string) => { instrumentId?: string; date: string } | undefined,
  instrumentIds: string[],
  from: string | undefined,
  to: string,
): string[] {
  const ids = new Set(instrumentIds);
  const all = diagnostics
    .filter((d) => d.code === code && d.transactionId)
    .map((d) => ({ id: d.transactionId!, tx: instrumentOf(d.transactionId!) }))
    .filter((x) => x.tx && (!ids.size || ids.has(x.tx.instrumentId ?? '')) && x.tx.date <= to);
  const inside = from ? all.filter((x) => x.tx!.date >= from) : all;
  return [...new Set((inside.length ? inside : all).map((x) => x.id))];
}

/**
 * Small warning chip for a month or a period summary whose figures depend on a questionable trade
 * price. Opens a list of those trades with "Abrir" and "Confirmar precio" (sets priceConfirmed).
 */
export function PriceWarnings({ warnings, from, to, compact }: { warnings: string[] | undefined; from?: string; to: string; compact?: boolean }) {
  const { t } = useTranslation();
  const f = useFmt();
  const { analysis } = useAnalysis();
  const instruments = useInstrumentMap();
  const parsed = parsePriceWarnings(warnings);
  const flagged = parsed.flatMap((p) => p.instrumentIds);
  const txs = useLiveQuery<StoredTransaction[], StoredTransaction[]>(
    async () => (flagged.length ? db.transactions.where('instrumentId').anyOf(flagged).toArray() : []),
    [flagged.join('|')],
    [],
  );
  if (!parsed.length) return null;
  const byId = new Map(txs.map((x) => [x.id, x]));
  const items = parsed.flatMap((p) =>
    flaggedTransactionIds(analysis?.diagnostics ?? [], p.code, (id) => byId.get(id), p.instrumentIds, from, to)
      .map((id) => byId.get(id))
      .filter((x): x is NonNullable<typeof x> => !!x && !x.priceConfirmed)
      .map((tx) => ({ code: p.code, tx })),
  );
  const label = parsed.some((p) => p.code === 'TRADE_PRICE_OUTLIER') ? t('pw.outlier') : t('pw.unconfirmed');
  const symbols = [...new Set(flagged.map((id) => instruments.get(id)?.symbol ?? id))].join(', ');
  return (
    <details className="inline-block relative align-middle print:hidden" data-testid="price-warning" onClick={(e) => e.stopPropagation()}>
      <summary
        className="chip !h-5 !text-[10.5px] !text-warn !border-warn/30 cursor-pointer list-none inline-flex items-center gap-1"
        title={`${label}: ${symbols}`}
      >
        <AlertTriangle size={11} aria-hidden />
        {compact ? <span className="sr-only">{label}</span> : label}
      </summary>
      <div className="absolute z-20 mt-1 left-0 w-[320px] max-w-[85vw] card p-3 shadow-lg text-[12.5px] font-normal whitespace-normal text-left">
        <p className="text-ink-2 mb-2">{t('pw.hint', { symbols })}</p>
        {items.length ? (
          <ul className="flex flex-col gap-2">
            {items.map(({ code, tx }) => (
              <li key={tx.id} className="flex items-center gap-2">
                <span className="flex-1 min-w-0">
                  <span className="font-medium">{instruments.get(tx.instrumentId ?? '')?.symbol ?? tx.instrumentId}</span>{' '}
                  <span className="text-muted num">
                    {formatDate(tx.date, f.locale, 'short')} · {formatPrice(tx.price, tx.currency, f.locale)}
                  </span>
                  <span className="block text-[11px] text-warn">{t(`diag.code.${code}`)}</span>
                </span>
                <Link className="btn btn-sm btn-ghost" to={`/movimientos?editar=${encodeURIComponent(tx.id)}`}>
                  {t('pw.open')}
                </Link>
                <button className="btn btn-sm" data-testid="confirm-price" onClick={() => void db.transactions.update(tx.id, { priceConfirmed: true })}>
                  <Check size={13} /> {t('pw.confirm')}
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-muted">{t('pw.none')}</p>
        )}
      </div>
    </details>
  );
}
