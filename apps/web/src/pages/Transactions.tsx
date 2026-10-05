import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import clsx from 'clsx';
import { ArrowLeftRight, Download, Pencil, Plus, Search, Trash2 } from 'lucide-react';
import type { TransactionType } from '@pm/core';
import { Card, EmptyState, Modal, PageHeader } from '../components/ui';
import { TransactionForm } from '../components/TransactionForm';
import { useInstrumentMap, usePortfolios, useScopedTransactions } from '../hooks/useData';
import { useAnalysis } from '../hooks/useAnalysis';
import { useApp, useFmt } from '../store/app';
import { deleteTransactions } from '../db/repo';
import type { StoredTransaction } from '../db/schema';
import { formatDate, formatMoney, formatPrice, formatQuantity } from '../lib/format';
import { downloadText } from '../lib/export';
import { exportTransactionsCsv } from '../services/importers';

const TYPE_TONE: Partial<Record<TransactionType, string>> = {
  BUY: 'bg-info-soft text-info border-info/25',
  SELL: 'bg-warn-soft text-warn border-warn/25',
  DIVIDEND: 'bg-pos-soft text-pos border-pos/25',
  INTEREST: 'bg-pos-soft text-pos border-pos/25',
  DEPOSIT: 'bg-accent-soft text-accent border-accent/25',
  WITHDRAWAL: 'bg-neg-soft text-neg border-neg/25',
  FEE: 'bg-neg-soft text-neg border-neg/25',
  TAX: 'bg-neg-soft text-neg border-neg/25',
};

export function TxTypeBadge({ type }: { type: TransactionType }) {
  const { t } = useTranslation();
  return <span className={clsx('chip', TYPE_TONE[type])}>{t(`tx.type.${type}`)}</span>;
}

const PAGE = 100;

