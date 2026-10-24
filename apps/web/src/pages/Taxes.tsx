import { useEffect, useState } from 'react';
import { jurisdictionOf } from '../lib/currencyDefaults';
import { useLiveQuery } from 'dexie-react-hooks';
import { db } from '../db/schema';
import { addTransactionsOnce, getMeta, setMeta } from '../db/repo';
import { once } from '../lib/writeGuard';
import { BensDireitosView, CryptoView, printTaxDocument, TaxDocumentView, TaxExports } from '../components/TaxPack';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle2, Download, Info } from 'lucide-react';
import { Banner, Card, CountryTag, Field, Kpi, Modal, Money, PageHeader, Segmented, Skeleton } from '../components/ui';
import { parseDecimal, toInputNumber } from '../lib/parse';
import { tidyTaxIssues, YEARLY_NOTICES } from '../lib/taxText';
import { useApp, useFmt } from '../store/app';
import { usePortfolios } from '../hooks/useData';
import { formatDate, formatMoney, formatMonth, formatPct, formatQuantity } from '../lib/format';
import { downloadText } from '../lib/export';
import { brazilApuracaoCsv, colombiaAccountantCsv, darfDueOn, pendingRedemptions, redemptionTransactions, runTaxReports, TAX_DISCLAIMER, type PendingRedemption, type TaxReports } from '../services/tax';
import { useInstrumentLabel } from '../hooks/useAnalysis';
import type { Lang } from '../lib/format';

export default function TaxesPage() {
  const { t } = useTranslation();
  const f = useFmt();
  const portfolios = usePortfolios();
  const pid = useApp((s) => s.settings.selectedPortfolioId);
  // W66: the jurisdiction of the viewed portfolio — its tax residence, else its base currency (BRL →
  // Brasil); in "Todos", the first real portfolio. The user's pick wins until the portfolio changes.
  const current = portfolios.find((p) => p.id === pid) ?? portfolios.find((p) => !p.isDemo) ?? portfolios[0];
  const defaultCountry = jurisdictionOf(current);
  const [picked, setPicked] = useState<{ pid: string; country: 'CO' | 'BR' }>();
  const country = picked?.pid === pid ? picked.country : defaultCountry;
  const setCountry = (c: 'CO' | 'BR') => setPicked({ pid, country: c });
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(thisYear - 1);
  const [reports, setReports] = useState<TaxReports>();
  const [loading, setLoading] = useState(true);
  const txVersion = useLiveQuery(() => db.transactions.count(), [], 0);
  const [bump, setBump] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    runTaxReports(country, year, pid)
      .then((r) => !cancelled && setReports(r))
      .catch((e) => !cancelled && setReports({ errors: { load: String(e) } }))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [country, year, pid, txVersion, bump]);

  const disclaimer = TAX_DISCLAIMER[f.language as Lang] ?? TAX_DISCLAIMER.es;
  const years = Array.from({ length: 6 }, (_, i) => thisYear - i);
  const money = (v: number | undefined, ccy: string) => formatMoney(v, ccy, f.locale, { privacy: f.privacy });

  return (
    <div>
      <PageHeader
        title={t('tax.title')}
        subtitle={t('tax.subtitle')}
        actions={
          <>
            <Segmented
              label={t('tax.country')}
              value={country}
              onChange={setCountry}
              options={[
                {
                  value: 'CO',
                  label: (
                    <span className="inline-flex items-center gap-1.5">
                      <CountryTag code="CO" /> {t('tax.countryCO')}
                    </span>
                  ),
                },
                {
                  value: 'BR',
                  label: (
                    <span className="inline-flex items-center gap-1.5">
                      <CountryTag code="BR" /> {t('tax.countryBR')}
                    </span>
                  ),
                },
              ]}
            />
            <select className="select !w-auto" aria-label={t('tax.year')} value={year} onChange={(e) => setYear(Number(e.target.value))}>
              {years.map((y) => (
                <option key={y} value={y}>
                  {y}
                </option>
              ))}
            </select>
            {country === 'CO' && reports?.colombia && (
              <button className="btn" onClick={() => downloadText(`impuestos-co-${year}.csv`, colombiaAccountantCsv(reports.colombia!), 'text/csv')}>
                <Download size={15} /> {t('tax.csvAccountant')}
              </button>
            )}
            {country === 'BR' && reports?.brazil && (
              <button className="btn" onClick={() => downloadText(`apuracao-br-${year}.csv`, brazilApuracaoCsv(reports.brazil!), 'text/csv')}>
                <Download size={15} /> CSV
              </button>
            )}
          </>
        }
      />
      <div className="mb-3">
        <Banner tone="info">{disclaimer}</Banner>
      </div>
      {Object.entries(reports?.errors ?? {}).map(([k, v]) => (
        <div className="mb-3" key={k}>
          <Banner tone="error">
            {t('tax.error')}: <code className="text-xs">{v}</code>
          </Banner>
        </div>
      ))}
      {loading ? (
        <div className="grid gap-3">
          <Skeleton className="h-24" />
          <Skeleton className="h-64" />
        </div>
      ) : country === 'CO' && reports?.colombia ? (
        <>
          <MaturedCdts portfolioId={pid} year={year} version={txVersion} />
          <ColombiaView r={reports.colombia} money={money} />
          {reports.coPack && (
            <>
              <TaxExports files={reports.coPack.files} xlsx={reports.coPack.xlsx} name={`colombia-${year}`} onPrint={() => printTaxDocument(reports.coPack!.document, 'es-CO')} />
              <TaxDocumentView doc={reports.coPack.document} />
            </>
          )}
        </>
      ) : country === 'BR' && reports?.brazil ? (
        <>
          <BrazilView r={reports} money={money} portfolioId={pid} />
          {reports.brPack && (
            <>
              <BensDireitosView report={reports.brPack.bensDireitos} money={money} onChanged={() => setBump((b) => b + 1)} />
              <CryptoView report={reports.brPack.cripto} money={money} />
              <TaxExports files={reports.brPack.files} xlsx={reports.brPack.xlsx} name={`brasil-${year}`} onPrint={() => printTaxDocument(reports.brPack!.document, 'pt-BR')} />
              <TaxDocumentView doc={reports.brPack.document} />
            </>
          )}
        </>
      ) : null}
    </div>
  );
}

