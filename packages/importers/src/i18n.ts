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
    es: 'No se pudo leer el archivo .xls (Excel 97-2003): {detail}. Ábrelo en Excel y guárdalo como .xlsx o CSV.',
    pt: 'Não foi possível ler o arquivo .xls (Excel 97-2003): {detail}. Abra no Excel e salve como .xlsx ou CSV.',
    en: 'Could not read the .xls (Excel 97-2003) file: {detail}. Open it in Excel and save as .xlsx or CSV.',
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

const R2: Catalog = {
  FILE_PDF_UNSUPPORTED: {
    es: 'PDF no reconocido: se leen notas de corretagem SINACOR, extractos con tabla de movimientos y certificados de CDT. Si es otro documento, exporta a Excel/CSV.',
    pt: 'PDF não reconhecido: são lidas notas de corretagem SINACOR, extratos com tabela de movimentações e certificados de CDT. Se for outro documento, exporte para Excel/CSV.',
    en: 'Unrecognized PDF: supported are SINACOR brokerage notes, statements with a transactions table and CDT certificates. Otherwise export to Excel/CSV.',
  },
  PDF_READ_ERROR: {
    es: 'No se pudo leer el PDF ({detail}). Si tiene contraseña, quítala y vuelve a intentarlo.',
    pt: 'Não foi possível ler o PDF ({detail}). Se tiver senha, remova-a e tente de novo.',
    en: 'Could not read the PDF ({detail}). If it is password-protected, remove the password and retry.',
  },
  CONFIRM_DATE_FORMAT: {
    es: 'Todas las fechas son ambiguas (día y mes ≤ 12). Confirma el formato antes de importar (sugerido: {format}).',
    pt: 'Todas as datas são ambíguas (dia e mês ≤ 12). Confirme o formato antes de importar (sugerido: {format}).',
    en: 'All dates are ambiguous (day and month ≤ 12). Confirm the format before importing (suggested: {format}).',
  },
  CONFIRM_NUMBER_FORMAT: {
    es: 'Hay números ambiguos (p. ej. 1.000 o 2,450). Confirma el separador decimal antes de importar (sugerido: "{separator}").',
    pt: 'Há números ambíguos (ex.: 1.000 ou 2,450). Confirme o separador decimal antes de importar (sugerido: "{separator}").',
    en: 'Some numbers are ambiguous (e.g. 1.000 or 2,450). Confirm the decimal separator before importing (suggested: "{separator}").',
  },
  DATE_FORMAT_INFERRED: {
    es: 'Formato de fecha {format} deducido del orden de las filas, la fecha de liquidación o la hora AM/PM.',
    pt: 'Formato de data {format} deduzido da ordem das linhas, da data de liquidação ou da hora AM/PM.',
    en: 'Date format {format} inferred from row order, settlement dates or AM/PM times.',
  },
  NUMBER_FORMAT_INFERRED: {
    es: 'Separador decimal "{separator}" deducido del delimitador ";" del archivo.',
    pt: 'Separador decimal "{separator}" deduzido do delimitador ";" do arquivo.',
    en: 'Decimal separator "{separator}" inferred from the ";" delimiter.',
  },
  POSSIBLE_DUPLICATE_IN_FILE: {
    es: 'Fila idéntica a la línea {line} del mismo archivo; no se importa salvo que la aceptes.',
    pt: 'Linha idêntica à linha {line} do mesmo arquivo; não é importada a menos que você aceite.',
    en: 'Identical to line {line} of the same file; not imported unless you accept it.',
  },
  SETTLEMENT_MATCHED: {
    es: 'Liquidación de una operación del {date} ya importada desde Negociação/nota; se omite para no contarla dos veces.',
    pt: 'Liquidação de uma operação de {date} já importada da Negociação/nota; ignorada para não contar duas vezes.',
    en: 'Settlement of a trade on {date} already imported from Negociação/note; skipped to avoid double counting.',
  },
  UNHANDLED_SECTION: {
    es: 'La sección "{section}" ({count} filas) no se importa; revísala.',
    pt: 'A seção "{section}" ({count} linhas) não é importada; revise.',
    en: 'Section "{section}" ({count} rows) is not imported; please review.',
  },
  TRANSFER_COST_FROM_MARKET: {
    es: 'Costo de la transferencia tomado del valor de mercado; corrígelo con tu costo original si lo conoces.',
    pt: 'Custo da transferência tomado do valor de mercado; corrija com o custo original se souber.',
    en: 'Transfer cost taken from market value; replace it with your original cost if known.',
  },
  FX_FEE_SEPARATE: {
    es: 'Comisión de la conversión ({amount} {currency}) registrada como comisión aparte.',
    pt: 'Comissão da conversão ({amount} {currency}) registrada como tarifa separada.',
    en: 'Conversion commission ({amount} {currency}) recorded as a separate fee.',
  },
  QUANTITY_SIGN_CONTRADICTS: {
    es: 'La cantidad es negativa pero el movimiento es {type}; revisa la fila.',
    pt: 'A quantidade é negativa mas a movimentação é {type}; revise a linha.',
    en: 'Quantity is negative but the row is a {type}; please check.',
  },
  DIVIDEND_REVERSAL_ROW: {
    es: 'Monto negativo: se registra como reversión del pago.',
    pt: 'Valor negativo: registrado como estorno do pagamento.',
    en: 'Negative amount: recorded as a reversal of the payment.',
  },
  REFUND: {
    es: 'Devolución/reintegro: se registra con monto negativo.',
    pt: 'Devolução/estorno: registrado com valor negativo.',
    en: 'Refund: recorded with a negative amount.',
  },
  JCP_GROSS_ESTIMATED: {
    es: 'JCP neto {net} → bruto estimado {gross} con IRRF de 15 %.',
    pt: 'JCP líquido {net} → bruto estimado {gross} com IRRF de 15 %.',
    en: 'Net JCP {net} → estimated gross {gross} with 15 % withholding.',
  },
  FRACTION_SOLD: {
    es: 'Subasta de fracciones unida a la venta de la fracción.',
    pt: 'Leilão de frações unido à venda da fração.',
    en: 'Fraction auction merged into the fraction sale.',
  },
  FRACTION_PENDING: {
    es: 'Fracción retirada sin el valor de la subasta; actualiza el monto cuando lo recibas.',
    pt: 'Fração retirada sem o valor do leilão; atualize o valor quando receber.',
    en: 'Fraction removed without auction proceeds; update the amount when received.',
  },
  CORPORATE_ACTION_PENDING: {
    es: 'Evento corporativo "{value}": confírmalo en el asistente de eventos corporativos.',
    pt: 'Evento corporativo "{value}": confirme no assistente de eventos corporativos.',
    en: 'Corporate event "{value}": confirm it in the corporate-action wizard.',
  },
  MGC_FOREIGN_LISTING: {
    es: '{symbol} en COP (Mercado Global Colombiano) se asoció al activo {id}; la operación queda en COP.',
    pt: '{symbol} em COP (Mercado Global Colombiano) associado ao ativo {id}; a operação fica em COP.',
    en: '{symbol} in COP (Colombian Global Market) linked to {id}; the trade stays in COP.',
  },
  EXCHANGE_REQUIRED: {
    es: 'Indica la bolsa de {symbol} ({currency}): el símbolo existe en varias bolsas.',
    pt: 'Informe a bolsa de {symbol} ({currency}): o símbolo existe em várias bolsas.',
    en: 'Choose the exchange for {symbol} ({currency}): the symbol exists on several venues.',
  },
  EXCHANGE_REFINED: {
    es: 'El activo {id} cotiza en {exchange}; se sugiere actualizar su bolsa.',
    pt: 'O ativo {id} é negociado em {exchange}; sugere-se atualizar a bolsa.',
    en: 'Instrument {id} trades on {exchange}; updating its exchange is suggested.',
  },
  FEES_MODE_AMBIGUOUS: {
    es: 'Nota {nota}: costos iguales en todas las filas; se tomaron por fila. Elige "totales de la nota" si corresponde.',
    pt: 'Nota {nota}: custos iguais em todas as linhas; considerados por linha. Escolha "totais da nota" se for o caso.',
    en: 'Note {nota}: identical costs on every row; taken per row. Choose "note totals" if applicable.',
  },
  NOTA_TOTALS_MISMATCH: {
    es: 'Nota {nota}: el líquido calculado ({expected}) no coincide con el de la nota ({actual}); revisa la lectura.',
    pt: 'Nota {nota}: o líquido calculado ({expected}) não confere com o da nota ({actual}); revise a leitura.',
    en: 'Note {nota}: computed net ({expected}) differs from the note ({actual}); please review.',
  },
  UNKNOWN_SECURITY: {
    es: 'No se reconoce el título "{spec}": indica su ticker.',
    pt: 'Título "{spec}" não reconhecido: informe o ticker.',
    en: 'Unknown security "{spec}": please provide its ticker.',
  },
  CDT_IMPORTED: {
    es: 'CDT de {issuer} ({rate}) con vencimiento {maturity}: se valorará por causación.',
    pt: 'CDT de {issuer} ({rate}) com vencimento {maturity}: avaliado por acúmulo.',
    en: 'CDT from {issuer} ({rate}) maturing {maturity}: valued by accrual.',
  },
  AUTOFX_PAIRED: {
    es: 'Conversión automática unida con la línea {line}.',
    pt: 'Conversão automática unida à linha {line}.',
    en: 'Automatic FX leg paired with line {line}.',
  },
  AUTOFX_UNPAIRED: {
    es: 'Conversión de divisas "{value}" sin su contraparte; no se importa.',
    pt: 'Conversão de moedas "{value}" sem contrapartida; não importada.',
    en: 'FX leg "{value}" without its counterpart; not imported.',
  },
  SPLIT_PAIR_MERGED: {
    es: 'Split inverso en dos filas unido (proporción {ratio}).',
    pt: 'Grupamento em duas linhas unido (proporção {ratio}).',
    en: 'Two-row reverse split merged (ratio {ratio}).',
  },
  OPENING_POSITION: {
    es: 'Posición inicial importada como transferencia de entrada.',
    pt: 'Posição inicial importada como transferência de entrada.',
    en: 'Opening position imported as a transfer in.',
  },
  RECONCILIATION_DIFF: {
    es: 'Hay {count} diferencias entre lo importado y la posición/caja informada por el corredor.',
    pt: 'Há {count} diferenças entre o importado e a posição/caixa informada pela corretora.',
    en: '{count} differences between imported data and the broker-reported positions/cash.',
  },
};
Object.assign(ISSUE_MESSAGES, R2);

