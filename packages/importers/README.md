# @pm/importers — Importación de movimientos

Convierte archivos de corredores (CSV, XLSX, `.xls` de Excel 97-2003, tablas HTML guardadas como `.xls` y PDF) en `Transaction[]` de
`@pm/core`, más una lista de `Instrument[]` sugeridos. Para cada fila hay una vista previa con número de
línea, estado (`ok`, `duplicate`, `error`, `skipped`) y mensajes en español, portugués o inglés.

Funciona en el navegador y en Node. No usa `fs` ni otras API de Node, y acepta `File`/`Blob`,
`ArrayBuffer`, `Uint8Array` o texto.

## Uso rápido

```ts
import { importFile, inspectFile, suggestMapping, exportTransactionsCsv, createBackup, parseBackup } from '@pm/importers';

// 1) (opcional) Asistente: ver hojas, formato detectado y mapeo sugerido
const info = await inspectFile({ data: file, fileName: file.name });

// 2) Importar
const res = await importFile(
  { data: file, fileName: file.name },
  {
    portfolioId: 'p1',
    account: 'XP',                       // opcional: se asigna a cada movimiento
    existingTransactions,                // para no duplicar al reimportar
    existingInstruments,                 // para reutilizar activos ya creados (por id, ISIN o símbolo)
    locale: 'es',
  },
);
res.detection;     // formato, codificación, delimitador, formato de números y fechas
res.rows;          // vista previa fila por fila, con línea y mensajes
res.transactions;  // listas para guardar (sin errores ni duplicados)
res.instruments;   // activos NUEVOS sugeridos (id `BOLSA:SÍMBOLO`, Yahoo, moneda, país, clase)
res.warnings; res.errors; res.stats;

// 3) Si no se reconoce el formato: res.needsMapping === true y res.mappingSuggestion trae
//    los encabezados y el mapeo sugerido. El usuario lo corrige y se vuelve a importar:
await importFile({ data: file }, { portfolioId: 'p1', mapping: { headerRow: 0, columns: { date: 0, type: 1, symbol: 2, quantity: 3, price: 4 }, defaultCurrency: 'COP', defaultExchange: 'XBOG' } });
```

## Qué hace el pipeline

1. **Tipo de archivo.** Se detecta por los bytes: XLSX (zip), `.xls` antiguo (se rechaza con un mensaje
   claro), HTML disfrazado de `.xls`, JSON (respaldo) o CSV.
2. **Codificación.** UTF-8 (con o sin BOM) y UTF-16 LE/BE. Si el archivo no es UTF-8 válido se lee como
   **Windows-1252/Latin-1**, que es lo habitual en bancos y corredores de Brasil y Colombia.
3. **Delimitador.** `,`, `;`, tabulador o `|`, según cuál se repite de forma más constante entre líneas.
   También respeta la línea `sep=;` de Excel. Los números de línea se conservan aunque haya campos
   entre comillas con saltos de línea.
4. **Formato del archivo.** Se identifica por la firma de los encabezados, incluso si hay líneas de
   presentación antes de la tabla. En XLSX se elige la mejor hoja.
5. **Números.** Se aceptan `1.234,56` (es/pt) y `1,234.56` (en). El separador decimal se decide **por
   archivo**, votando entre todos los valores. También se entienden `R$`, `$`, `€`, `COP`, negativos
   entre paréntesis y el signo menos al final.
6. **Fechas.** Se aceptan `DD/MM/AAAA`, `MM/DD/AAAA`, `AAAA-MM-DD`, `AAAAMMDD`, nombres de mes
   (es/pt/en), seriales y celdas de fecha de Excel, y el formato "as of" de Schwab. El orden día/mes se
   decide por archivo. Si todas las fechas son ambiguas, se avisa.
7. **Tipos de movimiento.** Vocabulario en es/pt/en: compra/venta/C/V/buy/sell, dividendo, JCP,
   rendimento, intereses, consignación/retiro, comisión, GMF/4x1000/IOF/IRRF, desdobro, grupamento,
   bonificación, amortización, monetización y otros.
8. **Activos.** El id sigue la convención `BOLSA:SÍMBOLO`, por ejemplo `BVMF:PETR4`, `XBOG:ECOPETROL`,
   `XNAS:AAPL` o `XETR:SAP`. Además se asignan `providerSymbols.yahoo` (`.SA`, `.CL`, `.DE`, `.L`,
   `BRK-B`...), la moneda y el país según la bolsa, y la clase de activo:
   - FII de B3 → `reit`.
   - ETF como BOVA11, ICOLCAP o SPY → `etf`.
   - Tesouro, CDB y CDT → `fixed_income` con precio manual.

   El ticker fraccionario de B3 se normaliza (`ITSA4F` → `ITSA4`). Primero se reutilizan los activos
   que ya tiene el usuario (por ISIN, por id o por símbolo único).
9. **Proporciones de splits y bonificaciones.** Cuando el corredor solo informa las acciones recibidas
   (B3 "Desdobro" o "Bonificação", Schwab "Stock Split"), la proporción se calcula con la posición
   acumulada. Esa posición combina los movimientos existentes y los importados.
10. **De-duplicación.**
    - `importHash` es un hash estable de la fila normalizada. Usa la referencia del corredor cuando
      existe y, si no, un contador de ocurrencias, para que dos compras idénticas el mismo día sigan
      siendo dos.
    - Al reimportar, las filas ya importadas quedan como `duplicate`.
    - Si un movimiento coincide con otro ya guardado de distinta fuente **y de la misma cuenta o
      institución** (mismo activo, tipo y cantidad, a ±3 días hábiles), queda como "posible duplicado".
      Pasa, por ejemplo, entre B3 Negociação y Movimentação.
    - Dos filas idénticas dentro del mismo archivo **nunca se descartan**: se importan las dos con la
      marca `POSSIBLE_DUPLICATE_IN_FILE`.

## Formatos soportados

Confianza:
- **Alta:** el formato es público, estable y muy conocido.
- **Media:** el formato es conocido, pero cambia según la versión, el idioma o las columnas que elija el
  usuario.
- **Baja:** el formato fue reconstruido sin un archivo real a la vista, o es una plantilla genérica.

Las pruebas usan archivos sintéticos fieles a esa estructura. Desde la ronda 4 hay además un corpus
"real-like" (`test/fixtures/real-like/`) que reproduce cómo generan sus PDF y `.xls` los corredores
(compresión, fuentes, texto por palabra o por letra, cifrado, orden de dibujo, CFB fragmentado). Durante
el desarrollo no hubo documentos reales de usuarios.

