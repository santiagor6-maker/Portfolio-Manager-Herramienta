import type { ISODate, Transaction } from '@pm/core';
import { monthOf } from '../common/dates';
import { TAX_DISCLAIMER } from '../common/disclaimer';
import type { LocalizedText, TaxInput, TaxIssue } from '../common/types';
import { displaySymbol, grossAmount, instrumentMap, sum } from '../common/util';
import { issuerKey } from '../common/basis';
import { classifyForBrazil, type BrCategory } from './classify';
import { brazilConfig, DIRPF_INCOME_LINES, type BrazilTaxYearConfig } from './config';

export type BrProventoType = 'DIVIDENDO' | 'JCP' | 'RENDIMENTO_FII' | 'OUTRO';

export interface BrProventoRow {
  transactionId: string;
  date: ISODate;
  instrumentId?: string;
  symbol?: string;
  type: BrProventoType;
  gross: number;
  irrf: number;
  net: number;
  /** Expected withholding under the year's rules (JCP rate; dividends above the monthly limit from 2026). */
  expectedIrrf: number;
  dirpf?: { ficha: string; linha: string };
  /** Paying company key (dividends of PETR3 and PETR4 share the same payer). */
  issuer?: string;
  /** Lei 15.270/2025 transition: profits up to 2025 approved by 31/12/2025 (no 10% IRRF). */
  lei15270Transition?: boolean;
}

export interface BrProventosReport {
  country: 'BR';
  year: number;
  disclaimer: LocalizedText;
  rows: BrProventoRow[];
  totals: { dividendos: number; jcpGross: number; jcpIrrf: number; rendimentosFii: number; dividendIrrf: number };
  notes: string[];
  issues: TaxIssue[];
}

export interface BrProventosOptions {
  year: number;
  config?: BrazilTaxYearConfig;
  categoryOverrides?: Record<string, BrCategory>;
  /** Custom classifier; return undefined to fall back to the default heuristic. */
  classify?: (tx: Transaction) => BrProventoType | undefined;
  /** Issuer (paying company, e.g. CNPJ) per instrument id; default groups B3 classes by root ticker. */
  issuers?: Record<string, string>;
  /**
   * Transaction ids of dividends from profits up to 2025 approved by 31/12/2025 (Lei 15.270/2025
   * transition: no 10% withholding). Notes like "ref. 2025" / "lucros de 2024" are detected too.
   */
  preLei15270Dividends?: string[];
  /**
   * Date of "crédito" (declaration) of JCP by transaction id: LC 224/2025 applies the rate of the
   * date of payment OR credit, so JCP credited in 2025 and paid in 2026 keeps 15% (T31).
   * Notes like "JCP declarado em 12/2025" / "creditado em 2025-12-20" are detected too.
   */
  jcpCreditDates?: Record<string, string>;
}

const CREDIT_RE = /(declarad[oa]|creditad[oa]|cr[eé]dito|aprovad[oa]|data[\s-]*com)\D{0,12}(?:(\d{4})-(\d{2})(?:-\d{2})?|(?:\d{2}\/)?(\d{2})\/(\d{4}))/i;

function jcpCreditYear(tx: Transaction, map?: Record<string, string>): number | undefined {
  const d = map?.[tx.id];
  if (d) return Number(d.slice(0, 4));
  const m = CREDIT_RE.exec(tx.note ?? '');
  if (!m) return undefined;
  return Number(m[2] ?? m[5]);
}

/** Lei 15.270/2025 transition hint in the note: profits of 2025 or earlier. */
const TRANSITION_RE = /(ref(erente)?\.?\s*(a|ao)?\s*(exerc[ií]cio\s*(de)?\s*)?|lucros?\s*(de|até|ate)\s*|exerc[ií]cio\s*(de)?\s*)(20(1\d|2[0-5]))\b/i;

const JCP_RE = /\b(jcp|jscp|juros\s+s(obre|\/)?\s*(o\s+)?capital)/i;