const R3: Catalog = {
  CDT_INVALID_DATES: {
    es: 'Fechas del CDT inconsistentes: el vencimiento ({maturity}) debe ser posterior a la apertura ({issueDate}); revisa el certificado.',
    pt: 'Datas do CDT inconsistentes: o vencimento ({maturity}) deve ser posterior à abertura ({issueDate}).',
    en: 'Inconsistent CDT dates: maturity ({maturity}) must be after the issue date ({issueDate}).',
  },
  CDT_RATE_NOMINAL: {
    es: 'Tasa nominal convertida a efectiva anual: {rate}.',
    pt: 'Taxa nominal convertida para efetiva anual: {rate}.',
    en: 'Nominal rate converted to effective annual: {rate}.',
  },
  CDT_WITHHOLDING: {
    es: 'Retención en la fuente sobre rendimientos: {rate}% (se aplica al cobrar intereses).',
    pt: 'Retenção na fonte sobre rendimentos: {rate}% (aplicada ao receber juros).',
    en: 'Withholding tax on interest: {rate}% (applied when interest is paid).',
  },
  DAY_TRADE: {
    es: 'Operación day trade (Obs. D).',
    pt: 'Operação day trade (Obs. D).',
    en: 'Day-trade operation (Obs. D).',
  },
  FEES_OF_SKIPPED: {
    es: 'Costos de operaciones omitidas (opciones/termo) no cargados al contado: {amount}.',
    pt: 'Custos de operações ignoradas (opções/termo) não atribuídos ao à vista: {amount}.',
    en: 'Costs of skipped trades (options/forwards) not charged to spot trades: {amount}.',
  },
  MONEY_MARKET_SWEEP: {
    es: 'Movimiento del fondo de liquidez {symbol} (efectivo de la cuenta); no es una inversión.',
    pt: 'Movimentação do fundo de liquidez {symbol} (caixa da conta); não é um investimento.',
    en: 'Core money-market {symbol} sweep (account cash); not an investment.',
  },
  NOTE_WITHOUT_TRADES: {
    es: 'Se detectó una nota de corretagem ({nota}) pero no se pudieron leer sus operaciones; revisa el formato o súbela como planilla.',
    pt: 'Foi detectada uma nota de corretagem ({nota}) mas não foi possível ler as operações; verifique o formato.',
    en: 'A brokerage note ({nota}) was detected but its trades could not be read; check the layout.',
  },
  PDF_NO_TEXT: {
    es: 'El PDF no contiene texto (¿escaneado?). No hay OCR: descarga el PDF original desde tu corredor.',
    pt: 'O PDF não contém texto (escaneado?). Sem OCR: baixe o PDF original da corretora.',
    en: 'The PDF has no text (scanned?). OCR is not supported: download the original PDF from your broker.',
  },
  PDF_PASSWORD_REQUIRED: {
    es: 'El PDF está protegido con contraseña (en XP, Clear y Rico suelen ser los primeros dígitos del CPF). Ingrésala para continuar.',
    pt: 'O PDF está protegido por senha (na XP, Clear e Rico costumam ser os primeiros dígitos do CPF). Informe-a para continuar.',
    en: 'The PDF is password protected (XP, Clear and Rico usually use the first CPF digits). Enter it to continue.',
  },
  PDF_PASSWORD_INCORRECT: {
    es: 'La contraseña del PDF no es correcta.',
    pt: 'A senha do PDF está incorreta.',
    en: 'Incorrect PDF password.',
  },
  DIRECTION_ASSUMED: {
    es: 'El archivo no trae signos: "{value}" se tomó como {type} (entrada). Si es una salida, asigna esa palabra al tipo correcto en el mapeo.',
    pt: 'O arquivo não traz sinais: "{value}" foi tomado como {type} (entrada). Se for uma saída, associe a palavra ao tipo correto no mapeamento.',
    en: 'The file has no signs: "{value}" was taken as {type} (inflow). If it is an outflow, map that word to the right type.',
  },
  TICKER_RENAMED: {
    es: '{from} cambió de código: se usa {to} (misma acción).',
    pt: '{from} mudou de código: usa-se {to} (mesma ação).',
    en: '{from} was renamed: {to} is used (same security).',
  },
  RECONCILIATION_UNASSIGNED: {
    es: '{count} movimientos de este corredor no tienen cuenta y podrían ser de otra cuenta (usados en la conciliación: {used}). Asígnales la cuenta para una conciliación exacta.',
    pt: '{count} movimentações desta corretora não têm conta e podem ser de outra conta (usadas na conciliação: {used}). Atribua a conta para uma conciliação exata.',
    en: '{count} transactions of this broker have no account and may belong to another account (used in reconciliation: {used}). Label them for an exact reconciliation.',
  },
  ROW_NUMBER_AMBIGUOUS: {
    es: 'El valor "{value}" en {currency} es ambiguo en este archivo (¿decimal o miles?); confirma la fila.',
    pt: 'O valor "{value}" em {currency} é ambíguo neste arquivo (decimal ou milhar?); confirme a linha.',
    en: 'Value "{value}" in {currency} is ambiguous in this file (decimal or thousands?); confirm the row.',
  },
};
Object.assign(ISSUE_MESSAGES, R3);

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