| Formato (id) | Corredor | Archivo | Confianza | Qué importa |
|---|---|---|---|---|
| `portafolio-pro` | Plantilla propia | CSV/XLSX | Alta | Todo (ida y vuelta sin pérdidas) |
| `ibkr-activity` | Interactive Brokers, Activity Statement | CSV | Alta | Operaciones, FX, dividendos con retención (y reversiones), depósitos/retiros, intereses, comisiones, splits |
| `ibkr-flex` | Interactive Brokers, Flex Query | CSV | Media | Secciones Trades y Cash Transactions |
| `b3-negociacao` | B3 Área do Investidor, Negociação | XLSX | Alta | Compras/ventas a la vista y fraccionarias (sin costos) |
| `b3-movimentacao` | B3 Área do Investidor, Movimentação | XLSX | Media | Liquidaciones, Dividendo, JCP (neto), Rendimento, Desdobro, Grupamento, Bonificação, Amortização, Tesouro |
| `nota-corretagem` | Notas de corretagem resumidas (XP, Clear, Rico, BTG...) | CSV/XLSX | Baja | Operaciones con costos por nota prorrateados e IRRF |
| `schwab` | Charles Schwab, Transactions | CSV | Alta | Compras/ventas, dividendos + NRA tax, intereses, transferencias, splits, reinversiones |
| `degiro-transactions` | DEGIRO, Transacciones (en/es/pt/nl/de) | CSV | Media | Compras/ventas; costos convertidos a la moneda de la operación |
| `degiro-account` | DEGIRO, Estado de cuenta | CSV | Media | Dividendos + retención, depósitos, retiros, intereses, comisiones de conectividad |
| `trading212` | Trading 212, Historial | CSV | Media | Compras/ventas, dividendos (bruto = neto + retención), depósitos, retiros, intereses, conversiones, splits |
| `etoro` | eToro, Account Statement (hoja "Account Activity") | XLSX | Baja | Posiciones reales (no CFD), cripto, dividendos, depósitos, retiros, comisiones (en USD) |
| `extracto-co` | Extracto colombiano genérico (Davivienda Corredores, Acciones & Valores, Credicorp, Trii, tyba...) | CSV/XLSX/HTML | Baja | Movimientos con encabezados en español; BVC y COP por defecto |
| `b3-posicao` | B3 Área do Investidor, Posição (varias hojas) | XLSX | Media | Conciliación de posiciones o posición inicial (`positionsMode: 'opening'`) |
| `fidelity` | Fidelity, Activity / Accounts History | CSV | Media | Compras/ventas, reinversiones, dividendos, impuesto extranjero, intereses, transferencias |
| `nota-sinacor-pdf` | Notas de corretagem SINACOR (XP, Clear, Rico, BTG, Inter, Nu, Genial…) | **PDF** | Media | Negócios realizados + Resumo Financeiro: costos prorrateados por valor, IRRF a las ventas, verificación contra "Líquido para" |
| `extracto-co-pdf` | Extracto colombiano en PDF (Trii, tyba, Davivienda Corredores, Acciones & Valores, Credicorp…) | **PDF** | Baja | Tabla de movimientos reconstruida por posición del texto |
| `cdt-pdf` | Certificado/constancia de CDT (Colombia) | **PDF** | Baja | Emisor, valor, tasa E.A. o IPC/IBR + spread, emisión y vencimiento → activo `fixed_income` con `accrual` + compra |
| `ibkr-flex-sync` | Interactive Brokers, Flex Web Service (token + query id) | API | Media | Igual que Flex: operaciones, efectivo, transferencias, posiciones abiertas y eventos corporativos |
| `inbox` | Bandeja del servidor (`GET /api/sync/ibkr-flex/inbox`) o cualquier lote de `Transaction[]` | JSON | Alta | Pasa por el pipeline normal: duplicados exactos y entre fuentes, activos, validación |
| (correo) | Correos reenviados con notas, extractos o confirmaciones (`importEmail`) | .eml | Media | Cada adjunto importable (PDF con contraseña, CSV, Excel, HTML), sin duplicar entre adjuntos |
| `generic` | Cualquiera | CSV/XLSX/XLS/HTML | Depende del mapeo | Mapeo de columnas sugerido automáticamente (es/pt/en) y editable |

**Colombia.** No se conoce un formato estable de exportación CSV/Excel de Trii, tyba, Acciones &
Valores ni Davivienda Corredores; casi todos entregan extractos en PDF. Por eso el preset `extracto-co`
es el importador genérico con valores por defecto colombianos:
- Encabezados como Fecha, Operación/Concepto, Especie/Nemotécnico, Cantidad, Precio, Valor bruto,
  Comisión, IVA, Retención en la fuente, GMF y Valor neto.
- Mercado `XBOG`, moneda `COP`, fechas `DD/MM/AAAA` y números `1.234,56`.

Si tu extracto está en PDF, súbelo directamente: `extracto-co-pdf` reconstruye la tabla por posición del texto (confianza baja). Los certificados de CDT en PDF los lee `cdt-pdf`.

## Cómo exportar desde cada corredor

- **Interactive Brokers, Activity Statement.** Portal del Cliente → Rendimiento e Informes → Extractos →
  *Actividad* → periodo (Anual o Personalizado) → formato **CSV** → Ejecutar.
- **Interactive Brokers, Flex Query.** Rendimiento e Informes → Consultas Flex → nueva consulta de
  actividad.
  1. Agrega las secciones **Trades** y **Cash Transactions** con estos campos: Symbol, ISIN,
     ListingExchange, CurrencyPrimary, AssetClass, TradeDate, Quantity, TradePrice, Proceeds,
     IBCommission, IBCommissionCurrency, Buy/Sell, TransactionID, Type, Amount, DateTime, Description.
  2. Elige el formato CSV.
- **B3, Negociação y Movimentação.** investidor.b3.com.br → Extratos → *Negociação* o *Movimentação* →
  filtra el periodo → **Baixar** → Excel. Importa uno de los dos para las compras y ventas:
  - Movimentação usa la fecha de liquidación (D+2).
  - Si importas ambos, se marcan posibles duplicados.
  - Lo recomendado es usar Negociação para las operaciones y Movimentação para los proventos.
- **Notas de corretagem.** Usa un lector de notas o tu propia planilla con las columnas Data pregão,
  Nota, C/V, Código, Quantidade, Preço, Valor, Taxa de liquidação, Emolumentos, Corretagem, ISS, IRRF y
  Corretora. Puedes repetir los costos totales de la nota en cada fila: se prorratean por valor.
- **Charles Schwab.** schwab.com → Accounts → History → Transactions → elige cuenta y fechas → **Export**.
- **DEGIRO.** Actividad → *Transacciones* → fechas → Exportar → CSV, y *Estado de cuenta* → Exportar →
  CSV. Importa los dos: el primero trae las operaciones y el segundo los dividendos y el efectivo.
- **Trading 212.** Menú → Historial → icono de exportar → periodo (máx. 12 meses) → marca todas las
  casillas → Exportar CSV.
- **eToro.** Configuración → Cuenta → Estado de cuenta → fechas → Crear → descargar XLSX.
- **Colombia (Trii, tyba, Davivienda Corredores, Acciones & Valores, Credicorp).** Descarga el extracto o
  los movimientos en Excel si está disponible, y revisa el mapeo sugerido.

## Plantilla CSV de Portafolio Pro

- `exportTransactionsCsv(transactions, instruments, { delimiter, decimal, bom })` exporta los movimientos.
- `canonicalTemplateCsv()` genera la plantilla con filas de ejemplo.
- Con `delimiter: ';'` el separador decimal pasa a ser `,`, que es lo que espera Excel en es/pt.
- La importación acepta un subconjunto de columnas, tipos en español (compra, venta...) y fechas
  `DD/MM/AAAA`.

| Columna | Obligatoria | Descripción |
|---|---|---|
| `date` | sí | Fecha `AAAA-MM-DD` (también `DD/MM/AAAA`) |
| `type` | sí | BUY, SELL, DIVIDEND, INTEREST, DEPOSIT, WITHDRAWAL, FEE, TAX, SPLIT, STOCK_DIVIDEND, TRANSFER_IN, TRANSFER_OUT, FX_CONVERSION, RETURN_OF_CAPITAL (o compra/venta/dividendo...) |
| `instrument_id` | no | `BOLSA:SÍMBOLO` (BVMF:PETR4, XBOG:ECOPETROL, XNAS:AAPL). Si falta, se deduce de symbol/exchange |
| `symbol` | compras/ventas | Ticker |
| `exchange` | no | MIC (XBOG, BVMF, XNYS, XNAS, ARCX, XMAD, XETR...) o B3/BVC/NYSE/NASDAQ |
| `name`, `isin`, `asset_class` | no | Datos del activo (equity, etf, fund, reit, bond, fixed_income, cash, crypto, commodity, other) |
| `quantity` | compras/ventas | Títulos (positivo) |
| `price` | compras/ventas* | Precio por título (*o `amount`) |
| `currency` | sí | ISO 4217 (COP, BRL, USD, EUR...) |
| `amount` | dividendos/efectivo | Monto bruto positivo |
| `fees` | no | Comisiones (positivo) |
| `taxes` | no | Impuestos retenidos (retención, GMF, IOF, IRRF) |
| `ratio` | splits | Acciones nuevas por cada acción anterior (2 = 2×1; 0,1 = 1×10) |
| `to_currency`, `to_amount` | FX_CONVERSION | Moneda y monto recibidos |
| `fx_rate_to_base` | no | Tasa real usada (moneda base por 1 unidad), p. ej. la TRM |
| `account` | no | Cuenta o corredor |
| `note` | no | Nota libre |

## Respaldo JSON

Funciones:
- `createBackup()` arma el respaldo.
- `serializeBackup()` lo convierte en texto.
- `parseBackup()` y `validateBackup()` lo leen y validan.

Contenido: `{ format: 'portafolio-pro-backup', schemaVersion: 1, exportedAt, portfolios, instruments, transactions, manualPrices, settings? }`.

La validación revisa:
- tipos, fechas ISO, monedas e ids duplicados;
- que existan los portafolios y activos a los que apunta cada referencia;
- la versión: rechaza respaldos de versiones futuras y migra la versión 0.

## API para la interfaz

