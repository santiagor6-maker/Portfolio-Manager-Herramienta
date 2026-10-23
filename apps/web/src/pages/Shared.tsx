/**
 * Read-only view of a shared report (W10). Lives outside the app layout: nothing from the viewer's own
 * data is shown or created. The report HTML is rendered in an iframe sandbox without scripts.
 */
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Download, Lock, Printer } from 'lucide-react';
import { decodeShare, isEncryptedShare, sanitizeReportHtml, type SharePayload } from '../lib/share';
import { REPORT_CSS } from './Report';
import { downloadText } from '../lib/export';
import { formatDateTime } from '../lib/format';
import { LOCALE_BY_LANG } from '../lib/format';
import { setLanguage } from '../i18n';

export default function SharedPage() {
  const { t, i18n } = useTranslation();
  const [payload, setPayload] = useState<SharePayload>();
  const [error, setError] = useState<string>();
  const [needsPass, setNeedsPass] = useState(() => isEncryptedShare(location.hash));
  const [pass, setPass] = useState('');
  const frame = useRef<HTMLIFrameElement>(null);

  // The fragment being shown: a decode that finishes after the hash changed again is dropped.
  const current = useRef(location.hash);

  const open = async (passphrase?: string) => {
    const hash = location.hash;
    setError(undefined);
    try {
      const p = await decodeShare(hash, passphrase);
      if (hash !== current.current) return;
      setPayload(p);
      setNeedsPass(false);
      if (p.lang && p.lang !== i18n.language) void setLanguage(p.lang);
    } catch (e) {
      if (hash === current.current) setError(e instanceof Error ? e.message : 'invalid_link');
    }
  };

  // W46: pasting another link in the same tab only changes the fragment (no reload): show that report.
  useEffect(() => {
    const load = () => {
      current.current = location.hash;
      setPayload(undefined);
      setError(undefined);
      setPass('');
      const encrypted = isEncryptedShare(location.hash);
      setNeedsPass(encrypted);
      if (!encrypted) void open();
    };
    load();
    window.addEventListener('hashchange', load);
    return () => window.removeEventListener('hashchange', load);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (payload) document.title = `${payload.t} · Portafolio Pro`;
  }, [payload]);

  const doc = payload
    ? `<!doctype html><html lang="${payload.lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${payload.t}</title><style>body{margin:0;background:#fff}${REPORT_CSS}</style></head><body>${sanitizeReportHtml(payload.h)}</body></html>`
    : '';

  return (
    <div className="min-h-screen bg-bg">
      <header className="sticky top-0 z-10 bg-surface border-b border-line px-4 py-2 flex flex-wrap items-center gap-2 print:hidden">
        <div className="flex-1 min-w-0">
          <div className="font-semibold text-[14px] truncate">{payload?.t ?? 'Portafolio Pro'}</div>
          <div className="text-xs text-muted">
            {t('share.readOnly')}
            {payload && ` · ${t('share.generated', { date: formatDateTime(Date.parse(payload.g), LOCALE_BY_LANG[(payload.lang as 'es') ?? 'es'] ?? 'es-CO') })}`}
          </div>
        </div>
        {payload && (
          <>
            <button className="btn btn-sm" onClick={() => frame.current?.contentWindow?.print()} data-testid="shared-print">
              <Printer size={14} /> {t('report.print')}
            </button>
            <button className="btn btn-sm" onClick={() => downloadText(`${payload.t.replace(/[^\w.-]+/g, '-')}.html`, doc, 'text/html')}>
              <Download size={14} /> HTML
            </button>
          </>
        )}
        <a className="btn btn-sm btn-ghost" href="/">
          {t('share.openApp')}
        </a>
      </header>

      {needsPass && !payload && (
        <form
          className="max-w-sm mx-auto mt-16 card p-5 flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void open(pass);
          }}
        >
          <div className="flex items-center gap-2 font-semibold">
            <Lock size={16} /> {t('share.protected')}
          </div>
          <label className="label" htmlFor="share-pass">
            {t('share.passphrase')}
          </label>
          <input id="share-pass" className="input" type="password" autoFocus value={pass} onChange={(e) => setPass(e.target.value)} />
          {error === 'wrong_passphrase' && <p className="text-xs text-neg">{t('share.wrongPass')}</p>}
          <button className="btn btn-primary" type="submit" disabled={!pass}>
            {t('share.open')}
          </button>
        </form>
      )}

      {error && error !== 'wrong_passphrase' && error !== 'needs_passphrase' && (
        <div className="max-w-md mx-auto mt-16 card p-5 text-[13.5px]" data-testid="shared-error">
          {t('share.invalid')}
        </div>
      )}

      {payload && (
        <iframe
          ref={frame}
          title={payload.t}
          data-testid="shared-frame"
          // No scripts ever run inside; same-origin only so the toolbar can print it.
          sandbox="allow-same-origin allow-modals"
          srcDoc={doc}
          className="w-full border-0 bg-white"
          style={{ height: 'calc(100vh - 52px)' }}
        />
      )}
    </div>
  );
}
