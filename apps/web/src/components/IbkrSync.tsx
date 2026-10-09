import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLiveQuery } from 'dexie-react-hooks';
import { Inbox, Link2, Loader2, RefreshCw, Unplug } from 'lucide-react';
import type { ImportResult } from '@pm/importers';
import { Banner, Card, Field } from './ui';
import { db } from '../db/schema';
import { useFmt } from '../store/app';
import { formatDateTime } from '../lib/format';
import {
  connectIbkr,
  disconnectIbkr,
  fetchIbkrInbox,
  inboxToImportResult,
  SyncError,
  syncIbkrNow,
  type IbkrConnection,
  type IbkrInbox,
} from '../services/ibkrSync';

export type SyncOrigin = 'ibkr-sync' | 'ibkr-inbox';

/** Translated, user-facing message for a sync failure (503 / 401 / IBKR errors...). */
export function syncErrorText(e: unknown, t: (k: string, o?: Record<string, unknown>) => string): string {
  if (e instanceof SyncError) return t(`ibkr.err.${e.kind}`, { message: e.code ? `${e.message} (${e.code})` : e.message });
  return t('ibkr.err.other', { message: e instanceof Error ? e.message : String(e) });
}

/**
 * "Conectar Interactive Brokers": saves the Flex token on the server, syncs on demand and reviews
 * the daily-sync inbox. Results go through the Import page's preview / confirm flow.
 */