| Función | Para qué sirve |
|---|---|
| `inspectFile` | Hojas, puntaje de cada formato y mapeo sugerido |
| `suggestMapping` / `suggestMappingFromHeaders` | Sugerir el mapeo de columnas |
| `listPresets()` | Nombre, confianza e instrucciones de exportación de cada formato |
| `translateIssue(issue, 'pt')` | Volver a traducir los mensajes |
| `parseNumber`, `parseDate`, `classifyType`, `InstrumentResolver` | Utilidades sueltas |
| `importTransactionBatch(inbox, opts)` | Importar la bandeja de sincronización (o un lote de transacciones) con la misma vista previa y deduplicación |
| `importEmail(eml, { pdfPasswords })` | Importar los adjuntos de un correo reenviado |
| `resolveSpec`, `sinacorSuggestions`, `securityMapFromTransactions` | Nombres de pregão: ticker, sugerencias y respuestas aprendidas |

## Pruebas

```bash
npx vitest run packages/importers
npx tsc -p packages/importers --noEmit
```

Los archivos de ejemplo están en `test/fixtures/` y son sintéticos, pero tienen la estructura real:
- un CSV por formato, incluidos archivos Latin-1 con `;` y decimales con coma;
- archivos XLSX de B3 (Negociação, Movimentação y Posição) y eToro;
- `.xls` BIFF8 (normal y con mini stream), PDF de notas SINACOR, CDT y extracto de Trii;
- respuestas grabadas del Flex Web Service de IBKR (`ibkr-flex-ws/`).

Se regeneran con `npx tsx packages/importers/test/fixtures/generate.ts` (XLSX y CSV Latin-1),
`npx tsx packages/importers/test/fixtures/generate-r2.ts` (PDF, XLS y Posição) y
`npx tsx packages/importers/test/fixtures/generate-r4.ts` (corpus real-like). Los generadores usan los
escritores de `test/helpers/`: los mínimos (PDF, XLS y XLSX) y los realistas (`pdf-real.ts` y
`xls-excel.ts`).

## Pendientes conocidos (ronda 1, actualizado)

- **Formatos sin archivo real.** eToro, notas de corretagem y los extractos colombianos se
  reconstruyeron sin un archivo real a la vista, y conviene validarlos con usuarios. Lo mismo aplica a
  la semántica exacta de la tasa de cambio de Trading 212 y DEGIRO, que se usa para convertir comisiones
  y retenciones.
- **B3 Movimentação.**
  - Se asume que "Juros Sobre Capital Próprio" llega neto de IR; el bruto se estima como neto / 0,85.
  - Fração + Leilão se importan como venta de la fracción; incorporaciones y cisões se entregan en `corporateActions` para el asistente.
- **eToro.** Los montos están en USD aunque el activo cotice en EUR o GBP (se avisa con
  `CURRENCY_MISMATCH`).
- **Símbolos sin ticker.** DEGIRO no trae ticker: los ISIN que no están en el directorio interno se
  importan con el ISIN como símbolo y el usuario debe corregirlos.
- **Bolsa de EE.UU.** Si el ticker no está en la lista interna ni en el catálogo inyectado, el activo
  queda como `XNYS:SÍMBOLO`, el mismo valor por defecto que usa `@pm/market-data` (configurable con
  `defaultUsExchange`), y se avisa. Cuando llega la bolsa real se reutiliza el activo y se sugiere la
  actualización en `instrumentUpdates`.
- **No soportados.** Opciones, futuros y CFD se omiten con aviso. Los traspasos de custodia entre
  corredores de B3 se omiten.
- **Cotización en peniques.** Las acciones de Londres se guardan en GBP, pero Yahoo cotiza `.L` en
  peniques (GBp). Esto debe resolverse en `@pm/market-data`.
- **MGC.** Las acciones extranjeras del Mercado Global Colombiano compradas en COP se asocian al activo
  de EE. UU. (`XNAS:AAPL`) y la operación queda en COP, sin `fxRateToBase`.


## Respuesta a la revisión ronda 1

Revisión: `reviews/importers-r1.md`.

Los archivos de prueba del revisor (`scratchpad/review-imp/t1.ts` a `t4.ts`) quedaron como pruebas de regresión en `test/review-r1.test.ts`, organizadas por número de brecha. Las pruebas de PDF y de sincronización están en `test/pdf-sync.test.ts`.

**Línea base:**
- Antes: 86 pruebas.
- Ahora: **146 pruebas**, todas pasan (`npx vitest run packages/importers`).
- `npx tsc -p packages/importers --noEmit` termina sin errores. Los archivos de prueba también pasan el typecheck.

### Altas

**I3 — Números ambiguos.** La detección del separador decimal ahora usa evidencia, en este orden:
1. Muestras inequívocas.
2. Cruce `cantidad × precio ≈ valor` en cada fila, probando las dos lecturas.
3. Precio de referencia opcional (`options.referencePrice`, que la app puede alimentar con `@pm/market-data`).
4. El delimitador `;`, que implica coma decimal.

Si después de todo eso siguen quedando valores como `1.000` o `2,450`, la importación se **bloquea**:
- `needsConfirmation: [{ kind: 'numberFormat', candidates, suggested, samples, affectedLines }]` y `numberFormatCandidates`;
- las filas quedan en estado `pending` y `transactions` llega vacío.

La UI vuelve a llamar con `numberFormat`. El idioma de los encabezados y la moneda solo deciden cuál opción se sugiere primero. `allowAmbiguous: true` acepta la sugerencia con un aviso.

Casos del revisor:
- `1.000;2.450` en un archivo con `;` → 1000 acciones a 2450.
- `"1,500","2,450"` en un archivo con `,` → bloqueado.

**I4 — Fechas ambiguas.** Cuenta como evidencia:
- un día mayor que 12;
- hora con AM/PM;
- el orden fecha de operación ≤ fecha de liquidación (nuevo campo de mapeo `settleDate`);
- la monotonía cronológica de las filas.

Si todas las fechas siguen ambiguas: `needsConfirmation` con `kind: 'dateFormat'` y `dateFormatCandidates`. Con encabezados en inglés se sugiere MM/DD primero. Las filas quedan `pending`. `05/05` ya no cuenta como ambigua.

**I5 — Doble conteo B3.**
- En Movimentação, cada "Transferência - Liquidação" se empareja con la operación ya importada desde Negociação o desde una nota (mismo activo, lado y cantidad) a **0 a 3 días hábiles del calendario B3**. El calendario incluye Carnaval, Viernes Santo, Corpus Christi, 24 y 31 de diciembre y Consciência Negra desde 2024. La fila queda `skipped` con `SETTLEMENT_MATCHED`.
- `b3SettlementMode` admite `'auto'` (por defecto), `'include'` y `'skip'`.
- Los posibles duplicados quedan fuera de `transactions` y de la inferencia de proporciones. La bonificación de 13,7 sobre 137 acciones ahora da exactamente 0,1.

**I6 — IBKR descartaba secciones.** El Activity Statement ahora importa:
- `Transfers` (ACATS/FOP): TRANSFER_IN/OUT con precio y valor de mercado como costo sugerido, con aviso;
- transferencias de efectivo, como DEPOSIT/WITHDRAWAL;
- `Transaction Fees`, como FEE asociado al activo.

Cualquier sección con filas `Data` que no se maneja genera `UNHANDLED_SECTION` con nombre y número de filas. Solo se exceptúan las secciones de metadatos. `Open Positions` y `Cash Report` alimentan la conciliación (ver I20).

**I1 — PDF.** Nueva capa `src/pdf/`: pdf.js (`pdfjs-dist` legacy, que funciona en navegador y en Node) → texto con coordenadas → líneas y celdas → tabla alineada con las columnas del encabezado. `sniffKind` reconoce `%PDF`. Analizadores:
- **`nota-sinacor-pdf`:**
  - lee cabecera (Nr. nota, Data pregão, corretora), Negócios realizados (C/V, mercado, prazo, especificación, obs, cantidad, precio, valor, D/C) y Resumo Financeiro (liquidação, registro, termo/opções, A.N.A., emolumentos, corretagem/taxa operacional, execução, custódia, ISS/impostos, IRRF y outros);
  - prorratea los costos por valor y el IRRF entre las ventas;
  - verifica el resultado contra "Líquido para" (`NOTA_TOTALS_MISMATCH`);
  - admite varias notas y páginas, y omite opciones y termo;
  - deduce el ticker desde "PETROBRAS PN N2" con una tabla de emisores y clase (ON/PN/PNA/PNB/UNT/CI) o desde un ticker explícito; si no lo reconoce, devuelve el error `UNKNOWN_SECURITY` y el usuario responde con `securityMap`.
