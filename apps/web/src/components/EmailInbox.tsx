import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Copy, Inbox, Loader2, Mail } from 'lucide-react';
import type { ImportResult } from '@pm/importers';
import { Banner, Card, Field } from './ui';
import { useFmt } from '../store/app';
import { formatDateTime } from '../lib/format';
import { SyncError } from '../services/ibkrSync';
import {
  draftsToImportResult,
  fetchEmailDrafts,
  getEmailInboxSettings,
  saveEmailInboxSettings,
  type EmailDraft,
} from '../services/emailInbox';

/** Translated message for an inbox failure (401 / 403 / 503 / offline…). */
export function emailErrorText(e: unknown, t: (k: string, o?: Record<string, unknown>) => string): string {
  const message = e instanceof Error ? e.message : String(e);
  const kind = e instanceof SyncError ? e.kind : 'other';
  return t(`mail.err.${kind}`, { message: e instanceof SyncError && e.code ? `${message} (${e.code})` : message, defaultValue: t('ibkr.err.other', { message }) });
}

/**
 * "Importar por correo": the forwarding address and its setup, and the drafts the server imported
 * from forwarded e-mails, reviewed through the same preview / dedup / confirm flow as a file.
 */
export function EmailInboxCard({
  resolvePortfolio,
  onResult,
}: {
  resolvePortfolio: () => Promise<string>;
  onResult: (r: ImportResult, portfolioId: string, ackIds: string[]) => void;
}) {
  const { t } = useTranslation();
  const f = useFmt();
  const [address, setAddress] = useState('');
  const [pid, setPid] = useState<string>();
  const [drafts, setDrafts] = useState<EmailDraft[]>();
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    void getEmailInboxSettings().then((s) => {
      setAddress(s.address ?? '');
      if (s.enabled) void load();
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const p = await resolvePortfolio();
      setPid(p);
      const d = await fetchEmailDrafts(p);
      setDrafts(d);
      setSel(new Set(d.map((x) => x.id)));
    } catch (e) {
      setError(emailErrorText(e, t));
    } finally {
      setBusy(false);
    }
  };

  const review = async () => {
    if (!pid || !drafts) return;
    setBusy(true);
    try {
      const chosen = drafts.filter((d) => sel.has(d.id));
      onResult(await draftsToImportResult(pid, chosen), pid, chosen.map((d) => d.id));
    } catch (e) {
      setError(emailErrorText(e, t));
    } finally {
      setBusy(false);
    }
  };

  const pattern = address.trim() || 'importar+<token>@tu-dominio';
  return (
    <div className="xl:col-span-3" data-testid="email-inbox">
      <Card title={<span className="flex items-center gap-2"><Mail size={15} className="text-accent" /> {t('mail.title')}</span>} subtitle={t('mail.sub')}>
        {error && (
          <div className="mb-3" data-testid="email-error">
            <Banner tone="error">{error}</Banner>
          </div>
        )}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          <Field label={t('mail.address')} htmlFor="mail-address" hint={t('mail.addressHint')}>
            <div className="flex gap-2">
              <input
                id="mail-address"
                className="input font-mono text-[13px]"
                placeholder="importar+<token>@tu-dominio"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                onBlur={() => void saveEmailInboxSettings({ address: address.trim() || undefined })}
              />
              <button className="btn" type="button" onClick={() => void navigator.clipboard?.writeText(pattern)} title={t('share.copy')}>
                <Copy size={14} />
              </button>
            </div>
          </Field>
          <div className="flex items-start gap-2 lg:pt-[22px]">
            <button className="btn btn-primary" onClick={() => void load()} disabled={busy} data-testid="email-check">
              {busy ? <Loader2 size={15} className="animate-spin" /> : <Inbox size={15} />} {t('mail.check')}
            </button>
          </div>
        </div>

        <details className="mt-3 text-[13px]" data-testid="email-setup">
          <summary className="cursor-pointer text-accent font-medium">{t('mail.setup')}</summary>
          <ol className="list-decimal pl-5 mt-2 flex flex-col gap-1 text-ink-2">
            {(t('mail.steps', { returnObjects: true }) as string[]).map((s) => (
              <li key={s}>{s}</li>
            ))}
          </ol>
          <pre className="mt-2 text-xs bg-surface-2 rounded-lg p-2 overflow-x-auto">
            {`INBOX_SECRET=$(openssl rand -hex 24)\nINBOX_RECIPIENTS=<token>:${pid ?? '<portfolioId>'}\nINBOX_ALLOWED_SENDERS=@xpi.com.br,@nuinvest.com.br\nAPI_TOKEN=…   # el mismo de Ajustes → «Token de API del servidor»`}
          </pre>
        </details>

        {drafts && (
          <div className="mt-3 rounded-lg border border-line" data-testid="email-drafts">
            {drafts.length === 0 ? (
              <p className="p-3 text-[13px] text-muted">{t('mail.empty')}</p>
            ) : (
              <>
                <ul className="divide-y divide-line">
                  {drafts.map((d) => (
                    <li key={d.id} className="p-3 text-[13px] flex items-start gap-2" data-testid="email-draft">
                      <input
                        type="checkbox"
                        className="mt-1"
                        aria-label={d.subject ?? d.id}
                        checked={sel.has(d.id)}
                        onChange={(e) =>
                          setSel((s) => {
                            const n = new Set(s);
                            if (e.target.checked) n.add(d.id);
                            else n.delete(d.id);
                            return n;
                          })
                        }
                      />
                      <div className="flex-1 min-w-0">
                        <div className="font-medium truncate">{d.subject || t('mail.noSubject')}</div>
                        <div className="text-xs text-muted truncate">
                          {d.from} · {formatDateTime(Date.parse(d.receivedAt), f.locale)} · {t('mail.txCount', { count: d.transactions?.length ?? 0 })}
                        </div>
                        {(d.needsPassword?.length ?? 0) > 0 && <div className="text-xs text-warn mt-0.5">{t('mail.needsPassword', { files: d.needsPassword!.join(', ') })}</div>}
                      </div>
                    </li>
                  ))}
                </ul>
                <div className="p-3 border-t border-line flex justify-end">
                  <button className="btn btn-primary" disabled={busy || sel.size === 0} onClick={() => void review()} data-testid="email-review">
                    {t('mail.review', { count: sel.size })}
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
