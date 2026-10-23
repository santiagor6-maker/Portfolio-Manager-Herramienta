/**
 * Tax pack views (tax R8): exports (CSV / XLSX / print), the presentation-neutral TaxDocument from
 * @pm/tax rendered generically (every section the package produces), Bens e Direitos with cost-status
 * badges and the "em trânsito" resolution, and the crypto monthly report.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Download, FileSpreadsheet, Printer } from 'lucide-react';
import type { BensDireitosReport, CryptoReport, TaxDocument, TaxIssue } from '@pm/tax';
import { Card } from './ui';
import { useFmt } from '../store/app';
import { formatDate, formatMonth } from '../lib/format';
import { downloadBlob, downloadText } from '../lib/export';
import { db } from '../db/schema';
import { getMeta, setMeta } from '../db/repo';
import type { TransitResolution } from '../services/tax';
import { cleanTaxMessage, localizeNumbers } from '../lib/taxText';

type MoneyFn = (v: number | undefined, ccy: string) => string;

/** Downloads: the XLSX workbook, each CSV, and a print view of the document. */
export function TaxExports({ files, xlsx, name, onPrint }: { files: Record<string, string>; xlsx: Uint8Array; name: string; onPrint: () => void }) {
  const { t } = useTranslation();
  return (
    <Card className="mt-3" title={t('taxpack.exports')} subtitle={t('taxpack.exportsSub')}>
      <div className="flex flex-wrap gap-2" data-testid="tax-exports">
        <button
          className="btn btn-primary"
          data-testid="tax-xlsx"
          onClick={() => downloadBlob(`${name}.xlsx`, new Blob([xlsx as BlobPart], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }))}
        >
          <FileSpreadsheet size={15} /> {t('taxpack.xlsx')}
        </button>
        <button className="btn" onClick={onPrint} data-testid="tax-print">
          <Printer size={15} /> {t('taxpack.print')}
        </button>
        {Object.entries(files).map(([fn, text]) => (
          <button key={fn} className="btn btn-sm" onClick={() => downloadText(fn, `﻿${text}`, 'text/csv')} title={fn}>
            <Download size={13} /> {fn.replace(/^(brasil|colombia)-\d{4}-/, '').replace(/\.csv$/, '')}
          </button>
        ))}
      </div>
    </Card>
  );
}

function cell(v: unknown, locale: string): string {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'number') return new Intl.NumberFormat(locale, { maximumFractionDigits: Math.abs(v) < 10 && !Number.isInteger(v) ? 6 : 2 }).format(v);
  if (typeof v === 'boolean') return v ? '✓' : '—';
  return cleanTaxMessage(String(v));
}