- **`extracto-co-pdf`:** extractos de Trii, tyba, Davivienda Corredores, Acciones & Valores y Credicorp con tabla de movimientos. Usa el mapeo genérico con valores por defecto colombianos e identifica el corredor como cuenta. Ignora el encabezado repetido en cada página.
- **`cdt-pdf`:** certificados de CDT. Extrae emisor, número, valor, tasa E.A. o IPC/IBR/DTF + spread, apertura y vencimiento (o plazo en días) y periodicidad. Crea un activo `MANUAL:CDT-…` `fixed_income` con `accrual` (`AccrualSpec` de core) y una compra.
- PDF no reconocido → `FILE_PDF_UNSUPPORTED`. PDF dañado o con contraseña → `PDF_READ_ERROR`, con mensaje claro.

Confianza honesta:
- **SINACOR: media.** El formato es estándar, pero el texto extraído varía según cómo genere el PDF cada corredora. La prueba usa un PDF sintético fiel al layout.
- **Extractos colombianos y CDT: baja.** No hay un formato público. Son analizadores aproximados por etiquetas y columnas y deben validarse con PDF reales de usuarios.

**I2 — Sincronización.** `src/sync/ibkr-flex.ts`:
- Flujo: `SendRequest` → `GetStatement`, con reintentos ante 1019/1018/1009, `fetch` inyectable y `sleep` configurable.
- Errores: mensajes en español para los códigos documentados (1012 token vencido, 1015 token inválido, 1014 query inválida…), devueltos como `FlexError`.
- Conversión: XML → la misma tabla que el Flex CSV (Trades, CashTransactions, Transfers, OpenPositions) → mismo analizador, con `source: 'import:ibkr-flex'`. Por eso un CSV y una sincronización se deduplican entre sí.
- Pruebas con respuestas grabadas en `test/fixtures/ibkr-flex-ws/`.

Uso recomendado: desde `apps/server`, porque IBKR no envía CORS y así el token no llega al navegador; por ejemplo, con una rutina diaria. Llamada: `syncIbkrFlex({ token, queryId, fetch }, { portfolioId, existingTransactions })`.

### Medias

**I7 — Duplicados entre fuentes y dentro del archivo.**
- Nuevo estado **`possible_duplicate`**, excluido por defecto, con `duplicateOf` (fuente, fecha, línea, id).
- Criterio: mismo tipo, activo y moneda; misma cantidad (y precio ±0,5 %) o mismo monto. La ventana es de **±3 días hábiles** si la fuente es otra y el mismo día si la fuente es la misma, salvo que las referencias del corredor sean distintas. (Ronda 3: además deben coincidir cuenta o institución, y dentro del archivo solo se marca; ver I21.)
- Cubre BUY, SELL, TRANSFER, DIVIDEND, INTEREST, DEPOSIT, WITHDRAWAL, FEE, TAX, FX_CONVERSION y SPLIT.
- La UI acepta con `acceptDuplicates: 'in-file' | 'all' | [líneas]`.

**I8 — Bolsa adivinada.** Ahora se consulta primero lo existente del usuario y luego un catálogo inyectable (`options.catalog`, por ejemplo `CATALOG.instruments` de `@pm/market-data`) por ISIN y símbolo. Además:

| Caso | Resultado |
|---|---|
| Tickers de la BVC | Siempre `XBOG`, aunque la fila esté en USD (con `CURRENCY_MISMATCH`) |
| `CURRENCY_MISMATCH` | Se avisa en **cada** fila, no solo al crear el activo |
| Acciones de EE. UU. compradas en COP (MGC) | El activo de EE. UU. (`XNAS:AAPL`); la operación se queda en COP (`MGC_FOREIGN_LISTING`) |
| Ticker de EE. UU. desconocido | `XNYS:ENB` (valor por defecto de `@pm/market-data`; ronda 3) |
| Llega después la bolsa real (por ejemplo, NASDAQ) | Se reutiliza el activo y se devuelve `instrumentUpdates` |
| EUR sin ISIN ni bolsa conocida | Error `EXCHANGE_REQUIRED`, que se resuelve con `securityMap: { SAN: 'XMAD' }`; hay una lista de tickers europeos sin ambigüedad |

**I9 — Signo.**
- DIVIDEND/INTEREST negativo → reversión (monto negativo, aviso).
- TAX/FEE: la convención de signo se decide por archivo (estilo flujo de caja o positivo). Las palabras devolución, reintegro, reembolso, reversión, estorno y refund fuerzan un monto negativo.
- "Compra" con cantidad negativa → `QUANTITY_SIGN_CONTRADICTS`.

**I10 — Comisión de FX en IBKR.** Cuando la comisión está en otra moneda, se emite un FEE aparte en la moneda de la comisión (`extraTransactions` de la fila), tanto en el Activity como en Flex.

**I11 — B3: fracciones, JCP y eventos.**
- "Fração em Ativos" + "Leilão de Fração" → una venta de la fracción con el valor de la subasta.
- JCP: bruto = neto / 0,85 e IR estimado (`JCP_GROSS_ESTIMATED`).
- Incorporação, cisão y conversão → `corporateActions` (patas de entrada y salida, cantidades) para el asistente de eventos de la UI.

**I12 — Planilla de nota.**
- `notaFeesMode: 'auto' | 'per-row' | 'per-note'`.
- En `auto`, un valor repetido solo se toma como total de la nota si todas las columnas de costos se repiten y los valores de las operaciones difieren. Si los valores son iguales, se avisa `FEES_MODE_AMBIGUOUS`.
- Hay columnas "Total custos nota".
- Se leen `Tipo mercado` y `D/C`, y se omiten las opciones (`PETRA250`, `PETR4E250`) y el termo.
- Las notas distintas con operaciones idénticas no se marcan como duplicadas.

**I13 — Cobertura y vocabulario.**
- Nuevo preset **Fidelity**, más los PDF anteriores.
- `listBrokerProfiles()` y `brokerProfile`: XP, Rico, Clear, BTG, Nu Invest, Inter, Tesouro Direto, Avenue, Hapi, Trii, tyba, Davivienda Corredores, Acciones & Valores, Credicorp, CDT, IBKR, Schwab, Fidelity, DEGIRO, T212 y eToro. Indican qué archivo descargar y qué formato lo lee, y aplican cuenta, mercado, moneda y formatos por defecto a los archivos genéricos.
- Vocabulario de CDT: constitución/apertura = BUY, redención/cancelación/vencimiento = SELL.
- Se quitan las palabras neutras iniciales (abono, pago, cargo, ingreso por…) y gana la palabra clave que aparece primero: "Dividendo neto de retención" → DIVIDEND.
- Palabras con sentido por signo (traslado, liquidación, ajuste, transferencia) → BUY/SELL/TRANSFER/DEPOSIT/WITHDRAWAL según el signo.
- Cash in lieu y leilão de fração → venta (o devolución de capital si no hay cantidad).
- `classifyTypeDetailed()` expone `refund` y `signBased`.

Para Avenue y Hapi no hay una exportación pública estable: el perfil guía al usuario a la plantilla.

**I14 — Rendimiento.** Índice por tipo, activo y moneda, con cubetas por día. Las fechas se parsean una sola vez.

| Importados | Existentes | Antes | Ahora |
|---|---|---|---|
| 10.000 | 10.000 | 35 s | 0,35 s |
| 50.000 | 50.000 | más de 10 min | ≈ 4 s |

**I15 — AutoFX de DEGIRO.** Los movimientos de cambio (Valuta Creditering/Debitering, FX Credit/Debit, Ingreso/Retirada Cambio de Divisa) se emparejan por fecha y hora en un FX_CONVERSION. Los que no tienen pareja se avisan.

### Bajas

**I16 — `.xls` y HTML.**
- Lector BIFF8 propio (`src/xls.ts`): contenedor CFB, también con mini stream; SST con CONTINUE; LABELSST, LABEL, NUMBER, RK, MULRK, BOOLERR, FORMULA y STRING; fechas por formato XF.
- HTML con tablas anidadas (cada una por separado) y `colspan` expandido.

**I17 — Formatos que daban error.** Ahora se aceptan:
- proporciones `2:1`, `1x10`, `1/10` y `10%`;
- seriales de Excel como texto (`45292`);
- sufijos `DR`/`D`/`CR`/`C`;
- fechas con día de la semana ("Mon Jan 15 2024").

