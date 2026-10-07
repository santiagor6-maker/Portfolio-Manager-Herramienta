import type { YearMonth } from '@pm/core';
import { b3Root } from '../common/basis';
import { addTo, reconcileMaps, type OfficialDocRow, type ReconLine, type ReconValue } from '../common/reconcile';
import type { TaxIssue } from '../common/types';
import { sum } from '../common/util';
import type { BrazilTaxPack } from './taxPack';

/** Informe de rendimentos of a broker/bank (one per paying source), as structured data. */
export interface BrInformeRendimentos {
  fonte: { cnpj: string; nome: string };
  ano: number;
  itens: {
    tipo: 'DIVIDENDO' | 'JCP' | 'RENDIMENTO_FII' | 'ALUGUEL' | 'RENDA_FIXA' | 'IRRF_BOLSA';
    ticker?: string;
    cnpjEmpresa?: string;
    nomeEmpresa?: string;
    valor: number;
    irrf?: number;
    /** The value is net of IRRF (common for JCP in B3/broker statements). */
    liquido?: boolean;
  }[];
  /** Custody position at 31/12. */
  posicoes?: { ticker: string; quantidade: number; cnpjEmpresa?: string }[];
}

/** Data of the pre-filled DIRPF (declaração pré-preenchida). */
export interface BrPrePreenchida {
  ano: number;
  darfsPagos?: { codigo: string; periodo: YearMonth; valor: number }[];
  /** IRRF of renda variável reported by B3/brokers (dedo-duro + day trade). */
  irrfRendaVariavel?: number;
  rendimentos?: { tipo: 'DIVIDENDO' | 'JCP' | 'RENDIMENTO_FII'; cnpjFonte?: string; ticker?: string; valor: number }[];
}

export interface BrReconciliation {
  lines: ReconLine[];
  /** CNPJ by B3 root ticker learnt from the informes (feed into Bens e Direitos `cnpjByIssuer`). */
  cnpjByIssuer: Record<string, string>;
  summary: { ok: number; diferente: number; faltaNoPortfolio: number; faltaNoDocumento: number };
  issues: TaxIssue[];
}

const b3Ticker = (s?: string) => (s ?? '').split(/\s+-\s+|\s/)[0]?.trim().toUpperCase() ?? '';
const yearOfBr = (d?: string) => (d ? (/(\d{4})-\d{2}-\d{2}/.exec(d)?.[1] ?? /\d{2}\/\d{2}\/(\d{4})/.exec(d)?.[1]) : undefined);

/**
 * B3 Área do Investidor "Movimentação" export (XLSX/CSV, read with readXlsx/parseCsv +
 * officialDocRowsFromTable): proventos credited to the investor. JCP there is NET of IRRF (T44).
 */
export function informeFromB3Movimentacao(rows: OfficialDocRow[], ano: number): BrInformeRendimentos {
  const itens: BrInformeRendimentos['itens'] = [];
  for (const r of rows) {
    if (yearOfBr(r.periodo) !== String(ano)) continue;
    const t = r.tipo.toLowerCase();
    const tipo = /juros\s+sobre\s+capital/.test(t)
      ? 'JCP'
      : /dividendo/.test(t)
        ? 'DIVIDENDO'
        : /rendimento/.test(t)
          ? 'RENDIMENTO_FII'
          : /empr[eé]stimo|aluguel/.test(t) && /remunera|cr[eé]dito|liquida/.test(t)
            ? 'ALUGUEL'
            : undefined;
    if (!tipo) continue;
    itens.push({ tipo, ticker: b3Ticker(r.ticker), valor: Math.abs(r.valor), liquido: tipo === 'JCP' || tipo === 'ALUGUEL' });
  }
  return { fonte: { cnpj: '09.346.601/0001-25', nome: 'B3 - Área do Investidor' }, ano, itens };
}

/** B3 Área do Investidor "Posição" export (all sheets): quantities and issuer CNPJ at the date. */
export function informeFromB3Posicao(sheets: { name: string; rows: OfficialDocRow[] }[], ano: number): BrInformeRendimentos {
  const posicoes: NonNullable<BrInformeRendimentos['posicoes']> = [];
  for (const sh of sheets) {
    for (const r of sh.rows) {
      const ticker = b3Ticker(r.ticker);
      if (!ticker || r.quantidade === undefined || /^total/i.test(ticker)) continue;
      posicoes.push({ ticker, quantidade: r.quantidade, cnpjEmpresa: r.id });
    }
  }
  return { fonte: { cnpj: '09.346.601/0001-25', nome: 'B3 - Área do Investidor' }, ano, itens: [], posicoes };
}