type MoneyFn = (v: number | undefined, ccy: string) => string;

/**
 * W42: a CDT that matured without a recorded payment stays in the tax patrimonio at cost (the tax
 * package reads transactions only). Warn and offer to record the engine's estimate in one click.
 */
function MaturedCdts({ portfolioId, year, version }: { portfolioId: string; year: number; version: number }) {
  const { t } = useTranslation();
  const f = useFmt();
  const label = useInstrumentLabel();
  const [list, setList] = useState<PendingRedemption[]>([]);
  const [busy, setBusy] = useState<string>();
  useEffect(() => {
    let cancel = false;
    void pendingRedemptions(portfolioId, `${year}-12-31`).then((r) => !cancel && setList(r));
    return () => {
      cancel = true;
    };
  }, [portfolioId, year, version]);
  if (!list.length) return null;
  const record = async (r: PendingRedemption) => {
    setBusy(`${r.instrumentId}|${r.date}`);
    try {
      // W61: one guarded write; an already recorded redemption is skipped.
      await once(`redeem|${r.instrumentId}|${r.date}`, () => addTransactionsOnce(redemptionTransactions(r, t('tax.co.redemptionNote'))));
      // Gone at once: a second click must not record it twice while the reports recompute.
      setList((l) => l.filter((x) => x !== r));
    } finally {
      setBusy(undefined);
    }
  };
  return (
    <div className="flex flex-col gap-2 mb-3" data-testid="matured-cdts">
      {list.map((r) => {
        const net = r.principal + r.interestGross - r.withholding;
        const key = `${r.instrumentId}|${r.date}`;
        return (
          <Banner
            key={key}
            tone="warn"
            action={
              <button className="btn btn-sm btn-primary" disabled={busy === key} onClick={() => void record(r)} data-testid="record-redemption">
                {t('tax.co.recordRedemption', { amount: formatMoney(net, r.currency, f.locale) })}
              </button>
            }
          >
            <strong className="font-semibold">{t('tax.co.maturedTitle', { symbol: label(r.instrumentId).symbol, date: formatDate(r.date, f.locale) })}</strong>{' '}
            <span className="text-ink-2">
              {t('tax.co.maturedBody', {
                principal: formatMoney(r.principal, r.currency, f.locale),
                interest: formatMoney(r.interestGross, r.currency, f.locale),
                withholding: formatMoney(r.withholding, r.currency, f.locale),
              })}
            </span>
          </Banner>
        );
      })}
    </div>
  );
}