**I18 — Reverse split de Schwab en dos filas.** Se calcula la proporción nuevo/antiguo (0,1).

**I19 — Avisos de fecha innecesarios.** Los presets de formato fijo no avisan ni bloquean: B3, notas, DEGIRO, Schwab, Fidelity, eToro y T212.

**I20 — Conciliación y foto inicial.** `result.reconciliation` incluye posiciones y caja informadas, las diferencias calculadas contra existentes + importados a la fecha del extracto, y el aviso `RECONCILIATION_DIFF`. Fuentes:
- IBKR `Open Positions` y `Cash Report`;
- Flex `OpenPositions`;
- nuevo preset **B3 Posição**, que une todas las hojas.

Con `positionsMode: 'opening'` (+ `asOfDate`) las posiciones se importan como TRANSFER_IN para arrancar el seguimiento mensual. `computeBalances()` está exportada.

## Notas de diseño: sincronización futura

- **B3 Área do Investidor (API).** B3 ofrece APIs de posición, movimientos y proventos a instituciones certificadas como *parceiro* del Canal Eletrônico do Investidor. Requieren contrato, homologación y el consentimiento OAuth del inversionista. Mientras no exista ese contrato, el flujo es:
  1. descarga mensual guiada de Negociação + Movimentação + Posição (los tres presets ya existen);
  2. conciliación automática con Posição.

  Cuando haya contrato, un conector `src/sync/b3.ts` debe producir las mismas filas que los presets XLSX para reutilizar la deduplicación por `source`.
- **Reenvío por correo** (como Sharesight):
  1. Cada usuario recibe una dirección única `importar+<token>@…`.
  2. El servidor (`apps/server`) recibe el webhook del proveedor de correo entrante (SES, Postmark o Mailgun), verifica SPF/DKIM y que el remitente esté autorizado, y descarta lo demás.
  3. Pasa cada adjunto (PDF de nota SINACOR, confirmaciones de IBKR/XP/BTG, extractos) por `importFile`.
  4. Guarda el resultado como **borrador**: nada se importa sin revisión del usuario, y los `possible_duplicate`/`pending` se muestran en la app.

  La deduplicación por `importHash` hace idempotente el reenvío repetido.
- **Agregadores** (Belvo/Pluggy para BR y CO, SnapTrade para EE. UU.): implementarlos como `src/sync/<proveedor>.ts`, que convierta su JSON a `DraftTransaction` y llame a `finalizeRows` con `source: 'sync:<proveedor>'`.

## Pendientes tras la ronda 2

- **Validar con archivos reales:**
  - PDF reales de cada corredora: SINACOR de XP, Clear, BTG, Nu e Inter; extractos de Trii, tyba, Davivienda y A&V; CDT de varios bancos.
  - La semántica de la tasa de cambio de T212/DEGIRO.
  - El supuesto de JCP neto en B3.
- **Tabla de nombres de pregão de SINACOR:** ver la ronda 3 (I23).
- **Lector `.xls`:** no lee celdas `RSTRING` antiguas (BIFF5) ni hojas protegidas con cifrado.
- **MGC:** la operación en COP queda sin `fxRateToBase`; el motor la convierte con la TRM del día.
- **Eventos corporativos (incorporação/cisão):** se entregan como sugerencias; falta el asistente en la UI.

## Respuesta a la revisión ronda 2

Revisión: `reviews/importers-r2.md` (6,5 frente a 8 de Sharesight). Las regresiones están en
`test/review-r2.test.ts`, organizadas por número de brecha.

**Línea base:**
- Antes: 146 pruebas.
- Ahora: **189 pruebas**, todas pasan (`npx vitest run packages/importers`).
- `npx tsc -p packages/importers --noEmit` termina sin errores. Los archivos de prueba también pasan el typecheck.

### Altas

**I21 — Duplicados que borraban movimientos legítimos.**
- La comparación semántica solo cruza movimientos de **cuentas compatibles**. `accountKey()` normaliza
  el nombre de la cuenta o institución (quita "S.A.", "CCTVM", "Corretora", "Invest"…), y
  `accountsCompatible()` exige que coincidan cuando ambas lo informan. Así, un dividendo de PETR4 en XP y
  otro en BTG el mismo día se importan los dos.
- Cada movimiento existente solo puede "absorber" una fila importada. Tres lotes iguales de B3 contra un
  existente dan uno duplicado y dos nuevos.
- Las filas idénticas **dentro del mismo archivo** ya no se bloquean: se importan con la marca
  `POSSIBLE_DUPLICATE_IN_FILE`. Es informativa en presets de corredor y es un aviso en archivos
  genéricos, plantillas y PDF.
- La reimportación exacta (mismo `importHash`) sigue quedando `duplicate`.

**I22 — Flex XML.**
- `flexXmlToTables()` lee Trades, CashTransactions, Transfers, OpenPositions, **CorporateActions** y
  **SalesTaxes**. Cualquier otro elemento con datos genera `UNHANDLED_SECTION`; ya nada se descarta en
  silencio.
- Splits: los tipos FS/RS o la descripción "SPLIT a FOR b" dan `SPLIT` con proporción a/b, una sola vez
  por evento. El tipo SD da `STOCK_DIVIDEND`. Spin-offs, fusiones y cambios de símbolo van a
  `corporateActions` con el aviso `CORPORATE_ACTION_PENDING`.
- Nivel de detalle: se ignoran las filas `SUMMARY`, `SYMBOL_SUMMARY`, `ASSET_SUMMARY` y `CLOSED_LOT`
  (salvo en posiciones), y las `ORDER` cuando hay `EXECUTION`. Los dividendos ya no se cuentan dos veces.
- Sales tax → `TAX` asociado al activo.

**I23 — Ticker de SINACOR.**
- El ticker solo se deduce cuando es seguro. Se usa el ticker explícito si aparece, o el **nombre de
  pregão exacto** + la clase (ON/PN/PNA/PNB/PNC/UNT/CI/DRN/DR1-3):
  - `B3_PREGAO_ROOTS` tiene 120 nombres. Por ejemplo, "GERDAU MET PN" → **GOAU4** y "GERDAU PN" → GGBR4.
  - `B3_ETF_PREGAO` tiene 11 ETF (CI). Por ejemplo, "ISHARES BOVA CI" → BOVA11.
  - `B3_BDR_PREGAO` tiene 22 BDR (DRN). Por ejemplo, "APPLE DRN" → AAPL34.
- Ya no hay coincidencia por la primera palabra. Si el nombre no está en la tabla, se **pregunta**:
  - la fila queda con `UNKNOWN_SECURITY`;
  - `result.unknownSecurities` lista `{ key, lines, suggestions }`;
  - la UI responde con `securityMap`.

**I4 — Fechas ambiguas.** La monotonía solo decide cuando:
- hay al menos 8 fechas;
- la otra lectura tiene más de una inversión;
- el resultado no contradice la pista del archivo (idioma de los encabezados o moneda: es/pt, COP o BRL
  apuntan a DD/MM; en o USD, a MM/DD).

En cualquier otro caso se pide confirmación, sugiriendo la pista. Un extracto agrupado por especie en el
que MM/DD "queda ordenado" ya no se lee como MM/DD.

**I2 — Sincronización montable en el servidor.** `src/sync/server.ts` usa la Fetch API
(`Request`/`Response`) y WebCrypto. Funciona en Node 20 o superior, Deno, Bun y Workers.

```ts
import { createIbkrFlexSyncHandler, createTokenVault, runIbkrFlexSyncJobs } from '@pm/importers';
const vault = await createTokenVault(process.env.SYNC_SECRET!); // ≥ 16 caracteres; mejor 32 aleatorios
const handler = createIbkrFlexSyncHandler({
  vault,
  store, // CredentialStore propio (get/set/delete) o MemoryCredentialStore
  authorize: async (req) => userIdFromSession(req), // undefined → 401
});
app.post('/api/sync/ibkr-flex', (c) => handler(c.req.raw)); // Hono
```

- Acciones (cuerpo JSON):
  - `save { token, queryId, credentialId? }` guarda el token cifrado con AES-256-GCM.
  - `sync { credentialId, portfolioId, existingTransactions?, existingInstruments?, account?, catalog? }`
    devuelve un `ImportResult`.
  - `delete { credentialId }` borra la credencial.
