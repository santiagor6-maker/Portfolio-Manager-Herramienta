import type { ImportIssue, Locale, Severity } from './types';

type Catalog = Record<string, { es: string; pt: string; en: string }>;

/** Issue messages. Placeholders: `{name}`. */
export const ISSUE_MESSAGES: Catalog = {
  FILE_EMPTY: {
    es: 'El archivo está vacío o no tiene filas de datos.',
    pt: 'O arquivo está vazio ou não tem linhas de dados.',
    en: 'The file is empty or has no data rows.',
  },
  FILE_XLS_LEGACY: {
    es: 'Formato .xls antiguo no soportado: ábrelo en Excel y guárdalo como .xlsx o CSV.',
    pt: 'Formato .xls antigo não suportado: abra no Excel e salve como .xlsx ou CSV.',
    en: 'Legacy .xls is not supported: open it in Excel and save as .xlsx or CSV.',
  },
  FILE_UNSUPPORTED: {
    es: 'No se reconoce el tipo de archivo. Usa CSV o XLSX.',
    pt: 'Tipo de arquivo não reconhecido. Use CSV ou XLSX.',
    en: 'Unrecognized file type. Use CSV or XLSX.',
  },
  FILE_IS_BACKUP: {
    es: 'Este archivo es un respaldo JSON de Portafolio Pro: usa "Restaurar respaldo".',
    pt: 'Este arquivo é um backup JSON do Portafolio Pro: use "Restaurar backup".',
    en: 'This is a Portafolio Pro JSON backup: use "Restore backup".',
  },
  XLSX_READ_ERROR: {
    es: 'No se pudo leer el archivo Excel: {detail}',
    pt: 'Não foi possível ler o arquivo Excel: {detail}',
    en: 'Could not read the Excel file: {detail}',
  },
  UNKNOWN_PRESET: {
    es: 'Formato "{preset}" desconocido.',
    pt: 'Formato "{preset}" desconhecido.',
    en: 'Unknown format "{preset}".',
  },
  NEEDS_MAPPING: {
    es: 'No se reconoció el formato. Indica qué columna corresponde a cada dato (faltan: {fields}).',
    pt: 'Formato não reconhecido. Indique qual coluna corresponde a cada dado (faltam: {fields}).',
    en: 'Format not recognized. Map the columns (missing: {fields}).',
  },
  GENERIC_AUTO_MAPPING: {
    es: 'Formato genérico: se adivinaron las columnas a partir de los encabezados; revisa el mapeo.',
    pt: 'Formato genérico: as colunas foram deduzidas dos cabeçalhos; revise o mapeamento.',
    en: 'Generic format: columns were guessed from the headers; please review the mapping.',
  },
  ENCODING_LATIN1: {
    es: 'El archivo no está en UTF-8; se leyó como Windows-1252 (Latin-1).',
    pt: 'O arquivo não está em UTF-8; foi lido como Windows-1252 (Latin-1).',
    en: 'The file is not UTF-8; it was read as Windows-1252 (Latin-1).',
  },
  AMBIGUOUS_DATE_FORMAT: {
    es: 'Las fechas son ambiguas (día y mes ≤ 12); se asumió el formato {format}.',
    pt: 'As datas são ambíguas (dia e mês ≤ 12); assumiu-se o formato {format}.',
    en: 'Dates are ambiguous (day and month ≤ 12); assumed {format}.',
  },
  AMBIGUOUS_NUMBER_FORMAT: {
    es: 'No se pudo determinar el separador decimal; se asumió "{separator}".',
    pt: 'Não foi possível determinar o separador decimal; assumiu-se "{separator}".',
    en: 'Could not determine the decimal separator; assumed "{separator}".',
  },
  INVALID_DATE: {
    es: 'Fecha inválida: "{value}".',
    pt: 'Data inválida: "{value}".',
    en: 'Invalid date: "{value}".',
  },
  INVALID_NUMBER: {
    es: 'Número inválido en {field}: "{value}".',
    pt: 'Número inválido em {field}: "{value}".',
    en: 'Invalid number in {field}: "{value}".',
  },
  UNKNOWN_TYPE: {
    es: 'Tipo de movimiento no reconocido: "{value}".',
    pt: 'Tipo de movimentação não reconhecido: "{value}".',
    en: 'Unrecognized transaction type: "{value}".',
  },
  MISSING_FIELD: {
    es: 'Falta el dato obligatorio "{field}".',
    pt: 'Falta o dado obrigatório "{field}".',
    en: 'Missing required field "{field}".',
  },
  MISSING_INSTRUMENT: {
    es: 'Falta el activo (ticker/ISIN).',
    pt: 'Falta o ativo (ticker/ISIN).',
    en: 'Missing instrument (ticker/ISIN).',
  },
  INVALID_CURRENCY: {
    es: 'Moneda inválida: "{value}".',
    pt: 'Moeda inválida: "{value}".',
    en: 'Invalid currency: "{value}".',
  },
  SKIPPED_TOTAL: {
    es: 'Fila de totales o resumen omitida.',
    pt: 'Linha de totais ou resumo ignorada.',
    en: 'Totals/summary row skipped.',
  },
  SKIPPED_MOVEMENT: {
    es: 'Movimiento "{value}" omitido: {reason}',
    pt: 'Movimentação "{value}" ignorada: {reason}',
    en: 'Movement "{value}" skipped: {reason}',
  },
  UNSUPPORTED_ASSET: {
    es: 'Tipo de activo no soportado ({value}); fila omitida.',
    pt: 'Tipo de ativo não suportado ({value}); linha ignorada.',
    en: 'Unsupported asset type ({value}); row skipped.',
  },
  SPLIT_RATIO_UNKNOWN: {
    es: 'No se pudo calcular la proporción del desdoblamiento/bonificación de {symbol} (no hay posición previa); ingrésala manualmente.',
    pt: 'Não foi possível calcular a proporção do desdobramento/bonificação de {symbol} (sem posição anterior); informe manualmente.',
    en: 'Could not infer the split/bonus ratio for {symbol} (no prior position); enter it manually.',
  },
  SPLIT_RATIO_INFERRED: {
    es: 'Proporción {ratio} calculada a partir de la posición ({position} → {after} acciones).',
    pt: 'Proporção {ratio} calculada a partir da posição ({position} → {after} ações).',
    en: 'Ratio {ratio} inferred from the position ({position} → {after} shares).',
  },
  EXCHANGE_GUESSED: {
    es: 'Bolsa de {symbol} deducida como {exchange}; verifícala.',
    pt: 'Bolsa de {symbol} deduzida como {exchange}; verifique.',
    en: 'Exchange for {symbol} guessed as {exchange}; please verify.',
  },
  SYMBOL_FROM_ISIN: {
    es: 'El archivo no trae ticker para {name} ({isin}); se usó el ISIN como símbolo. Corrígelo en Activos.',
    pt: 'O arquivo não traz ticker para {name} ({isin}); usou-se o ISIN como símbolo. Corrija em Ativos.',
    en: 'No ticker for {name} ({isin}); the ISIN was used as symbol. Fix it in Instruments.',
  },
  WITHHOLDING_MERGED: {
    es: 'Retención de {amount} {currency} asociada al dividendo.',
    pt: 'Retenção de {amount} {currency} associada ao dividendo.',
    en: 'Withholding of {amount} {currency} attached to the dividend.',
  },
  FEES_CONVERTED: {
    es: 'Comisión convertida de {from} a {to} con tasa {rate}.',
    pt: 'Comissão convertida de {from} para {to} com taxa {rate}.',
    en: 'Fee converted from {from} to {to} at rate {rate}.',
  },
  GBX_CONVERTED: {
    es: 'Precio en peniques (GBX) convertido a libras (GBP).',
    pt: 'Preço em pence (GBX) convertido para libras (GBP).',
    en: 'Price in pence (GBX) converted to pounds (GBP).',
  },
  NET_AMOUNT: {
    es: 'El archivo informa el valor neto (después de impuestos).',
    pt: 'O arquivo informa o valor líquido (após impostos).',
    en: 'The file reports the net amount (after taxes).',
  },
  B3_NO_FEES: {
    es: 'El extracto de B3 no incluye corretagem ni emolumentos: el costo promedio puede quedar levemente subestimado.',
    pt: 'O extrato da B3 não inclui corretagem nem emolumentos: o preço médio pode ficar levemente subestimado.',
    en: 'B3 statements do not include brokerage fees: average cost may be slightly understated.',
  },
  B3_SETTLEMENT_DATE: {
    es: 'Compras/ventas de "Movimentação" usan la fecha de liquidación (D+2). Si también importas "Negociação", habrá duplicados.',
    pt: 'Compras/vendas da "Movimentação" usam a data de liquidação (D+2). Se também importar "Negociação", haverá duplicidade.',
    en: '"Movimentação" trades use the settlement date (T+2). Importing "Negociação" too will duplicate them.',
  },
  DIVIDEND_REVERSAL: {
    es: 'Reversión de dividendo compensada con su registro original.',
    pt: 'Estorno de dividendo compensado com o lançamento original.',
    en: 'Dividend reversal netted against the original entry.',
  },
  FEES_ALLOCATED: {
    es: 'Costos de la nota {nota} repartidos proporcionalmente entre sus operaciones.',
    pt: 'Custos da nota {nota} rateados proporcionalmente entre as operações.',
    en: 'Costs of note {nota} allocated proportionally to its trades.',
  },
  FEE_REFUND: {
    es: 'Devolución de comisión registrada como comisión negativa.',
    pt: 'Estorno de tarifa registrado como tarifa negativa.',
    en: 'Fee refund recorded as a negative fee.',
  },
  CURRENCY_MISMATCH: {
    es: 'El movimiento está en {currency} pero el activo cotiza en {instrumentCurrency}.',
    pt: 'A movimentação está em {currency} mas o ativo é cotado em {instrumentCurrency}.',
    en: 'The row is in {currency} but the instrument trades in {instrumentCurrency}.',
  },
  DUPLICATE: {
    es: 'Ya importado anteriormente (duplicado).',
    pt: 'Já importado anteriormente (duplicado).',
    en: 'Already imported (duplicate).',
  },
  POSSIBLE_DUPLICATE: {
    es: 'Posible duplicado de un movimiento existente del {date} ({source}).',
    pt: 'Possível duplicata de uma movimentação existente de {date} ({source}).',
    en: 'Possible duplicate of an existing transaction on {date} ({source}).',
  },
  NON_POSITIVE: {
    es: 'El valor de {field} debe ser mayor que cero.',
    pt: 'O valor de {field} deve ser maior que zero.',
    en: '{field} must be greater than zero.',
  },
};

export function formatMessage(code: string, locale: Locale = 'es', params?: Record<string, string | number>): string {
  const entry = ISSUE_MESSAGES[code];
  const template = entry ? entry[locale] : code;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (params[k] !== undefined ? String(params[k]) : m));
}

/** Re-render an issue in another locale (the UI can switch language after import). */
export function translateIssue(issue: ImportIssue, locale: Locale): ImportIssue {
  return { ...issue, message: formatMessage(issue.code, locale, issue.params) };
}

export function makeIssue(
  locale: Locale,
  code: string,
  severity: Severity,
  params?: Record<string, string | number>,
  where?: { line?: number; sheet?: string; column?: string },
): ImportIssue {
  const issue: ImportIssue = { code, severity, message: formatMessage(code, locale, params) };
  if (params) issue.params = params;
  if (where?.line !== undefined) issue.line = where.line;
  if (where?.sheet !== undefined) issue.sheet = where.sheet;
  if (where?.column !== undefined) issue.column = where.column;
  return issue;
}
