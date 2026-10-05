import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, CheckCircle2, Download, Info } from 'lucide-react';
import { Banner, Card, Kpi, PageHeader, Segmented, Skeleton } from '../components/ui';
import { useApp, useFmt } from '../store/app';
import { usePortfolios } from '../hooks/useData';
import { formatDate, formatMoney, formatMonth, formatPct, formatQuantity } from '../lib/format';
import { downloadText } from '../lib/export';
import { brazilApuracaoCsv, colombiaAccountantCsv, runTaxReports, TAX_DISCLAIMER, type TaxReports } from '../services/tax';
import type { Lang } from '../lib/format';

export default function TaxesPage() {
  const { t } = useTranslation();
  const f = useFmt();
  const portfolios = usePortfolios();
  const pid = useApp((s) => s.settings.selectedPortfolioId);
  const current = portfolios.find((p) => p.id === pid) ?? portfolios[0];
  const [country, setCountry] = useState<'CO' | 'BR'>(current?.taxResidence === 'BR' ? 'BR' : 'CO');
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(thisYear - 1);
  const [reports, setReports] = useState<TaxReports>();
  const [loading, setLoading] = useState(true);

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
  }, [country, year, pid]);

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
                { value: 'CO', label: '🇨🇴 Colombia' },
                { value: 'BR', label: '🇧🇷 Brasil' },
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
        <ColombiaView r={reports.colombia} money={money} />
      ) : country === 'BR' && reports?.brazil ? (
        <BrazilView r={reports} money={money} />
      ) : null}
    </div>
  );
}

type MoneyFn = (v: number | undefined, ccy: string) => string;

function Issues({ issues }: { issues: { level: string; message: string }[] }) {
  const { t } = useTranslation();
  if (!issues.length) return null;
  return (
    <Card className="mt-3" title={t('tax.issues', { count: issues.length })}>
      <ul className="flex flex-col gap-1.5 text-[13px]">
        {issues.slice(0, 30).map((i, k) => (
          <li key={k} className="flex gap-2">
            {i.level === 'info' ? <Info size={14} className="text-info mt-0.5 shrink-0" /> : <AlertTriangle size={14} className="text-warn mt-0.5 shrink-0" />}
            <span>{i.message}</span>
          </li>
        ))}
      </ul>
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
        <Kpi label={t('tax.co.patrimonio', { date: formatDate(r.patrimonio.date, f.locale) })} value={money(r.patrimonio.patrimonioBrutoCop, 'COP')} sub={<span className="text-xs text-muted">{t('tax.co.market')}: {money(r.patrimonio.marketValueCop, 'COP')}</span>} />
        <Kpi label={t('tax.co.dividends')} value={money(r.ingresos.totals.nationalDividendsCop + r.ingresos.totals.foreignDividendsCop, 'COP')} sub={<span className="text-xs text-muted">{t('tax.co.withheld')}: {money(r.ingresos.totals.nationalDividendWithholdingCop + r.ingresos.totals.foreignDividendTaxPaidCop, 'COP')}</span>} />
        <Kpi label={t('tax.co.go')} value={money(v.gananciaOcasional.gananciaGravableCop, 'COP')} sub={<span className="text-xs text-muted">{t('tax.co.estimatedTax')}: {money(v.gananciaOcasional.impuestoEstimadoCop, 'COP')} ({formatPct(v.gananciaOcasional.rate, f.locale, { decimals: 0 })})</span>} />
        <Kpi label={t('tax.co.fx')} value={money(r.diferenciaEnCambio.netCop, 'COP')} sub={<span className="text-xs text-muted">{t('tax.co.foreignAssets')}: {money(r.patrimonio.foreignAssetsCop, 'COP')}</span>} />
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

function BrazilView({ r, money }: { r: TaxReports; money: MoneyFn }) {
  const { t } = useTranslation();
  const f = useFmt();
  const a = r.brazil!;
  const p = r.proventos;
  return (
    <>
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
        <Kpi label={t('tax.br.darfTotal')} value={money(a.totals.darfTotal, 'BRL')} sub={<span className="text-xs text-muted">{t('tax.br.darfs', { count: a.darfs.length })}</span>} />
        <Kpi label={t('tax.br.exempt')} value={money(a.totals.exemptGain, 'BRL')} sub={<span className="text-xs text-muted">{t('tax.br.exemptSub')}</span>} />
        <Kpi label={t('tax.br.losses')} value={money(a.lossesAtEnd.comum + a.lossesAtEnd.dayTrade + a.lossesAtEnd.fii, 'BRL')} sub={<span className="text-xs text-muted">{t('tax.br.lossesSub')}</span>} />
        <Kpi label={t('tax.br.proventos')} value={money(p ? p.totals.dividendos + p.totals.jcpGross + p.totals.rendimentosFii : undefined, 'BRL')} sub={<span className="text-xs text-muted">JCP IRRF: {money(p?.totals.jcpIrrf, 'BRL')}</span>} />
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
                  <td className="text-xs">{m.darf ? formatDate(m.darf.dueDate, f.locale, 'short') : ''}</td>
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
      <Issues issues={[...a.issues, ...(p?.issues ?? [])]} />
    </>
  );
}