- Respuestas HTTP:
  - 401 sin usuario, 400 si la petición es inválida y 404 si no hay credencial;
  - 502 o 503 ante errores de IBKR, con `{ error: { code: 'FLEX_1012', message } }` en español.
- Las credenciales se guardan por usuario (`ibkr-flex:<usuario>:<credencial>`), así que un usuario no
  puede usar la de otro. El token no vuelve al navegador.
- Para la rutina diaria, `runIbkrFlexSyncJobs(jobs, { vault, store })` ejecuta cada trabajo
  `{ userId, portfolioId, load, save }`. Si un trabajo falla, los demás siguen.
- La conexión con `apps/server` la hace el coordinador.

### Medias

**I24 — Layouts de SINACOR, contraseña y OCR.**
- La cabecera se lee con etiquetas arriba y valores abajo, o apilada en la misma línea ("Nr. nota 123",
  "Data pregão 12/03/2024"), como en las notas de Nu e Inter.
- Si se detecta una nota sin operaciones, se avisa `NOTE_WITHOUT_TRADES`.
- Contraseña: `options.pdfPassword`. Sin ella, o si es incorrecta, se devuelve `needsPassword:
  'required' | 'incorrect'` y el error `PDF_PASSWORD_REQUIRED/INCORRECT`. El mensaje recuerda que XP,
  Clear y Rico usan los primeros dígitos del CPF. Las pruebas usan un PDF cifrado de verdad (RC4).
- **No hay OCR.** Un PDF escaneado devuelve `PDF_NO_TEXT` y se pide el PDF original.

**I25 — Costos e IRRF de SINACOR.**
- El IRRF de day trade se asigna a las ventas day trade y el IRRF normal (0,005 %), a las demás ventas.
  Las operaciones day trade llevan el aviso `DAY_TRADE`.
- Un costo marcado "C" (crédito) resta.
- Los costos generales se prorratean entre **todas** las operaciones, opciones incluidas. La parte de
  las opciones omitidas se descarta con `FEES_OF_SKIPPED`, y la taxa de termo/opções solo se asigna a
  derivados.
- Dos notas distintas con operaciones idénticas el mismo día se importan las dos, porque la referencia
  es `nota:<número>:<línea>`.

**I26 — CDT.**
- Las tasas nominales (N.M.V., N.T.V., N.S.V., N.A.V. y las anticipadas) se convierten a E.A., con el
  aviso `CDT_RATE_NOMINAL`.
- "Intereses al vencimiento" ya no se confunde con la fecha de vencimiento.
- Se lee la retención en la fuente (`CDT_WITHHOLDING`, que queda en la nota).
- Un vencimiento igual o anterior a la apertura es el error `CDT_INVALID_DATES`.

**I20 — Conciliación entre corredores.** Solo se concilia contra los movimientos de la misma cuenta, ya
sea por `options.account`, por las cuentas que informa el extracto (U-número de IBKR, cuenta de Activity)
o por la misma familia de fuente (IBKR, B3/notas, DEGIRO). Las posiciones de Schwab ya no aparecen como
diferencias en un extracto de IBKR.

**I28 — Ids compatibles con `@pm/market-data`.** Se revisaron `packages/market-data/src/symbols.ts` y su
README:
- Ya no existen los ids `US:`. Un ticker de EE. UU. sin bolsa conocida queda como `XNYS:SÍMBOLO`, igual
  que `parseYahooSymbol`, con `providerSymbols.yahoo` sin sufijo.
- Hay un solo activo por símbolo de EE. UU. Si después se conoce otra bolsa, se devuelve
  `instrumentUpdates` (`EXCHANGE_REFINED`).
- Tesouro Direto: `tesouroId()` da `TD:<código>-<vencimiento>`, con los códigos NTNB, NTNBP, NTNF, LTN,
  LFT y NTNC, `pricing: 'auto'` y `providerSymbols.tesouro`. Por ejemplo, Tesouro IPCA+ 2035 →
  `TD:NTNBP-2035-05-15`.
- Fondos (FIC): se buscan por nombre exacto en los activos del usuario y en `options.catalog`, antes de
  crear un activo `MANUAL`.

**I3 — Varias monedas en un archivo.**
- El separador decimal del archivo lo decide la moneda dominante.
- Si una fila en otra moneda trae un valor ambiguo, se resuelve con el precio de referencia o queda
  `pending`, con `needsConfirmation: [{ kind: 'numberFormat', scope: 'rows', affectedLines }]`. Las
  demás filas se importan.
- La UI responde por fila con `rowNumberFormats: { 4: 'dot' }`.

**I13 — Cobertura.**
- Fidelity: el money market base (SPAXX, FDRXX, FZFXX, SPRXX, CORE) se trata como efectivo. Las
  compras y reinversiones se omiten con `MONEY_MARKET_SWEEP`, y su dividendo es `INTEREST`.
- "Traslado", "Liquidación" y "Transferência" toman la dirección del signo. Si el archivo no trae ningún
  signo, se usa la entrada y se avisa `DIRECTION_ASSUMED` para que el usuario corrija el mapeo
  (`typeValues`).

### Bajas

**I29 — Sección de portafolio en extractos PDF.** La tabla "Portafolio al cierre" (también "Posición",
"Saldos" o "Resumen de portafolio") corta la tabla de movimientos y alimenta `reconciliation`. La fecha
de corte se toma del "Periodo" del extracto.

### Confianza y límites

- **Sin OCR.** Las notas escaneadas se rechazan con un mensaje claro.
- **Nombres de pregão.** No hay acceso al cadastro de B3 sin conexión, así que la tabla es limitada (ver
  la ronda 4: 184 emisores, ETF, FII y BDR). Lo que no está en la tabla se pregunta y nunca se adivina.
  Desde la ronda 4, la respuesta del usuario se aprende de sus propios movimientos.
- **Renda+ y Educa+.** `@pm/market-data` tiene los códigos `RENDA` y `EDUCA`, pero el id usa la fecha
  de vencimiento real (fin de los pagos), que no se puede deducir con certeza del año del nombre. Por eso
  no se adivina: si `options.catalog` trae el título con el mismo nombre, se usa su id `TD:`; si no,
  queda como `MANUAL`.
- **XP, BTG y Avenue.** Sus extratos propios siguen sin analizador dedicado, porque no se conoce un
  formato estable. Las notas SINACOR y los archivos de B3 cubren las operaciones de XP y BTG.
- **Formatos sin archivo real.** Los PDF de SINACOR y de los extractos colombianos se validaron con
  archivos sintéticos fieles al layout, no con archivos reales de usuarios (ver el corpus real-like de la
  ronda 4).

## Respuesta a la revisión ronda 3

Revisión: `reviews/importers-r3.md` (7,5 frente a 8 de Sharesight). Las regresiones están en
`test/review-r3.test.ts`, organizadas por número de brecha.

**Línea base:**
- Antes: 189 pruebas.
- Ahora: **240 pruebas**, todas pasan (`npx vitest run packages/importers`).
- `npx tsc -p packages/importers --noEmit` termina sin errores. Los archivos de prueba también pasan el typecheck.
- Las 50 pruebas de `apps/server` que usan este paquete siguen pasando.

### I30 — Nomes de pregão

- **Cambios de código.** (Desde la ronda 5 la fuente es `@pm/core`, ver abajo.) `TICKER_RENAMES` (en `markets.ts`) refleja las filas `rename` de
  `TICKER_ALIASES` de `@pm/market-data` y agrega ISA CTEEP → ISA Energia (TRPL → ISAE):
  - ELET3 → AXIA3;
  - EMBR3 → EMBJ3;
  - CCRO3 → MOTV3;
  - MRFG3 → MBRF3;
  - PFBCOLOM → PFCIBEST y BCOLOMBIA → CIBEST.

  El resolvedor las aplica en todos los formatos, no solo en SINACOR, con el aviso `TICKER_RENAMED`.
  Hay un solo activo por acción: si el portafolio ya tiene el código viejo, se sigue usando. Las fusiones
  y conversiones (BRFS3, NTCO3, CPLE6) no se tratan como cambios de código.
- **Nombres por fecha.** "NATURA ON" es NTCO3 hasta el 01/07/2025 y NATU3 desde el 02/07/2025.
- **Cobertura** (`src/pdf/b3-names.ts`):
  - 210 nombres (184 emisores), con los componentes del Ibovespa y el IBrX-100 de 2023-2025;
  - 13 ETF;
  - 38 FII, incluidos los que no traen el ticker en la especificação ("FII XP LOG CI ER" → XPLG11);
  - 50 BDR, contando la clase DR3 de ROXO34.

  Solo se listan los nombres cuyo ticker es seguro.
