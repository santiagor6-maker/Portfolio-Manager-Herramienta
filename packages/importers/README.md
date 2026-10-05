# @pm/importers — Importación de movimientos

Convierte archivos de corredores (CSV, XLSX y tablas HTML guardadas como `.xls`) en `Transaction[]` de
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
    - Si un movimiento coincide con otro de distinta fuente (mismo activo, tipo y cantidad, a ±3 días),
      se avisa como "posible duplicado". Pasa, por ejemplo, entre B3 Negociação y Movimentação.

## Formatos soportados

Confianza:
- **Alta:** el formato es público, estable y muy conocido.
- **Media:** el formato es conocido, pero cambia según la versión, el idioma o las columnas que elija el
  usuario.
- **Baja:** el formato fue reconstruido sin un archivo real a la vista, o es una plantilla genérica.

Las pruebas usan archivos sintéticos fieles a esa estructura. Durante el desarrollo no hubo acceso web
para verificar con exportaciones reales.

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
| `generic` | Cualquiera | CSV/XLSX/HTML | Depende del mapeo | Mapeo de columnas sugerido automáticamente (es/pt/en) y editable |

**Colombia.** No se conoce un formato estable de exportación CSV/Excel de Trii, tyba, Acciones &
Valores ni Davivienda Corredores; casi todos entregan extractos en PDF. Por eso el preset `extracto-co`
es el importador genérico con valores por defecto colombianos:
- Encabezados como Fecha, Operación/Concepto, Especie/Nemotécnico, Cantidad, Precio, Valor bruto,
  Comisión, IVA, Retención en la fuente, GMF y Valor neto.
- Mercado `XBOG`, moneda `COP`, fechas `DD/MM/AAAA` y números `1.234,56`.

Si tu extracto solo está en PDF, copia la tabla a Excel o usa la plantilla propia.

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

## Pruebas

```bash
npx vitest run packages/importers
npx tsc -p packages/importers --noEmit
```

Los archivos de ejemplo están en `test/fixtures/` y son sintéticos, pero tienen la estructura real:
- un CSV por formato, incluidos archivos Latin-1 con `;` y decimales con coma;
- archivos XLSX de B3 y eToro.

Los XLSX y los CSV Latin-1 se regeneran con `npx tsx packages/importers/test/fixtures/generate.ts`.

## Pendientes conocidos

- **Formatos sin archivo real.** eToro, notas de corretagem y los extractos colombianos se
  reconstruyeron sin un archivo real a la vista, y conviene validarlos con usuarios. Lo mismo aplica a
  la semántica exacta de la tasa de cambio de Trading 212 y DEGIRO, que se usa para convertir comisiones
  y retenciones.
- **B3 Movimentação.**
  - Se asume que "Juros Sobre Capital Próprio" llega neto de IR.
  - "Leilão de Fração", "Fração em Ativos", incorporaciones y cisões no se importan; quedan como aviso.
- **eToro.** Los montos están en USD aunque el activo cotice en EUR o GBP (se avisa con
  `CURRENCY_MISMATCH`).
- **Símbolos sin ticker.** DEGIRO no trae ticker: los ISIN que no están en el directorio interno se
  importan con el ISIN como símbolo y el usuario debe corregirlos.
- **Bolsa de EE.UU.** Si el ticker no está en la lista interna, se supone `XNAS` (configurable con
  `defaultUsExchange`) y se avisa.
- **No soportados.** Opciones, futuros y CFD se omiten con aviso. Los traspasos de custodia entre
  corredores de B3 se omiten.
- **Cotización en peniques.** Las acciones de Londres se guardan en GBP, pero Yahoo cotiza `.L` en
  peniques (GBp). Esto debe resolverse en `@pm/market-data`.
- **MGC.** Las acciones extranjeras del Mercado Global Colombiano compradas en COP quedan como
  `XBOG:SÍMBOLO`, y Yahoo puede no tener ese símbolo.