function Issues({ issues }: { issues: { level: string; message: string; code?: string }[] }) {
  const { t } = useTranslation();
  const f = useFmt();
  // W45: one line per distinct message, numbers in the user's locale; yearly notices (PTAX) once.
  const seenNotices = useLiveQuery(async () => (await getMeta<string[]>('taxNoticesSeen')) ?? [], [], [] as string[]);
  const tidy = tidyTaxIssues(issues, f.locale);
  const notices = tidy.filter((i) => i.code && YEARLY_NOTICES.includes(i.code) && !seenNotices.includes(i.code));
  const list = tidy.filter((i) => !(i.code && YEARLY_NOTICES.includes(i.code)));
  if (!list.length && !notices.length) return null;
  return (
    <Card className="mt-3" title={t('tax.issues', { count: list.length })}>
      <ul className="flex flex-col gap-1.5 text-[13px]" data-testid="tax-issues">
        {list.slice(0, 30).map((i, k) => (
          <li key={k} className="flex gap-2">
            {i.level === 'info' ? <Info size={14} className="text-info mt-0.5 shrink-0" /> : <AlertTriangle size={14} className="text-warn mt-0.5 shrink-0" />}
            <span>{i.text}</span>
          </li>
        ))}
      </ul>
      {notices.map((n) => (
        <p key={n.code} className="text-xs text-muted mt-3 flex items-start gap-2" data-testid="tax-yearly-notice">
          <Info size={13} className="text-info mt-0.5 shrink-0" aria-hidden />
          <span className="flex-1">{n.text}</span>
          <button className="text-accent hover:underline shrink-0" onClick={() => void setMeta('taxNoticesSeen', [...seenNotices, n.code!])}>
            {t('tax.gotIt')}
          </button>
        </p>
      ))}
    </Card>
  );
}