/** Converts generic CSV rows (parseOfficialDocCsv) of an informe into the structured type. */
export function informeFromRows(rows: OfficialDocRow[], fonte: { cnpj: string; nome: string }, ano: number): BrInformeRendimentos {
  const tipos = new Set(['DIVIDENDO', 'JCP', 'RENDIMENTO_FII', 'ALUGUEL', 'RENDA_FIXA', 'IRRF_BOLSA']);
  const itens: BrInformeRendimentos['itens'] = [];
  const posicoes: NonNullable<BrInformeRendimentos['posicoes']> = [];
  for (const r of rows) {
    const t = r.tipo.toUpperCase().replace(/\s+/g, '_');
    if (t === 'POSICAO' || t === 'POSIÇÃO') posicoes.push({ ticker: r.ticker ?? '', quantidade: r.quantidade ?? 0, cnpjEmpresa: r.id });
    else if (tipos.has(t)) itens.push({ tipo: t as BrInformeRendimentos['itens'][number]['tipo'], ticker: r.ticker, cnpjEmpresa: r.id, nomeEmpresa: r.nome, valor: r.valor, irrf: r.imposto });
  }
  return { fonte, ano, itens, posicoes };
}

/**
 * Reconciles the Brazilian tax pack with official documents: brokers' informes de rendimentos
 * (proventos per company, IRRF, positions at 31/12) and the pré-preenchida (DARFs paid, IRRF of
 * renda variável, rendimentos). Differences usually mean missing/duplicated transactions.
 */