/**
 * Proventos of B3 assets received by a Brazilian resident: dividends (exempt; from 2026 IRRF 10%
 * above R$ 50k/month per payer — Lei 15.270/2025), JCP (exclusive taxation at source: 15% until
 * 2025, 17.5% from 2026 — LC 224/2025) and FII income (exempt under Lei 11.033/2004 art. 3º III).
 */
export function brazilProventosReport(input: TaxInput, opts: BrProventosOptions): BrProventosReport {
  const cfg = opts.config ?? brazilConfig(opts.year);
  const instruments = instrumentMap(input.instruments);
  const issues: TaxIssue[] = [];
  const rows: BrProventoRow[] = [];
  const txs = input.transactions.filter(
    (t) => t.type === 'DIVIDEND' && t.date.startsWith(`${opts.year}-`),
  );
  for (const tx of txs) {
    const inst = tx.instrumentId ? instruments.get(tx.instrumentId) : undefined;
    const category = classifyForBrazil(inst, opts.categoryOverrides);
    if (category === 'FOREIGN' || (category === 'OTHER' && tx.currency !== 'BRL')) continue;
    const gross = grossAmount(tx);
    const irrf = tx.taxes ?? 0;
    let type = opts.classify?.(tx);
    if (!type) {
      if (category === 'FII') type = 'RENDIMENTO_FII';
      else if (JCP_RE.test(`${tx.note ?? ''} ${tx.source ?? ''}`)) type = 'JCP';
      else if (gross > 0 && irrf > 0 && [0.15, 0.175, cfg.jcpRate].some((r) => Math.abs(irrf / gross - r) < 0.005)) type = 'JCP';
      else if (category === 'ACAO') type = 'DIVIDENDO';
      else type = 'OUTRO';
    }
    const line = type === 'OUTRO' ? undefined : DIRPF_INCOME_LINES[type];
    rows.push({
      transactionId: tx.id,
      date: tx.date,
      instrumentId: tx.instrumentId,
      symbol: tx.instrumentId ? displaySymbol(tx.instrumentId, inst) : undefined,
      type,
      gross,
      irrf,
      net: gross - irrf,
      expectedIrrf:
        type === 'JCP'
          ? gross * (jcpCreditYear(tx, opts.jcpCreditDates) !== undefined && jcpCreditYear(tx, opts.jcpCreditDates)! < opts.year
              ? brazilConfig(jcpCreditYear(tx, opts.jcpCreditDates)!).jcpRate
              : cfg.jcpRate)
          : 0,
      dirpf: line ? { ficha: line.ficha, linha: line.linha } : undefined,
      issuer: tx.instrumentId ? issuerKey(inst, tx.instrumentId, opts.issuers) : undefined,
      lei15270Transition:
        type === 'DIVIDENDO' && ((opts.preLei15270Dividends ?? []).includes(tx.id) || TRANSITION_RE.test(tx.note ?? ''))
          ? true
          : undefined,
    });
    if ((category === 'BDR' || category === 'ETF') && type === 'OUTRO') {
      issues.push({
        level: 'warning',
        code: category === 'BDR' ? 'BDR_DIVIDEND_TAXABLE' : 'ETF_DISTRIBUTION',
        transactionId: tx.id,
        instrumentId: tx.instrumentId,
        message:
          category === 'BDR'
            ? `Dividendos de BDR (${displaySymbol(tx.instrumentId ?? '', inst)}) não são isentos: rendimento do exterior tributável (carnê-leão/ajuste anual).`
            : `Distribuição de ETF (${displaySymbol(tx.instrumentId ?? '', inst)}): tratamento depende do tipo de fundo (IRRF na fonte); conferir informe da gestora.`,
      });
    }
  }

  // Lei 15.270/2025: dividends above the monthly threshold per payer.
  if (cfg.dividendWithholding) {
    const { monthlyThresholdPerPayer, rate } = cfg.dividendWithholding;
    const groups = new Map<string, BrProventoRow[]>();
    for (const r of rows.filter((x) => x.type === 'DIVIDENDO')) {
      if (r.lei15270Transition) continue;
      const k = `${r.issuer ?? r.instrumentId ?? ''}|${monthOf(r.date)}`;
      groups.set(k, [...(groups.get(k) ?? []), r]);
    }
    for (const list of groups.values()) {
      const total = sum(list.map((r) => r.gross));
      if (total > monthlyThresholdPerPayer) {
        for (const r of list) r.expectedIrrf = r.gross * rate;
        const symbols = [...new Set(list.map((r) => r.symbol ?? ''))].join('+');
        issues.push({
          level: 'info',
          code: 'DIVIDEND_IRRF_LEI_15270',
          instrumentId: list[0]?.instrumentId,
          message:
            `Dividendos da mesma empresa (${symbols}) acima de R$ ${monthlyThresholdPerPayer} no mês: IRRF de ${rate * 100}% sobre o total ` +
            '(Lei 15.270/2025), salvo lucros apurados até 2025 aprovados até 31/12/2025 (regra de transição).',
        });
      }
    }
    if (rows.some((r) => r.lei15270Transition)) {
      issues.push({
        level: 'info',
        code: 'LEI_15270_TRANSITION',
        message: 'Dividendos marcados como lucros até 2025 aprovados até 31/12/2025: sem a retenção de 10% da Lei 15.270/2025 (regra de transição).',
      });
    }
  }
  for (const r of rows) {
    if (r.type === 'DIVIDENDO' && r.expectedIrrf > 0 && r.irrf === 0) {
      issues.push({
        level: 'info',
        code: 'DIVIDEND_IRRF_LEI_15270_CHECK',
        transactionId: r.transactionId,
        instrumentId: r.instrumentId,
        message:
          `Dividendo de ${r.symbol ?? ''} em ${r.date} sem IRRF registrado, acima do limite mensal: confira se é lucro até 2025 ` +
          '(transição, sem retenção) ou se falta registrar a retenção de 10%.',
      });
      continue;
    }
    if (r.expectedIrrf > 0 && Math.abs(r.irrf - r.expectedIrrf) > Math.max(0.05, r.expectedIrrf * 0.01)) {
      issues.push({
        level: 'warning',
        code: 'IRRF_MISMATCH',
        transactionId: r.transactionId,
        instrumentId: r.instrumentId,
        message: `IRRF informado (${r.irrf.toFixed(2)}) difere do esperado (${r.expectedIrrf.toFixed(2)}) para ${r.symbol ?? ''} em ${r.date}.`,
      });
    }
  }

  const t = (type: BrProventoType) => rows.filter((r) => r.type === type);
  return {
    country: 'BR',
    year: opts.year,
    disclaimer: TAX_DISCLAIMER,
    rows,
    totals: {
      dividendos: sum(t('DIVIDENDO').map((r) => r.gross)),
      dividendIrrf: sum(t('DIVIDENDO').map((r) => r.irrf)),
      jcpGross: sum(t('JCP').map((r) => r.gross)),
      jcpIrrf: sum(t('JCP').map((r) => r.irrf)),
      rendimentosFii: sum(t('RENDIMENTO_FII').map((r) => r.gross)),
    },
    notes: [
      `JCP: tributação exclusiva na fonte de ${(cfg.jcpRate * 100).toFixed(1)}% (Lei 9.249/1995 art. 9º; LC 224/2025 a partir de 2026). Declarar o valor líquido em Tributação Exclusiva.`,
      'Dividendos de ações: isentos (Lei 9.249/1995 art. 10)' +
        (cfg.dividendWithholding
          ? `; a partir de 2026, IRRF de ${cfg.dividendWithholding.rate * 100}% quando a mesma empresa pagar mais de R$ ${cfg.dividendWithholding.monthlyThresholdPerPayer} no mês, e tributação mínima anual (IRPFM) para rendas acima de R$ 600 mil (Lei 15.270/2025).`
          : '.'),
      'Rendimentos de FII: isentos para pessoa física quando o fundo tem cotas negociadas exclusivamente em bolsa, ao menos 100 cotistas e o investidor detém menos de 10% das cotas (Lei 11.033/2004 art. 3º III, redação da Lei 14.754/2023) — verificar a condição de cada fundo.',
    ],
    issues,
  };
}