function ColombiaView({ r, money }: { r: NonNullable<TaxReports['colombia']>; money: MoneyFn }) {
  const { t } = useTranslation();
  const f = useFmt();
  const v = r.ventas.totals;
  return (
    <>
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
        <Kpi label={t('tax.co.patrimonio', { date: formatDate(r.patrimonio.date, f.locale) })} value={<Money value={r.patrimonio.patrimonioBrutoCop} currency="COP" />} sub={<span className="text-xs text-muted">{t('tax.co.market')}: {money(r.patrimonio.marketValueCop, 'COP')}</span>} />
        <Kpi label={t('tax.co.dividends')} value={<Money value={r.ingresos.totals.nationalDividendsCop + r.ingresos.totals.foreignDividendsCop} currency="COP" />} sub={<span className="text-xs text-muted">{t('tax.co.withheld')}: {money(r.ingresos.totals.nationalDividendWithholdingCop + r.ingresos.totals.foreignDividendTaxPaidCop, 'COP')}</span>} />
        <Kpi label={t('tax.co.go')} value={<Money value={v.gananciaOcasional.gananciaGravableCop} currency="COP" />} sub={<span className="text-xs text-muted">{t('tax.co.estimatedTax')}: {money(v.gananciaOcasional.impuestoEstimadoCop, 'COP')} ({formatPct(v.gananciaOcasional.rate, f.locale, { decimals: 0 })})</span>} />
        <Kpi label={t('tax.co.fx')} value={<Money value={r.diferenciaEnCambio.netCop} currency="COP" />} sub={<span className="text-xs text-muted">{t('tax.co.foreignAssets')}: {money(r.patrimonio.foreignAssetsCop, 'COP')}</span>} />
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mt-3">
        <Card title={t('tax.co.f160')}>
          <div className="flex items-start gap-2 text-[13px]">
            {r.formulario160.required ? <AlertTriangle size={16} className="text-warn shrink-0 mt-0.5" /> : <CheckCircle2 size={16} className="text-pos shrink-0 mt-0.5" />}
            <div>
              <div className="font-semibold">{r.formulario160.required ? t('tax.co.f160Required', { year: r.formulario160.filingYear }) : t('tax.co.f160NotRequired', { year: r.formulario160.filingYear })}</div>
              <p className="text-ink-2 mt-1">{r.formulario160.note}</p>
            </div>
          </div>
        </Card>
        <Card title={t('tax.co.obligation')}>
          <div className="flex items-start gap-2 text-[13px]">
            {r.obligacionDeclarar.byPatrimonio || r.obligacionDeclarar.byIngresosPortafolio ? <AlertTriangle size={16} className="text-warn shrink-0 mt-0.5" /> : <Info size={16} className="text-info shrink-0 mt-0.5" />}
            <p className="text-ink-2">{r.obligacionDeclarar.note}</p>
          </div>
          <p className="text-xs text-muted mt-2">
            GMF 4×1000: {money(r.gmf.estimatedGmfCop, 'COP')} · {r.gmf.note}
          </p>
        </Card>
      </div>
      <Card className="mt-3" title={t('tax.co.patrimonioTable')} bodyClassName="!p-0">
        <div className="overflow-x-auto max-h-[420px]">
          <table className="table">
            <thead>
              <tr>
                <th>{t('pos.instrument')}</th>
                <th className="r">{t('pos.quantity')}</th>
                <th>{t('dim.currency')}</th>
                <th className="r">{t('tax.co.fiscalCost')}</th>
                <th className="r">{t('tax.co.fiscalValue')}</th>
                <th className="r">{t('tax.co.marketValue')}</th>
                <th>{t('tax.co.abroad')}</th>
              </tr>
            </thead>
            <tbody>
              {r.patrimonio.rows.map((p, i) => (
                <tr key={i}>
                  <td>
                    <span className="font-semibold">{p.symbol ?? (p.kind === 'efectivo' ? t('common.cash') : '—')}</span> <span className="text-xs text-muted">{p.name}</span>
                  </td>
                  <td className="r num">{p.kind === 'efectivo' ? '—' : formatQuantity(p.quantity, f.locale, f.privacy)}</td>
                  <td>{p.currency}</td>
                  <td className="r num">{money(p.costLocal, p.currency)}</td>
                  <td className="r num font-semibold">{money(p.fiscalValueCop, 'COP')}</td>
                  <td className="r num text-ink-2">{money(p.marketValueCop, 'COP')}</td>
                  <td>{p.abroad ? t('common.yes') : t('common.no')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
      {r.ventas.rows.length > 0 && (
        <Card className="mt-3" title={t('tax.co.sales')} bodyClassName="!p-0">
          <div className="overflow-x-auto">
            <table className="table">
              <thead>
                <tr>
                  <th>{t('tx.date')}</th>
                  <th>{t('pos.instrument')}</th>
                  <th className="r">{t('tax.co.proceeds')}</th>
                  <th className="r">{t('tax.co.cost')}</th>
                  <th className="r">{t('tax.co.gain')}</th>
                  <th>{t('tax.co.class')}</th>
                </tr>
              </thead>
              <tbody>
                {r.ventas.rows.map((s, i) => (
                  <tr key={i}>
                    <td>{formatDate(s.sellDate, f.locale, 'short')}</td>
                    <td className="font-semibold">{s.symbol}</td>
                    <td className="r num">{money(s.proceedsCop, 'COP')}</td>
                    <td className="r num">{money(s.costCop, 'COP')}</td>
                    <td className="r num">{money(s.gainCop, 'COP')}</td>
                    <td>
                      <span className="chip" title={s.legalBasis}>
                        {t(`tax.co.saleClass.${s.classification}`)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      <Issues issues={r.issues} />
    </>
  );
}

function BrazilView({ r, money, portfolioId }: { r: TaxReports; money: MoneyFn; portfolioId: string }) {
  const [paying, setPaying] = useState<Darf>();
  const { t } = useTranslation();
  const f = useFmt();
  const a = r.brazil!;
  const p = r.proventos;
  const unpaid = a.darfs.filter((d) => d.status === 'pendente' || d.status === 'vencida');
  return (
    <>
      {paying && <DarfPaymentDialog darf={paying} portfolioId={portfolioId} onClose={() => setPaying(undefined)} />}
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
        {/* W34: "DARF a pagar" counts only DARFs not paid yet (overdue ones with their charges). */}
        <Kpi
          label={t('tax.br.darfTotal')}
          value={<Money value={unpaid.reduce((x, d) => x + (d.late?.total ?? d.amount), 0)} currency="BRL" />}
          sub={<span className="text-xs text-muted" data-testid="darf-kpi-sub">{t('tax.br.darfs', { count: unpaid.length })}</span>}
        />
        <Kpi label={t('tax.br.exempt')} value={<Money value={a.totals.exemptGain} currency="BRL" />} sub={<span className="text-xs text-muted">{t('tax.br.exemptSub')}</span>} />
        <Kpi label={t('tax.br.losses')} value={<Money value={a.lossesAtEnd.comum + a.lossesAtEnd.dayTrade + a.lossesAtEnd.fii} currency="BRL" />} sub={<span className="text-xs text-muted">{t('tax.br.lossesSub')}</span>} />
        <Kpi label={t('tax.br.proventos')} value={<Money value={p ? p.totals.dividendos + p.totals.jcpGross + p.totals.rendimentosFii : undefined} currency="BRL" />} sub={<span className="text-xs text-muted">JCP IRRF: {money(p?.totals.jcpIrrf, 'BRL')}</span>} />
      </div>
      <Card className="mt-3" title={t('tax.br.monthly')} subtitle={t('tax.br.monthlySub')} bodyClassName="!p-0">
        <div className="overflow-x-auto">
          <table className="table">
            <thead>
              <tr>
                <th>{t('monthly.col.month')}</th>
                <th className="r">{t('tax.br.salesAcoes')}</th>
                <th>{t('tax.br.exemptShort')}</th>
                <th className="r">{t('tax.br.comum')}</th>
                <th className="r">Day trade</th>
                <th className="r">FII</th>
                <th className="r">{t('tax.br.tax')}</th>
                <th className="r">DARF</th>
                <th>{t('tax.br.due')}</th>
              </tr>
            </thead>
            <tbody>
              {a.months.map((m) => (
                <tr key={m.month}>
                  <td>{formatMonth(m.month, f.locale)}</td>
                  <td className="r num">{money(m.salesAcoesSwing, 'BRL')}</td>
                  <td>{m.exempt ? <span className="chip !text-pos">{t('common.yes')}</span> : <span className="chip">{t('common.no')}</span>}</td>
                  <td className="r num">{money(m.comum.result, 'BRL')}</td>
                  <td className="r num">{money(m.dayTrade.result, 'BRL')}</td>
                  <td className="r num">{money(m.fii.result, 'BRL')}</td>
                  <td className="r num">{money(m.taxAfterIrrf, 'BRL')}</td>
                  <td className="r num font-semibold">{m.darf ? money(m.darf.amount, 'BRL') : '—'}</td>
                  <td className="text-xs">
                    {m.darf && (
                      <DarfStatusCell
                        darf={m.darf}
                        money={money}
                        onPay={m.darf.status === 'pendente' || m.darf.status === 'vencida' ? () => setPaying(m.darf!) : undefined}
                      />
                    )}
                  </td>
                </tr>
              ))}
              {!a.months.length && (
                <tr>
                  <td colSpan={9} className="text-center text-muted !py-8">
                    {t('tax.br.noTrades')}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>
      <Issues issues={[...a.issues, ...(p?.issues ?? []), ...(r.brPack ? [...r.brPack.cripto.issues, ...r.brPack.bensDireitos.issues.filter((i) => i.code !== 'CRYPTO_TRANSIT_STALE'), ...r.brPack.exterior.issues] : [])]} />
    </>
  );
}

type Darf = NonNullable<NonNullable<TaxReports['brazil']>['darfs']>[number];

/** Tax R8: DARF status (paga / paga em atraso / vencida / pendente) with multa + Selic. */
function DarfStatusCell({ darf, money, onPay }: { darf: Darf; money: MoneyFn; onPay?: () => void }) {
  const { t } = useTranslation();
  const f = useFmt();
  const tone =
    darf.status === 'paga' ? '!text-pos !border-pos/30' : darf.status === 'vencida' ? '!text-neg !border-neg/30' : darf.status === 'paga_em_atraso' ? '!text-warn !border-warn/30' : '';
  const late = darf.late;
  return (
    <div className="flex flex-col gap-0.5" data-testid="darf-status">
      <span className="flex items-center gap-1.5 flex-wrap">
        <span>{formatDate(darf.dueDate, f.locale, 'short')}</span>
        <span className={`chip !h-5 !text-[10.5px] ${tone}`}>{t(`tax.br.darfStatus.${darf.status}`)}</span>
      </span>
      {late && late.daysLate > 0 && (
        <span className="text-[11px] text-muted whitespace-normal">
          {t('tax.br.lateCharges', {
            days: late.daysLate,
            multa: money(late.multa, 'BRL'),
            juros: late.juros !== undefined ? money(late.juros, 'BRL') : '—',
            total: late.total !== undefined ? money(late.total, 'BRL') : '—',
          })}
        </span>
      )}
      {onPay && (
        <button className="btn btn-sm !h-6 !text-[11px] self-start" onClick={onPay} data-testid="darf-pay">
          {t('tax.br.recordPayment')}
        </button>
      )}
    </div>
  );
}

/** W34: the DARF payment is recorded with the date and amount actually paid (prefilled). */
function DarfPaymentDialog({ darf, portfolioId, onClose }: { darf: Darf; portfolioId: string; onClose: () => void }) {
  const { t } = useTranslation();
  const f = useFmt();
  const portfolios = usePortfolios();
  const real = portfolios.filter((p) => !p.isDemo);
  const [pid, setPid] = useState(portfolioId !== 'all' ? portfolioId : (real[0]?.id ?? ''));
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [amount, setAmount] = useState(toInputNumber(darf.late?.total ?? darf.amount, f.locale));
  // W44: the amount follows the payment date (multa + Selic recomputed) until the user types one.
  const [edited, setEdited] = useState(false);
  const due = darfDueOn(darf, date);
  const changeDate = (d: string) => {
    setDate(d);
    const next = darfDueOn(darf, d);
    if (!edited && next) setAmount(toInputNumber(next.total, f.locale));
  };
  const value = parseDecimal(amount, f.locale);
  const save = async () => {
    if (!pid || value === undefined || value <= 0) return;
    // W61: a double submit records the payment once.
    await once(`darf|${pid}|${darf.code}|${darf.month}`, () => addTransactionsOnce([{ portfolioId: pid, date, type: 'TAX', currency: 'BRL', amount: value, note: `DARF ${darf.code} ${darf.month}` }]));
    onClose();
  };
  return (
    <Modal open onClose={onClose} title={t('tax.br.payTitle', { code: darf.code, month: formatMonth(darf.month, f.locale) })}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void save();
        }}
        data-testid="darf-pay-dialog"
      >
        <p className="text-[13px] text-ink-2">{t('tax.br.payExplain', { due: formatDate(darf.dueDate, f.locale) })}</p>
        {portfolioId === 'all' && (
          <Field label={t('tx.portfolio')} htmlFor="darf-pf">
            <select id="darf-pf" className="select" value={pid} onChange={(e) => setPid(e.target.value)}>
              {real.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </Field>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('tax.br.payDate')} htmlFor="darf-date">
            <input id="darf-date" className="input num" type="date" value={date} onChange={(e) => changeDate(e.target.value)} required />
          </Field>
          <Field label={t('tax.br.payAmount')} htmlFor="darf-amount">
            <input
              id="darf-amount"
              className="input num"
              inputMode="decimal"
              value={amount}
              onChange={(e) => {
                setEdited(true);
                setAmount(e.target.value);
              }}
              required
            />
          </Field>
        </div>
        {due && (
          <p className="text-xs text-muted -mt-1" data-testid="darf-due-breakdown">
            {due.daysLate > 0
              ? t('tax.br.dueBreakdown', { principal: formatMoney(darf.amount, 'BRL', f.locale), multa: formatMoney(due.multa, 'BRL', f.locale), juros: due.juros !== undefined ? formatMoney(due.juros, 'BRL', f.locale) : '—', total: formatMoney(due.total, 'BRL', f.locale), days: due.daysLate })
              : t('tax.br.dueOnTime', { total: formatMoney(due.total, 'BRL', f.locale) })}
            {edited && Math.abs((value ?? 0) - due.total) > 0.005 && (
              <button type="button" className="ml-1 text-accent hover:underline" onClick={() => { setEdited(false); setAmount(toInputNumber(due.total, f.locale)); }} data-testid="darf-use-due">
                {t('tax.br.useDue')}
              </button>
            )}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button type="button" className="btn" onClick={onClose}>
            {t('common.cancel')}
          </button>
          <button type="submit" className="btn btn-primary" disabled={!pid || value === undefined || value <= 0} data-testid="darf-pay-save">
            {t('tax.br.recordPayment')}
          </button>
        </div>
      </form>
    </Modal>
  );
}