/** Every section of the package's TaxDocument: key figures and tables (collapsible). */
export function TaxDocumentView({ doc, skip = [] }: { doc: TaxDocument; skip?: string[] }) {
  const { t } = useTranslation();
  const f = useFmt();
  const sections = doc.sections.filter((s) => !skip.includes(s.heading));
  return (
    <div className="flex flex-col gap-2 mt-3" data-testid="tax-document">
      {sections.map((s, i) => (
        <details key={`${s.heading}-${i}`} className="card group" open={i === 0}>
          <summary className="px-4 py-3 cursor-pointer font-semibold text-[13.5px] flex items-center gap-2">
            <span className="flex-1">{s.heading}</span>
            {s.table && <span className="chip">{t('taxpack.rows', { count: s.table.rows.length })}</span>}
          </summary>
          <div className="px-4 pb-4">
            {s.paragraphs?.map((p, k) => (
              <p key={k} className="text-[13px] text-ink-2 mb-2">
                {p}
              </p>
            ))}
            {s.figures && (
              <dl className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2 mb-2">
                {s.figures.map((fg) => (
                  <div key={fg.label} className="rounded-lg border border-line px-3 py-2">
                    <dt className="text-xs text-muted">{fg.label}</dt>
                    <dd className="font-semibold num">
                      {typeof fg.value === 'number'
                        ? f.privacy
                          ? '•••'
                          : new Intl.NumberFormat(f.locale, fg.currency ? { style: 'currency', currency: fg.currency, maximumFractionDigits: 2 } : { maximumFractionDigits: 2 }).format(fg.value)
                        : fg.value}
                    </dd>
                  </div>
                ))}
              </dl>
            )}
            {s.table && s.table.rows.length > 0 && (
              <div className="overflow-x-auto max-h-[420px] rounded-lg border border-line">
                <table className="table table-compact">
                  <thead>
                    <tr>
                      {s.table.columns.map((c, k) => (
                        <th key={k} className={s.table!.numeric?.includes(k) ? 'r' : undefined}>
                          {c}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {s.table.rows.slice(0, 500).map((r, k) => (
                      <tr key={k}>
                        {r.map((v, j) => (
                          <td key={j} className={typeof v === 'number' ? 'r num' : 'whitespace-normal'}>
                            {f.privacy && typeof v === 'number' ? '•••' : cell(v, f.locale)}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {s.table && s.table.rows.length === 0 && <p className="text-xs text-muted">{t('common.noData')}</p>}
          </div>
        </details>
      ))}
    </div>
  );
}

/** Finds the TRANSFER_OUT behind a CRYPTO_TRANSIT_STALE issue (instrument + "em YYYY-MM-DD"). */
async function transferOutsFor(issue: TaxIssue): Promise<{ id: string; date: string; quantity?: number }[]> {
  if (!issue.instrumentId) return [];
  const outDate = issue.message.match(/ em (\d{4}-\d{2}-\d{2})/)?.[1];
  const outs = (await db.transactions.where('instrumentId').equals(issue.instrumentId).toArray()).filter((x) => x.type === 'TRANSFER_OUT');
  const exact = outs.filter((x) => x.date === outDate);
  return (exact.length ? exact : outs).map((x) => ({ id: x.id, date: x.date, quantity: x.quantity }));
}

/**
 * DIRPF Bens e Direitos at acquisition cost, with cost-status badges (provisório / pendente) and the
 * decision for crypto stuck "em trânsito" (CRYPTO_TRANSIT_STALE → alienado / mantido).
 */
export function BensDireitosView({ report, money, onChanged }: { report: BensDireitosReport; money: MoneyFn; onChanged: () => void }) {
  const { t } = useTranslation();
  const stale = report.issues.filter((i) => i.code === 'CRYPTO_TRANSIT_STALE');
  return (
    <Card className="mt-3" title={t('taxpack.bens')} subtitle={t('taxpack.bensSub', { year: report.year })} bodyClassName="!p-0" >
      {stale.length > 0 && (
        <div className="px-4 pt-3 flex flex-col gap-2" data-testid="transit-stale">
          {stale.map((i, k) => (
            <TransitResolutionRow key={k} issue={i} onChanged={onChanged} />
          ))}
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="table table-compact" data-testid="bens-table">
          <thead>
            <tr>
              <th>{t('taxpack.code')}</th>
              <th>{t('taxpack.discriminacao')}</th>
              <th>{t('taxpack.location')}</th>
              <th>CNPJ</th>
              <th className="r">31/12/{report.year - 1}</th>
              <th className="r">31/12/{report.year}</th>
            </tr>
          </thead>
          <tbody>
            {report.items.map((it, k) => (
              <tr key={k}>
                <td className="num whitespace-nowrap" title={it.codigoDescricao}>
                  {it.grupo}/{it.codigo}
                </td>
                <td className="whitespace-normal min-w-[260px] text-[12.5px]">
                  {it.ticker && <span className="font-semibold mr-1">{it.ticker}</span>}
                  {it.costStatus && (
                    <span className="chip !h-5 !text-[10.5px] !text-warn !border-warn/30 mr-1" data-testid="cost-status" title={t(`taxpack.costStatusHint.${it.costStatus}`)}>
                      {t(`taxpack.costStatus.${it.costStatus}`)}
                    </span>
                  )}
                  {it.emTransito && <span className="chip !h-5 !text-[10.5px] mr-1">{t('taxpack.inTransit')}</span>}
                  {it.transitoExcluido && <span className="chip !h-5 !text-[10.5px] !text-neg !border-neg/30 mr-1">{t('taxpack.transitExcluded')}</span>}
                  <span className="text-ink-2">{it.discriminacao}</span>
                </td>
                <td>{it.localizacao}</td>
                <td className="num text-xs">{it.cnpj || '—'}</td>
                <td className="r num">{money(it.situacaoAnterior, 'BRL')}</td>
                <td className="r num font-semibold">{money(it.situacaoAtual, 'BRL')}</td>
              </tr>
            ))}
            {!report.items.length && (
              <tr>
                <td colSpan={6} className="text-center text-muted !py-6">
                  {t('common.noData')}
                </td>
              </tr>
            )}
          </tbody>
          {report.items.length > 0 && (
            <tfoot>
              <tr>
                <td colSpan={4}>{t('common.total')}</td>
                <td className="r num">{money(report.totalAnterior, 'BRL')}</td>
                <td className="r num">{money(report.totalAtual, 'BRL')}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </Card>
  );
}

function TransitResolutionRow({ issue, onChanged }: { issue: TaxIssue; onChanged: () => void }) {
  const { t } = useTranslation();
  const f = useFmt();
  const [busy, setBusy] = useState(false);
  const resolve = async (value: 'alienado' | 'mantido') => {
    setBusy(true);
    try {
      const outs = await transferOutsFor(issue);
      const cur = (await getMeta<TransitResolution>('taxTransitResolution')) ?? {};
      for (const o of outs) cur[o.id] = value;
      await setMeta('taxTransitResolution', cur);
      onChanged();
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="rounded-lg border border-neg/30 bg-neg/5 p-3 text-[13px] flex flex-col gap-2">
      <div className="flex gap-2">
        <AlertTriangle size={15} className="text-neg shrink-0 mt-0.5" />
        <span>{localizeNumbers(cleanTaxMessage(issue.message), f.locale)}</span>
      </div>
      <div className="flex flex-wrap gap-2">
        <button className="btn btn-sm" disabled={busy} onClick={() => void resolve('alienado')} data-testid="transit-alienado">
          {t('taxpack.transitSold')}
        </button>
        <button className="btn btn-sm" disabled={busy} onClick={() => void resolve('mantido')} data-testid="transit-mantido">
          {t('taxpack.transitKept')}
        </button>
      </div>
    </div>
  );
}

/** Brazilian crypto (IN 1.888 / Lei 14.754): monthly sales, R$ 35 mil exemption, GCAP tax, DARF 4600. */
export function CryptoView({ report, money }: { report: CryptoReport; money: MoneyFn }) {
  const { t } = useTranslation();
  const f = useFmt();
  if (!report.months.length && !report.positions.length) return null;
  return (
    <Card className="mt-3" title={t('taxpack.crypto')} subtitle={t('taxpack.cryptoSub')} bodyClassName="!p-0">
      <div className="overflow-x-auto">
        <table className="table table-compact" data-testid="crypto-table">
          <thead>
            <tr>
              <th>{t('monthly.col.month')}</th>
              <th className="r">{t('taxpack.sales')}</th>
              <th>{t('tax.br.exemptShort')}</th>
              <th className="r">{t('taxpack.gain')}</th>
              <th className="r">{t('tax.br.tax')}</th>
              <th>DARF 4600</th>
            </tr>
          </thead>
          <tbody>
            {report.months.map((m) => (
              <tr key={m.month}>
                <td>{formatMonth(m.month, f.locale)}</td>
                <td className="r num">{money(m.salesBrl, 'BRL')}</td>
                <td>{m.exempt ? <span className="chip !text-pos">{t('common.yes')}</span> : <span className="chip">{t('common.no')}</span>}</td>
                <td className="r num">
                  {money(m.gainBrl, 'BRL')}
                  {m.pendingCost && <span className="chip !h-5 !text-[10.5px] !text-warn ml-1">{t('taxpack.costStatus.pendente')}</span>}
                </td>
                <td className="r num">{money(m.tax, 'BRL')}</td>
                <td className="text-xs">
                  {m.darf ? (
                    <span>
                      {money(m.darf.amount, 'BRL')} · {formatDate(m.darf.dueDate, f.locale, 'short')} · {t(`tax.br.darfStatus.${m.darf.status}`)}
                    </span>
                  ) : m.darfHeldAmount ? (
                    <span className="text-warn">{t('taxpack.darfHeld', { amount: money(m.darfHeldAmount, 'BRL') })}</span>
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

/** Print view of a TaxDocument in a new window (the browser's "Save as PDF"). */
export function printTaxDocument(doc: TaxDocument, locale: string): void {
  const esc = (s: unknown) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const num = (v: unknown) => (typeof v === 'number' ? new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(v) : esc(v));
  const body = doc.sections
    .map(
      (s) =>
        `<h2>${esc(s.heading)}</h2>${(s.paragraphs ?? []).map((p) => `<p>${esc(p)}</p>`).join('')}` +
        (s.figures ? `<dl>${s.figures.map((f) => `<div><dt>${esc(f.label)}</dt><dd>${num(f.value)} ${esc(f.currency ?? '')}</dd></div>`).join('')}</dl>` : '') +
        (s.table && s.table.rows.length
          ? `<table><thead><tr>${s.table.columns.map((c) => `<th>${esc(c)}</th>`).join('')}</tr></thead><tbody>${s.table.rows
              .map((r) => `<tr>${r.map((v) => `<td${typeof v === 'number' ? ' class="n"' : ''}>${num(v)}</td>`).join('')}</tr>`)
              .join('')}</tbody></table>`
          : ''),
    )
    .join('');
  const disclaimer = doc.locale === 'pt-BR' ? doc.disclaimer.pt : doc.disclaimer.es;
  const html = `<!doctype html><html lang="${doc.locale}"><head><meta charset="utf-8"><title>${esc(doc.title)}</title><style>
body{font:11px system-ui,sans-serif;color:#0e1525;margin:24px}h1{font-size:18px;margin:0}h2{font-size:13px;margin:18px 0 6px;border-bottom:1px solid #0f766e;padding-bottom:3px}
table{border-collapse:collapse;width:100%;margin:4px 0}th,td{border-bottom:1px solid #e3e7ee;padding:3px 5px;text-align:left;vertical-align:top}th{background:#f3f5f8}td.n{text-align:right;font-variant-numeric:tabular-nums}
dl{display:grid;grid-template-columns:repeat(3,1fr);gap:6px}dl div{border:1px solid #e3e7ee;border-radius:6px;padding:4px 8px}dt{color:#5f687b}dd{margin:0;font-weight:600}.d{color:#5f687b;margin-top:16px}
@page{size:A4 landscape;margin:12mm}</style></head><body><h1>${esc(doc.title)}</h1><p>${esc(doc.subtitle ?? '')}</p>${body}<p class="d">${esc(disclaimer)}</p></body></html>`;
  const w = window.open('', '_blank');
  if (!w) return;
  w.document.write(html);
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 300);
}
