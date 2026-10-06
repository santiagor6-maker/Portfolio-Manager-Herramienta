/**
 * Broker profiles: for every broker our users have, which file to download and which importer
 * reads it, plus defaults applied to generic files (account label, market, currency, formats).
 * Brokers without a public machine-readable export are routed to the path that works today
 * (B3 Área do Investidor, SINACOR notes in PDF, Colombian statement PDF/Excel, our template).
 */
import type { CurrencyCode, ExchangeCode } from '@pm/core';
import type { DateFormat, NumberFormat } from './types';

export interface BrokerProfile {
  id: string;
  label: string;
  country: 'BR' | 'CO' | 'US' | 'INTL' | 'MX' | 'CL' | 'PE';
  /** Presets that read this broker's files, best first. */
  presets: string[];
  /** Spanish instructions for the import wizard. */
  help: string;
  defaults: {
    account: string;
    exchange?: ExchangeCode;
    currency?: CurrencyCode;
    dateFormat?: DateFormat;
    numberFormat?: NumberFormat;
  };
}

const BR_HELP = 'Operaciones: descarga las notas de corretagem en PDF (o Negociação en la Área do Investidor de B3). Proventos y eventos: B3 → Movimentação. Conciliación: B3 → Posição.';

export const BROKER_PROFILES: BrokerProfile[] = [
  { id: 'xp', label: 'XP Investimentos', country: 'BR', presets: ['nota-sinacor-pdf', 'b3-negociacao', 'b3-movimentacao'], help: BR_HELP, defaults: { account: 'XP', exchange: 'BVMF', currency: 'BRL', dateFormat: 'DMY', numberFormat: 'comma' } },
  { id: 'rico', label: 'Rico', country: 'BR', presets: ['nota-sinacor-pdf', 'b3-negociacao', 'b3-movimentacao'], help: BR_HELP, defaults: { account: 'Rico', exchange: 'BVMF', currency: 'BRL', dateFormat: 'DMY', numberFormat: 'comma' } },
  { id: 'clear', label: 'Clear', country: 'BR', presets: ['nota-sinacor-pdf', 'b3-negociacao', 'b3-movimentacao'], help: BR_HELP, defaults: { account: 'Clear', exchange: 'BVMF', currency: 'BRL', dateFormat: 'DMY', numberFormat: 'comma' } },
  { id: 'btg', label: 'BTG Pactual', country: 'BR', presets: ['nota-sinacor-pdf', 'b3-negociacao', 'b3-movimentacao'], help: BR_HELP, defaults: { account: 'BTG Pactual', exchange: 'BVMF', currency: 'BRL', dateFormat: 'DMY', numberFormat: 'comma' } },
  { id: 'nu-invest', label: 'Nu Invest', country: 'BR', presets: ['nota-sinacor-pdf', 'b3-negociacao', 'b3-movimentacao'], help: BR_HELP, defaults: { account: 'Nu Invest', exchange: 'BVMF', currency: 'BRL', dateFormat: 'DMY', numberFormat: 'comma' } },
  { id: 'inter', label: 'Inter Invest', country: 'BR', presets: ['nota-sinacor-pdf', 'b3-negociacao', 'b3-movimentacao'], help: BR_HELP, defaults: { account: 'Inter', exchange: 'BVMF', currency: 'BRL', dateFormat: 'DMY', numberFormat: 'comma' } },
  { id: 'tesouro-direto', label: 'Tesouro Direto', country: 'BR', presets: ['b3-movimentacao'], help: 'B3 → Movimentação incluye compras, vencimientos, pagos de cupón y amortizaciones del Tesouro Direto.', defaults: { account: 'Tesouro Direto', exchange: 'MANUAL', currency: 'BRL', dateFormat: 'DMY', numberFormat: 'comma' } },
  { id: 'avenue', label: 'Avenue', country: 'US', presets: ['portafolio-pro', 'generic'], help: 'Avenue no ofrece una exportación estable: exporta el extracto a Excel/CSV y usa el mapeo (mercado EE. UU., USD) o la plantilla.', defaults: { account: 'Avenue', currency: 'USD', dateFormat: 'DMY', numberFormat: 'comma' } },
  { id: 'trii', label: 'Trii', country: 'CO', presets: ['extracto-co-pdf', 'extracto-co'], help: 'App Trii → Perfil → Extractos → descarga el PDF del mes (o el Excel si está disponible).', defaults: { account: 'Trii', exchange: 'XBOG', currency: 'COP', dateFormat: 'DMY' } },
  { id: 'tyba', label: 'tyba', country: 'CO', presets: ['extracto-co-pdf', 'extracto-co'], help: 'App tyba → Movimientos / Extractos → descarga el PDF o Excel.', defaults: { account: 'tyba', currency: 'COP', dateFormat: 'DMY' } },
  { id: 'davivienda-corredores', label: 'Davivienda Corredores', country: 'CO', presets: ['extracto-co', 'extracto-co-pdf'], help: 'Portal → Extractos → movimientos del periodo en Excel (o PDF).', defaults: { account: 'Davivienda Corredores', exchange: 'XBOG', currency: 'COP', dateFormat: 'DMY' } },
  { id: 'acciones-valores', label: 'Acciones & Valores', country: 'CO', presets: ['extracto-co', 'extracto-co-pdf'], help: 'Portal → Extracto mensual (PDF) o movimientos en Excel.', defaults: { account: 'Acciones & Valores', exchange: 'XBOG', currency: 'COP', dateFormat: 'DMY' } },
  { id: 'credicorp', label: 'Credicorp Capital Colombia', country: 'CO', presets: ['extracto-co', 'extracto-co-pdf'], help: 'Portal → Extractos → descarga el PDF/Excel.', defaults: { account: 'Credicorp Capital', exchange: 'XBOG', currency: 'COP', dateFormat: 'DMY' } },
  { id: 'cdt', label: 'CDT (cualquier banco)', country: 'CO', presets: ['cdt-pdf'], help: 'Sube el certificado/constancia del CDT en PDF: se crea el activo con su tasa y vencimiento.', defaults: { account: 'CDT', exchange: 'MANUAL', currency: 'COP', dateFormat: 'DMY' } },
  { id: 'hapi', label: 'Hapi', country: 'US', presets: ['portafolio-pro', 'generic'], help: 'Hapi no ofrece una exportación estable: copia tus operaciones a la plantilla (mercado EE. UU., USD).', defaults: { account: 'Hapi', currency: 'USD', dateFormat: 'DMY' } },
  { id: 'ibkr', label: 'Interactive Brokers', country: 'INTL', presets: ['ibkr-activity', 'ibkr-flex'], help: 'Sincronización con Flex Web Service (token + query id) o Activity Statement CSV.', defaults: { account: 'Interactive Brokers' } },
  { id: 'schwab', label: 'Charles Schwab', country: 'US', presets: ['schwab'], help: 'History → Transactions → Export.', defaults: { account: 'Charles Schwab', currency: 'USD', dateFormat: 'MDY', numberFormat: 'dot' } },
  { id: 'fidelity', label: 'Fidelity', country: 'US', presets: ['fidelity'], help: 'Activity & Orders → Download.', defaults: { account: 'Fidelity', currency: 'USD', dateFormat: 'MDY', numberFormat: 'dot' } },
  { id: 'degiro', label: 'DEGIRO', country: 'INTL', presets: ['degiro-transactions', 'degiro-account'], help: 'Transacciones + Estado de cuenta (CSV).', defaults: { account: 'DEGIRO' } },
  { id: 'trading212', label: 'Trading 212', country: 'INTL', presets: ['trading212'], help: 'Historial → Exportar CSV.', defaults: { account: 'Trading 212' } },
  { id: 'etoro', label: 'eToro', country: 'INTL', presets: ['etoro'], help: 'Estado de cuenta XLSX.', defaults: { account: 'eToro', currency: 'USD' } },
];

export function listBrokerProfiles(): BrokerProfile[] {
  return BROKER_PROFILES;
}

export function getBrokerProfile(id: string | undefined): BrokerProfile | undefined {
  return id ? BROKER_PROFILES.find((p) => p.id === id) : undefined;
}