export function IbkrSyncCard({
  resolvePortfolio,
  account,
  onResult,
}: {
  resolvePortfolio: () => Promise<string>;
  account: string;
  onResult: (r: ImportResult, origin: SyncOrigin, portfolioId: string) => void;
}) {
  const { t } = useTranslation();
  const { locale } = useFmt();
  const conn = useLiveQuery(() => db.meta.get('ibkrFlex'), [])?.value as IbkrConnection | undefined;
  const [token, setToken] = useState('');
  const [queryId, setQueryId] = useState('');
  const [busy, setBusy] = useState<'connect' | 'sync' | 'inbox' | 'disconnect'>();
  const [error, setError] = useState<string>();
  const [info, setInfo] = useState<string>();
  const [inbox, setInbox] = useState<IbkrInbox>();

  const run = async (kind: NonNullable<typeof busy>, fn: () => Promise<void>) => {
    setBusy(kind);
    setError(undefined);
    setInfo(undefined);
    try {
      await fn();
    } catch (e) {
      setError(syncErrorText(e, t));
    } finally {
      setBusy(undefined);
    }
  };

  const loadInbox = () =>
    run('inbox', async () => {
      const pid = await resolvePortfolio();
      setInbox(await fetchIbkrInbox(pid));
    });

  // Daily inbox: check when the card opens on a connected browser.
  useEffect(() => {
    if (conn) void loadInbox();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!conn]);

  const reviewInbox = () =>
    run('inbox', async () => {
      if (!inbox) return;
      const [existing, known] = await Promise.all([db.transactions.where('portfolioId').equals(inbox.portfolioId).toArray(), db.instruments.toArray()]);
      onResult(inboxToImportResult(inbox, existing, known), 'ibkr-inbox', inbox.portfolioId);
    });

  const lastRunError = inbox?.lastRun && (inbox.lastRun.error as string | undefined);

  return (
    <div className="xl:col-span-3" data-testid="ibkr-sync">
    <Card title={t('ibkr.title')} subtitle={t('ibkr.sub')}>
      {error && (
        <div className="mb-3" data-testid="ibkr-error">
          <Banner tone="error">{error}</Banner>
        </div>
      )}
      {info && (
        <div className="mb-3">
          <Banner tone="success">{info}</Banner>
        </div>
      )}
      {!conn ? (
        <form
          className="grid grid-cols-1 lg:grid-cols-[1fr_1fr_auto] gap-3 items-end"
          onSubmit={(e) => {
            e.preventDefault();
            void run('connect', async () => {
              await connectIbkr(token, queryId);
              setToken('');
            });
          }}
          data-testid="ibkr-connect"
        >
          <Field label={t('ibkr.token')} htmlFor="ibkr-token" hint={t('ibkr.tokenHint')}>
            <input id="ibkr-token" className="input" type="password" autoComplete="off" required value={token} onChange={(e) => setToken(e.target.value)} />
          </Field>
          <Field label={t('ibkr.queryId')} htmlFor="ibkr-query">
            <input id="ibkr-query" className="input num" inputMode="numeric" required value={queryId} onChange={(e) => setQueryId(e.target.value)} />
          </Field>
          <button className="btn btn-primary lg:mb-[22px]" type="submit" disabled={!!busy || !token.trim() || !queryId.trim()}>
            {busy === 'connect' ? <Loader2 size={15} className="animate-spin" /> : <Link2 size={15} />}
            {busy === 'connect' ? t('ibkr.connecting') : t('ibkr.connect')}
          </button>
          <details className="lg:col-span-3 text-[13px]">
            <summary className="cursor-pointer text-accent font-medium">{t('ibkr.help')}</summary>
            <ol className="list-decimal pl-5 mt-2 flex flex-col gap-1 text-ink-2">
              {(t('ibkr.helpSteps', { returnObjects: true }) as string[]).map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
            <p className="text-xs text-muted mt-2">{t('ibkr.needsServer')}</p>
          </details>
        </form>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="text-[13.5px]">
            <span className="font-medium">{t('ibkr.connected', { queryId: conn.queryId })}</span>
            {conn.lastSync && <span className="text-muted"> · {t('ibkr.lastSync', { when: formatDateTime(conn.lastSync, locale) })}</span>}
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              className="btn btn-primary"
              disabled={!!busy}
              data-testid="ibkr-sync-now"
              onClick={() =>
                void run('sync', async () => {
                  const pid = await resolvePortfolio();
                  onResult(await syncIbkrNow(pid, account || undefined), 'ibkr-sync', pid);
                })
              }
            >
              {busy === 'sync' ? <Loader2 size={15} className="animate-spin" /> : <RefreshCw size={15} />}
              {busy === 'sync' ? t('ibkr.syncing') : t('ibkr.syncNow')}
            </button>
            <button className="btn" disabled={!!busy} onClick={() => void loadInbox()} data-testid="ibkr-check-inbox">
              {busy === 'inbox' ? <Loader2 size={15} className="animate-spin" /> : <Inbox size={15} />} {t('ibkr.checkInbox')}
            </button>
            <button
              className="btn"
              disabled={!!busy}
              data-testid="ibkr-disconnect"
              onClick={() => {
                if (!window.confirm(t('ibkr.disconnectConfirm'))) return;
                void run('disconnect', async () => {
                  await disconnectIbkr();
                  setInbox(undefined);
                  setInfo(t('ibkr.disconnected'));
                });
              }}
            >
              <Unplug size={15} /> {t('ibkr.disconnect')}
            </button>
          </div>
          {inbox && (
            <div className="rounded-lg border border-line p-3 flex flex-wrap items-center gap-3 text-[13.5px]" data-testid="ibkr-inbox">
              <Inbox size={16} className="text-muted" aria-hidden />
              <span className="font-medium">{t('ibkr.inbox')}:</span>
              {inbox.pending.length ? <span>{t('ibkr.inboxCount', { count: inbox.pending.length })}</span> : <span className="text-muted">{t('ibkr.inboxEmpty')}</span>}
              {inbox.pending.length > 0 && (
                <button className="btn btn-sm btn-primary ml-auto" onClick={() => void reviewInbox()} data-testid="ibkr-review-inbox">
                  {t('ibkr.reviewInbox')}
                </button>
              )}
              {lastRunError && <div className="basis-full text-xs text-neg">{t('ibkr.lastRunError', { message: lastRunError })}</div>}
            </div>
          )}
        </div>
      )}
    </Card>
    </div>
  );
}