export function reconcileBrazil(
  pack: BrazilTaxPack,
  docs: { informes?: BrInformeRendimentos[]; prePreenchida?: BrPrePreenchida },
): BrReconciliation {
  const lines: ReconLine[] = [];
  const issues: TaxIssue[] = [];
  const cnpjByIssuer: Record<string, string> = {};
  const informes = docs.informes ?? [];

  // Proventos by company root and type
  const ours = new Map<string, ReconValue>();
  for (const r of pack.proventos.rows) {
    if (r.type === 'OUTRO') continue;
    const k = `${r.type}|${b3Root(r.symbol ?? '')}`;
    addTo(ours, k, `${r.type} ${r.symbol ?? ''}`, r.gross);
    if (r.type === 'JCP' || r.type === 'ALUGUEL') addTo(ours, `IRRF_${k}`, `IRRF ${r.type} ${r.symbol ?? ''}`, r.irrf);
  }
  const theirs = new Map<string, ReconValue>();
  for (const inf of informes) {
    for (const it of inf.itens) {
      if (it.ticker && it.cnpjEmpresa) cnpjByIssuer[b3Root(it.ticker)] ??= it.cnpjEmpresa;
      if (it.tipo === 'RENDA_FIXA' || it.tipo === 'IRRF_BOLSA') continue;
      const k = `${it.tipo}|${b3Root(it.ticker ?? it.nomeEmpresa ?? '')}`;
      addTo(theirs, k, `${it.tipo} ${it.ticker ?? it.nomeEmpresa ?? ''}`, it.valor);
      if ((it.tipo === 'JCP' || it.tipo === 'ALUGUEL') && it.irrf !== undefined) addTo(theirs, `IRRF_${k}`, `IRRF ${it.tipo} ${it.ticker ?? ''}`, it.irrf);
    }
    for (const p of inf.posicoes ?? []) if (p.cnpjEmpresa) cnpjByIssuer[b3Root(p.ticker)] ??= p.cnpjEmpresa;
  }
  // JCP may come net of IRRF (T44): compare with our net value when the informe says so or when it matches.
  const oursNet = new Map<string, number>();
  for (const r of pack.proventos.rows) {
    if (r.type !== 'JCP' && r.type !== 'ALUGUEL') continue;
    const k = `${r.type}|${b3Root(r.symbol ?? '')}`;
    oursNet.set(k, (oursNet.get(k) ?? 0) + r.gross - r.irrf);
  }
  const netKeys = new Set<string>();
  for (const inf of informes) for (const it of inf.itens) if (it.liquido) netKeys.add(`${it.tipo}|${b3Root(it.ticker ?? it.nomeEmpresa ?? '')}`);
  if (informes.length) {
    const pl = reconcileMaps('proventos', ours, theirs).map((l) => {
      const net = oursNet.get(l.key);
      if (net === undefined || l.theirs === undefined) return l;
      const matchesNet = Math.abs(net - l.theirs) <= Math.max(1, Math.abs(l.theirs) * 0.005);
      if (netKeys.has(l.key) || (l.status === 'diferente' && matchesNet)) {
        const diff = net - l.theirs;
        return { ...l, ours: net, diff, status: matchesNet ? ('ok' as const) : ('diferente' as const), note: 'Documento em valor líquido (bruto − IRRF)' };
      }
      return l;
    });
    lines.push(...pl);
  }

  // Positions at 31/12 (quantities)
  const posOurs = new Map<string, ReconValue>();
  for (const i of pack.bensDireitos.items) if (i.ticker && i.localizacao === 'Brasil' && (i.quantidade ?? 0) > 0) addTo(posOurs, i.ticker, `Quantidade ${i.ticker}`, i.quantidade ?? 0);
  const posTheirs = new Map<string, ReconValue>();
  for (const inf of informes) for (const p of inf.posicoes ?? []) addTo(posTheirs, p.ticker, `Quantidade ${p.ticker}`, p.quantidade);
  if (posTheirs.size) lines.push(...reconcileMaps('posicoes_31_12', posOurs, posTheirs, { abs: 1e-6, rel: 0 }));

  // Renda fixa yields
  const rfTheirs = sum(informes.flatMap((i) => i.itens.filter((x) => x.tipo === 'RENDA_FIXA').map((x) => x.valor)));
  if (rfTheirs > 0) {
    lines.push(
      ...reconcileMaps(
        'renda_fixa',
        new Map([['RENDA_FIXA', { label: 'Rendimentos de renda fixa', value: pack.rendaFixa.totals.rendimentosTributaveis + pack.rendaFixa.totals.rendimentosIsentos }]]),
        new Map([['RENDA_FIXA', { label: 'Rendimentos de renda fixa', value: rfTheirs }]]),
      ),
    );
  }

  // IRRF bolsa
  const irrfOurs = sum(pack.apuracao.months.map((m) => m.irrf.reported + m.irrf.estimate));
  const irrfInforme = sum(informes.flatMap((i) => i.itens.filter((x) => x.tipo === 'IRRF_BOLSA').map((x) => x.irrf ?? x.valor)));
  const irrfDoc = docs.prePreenchida?.irrfRendaVariavel ?? (irrfInforme > 0 ? irrfInforme : undefined);
  if (irrfDoc !== undefined) {
    lines.push(
      ...reconcileMaps('irrf_bolsa', new Map([['IRRF', { label: 'IRRF renda variável', value: irrfOurs }]]), new Map([['IRRF', { label: 'IRRF renda variável', value: irrfDoc }]]), {
        abs: 0.1,
        rel: 0.01,
      }),
    );
  }

  // DARFs paid (pré-preenchida)
  if (docs.prePreenchida?.darfsPagos) {
    const dOurs = new Map<string, ReconValue>();
    for (const d of pack.apuracao.darfs) addTo(dOurs, `${d.code}|${d.month}`, `DARF ${d.code} ${d.month}`, d.amount);
    for (const m of pack.cripto.months) if (m.darf) addTo(dOurs, `4600|${m.month}`, `DARF 4600 ${m.month}`, m.darf.amount);
    const dTheirs = new Map<string, ReconValue>();
    for (const d of docs.prePreenchida.darfsPagos) addTo(dTheirs, `${d.codigo}|${d.periodo}`, `DARF ${d.codigo} ${d.periodo}`, d.valor);
    const dl = reconcileMaps('darfs', dOurs, dTheirs).map((l) =>
      l.status === 'falta_no_documento' ? { ...l, note: 'DARF calculado que não consta como pago na pré-preenchida' } : l,
    );
    lines.push(...dl);
  }
  // Rendimentos in the pré-preenchida
  if (docs.prePreenchida?.rendimentos) {
    const rOurs = new Map<string, ReconValue>();
    for (const r of pack.proventos.rows) if (r.type === 'DIVIDENDO' || r.type === 'JCP' || r.type === 'RENDIMENTO_FII') addTo(rOurs, r.type, r.type, r.gross);
    const rTheirs = new Map<string, ReconValue>();
    for (const r of docs.prePreenchida.rendimentos) addTo(rTheirs, r.tipo, r.tipo, r.valor);
    lines.push(...reconcileMaps('pre_preenchida', rOurs, rTheirs));
  }

  const count = (s: ReconLine['status']) => lines.filter((l) => l.status === s).length;
  const summary = { ok: count('ok'), diferente: count('diferente'), faltaNoPortfolio: count('falta_no_portfolio'), faltaNoDocumento: count('falta_no_documento') };
  if (summary.diferente + summary.faltaNoPortfolio + summary.faltaNoDocumento > 0) {
    issues.push({
      level: 'warning',
      code: 'RECONCILIATION_DIFFERENCES',
      message: `Conciliação: ${summary.diferente} diferenças, ${summary.faltaNoPortfolio} itens faltando no portfólio e ${summary.faltaNoDocumento} faltando nos documentos.`,
    });
  }
  return { lines, cnpjByIssuer, summary, issues };
}