- **Sugerencias aproximadas** (`suggestB3Names`): combinan palabras en común, prefijos y distancia de
  edición, y muestran el código vigente. Por ejemplo:
  - "ISA ENERG PN" sugiere ISAE4 primero;
  - "PETROBRAZ PN" sugiere PETR4.

  También usan los nombres del catálogo inyectado (`options.catalog`, por ejemplo `CATALOG.instruments`
  de `@pm/market-data`).
- **Respuestas aprendidas.** Cada operación importada guarda su especificação en la nota ("Nota 123 ·
  GERDAU MET PN N1"). `securityMapFromTransactions(existentes)` reconstruye las respuestas que el usuario
  ya dio y se aplican solas en las notas siguientes, con el aviso informativo `SECURITY_LEARNED`. No
  requiere almacenamiento extra.
  - Orden de prioridad: respuesta explícita, tabla segura, respuesta aprendida, pregunta.
  - No se aprenden las respuestas contradictorias ni los nombres que dependen de la fecha.

### I31 — Corpus real-like

No hay documentos reales de usuarios. En su lugar se construyó un corpus que reproduce cómo se generan
los documentos reales, y las pruebas lo leen desde `test/fixtures/real-like/`.

**Notas SINACOR** de XP (2 páginas), Clear, BTG, Inter y Nu Invest (2024 y 2025). Reproducen:
- la caja de cabecera, que a veces comparte línea con la dirección o con el nombre de la corredora;
- el bloque del cliente;
- las 10 columnas de "Negócios realizados";
- "Resumo dos Negócios" y "Resumo Financeiro" en dos columnas, con subtotales (Total CBLC, Total Bovespa,
  Total Custos) que no son costos;
- "CONTINUA..." en la página 1;
- el IRRF con su base y el IRRF de day trade;
- la leyenda de Obs.

Cada nota cambia lo que suele romper a los lectores:
- Helvetica, Courier o Times;
- texto por celda, por palabra, por letra o en `TJ` con kerning;
- contenido comprimido (FlateDecode);
- orden de dibujo aleatorio;
- cifrado RC4 o AES-128;
- "1-BOVESPA" o "B3 RV LISTADO".

**Extractos colombianos:**
- **Estilo Davivienda Corredores:** resumen del portafolio antes de los movimientos, "SALDO ANTERIOR" y
  "SALDO FINAL" con fecha, descripciones en dos líneas, montos `$`, `-$` y `( )`, encabezado repetido en
  la página 2 y pies de página.
- **Estilo Trii:** fechas "05 mar. 2024", montos "COP 2.390,00" y portafolio al cierre.

**`.xls` guardado por Excel** (`test/helpers/xls-excel.ts`):
- streams de SummaryInformation en el mini stream;
- directorio en árbol rojo-negro;
- cadena del Workbook fragmentada;
- SST de más de 8 224 bytes partida en CONTINUE a mitad de cadena, con cambio de ancho de carácter,
  texto enriquecido y datos fonéticos;
- celdas MULRK, MULBLANK, RK ×100, FORMULA + STRING, BOOLERR y LABEL;
- celdas combinadas, una hoja oculta y fechas en el sistema 1904 (Mac).

**Errores reales que el corpus destapó y se corrigieron:**
- **Cabecera de la nota.** El número y la fecha se leían de la línea equivocada cuando la cabecera
  compartía línea con la dirección. Ahora los valores se buscan bajo su etiqueta, por posición.
- **Corredora.** No se detectaba si el título "NOTA DE NEGOCIAÇÃO" estaba en la misma línea. Ahora se
  busca por celda.
- **Columnas del PDF.** Se mezclaban columnas con fuentes de 6-7 pt. El umbral entre columnas ahora
  depende del tamaño de la fuente.
- **Saldos.** "SALDO ANTERIOR" y "SALDO FINAL" con fecha se importaban como depósitos. Ahora se omiten
  con `BALANCE_ROW`.
- **Texto suelto de los extractos.** Pies de página, avisos legales y la cabecera de la página 2 daban
  errores. Ahora quedan como `NOT_A_MOVEMENT`.
- **Tipo de movimiento.** Sin columna de tipo, "Descripción" (al lado de "Especie") no se usaba, y la
  venta salía como compra y el dividendo como depósito. Ahora esa columna da el tipo.
- **Portafolio al cierre.** Influía en la detección del separador decimal. Ya no.
- **Lector `.xls`:**
  - honra `DATEMODE` 1904;
  - lee RSTRING;
  - ignora las hojas que no son de celdas y pone las ocultas al final;
  - avisa `XLS_ENCRYPTED` si el libro tiene contraseña de apertura.

### I20 — Cuentas IBKR

- Los movimientos del Activity Statement y del Flex (CSV o XML) llevan el número de cuenta (`U1234567`)
  como `account`, salvo que el usuario haya elegido otra etiqueta.
- `accountsCompatible` reglas:
  - dos números distintos son cuentas distintas;
  - "IBKR" o "Interactive Brokers" es compatible con cualquiera de ellos;
  - alias de institución: IBKR/IB/Interactive, Schwab/Charles Schwab, Nu/Nubank/Easynvest, T212/Trading 212.
- Conciliación:
  - un extracto con número solo se compara con los movimientos de esa cuenta;
  - los movimientos de la misma corredora **sin cuenta** se usan por defecto (caso de una sola cuenta);
  - si el portafolio tiene otras cuentas de la corredora, se usa la variante que mejor explica el
    extracto;
  - en ambos casos se avisa `RECONCILIATION_UNASSIGNED` con `reconciliation.unassignedTransactions`.

### I32 — Clase de los BDR

- Una letra después de DRN que no sea una marca conocida (ED, EJ, N1, NM…) se pregunta con
  `BDR_CLASS_UNCERTAIN` y los códigos candidatos. Por ejemplo, "ALPHABET DRN C" sugiere GOGL34 y GOGL35.
  Un BDR de varias clases sin letra también se pregunta.
- **Columna Obs (*).** Si la cabecera de la columna está presente, se lee por posición. Así, una letra
  en la especificação ya no se confunde con un marcador de Obs.

### I33 — Eventos corporativos listos para confirmar

- Las descripciones de IBKR se leen con `parseIbkrCorporate`, en Flex y en Activity:
  - "MMM(US…) SPINOFF 1 FOR 4 (SOLV, SOLVENTUM CORP, US…)";
  - fusiones;
  - cambios de ISIN.
- Cada evento trae `proposal.transaction`, una transacción de `@pm/core` lista para usar:
  - `SPLIT` con `subtype: 'SPINOFF' | 'MERGER' | 'TICKER_CHANGE'`, `targetInstrumentId` y `ratio`;
  - en los spin-offs, `costFraction` precalculado por valor de mercado del día ex (`referencePrice`);
  - el activo nuevo en `proposal.instruments`.
- `missing` dice qué falta (`parent`, `ratio`, `costFraction`).
- **Un clic:** `acceptCorporateActions: [línea]` o `'all'`, más `corporateActionAnswers` si falta algo,
  aplica la transacción y la fila pasa a `ok`. Reimportar marca `alreadyImported`.
- Las incorporações y cisões de B3 Movimentação usan las mismas propuestas a partir de sus filas de
  entrada y salida.
- Las adquisiciones en efectivo del Activity ("Merged(Acquisition) FOR USD 10.00 PER SHARE") se importan
  como venta.

### I2 — Bandeja del servidor por el pipeline normal

`importTransactionBatch({ pending, instruments }, opciones)` hace pasar la respuesta de
`GET /api/sync/ibkr-flex/inbox` (o cualquier lote de `Transaction[]`) por `finalizeRows`:
- conserva `id`, `source` e `importHash` del servidor, así que un CSV de Flex ya importado queda
  `duplicate`;
- un movimiento cargado a mano o desde otra fuente queda `possible_duplicate`;
- los activos se emparejan con los del usuario o se proponen;
- se conservan los campos que el importador no construye (`subtype`, `targetInstrumentId`,
  `costFraction`).

`importFile` también reconoce ese JSON (`presetId: 'inbox'`), así que la web puede tratarlo como un
archivo más. La pantalla queda a cargo del agente web.

### Más allá de la revisión

**Correos reenviados** (`importEmail`, `src/email.ts`), como el buzón de Sharesight. Lee:
- MIME multipart anidado, base64 y quoted-printable;
- nombres de archivo en RFC 2047 y RFC 2231;
- correos reenviados como adjunto (`message/rfc822`).

Cada adjunto importable pasa por `importFile`, deduplicado contra los anteriores (la misma nota adjunta
dos veces queda duplicada). Las notas cifradas se abren con las contraseñas que el usuario guardó
(`pdfPasswords`; en XP, Clear y Rico son los primeros dígitos del CPF). Si ninguna sirve, quedan en
`needsPassword`. Una tabla en el HTML del mensaje se importa cuando no hay adjuntos.

La recepción del correo y la verificación del remitente (SPF/DKIM) son tarea del servidor.

### Límites

- **Sin documentos reales.** El corpus es real-like, no real: sigue faltando validar con PDF y `.xls` de
  usuarios. Se recomienda sumar cada documento real anonimizado a `test/fixtures/real-like/` con su
  prueba.
- **Sin OCR** para notas escaneadas.
- **Sin cadastro de B3 en línea.** Lo que no está en las tablas se pregunta, con sugerencias, y se
  aprende.
- **Fracción de costo de los spin-offs.** Cuando el emisor publica una fracción oficial distinta, debe
  ingresarse como respuesta: el valor de mercado del día ex es la aproximación por defecto.
- **AXIA6.** Resuelto en la ronda 5: ELET6 → AXIA6 está en la tabla única de `@pm/core`.

## Respuesta a la revisión ronda 4

Revisión: `reviews/importers-r4.md` (8 frente a 8 de Sharesight: empate, no aprobado). Las regresiones
están en `test/review-r4.test.ts`.

**Línea base:**
- Antes: 240 pruebas.
- Ahora: **255 pruebas**, todas pasan.
- `npx tsc -p packages/importers --noEmit` y `npx tsc -p packages/core --noEmit` terminan sin errores, y los archivos de prueba pasan el typecheck.
- Las pruebas de `packages/core` y `apps/server` siguen pasando (294).

### I35 — Líneas ilegibles en notas SINACOR

- Toda línea de "Negócios realizados" que parece una operación y no se puede leer genera el error
  `UNPARSED_LINE`. Cuenta como operación si empieza con `1-BOVESPA`, `B3 RV LISTADO` o C/V + mercado, o
  si termina en un valor con D/C. Por ejemplo, una cantidad `1OO` leída por OCR.
  - El error trae la nota y el texto crudo.
  - Si corregir las confusiones típicas de OCR (O→0, l/I→1) produce una lectura válida, se propone en
    `params.reading` ("C ITAUSA PN N1 100 × 10"), pero nunca se aplica sola.
- Una nota con líneas ilegibles, o que no cuadra con "Líquido para" (`NOTA_TOTALS_MISMATCH`), **no se
  importa tal cual**:
  - sus operaciones quedan `pending`, **sin costos prorrateados**;
  - se avisa `NOTE_REVIEW_REQUIRED`;
  - `result.noteChecks` resume cada nota: neto impreso, neto calculado, costos, líneas ilegibles y líneas
    leídas.

  Cuando el usuario carga a mano la línea ilegible o revisa la nota, acepta con `acceptNotes: ['número']`
  y entonces se prorratean los costos.
- Una especificação partida en dos líneas ("ITAUUNIBANCO" / "PN EJ N1") se une si la segunda línea es
  solo texto, está en la columna de especificação y va justo debajo.

### I34 — Activity Statement consolidado de IBKR

- La columna `Account` de cada sección (Trades, Deposits & Withdrawals, Dividends, Withholding Tax,
  Interest, Fees, Open Positions, Cash Report…) se lee fila por fila. Cada movimiento lleva su U-número.
- Dividendos y retenciones se agrupan por cuenta: una retención de U2222222 nunca va a un dividendo de
  U1111111.
- Conciliación por cuenta: las posiciones y la caja de cada cuenta se comparan solo con los movimientos
  de esa cuenta. Las diferencias llevan `account`, y `reconciliation.accounts` lista las cuentas. Dos
  compras iguales en cuentas distintas no se marcan como repetidas.

### I36 — Una sola tabla de cambios de código, en `@pm/core`

- Nuevo archivo `packages/core/src/tickerRenames.ts`, exportado desde `@pm/core` con una línea en
  `index.ts`. Son datos puros y unas pocas búsquedas:
  - `TICKER_EVENTS`, con todo lo de la tabla de importers y de `TICKER_ALIASES` de market-data:
    - `rename`: misma acción;
    - `merger` y `conversion`: con `ratio`, `cashPerShare`, `cashPayDate`, `components`, fechas
      `effective` y `lastTradingDay`, símbolos de Yahoo e ISIN viejos;
  - agrega TRPL3/TRPL4 → ISAE3/ISAE4, ELET6 → AXIA6 y la conversión NATU3 → NTCO3 (2019-12-18).
- Funciones:
  - `tickerEventsFrom(clave)`;
  - `renamedTickerId(id)`, que sigue cadenas de cambios de código;
  - `tickerRenameMap()`;
  - `tickerIdOn(idInicial, fecha)`, que aplica los eventos con fecha en orden cronológico, cada uno una
    sola vez. Así resuelve los códigos reutilizados, como NATU3.
- Los importers ya la usan: `TICKER_RENAMES = tickerRenameMap()` y la lógica de "NATURA" por fecha usa
  `tickerIdOn`. **Market-data y tax pueden cambiarse a ella** (`TICKER_ALIASES` tiene los mismos campos).

### I37 — NATURA ON antes de diciembre de 2019

`tickerIdOn('BVMF:NATU3', fecha)` da:
- NATU3 (Natura Cosméticos) hasta el 17/12/2019;
- NTCO3 desde el 18/12/2019;
- NATU3 otra vez desde el 02/07/2025.

Una nota del 10/06/2019 se importa como NATU3, el símbolo con historia en Yahoo. El canje NATU3 → NTCO3
de 2019 está en la tabla para que el motor o market-data lo apliquen.

### I38 — Retención en la segunda línea de un extracto

En los extractos PDF, una línea sin fecha que sigue a un movimiento y menciona una retención (retención,
retefuente, IRRF, GMF/4x1000) o un costo (comisión, IVA) se suma a ese movimiento como `taxes` o `fees`.
Se avisa `CONTINUATION_MERGED`. Ya no queda como `NOT_A_MOVEMENT`.

### I39 — Respuesta aprendida contra la tabla segura

Si el usuario importó antes una especificação como otro activo ("GERDAU MET PN N1" → GGBR4) y la tabla
dice otra cosa (GOAU4), gana la tabla y se avisa `SECURITY_ANSWER_CONFLICT` con ambos ids: la misma
acción quedaría repartida en dos activos.

### I2 — Receptor de correo

`createEmailInboxHandler` (`src/sync/email-inbox.ts`) está listo para montar:

```ts
const inbox = createEmailInboxHandler({
  secret: process.env.INBOX_SECRET!, // cabecera x-inbox-secret
  resolveRecipient: (token) => portfolios.byInboxToken(token), // importar+TOKEN@dominio
  save: (target, result) => drafts.add(target.portfolioId, result), // borrador a revisar
  allowedSenders: [/@(xpi|btgpactual|nuinvest|bancointer)\.com\.br$/i],
});
app.post('/api/inbox/email', (c) => inbox(c.req.raw));
```

- Acepta el MIME crudo (Cloudflare Email Workers, SES), el JSON de Postmark (`RawEmail`) o el de Mailgun
  (`body-mime`).
- Verifica, en este orden:
  - el secreto compartido, con comparación en tiempo constante;
  - el remitente permitido;
  - `spf=pass` o `dkim=pass` en `Authentication-Results`;
  - el destinatario con token.
- Corre `importEmail` con las contraseñas guardadas del usuario y entrega el resultado como borrador.
- Respuestas: 401, 403, 404 o 413 según el caso.

**Conexión con el servidor.** Falta montarlo en `apps/server` y que el proveedor de correo entrante lo
llame (trabajo del coordinador). La conexión con la Área do Investidor de B3 y los agregadores siguen
fuera de alcance: requieren contrato.

### I31

Las pruebas de I35 a I38 reproducen el ruido de documentos reales:
- OCR con `1OO`;
- especificação en dos líneas;
- extracto consolidado;
- retención en la línea siguiente.

Sigue faltando al menos un documento real anonimizado por corredora.