export default function TransactionsPage() {
  const { t } = useTranslation();
  const f = useFmt();
  const [params, setParams] = useSearchParams();
  const txs = useScopedTransactions();
  const map = useInstrumentMap();
  const portfolios = usePortfolios();
  const selectedPortfolio = useApp((s) => s.settings.selectedPortfolioId);
  const { analysis } = useAnalysis();
  const [q, setQ] = useState('');
  const [type, setType] = useState<string>('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [account, setAccount] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState<StoredTransaction>();
  const [confirmDelete, setConfirmDelete] = useState<string[]>();
  const [limit, setLimit] = useState(PAGE);

  useEffect(() => {
    if (params.get('nuevo')) {
      setEditing(undefined);
      setFormOpen(true);
    }
  }, [params]);

  const closeForm = () => {
    setFormOpen(false);
    setEditing(undefined);
    if (params.get('nuevo')) {
      params.delete('nuevo');
      params.delete('instrumento');
      setParams(params, { replace: true });
    }
  };

  const accounts = useMemo(() => [...new Set((txs ?? []).map((x) => x.account).filter(Boolean))] as string[], [txs]);
  const portfolioName = useMemo(() => new Map(portfolios.map((p) => [p.id, p.name])), [portfolios]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (txs ?? []).filter((x) => {
      if (type && x.type !== type) return false;
      if (from && x.date < from) return false;
      if (to && x.date > to) return false;
      if (account && x.account !== account) return false;
      if (needle) {
        const inst = x.instrumentId ? map.get(x.instrumentId) : undefined;
        const hay = `${inst?.symbol ?? ''} ${inst?.name ?? ''} ${x.note ?? ''} ${x.account ?? ''} ${x.currency}`.toLowerCase();
        if (!hay.includes(needle)) return false;
      }
      return true;
    });
  }, [txs, q, type, from, to, account, map]);

  const visible = filtered.slice(0, limit);
  const held = (id: string) => analysis?.valuation?.holdings.find((h) => h.instrumentId === id)?.quantity ?? 0;

  const exportCsv = () => {
    downloadText('movimientos.csv', exportTransactionsCsv(filtered, [...map.values()], { bom: true }), 'text/csv');
  };

  const types: TransactionType[] = ['BUY', 'SELL', 'DIVIDEND', 'INTEREST', 'DEPOSIT', 'WITHDRAWAL', 'FEE', 'TAX', 'FX_CONVERSION', 'SPLIT', 'STOCK_DIVIDEND', 'TRANSFER_IN', 'TRANSFER_OUT', 'RETURN_OF_CAPITAL'];
  const allVisibleSelected = visible.length > 0 && visible.every((x) => selected.has(x.id));

  return (
    <div>
      <PageHeader
        title={t('tx.title')}
        subtitle={txs ? t('tx.subtitle', { count: txs.length }) : undefined}
        actions={
          <>
            <button className="btn" onClick={exportCsv} disabled={!filtered.length}>
              <Download size={15} /> CSV
            </button>
            <button
              className="btn btn-primary"
              data-testid="add-tx"
              onClick={() => {
                setEditing(undefined);
                setFormOpen(true);
              }}
            >
              <Plus size={15} /> {t('tx.add')}
            </button>
          </>
        }
      />

      <Card bodyClassName="!p-0">
        <div className="flex flex-wrap items-end gap-2 p-3 border-b border-line">
          <div className="relative flex-1 min-w-[180px]">
            <Search size={15} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted" aria-hidden />
            <input className="input !pl-8" placeholder={t('tx.search')} aria-label={t('tx.search')} value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          <select className="select !w-auto" aria-label={t('tx.typeLabel')} value={type} onChange={(e) => setType(e.target.value)}>
            <option value="">{t('tx.allTypes')}</option>
            {types.map((ty) => (
              <option key={ty} value={ty}>
                {t(`tx.type.${ty}`)}
              </option>
            ))}
          </select>
          {accounts.length > 0 && (
            <select className="select !w-auto" aria-label={t('tx.account')} value={account} onChange={(e) => setAccount(e.target.value)}>
              <option value="">{t('tx.allAccounts')}</option>
              {accounts.map((a) => (
                <option key={a}>{a}</option>
              ))}
            </select>
          )}
          <label className="sr-only" htmlFor="tx-from">
            {t('tx.from')}
          </label>
          <input id="tx-from" type="date" className="input !w-auto" value={from} onChange={(e) => setFrom(e.target.value)} title={t('tx.from')} />
          <label className="sr-only" htmlFor="tx-to">
            {t('tx.to')}
          </label>
          <input id="tx-to" type="date" className="input !w-auto" value={to} onChange={(e) => setTo(e.target.value)} title={t('tx.to')} />
        </div>

        {selected.size > 0 && (
          <div className="flex items-center gap-3 px-3 py-2 bg-accent-soft border-b border-line text-[13px]" role="status">
            <span className="font-medium">{t('tx.selected', { count: selected.size })}</span>
            <button className="btn btn-sm btn-danger" onClick={() => setConfirmDelete([...selected])}>
              <Trash2 size={14} /> {t('tx.deleteSelected')}
            </button>
            <button className="btn btn-sm btn-ghost" onClick={() => setSelected(new Set())}>
              {t('common.clearSelection')}
            </button>
          </div>
        )}

        {txs && txs.length === 0 ? (
          <EmptyState
            icon={<ArrowLeftRight size={20} />}
            title={t('tx.emptyTitle')}
            body={t('tx.emptyBody')}
            action={
              <button className="btn btn-primary" onClick={() => setFormOpen(true)}>
                <Plus size={15} /> {t('tx.add')}
              </button>
            }
          />
        ) : (
          <div className="overflow-x-auto" data-testid="tx-table">
            <table className="table">
              <caption className="sr-only">{t('tx.title')}</caption>
              <thead>
                <tr>
                  <th className="w-8 !pr-0">
                    <input
                      type="checkbox"
                      aria-label={t('tx.selectAll')}
                      checked={allVisibleSelected}
                      onChange={(e) => setSelected(new Set(e.target.checked ? visible.map((x) => x.id) : []))}
                    />
                  </th>
                  <th>{t('tx.date')}</th>
                  <th>{t('tx.typeLabel')}</th>
                  <th>{t('tx.instrument')}</th>
                  <th className="r">{t('tx.quantity')}</th>
                  <th className="r">{t('tx.price')}</th>
                  <th className="r">{t('tx.amount')}</th>
                  <th className="r hidden md:table-cell">{t('tx.fees')}</th>
                  <th className="hidden lg:table-cell">{t('tx.account')}</th>
                  {selectedPortfolio === 'all' && <th className="hidden xl:table-cell">{t('tx.portfolio')}</th>}
                  <th className="w-20">
                    <span className="sr-only">{t('common.actions')}</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.map((x) => {
                  const inst = x.instrumentId ? map.get(x.instrumentId) : undefined;
                  const amount =
                    x.type === 'FX_CONVERSION'
                      ? `${formatMoney(x.amount, x.currency, f.locale, { privacy: f.privacy })} → ${formatMoney(x.toAmount, x.toCurrency ?? '', f.locale, { privacy: f.privacy })}`
                      : formatMoney(x.amount ?? (x.quantity ?? 0) * (x.price ?? 0), x.currency, f.locale, { privacy: f.privacy });
                  return (
                    <tr key={x.id} className={clsx(selected.has(x.id) && '[&>td]:!bg-accent-soft')}>
                      <td className="!pr-0">
                        <input
                          type="checkbox"
                          aria-label={t('tx.selectRow', { date: x.date })}
                          checked={selected.has(x.id)}
                          onChange={(e) => {
                            const n = new Set(selected);
                            if (e.target.checked) n.add(x.id);
                            else n.delete(x.id);
                            setSelected(n);
                          }}
                        />
                      </td>
                      <td className="num">{formatDate(x.date, f.locale, 'short')}</td>
                      <td>
                        <TxTypeBadge type={x.type} />
                      </td>
                      <td className="max-w-[220px]">
                        {inst ? (
                          <div className="min-w-0">
                            <span className="font-semibold">{inst.symbol}</span>{' '}
                            <span className="text-xs text-muted truncate">{inst.name}</span>
                          </div>
                        ) : (
                          <span className="text-muted text-xs">{x.note ?? '—'}</span>
                        )}
                      </td>
                      <td className="r num">{x.quantity !== undefined ? formatQuantity(x.quantity, f.locale, f.privacy) : x.ratio ? `×${x.ratio}` : '—'}</td>
                      <td className="r num">{x.price !== undefined ? formatPrice(x.price, x.currency, f.locale) : '—'}</td>
                      <td className="r num">{amount}</td>
                      <td className="r num text-muted hidden md:table-cell">{x.fees ? formatMoney(x.fees, x.currency, f.locale, { privacy: f.privacy }) : '—'}</td>
                      <td className="text-ink-2 text-xs hidden lg:table-cell">{x.account ?? '—'}</td>
                      {selectedPortfolio === 'all' && <td className="text-ink-2 text-xs hidden xl:table-cell">{portfolioName.get(x.portfolioId)}</td>}
                      <td>
                        <div className="flex gap-0.5 justify-end">
                          <button
                            className="btn btn-ghost btn-icon btn-sm !w-7"
                            aria-label={t('tx.edit')}
                            onClick={() => {
                              setEditing(x);
                              setFormOpen(true);
                            }}
                          >
                            <Pencil size={14} />
                          </button>
                          <button className="btn btn-ghost btn-icon btn-sm !w-7 btn-danger" aria-label={t('common.delete')} onClick={() => setConfirmDelete([x.id])}>
                            <Trash2 size={14} />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
                {filtered.length === 0 && txs && txs.length > 0 && (
                  <tr>
                    <td colSpan={11} className="text-center text-muted !py-10">
                      {t('common.noResults')}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            {filtered.length > limit && (
              <div className="p-3 text-center border-t border-line">
                <button className="btn btn-sm" onClick={() => setLimit((l) => l + PAGE * 3)}>
                  {t('tx.showMore', { shown: limit, total: filtered.length })}
                </button>
              </div>
            )}
          </div>
        )}
      </Card>

      <TransactionForm
        open={formOpen}
        onClose={closeForm}
        editing={editing}
        presetInstrumentId={params.get('instrumento') ?? undefined}
        heldQuantity={held}
      />

      <Modal
        open={!!confirmDelete}
        onClose={() => setConfirmDelete(undefined)}
        title={t('tx.deleteTitle', { count: confirmDelete?.length ?? 0 })}
        footer={
          <>
            <button className="btn" onClick={() => setConfirmDelete(undefined)}>
              {t('common.cancel')}
            </button>
            <button
              className="btn btn-primary !bg-neg !border-neg"
              onClick={async () => {
                await deleteTransactions(confirmDelete ?? []);
                setSelected(new Set());
                setConfirmDelete(undefined);
              }}
            >
              <Trash2 size={14} /> {t('common.delete')}
            </button>
          </>
        }
      >
        <p className="text-[13px] text-ink-2">{t('tx.deleteBody', { count: confirmDelete?.length ?? 0 })}</p>
      </Modal>
    </div>
  );
}
