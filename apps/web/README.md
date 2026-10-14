# @pm/web — Portafolio Pro (aplicación web)

Aplicación React + Vite, **local-first**: todos los datos viven en el navegador (IndexedDB vía Dexie).
Seguimiento de portafolios multi-mercado (BVC, B3, EE. UU., Europa) y multi-divisa, con el
**seguimiento mensual** como página central. Interfaz en español (por defecto), portugués e inglés.

## Cómo correrla

```bash
npm run dev:server          # (opcional) servidor de precios en http://localhost:8787
npm run dev -w @pm/web      # app en http://localhost:5173 (proxy /api → :8787)
```

Sin el servidor la app funciona igual: usa los precios guardados en IndexedDB (o los datos de
ejemplo) y muestra un aviso «Servidor de precios no disponible». La URL del servidor se cambia en
**Ajustes → Fuente de datos** (vacío = mismo origen `/api`).

| Comando | Qué hace |
|---|---|
| `npm run build -w @pm/web` | `tsc --noEmit` + build de producción en `apps/web/dist` |
| `npm test -w @pm/web` | pruebas unitarias/componentes (vitest + jsdom + fake-indexeddb) |
| `npx vitest run apps/web` | lo mismo desde la raíz (configuración del monorepo) |
| `npm run e2e -w @pm/web` | prueba de humo Playwright sobre el build (`vite preview` en :4173) y capturas |
| `npx tsc -p apps/web --noEmit` | chequeo de tipos |

Playwright usa el Chromium preinstalado en `/opt/pw-browsers` si existe. `e2e/live.spec.ts` solo
corre si el servidor de precios responde en :8787 (si no, se omite).

## Páginas

- **Resumen**: valor total, cambio del día / mes / año / total (TWR y TIR), gráfico valor vs.
  aportado con selector Mes/Año/1A/3A/Todo, distribución por país/divisa/clase/sector, rentabilidad de
  los últimos 12 meses vs. índice, mayores movimientos, dividendos próximos (estimados) y últimos,
  frescura de datos por fuente y avisos (precios faltantes, cierres manuales pendientes, FX, errores
  del motor).
- **Posiciones**: tabla ordenable y filtrable (país, clase, divisa, búsqueda): cantidad, costo
  promedio, precio y fecha, valor en moneda de reporte y local, ganancia no realizada separada en
  **efecto precio** y **efecto divisa**, peso; efectivo por divisa; exportar CSV. Detalle por activo
  (`/posiciones/:id`): gráfico de precio, lotes abiertos, movimientos, ingresos y realizado.
- **Seguimiento mensual** (página principal): mapa de calor año × mes de la TWR mensual con total
  anual y el del índice; tabla mes a mes con valor inicial, aportes/retiros, dividendos, comisiones,
  ganancia, valor final, rentabilidad del mes, acumulada, efecto precio, efecto divisa, índice y
  diferencia; KPI de mejor/peor mes y % de meses positivos; exportación **CSV** y **XLSX** (escritor
  XLSX propio, sin dependencias). El mes en curso se marca «en curso».
- **Cierre de mes** (`/mensual/cierre`): para activos sin precio automático (FIC, CDT, fondos) se
  ingresa el valor de la unidad al último día del mes; los activos con precio automático se muestran
  de solo lectura. Los meses cerrados se recuerdan.
- **Movimientos**: lista con filtros (tipo, cuenta, fechas, texto), selección y borrado masivo,
  edición, exportación en el CSV canónico de `@pm/importers` (ida y vuelta). Formulario rápido para
  compras, ventas, dividendos (bruto + retención), aportes, retiros y cambios de divisa (tasa
  implícita), más intereses, comisiones, impuestos, splits, traslados, etc. Validación con mensajes
  por campo (venta mayor a lo que se tiene, fecha futura, moneda distinta a la del activo…). Búsqueda
  de tickers en el servidor con catálogo local de respaldo y creación de activos manuales.
- **Importar**: asistente de 4 pasos con `@pm/importers` (archivo → columnas → revisión → listo):
  detección del corredor, mapeo de columnas cuando no se reconoce el formato, vista previa con
  errores/duplicados/omitidas, confirmación; plantilla CSV descargable.
- **Divisas**: exposición por moneda, tasas actuales y variación 1A, historial de tasas (USD/COP,
  USD/BRL, EUR/USD, EUR/COP, BRL/COP, USD/MXN) con fuente y fecha, y cuánto de la rentabilidad vino
  del precio vs. de la divisa (por año y acumulado).
- **Dividendos**: barras por mes comparando años, neto del año vs. anterior, últimos 12 meses,
  rentabilidad sobre costo y sobre valor, retenciones y tasa efectiva, por país y por activo, pagos.
- **Rendimiento y riesgo**: TWR (y anualizada) vs. TIR/MWR, volatilidad, Sharpe, Sortino, beta,
  caída máxima, gráfico de rentabilidad acumulada vs. índices, gráfico de caídas, tabla por periodo y
  comparación con COLCAP, Ibovespa, S&P 500 y MSCI World.
- **Impuestos**: reportes de `@pm/tax` — Colombia (patrimonio al 31-dic con TRM, Formulario 160,
  dividendos, ganancia ocasional / Art. 36-1, diferencia en cambio, GMF, CSV para el contador) y Brasil
  (apuración mensual B3, exención R$ 20 mil, DARF, pérdidas a compensar, proventos). Con aviso legal.
- **Ajustes**: idioma, moneda de reporte, método de costo, tasa libre de riesgo, tema, modo privado,
  índices, URL del servidor (con prueba de conexión), portafolios (crear, renombrar, moneda base,
  método de costo, residencia fiscal, eliminar), respaldo JSON (exportar / restaurar combinando o
  reemplazando), quitar/cargar datos de ejemplo y borrar todo.

Controles globales en la barra superior: selector de portafolio (incluye la vista consolidada
«Todos»), **moneda de reporte** (COP, BRL, USD, EUR, MXN, CLP, PEN, GBP, CHF — todas las cifras se
recalculan en esa moneda), actualizar precios (con estado y hora), modo privado y tema claro/oscuro.

## Arquitectura

```
src/
  main.tsx, App.tsx           arranque, rutas (páginas con carga diferida)
  db/schema.ts                Dexie: esquema versionado (v1 → v2 con migración)
  db/repo.ts                  acceso a datos, ajustes, datos de ejemplo, respaldo/restauración
  services/analysis.ts        dataset → Analysis con @pm/core (cada paso aislado con try/catch)
  worker/engine.worker.ts     el cálculo corre en un Web Worker (respaldo en el hilo principal)
  services/engineClient.ts    cliente del worker; descarta resultados viejos
  services/marketClient.ts    adaptador de @pm/market-data/client (inyectable en pruebas)
  services/marketData.ts      actualización de precios/FX/cotizaciones, caché y estado por fuente
  services/importers.ts       adaptador de @pm/importers
  services/tax.ts             adaptador de @pm/tax
  services/demo.ts            datos de ejemplo de @pm/core (+ un FIC con precios manuales)
  store/app.ts                estado de UI (zustand); ajustes persistidos en IndexedDB
  i18n/                       es / pt / en (pt y en tipados contra es: no faltan claves)
  lib/                        formato por locale, parseo de decimales, exportación CSV/XLSX…
  components/, pages/         UI
```

- **IndexedDB** (`portafolio-pro`): `portfolios`, `instruments`, `transactions`, `manualPrices`,
  `priceSeries`, `fxSeries`, `quotes`, `settings`, `meta`. Versión 2 agrega `quotes`/`meta` y completa
  `source` en movimientos antiguos (migración probada).
- **Primer arranque**: se siembra el «Portafolio de ejemplo» marcado como **Datos de ejemplo**
  (banner + insignia). «Empezar mi portafolio» lo quita y crea uno vacío; el primer movimiento real
  nunca se guarda en el portafolio de ejemplo.
- **Moneda de reporte**: el motor recibe `baseCurrency`; mientras recalcula, las cifras viejas se
  muestran atenuadas y con su moneda original (nunca cifras de COP con símbolo de USD).
- **Rendimiento**: el motor corre en un Web Worker; con 2.700 movimientos el análisis completo
  tarda ≈0,5 s (prueba incluida). Las páginas se cargan bajo demanda.
- **Formato**: `es-CO` → `$ 1.234.567`, `pt-BR` → `R$ 1.234,56`, `en-US` → `$1,234.56`; dólares
  que no son la moneda local se muestran con su código (`USD 1.234,56`). Números tabulares.
- **Accesibilidad**: navegación por teclado, «saltar al contenido», diálogos con foco atrapado y
  Escape, `aria-sort` en tablas, gráficos con `aria-label`, ganancias/pérdidas siempre con flecha y
  signo además del color, contraste en ambos temas, sin scroll horizontal a 390 px.

## Pruebas

- `src/__tests__/format.test.ts` — formato de dinero/porcentajes/meses por locale, modo privado.
- `src/__tests__/parse-export.test.ts` — parseo de decimales es/pt/en, CSV y XLSX.
- `src/__tests__/db.test.ts` — ajustes, borrado en cascada, series, datos de ejemplo, respaldo y
  migración v1 → v2 (fake-indexeddb).
- `src/__tests__/analysis.test.ts` — integración con el motor real: cambio de moneda de reporte,
  portafolio vacío, rendimiento con 2.500+ movimientos.
- `src/__tests__/txValidation.test.ts` — validación del formulario de movimientos.
- `src/__tests__/Money.test.tsx` — componentes reaccionan a moneda/idioma/modo privado (jsdom).
- `src/__tests__/r2-logic.test.ts` — ronda 2: cierres pendientes, rebalanceo, cifrado del respaldo,
  regla única de anualización, colores del mapa de calor, columnas, nombres de bolsa, TRM/PTAX,
  eventos corporativos → movimientos, paridad de claves i18n es/pt/en.
- `src/__tests__/picker.test.tsx` — el buscador nunca crea un activo manual «fantasma» (W1).
- `e2e/smoke.spec.ts` — Playwright: resumen con datos de ejemplo, cambio de moneda, página mensual,
  agregar un movimiento, validación, capturas de escritorio/teléfono/oscuro, sin scroll horizontal.
- `e2e/regression-r1.spec.ts` — regresiones de la revisión ronda 1 (escenarios y CSV del revisor):
  un caso por brecha W1–W20, incluido `big.csv` (3.000 movimientos).
- `e2e/live.spec.ts` — actualización real desde el servidor de precios (si está corriendo).

- `src/__tests__/ibkrSync.test.ts` — sincronización IBKR Flex con `fetch` simulado: conectar, errores
  503/401/IBKR/red, sincronizar, bandeja diaria con deduplicación y confirmación por `ids`, desconectar,
  y el token de API nunca va a un respaldo.
- `e2e/regression-r2.spec.ts` — revisión ronda 2: W21 (la compra del asistente va al portafolio creado,
  también con enlace directo en frío) y W22 (aporte con fecha y aviso de aporte implícito).
- `e2e/ibkr-sync.spec.ts` — conectar IBKR contra un servidor simulado, error 503, bandeja → vista previa →
  confirmar → `DELETE` con `ids`.

- `src/__tests__/importers-r4.test.ts` — importación de un correo `.eml` con adjunto y sugerencias para
  nombres de notas y clases de BDR.

- `src/__tests__/share.test.ts` — enlaces de solo lectura: compresión en el fragmento, cifrado con
  contraseña, enlaces dañados y limpieza de HTML.
- `e2e/taxes.spec.ts` — paquete de Colombia (Formulario 210, XLSX) y de Brasil (Bens e Direitos, exportes).

- `src/__tests__/r3.test.ts` — ronda 3: aislamiento de los datos del ejemplo (W31), índices y tasas por
  moneda (W32), cuentas del mismo corredor (W33), idioma del navegador (W35), mensajes de impuestos (W36).
- `e2e/pdf-import.spec.ts` — importación de PDF (SINACOR, Trii) y de `.eml` en la app compilada
  (`vite preview`), con el worker de pdf.js de producción (W30).
- `e2e/regression-r3.spec.ts` — W31 (al salir del ejemplo se borran sus series) y W35 (navegador pt-BR).

Totales: 73 pruebas unitarias (12 archivos) y 36 pruebas e2e (+1 en vivo que se omite sin servidor).
Todas las e2e corren contra el build de producción (`vite preview`).

Capturas en `e2e/screenshots/`.

## Pendiente / limitaciones conocidas

- La sincronización entre dispositivos es solo por respaldo cifrado (AES-GCM + PBKDF2) y por el
  informe HTML autocontenido; no hay servidor de sincronización.
- No hay conexión automática con corredores ni con B3/CEI; los movimientos entran a mano, por CSV/XLSX
  o por PDF (notas SINACOR, extractos colombianos, CDT).
- La serie IBR de los datos de ejemplo termina en septiembre; «% del IBR» se calcula con los meses
  cubiertos y la interfaz muestra «datos hasta …».
- La TWR del mes en curso queda en 0 % hasta que haya precios del mes (los datos de ejemplo terminan
  el 30-sep-2026).
- Metas usa `goalProjection` con el valor del análisis; `goalProjectionForPortfolio` (que necesita el
  `EngineInput` del worker) queda para la próxima ronda.

## Respuesta a la revisión ronda 1

Revisión: `reviews/web-r1.md`. Cada brecha tiene su prueba en `e2e/regression-r1.spec.ts` o en
`src/__tests__/r2-logic.test.ts`.

| Brecha | Arreglo |
|---|---|
| W1 (alta) | El buscador no ofrece «crear» mientras carga; Enter rápido espera los resultados y elige la coincidencia exacta. Crear activo manual es un flujo explícito (editor con divisa, país, clase, bolsa y aviso si ya existe uno cotizado). |
| W2 (alta) | Hoja de impresión (A4 horizontal, colores exactos, sin menús) y página **Informe** (`/informe`): portada, KPIs, gráfico, mapa de calor, tabla mensual completa, distribución, posiciones, dividendos, efecto divisa y metodología. Se imprime a PDF o se descarga como HTML autocontenido. |
| W3 (alta) | Tabla mensual con selector de columnas (Esencial / Completa / a medida), columna del mes fija, modo compacto, Nominal/Real y tarjetas en el teléfono. La vista esencial (efecto precio, efecto divisa, índice y diferencia) cabe a 1440 px sin scroll. |
| W4 (alta) | Rentabilidad real (IPC/IPCA/CPI/HICP) y «% del CDI/IBR» en Resumen, Rendimiento y Mensual. Formulario de CDT/CDB con causación (fija o indexada, % del índice, spread, base de días, vencimiento). Rendimiento por posición, bandeja de eventos corporativos (`applyCorporateActions`) y Metas. |
| W5 | El cierre de mes detecta **todos** los fin de mes faltantes de cada activo manual, empieza por el más antiguo y avanza al siguiente al confirmar. Resumen avisa de los cierres pendientes. |
| W6 | Precio sugerido (cierre del día, se descarga si falta) con aviso si difiere >5 %; cambio de divisa comparado con la TRM/PTAX del día; «Agregar y nuevo», duplicar movimiento y atajo `N`. |
| W7 | El menú móvil es un diálogo modal: foco atrapado, Escape cierra y el foco vuelve al botón. |
| W8 | Dividendos: año corrido contra el mismo periodo del año anterior, además del año completo. |
| W9 | Una sola regla de anualización: nada se anualiza por debajo de un año (TWR, TIR, índices). |
| W10 | Respaldo cifrado con contraseña e informe HTML autocontenido para compartir. |
| W11 | Alertas (precio sobre/bajo, movimiento diario, cierre de mes, dividendo) con notificaciones, lista de seguimiento, objetivos de distribución con rebalanceo (por operación o con aporte nuevo), metas con simulador «¿y si…?». |
| W12 | Calendario de dividendos: eventos anunciados por el proveedor (chip «anunciado») más estimados por historial, con retención estimada. |
| W13 | Asistente de inicio en 3 pasos, lista «Primeros pasos», datos de ejemplo congelados (no se actualizan) y etiqueta «desde el cierre del …» en vez de «hoy». |
| W14 | Divisas: KPIs en dinero, composición multiplicativa precio × divisa y cascada. |
| W15 | Importación: nombres enriquecidos (catálogo y servidor), columnas de comisiones y retención, formatos por confirmar con muestras, posibles duplicados con casillas, eventos corporativos y cambios de activos como asistente, PDF (SINACOR, extractos colombianos, CDT) con mapeo de títulos, perfiles de corredor (`listBrokerProfiles`). |
| W16 | Nombres de bolsa legibles (BVC, B3, NASDAQ…) en vez de códigos MIC. |
| W17 | «Borrar todo» no vuelve a sembrar el ejemplo; el estado del servidor de precios se guarda y se restaura. |
| W18 | Encabezado compacto en el teléfono (tema dentro del menú). |
| W19 | Cada gráfico tiene resumen accesible y tabla «Ver datos». |
| W20 | Bundle principal de ~990 kB a ~193 kB (gráficos, PDF e importadores bajo demanda); PWA con manifiesto y service worker. |

**Integración con el motor (core rondas 2–4).** El worker crea un solo `createEngine(input)` por cambio
de datos y llama a sus métodos. Se usan: `positionPerformance`, `realTwr` / `percentOfIndex` con
`indexSeries`, `ledgerDiagnostics` (panel en Movimientos, incluidos `TRADE_PRICE_OUTLIER`,
`TRADE_PRICE_UNCONFIRMED`, `LATE_REDEMPTION`, `INTEREST_ALREADY_RECORDED` y `COUPON_EXCEEDS_ACCRUAL`),
`applyCorporateActions`, `goalProjection`, el valor neto estimado de renta fija
(`netMarketValueBase` / `estimated`, en Posiciones) y la nota de inflación estimada
(`inflationEstimated` / `inflationThrough`, en Rendimiento).

**Otros arreglos de esta ronda.** El cambio de moneda hecho antes de que carguen los ajustes ya no se
pierde; los diálogos no le quitan el foco a un campo en el que ya se escribe; el asistente de inicio
no se abre cuando una importación reemplaza el ejemplo.

## Respuesta a la revisión ronda 2

Revisión: `reviews/web-r2.md`. Pruebas en `e2e/regression-r2.spec.ts`, `e2e/regression-r1.spec.ts` (W23)
y `src/__tests__/`.

| Brecha | Arreglo |
|---|---|
| W21 (alta) | El formulario ya no fija el portafolio al abrir: sigue el predeterminado hasta que el usuario elige, y se recalcula cuando carga la lista (enlace directo en frío). Nunca crea un portafolio nuevo si existe uno real y el usuario no eligió «Nuevo portafolio». |
| W22 (alta) | El asistente pide la fecha del aporte inicial («¿Desde cuándo inviertes?»). Las compras sin efectivo previo aparecen en Diagnóstico como «Compra sin aporte previo» con el monto y un botón «Crear aporte en esa fecha», y la tabla mensual marca esos meses con «Aporte implícito». |
| W23 | Barras de distribución del Informe con relleno visible (pantalla, PDF y HTML); los rótulos del eje no se cortan. |
| W24 | Los diagnósticos se muestran con plantillas por código en es/pt/en: símbolo en vez de id interno y montos con formato local. El mensaje técnico del motor queda en el tooltip. |
| W25 | Precio o cantidad vacíos dicen «Campo obligatorio»; un valor negativo, «No puede ser negativo». |
| W26 | El cambio del día compara los dos últimos cierres de mercado (sin activos manuales ni de causación). «Mayores movimientos» excluye activos manuales y muestra la fecha de cada fila cuando difieren. |
| W27 | Un índice que falla aparece con su nombre («Índice IBR») y el impacto (rentabilidad real y «% del índice»). |
| W28 | El aviso del servidor distingue origen rechazado (403 `FORBIDDEN_ORIGIN`, con el valor para `CORS_ORIGIN`), límite de solicitudes (429), token faltante (401) y otros códigos HTTP. La actualización automática cuenta también los intentos fallidos y espera tras un 429. |
| W29 | Sharpe y Sortino usan por defecto la tasa de referencia de la moneda (IBR para COP, CDI para BRL, realizada en los últimos 12 meses); se puede desactivar en Ajustes. Rendimiento muestra la tasa usada. |
| W12 | «Próximos dividendos» proyecta un año adelante los dividendos del proveedor del último año (AAPL, PETR4…), además de los anunciados y del historial propio. |
| W20 | ECharts vive en su propio módulo (`EChartsView`), solo con los tipos usados (línea, barras, torta), y se pide cuando el navegador queda libre después de pintar las cifras. Medido en el Resumen: JS antes de ver los KPI, de 1.248 kB a 692 kB; total, de 1.354 kB a 1.260 kB (ECharts, de 674 kB a 568 kB). Portugués e inglés se cargan solo al elegirlos. Íconos PNG 192/512 y `apple-touch-icon`. Prueba e2e de regresión. |
| W10 | En el Informe, «Enlace de solo lectura»: el informe va comprimido dentro del fragmento de la URL (`/compartido#p1.…`, unos 6 kB). El navegador no envía esa parte al servidor y no hace falta una cuenta. Con contraseña opcional, el enlace va cifrado con AES-GCM (`#e1.…`). Quien lo abre ve el informe en un iframe aislado sin scripts, sin tocar sus propios datos, y puede imprimirlo o descargar el HTML. |

**Interactive Brokers (Flex).** En Importar, «Conectar Interactive Brokers» guarda el token Flex y el id de
la consulta en el servidor (`POST /api/sync/ibkr-flex`, `action: save`). El token no queda en el navegador.
«Sincronizar ahora» pasa por la misma vista previa, deduplicación y confirmación que un archivo. La bandeja
de la sincronización diaria se revisa al abrir la app (insignia en «Importar») y se confirma por `ids`.
Errores claros para 503 (sin `SYNC_SECRET`), 401 (falta el token de API, que se configura en Ajustes y no
entra en los respaldos) y errores de IBKR.

**Otros cambios.**
- Core ronda 5: etiquetas de los nuevos diagnósticos y aviso «Precio por confirmar / atípico» en el mes y en
  el resumen de Rendimiento, con «Confirmar precio» (`priceConfirmed`). Al editar un movimiento se conservan
  `importHash` y `priceConfirmed` (si el precio no cambia).
- Datos de mercado ronda 5:
  - el punto `carried` queda en su fecha real y no pisa un cierre existente;
  - las series `partial` muestran «Datos parciales» en el activo y en «Frescura de datos»;
  - el buscador muestra la bolsa como etiqueta visible.
- Core ronda 6:
  - etiquetas y textos de `TRADE_PRICE_CONFIRMED_BY_RUN`, `INTEREST_POSSIBLY_NET` (con el botón «Marcar como
    neto») e `INTEREST_BELOW_ACCRUED`;
  - casilla «Monto neto de retención» (`amountIsNet`) en intereses y cupones;
  - retención «estimada» (`taxesEstimated`) en Dividendos.
- Importadores ronda 4:
  - propuestas de escisión o fusión con «Aceptar» en un clic (`acceptCorporateActions`, y la fracción del
    costo si falta);
  - sugerencias ordenadas para nombres de notas desconocidos y para la clase de un BDR (GOGL34 o GOGL35);
  - la bandeja de IBKR pasa por `importTransactionBatch`, que filtra los duplicados de operaciones existentes;
  - importación de correos `.eml` arrastrados (todos los adjuntos en una sola vista previa).
- Impuestos ronda 8:
  - la tabla mensual de Brasil muestra el estado de cada DARF (pagada, pagada con atraso, vencida,
    pendiente), con multa y Selic;
  - botón «Registrar pago», que crea el movimiento `TAX` con la nota `DARF <código> <mes>`.
  - La web no muestra Bens e Direitos ni el informe de cripto, así que `costStatus` y `transitResolution`
    quedan para cuando se agreguen.
- Área de impuestos completa:
  - **Brasil:** con `brazilTaxPack` se muestran la apuración mensual con estados de DARF, Bens e Direitos
    (insignias de costo provisorio o pendiente, «en tránsito» y la decisión `alienado` / `mantido` para
    `CRYPTO_TRANSIT_STALE`), cripto, exterior, renda fixa, come-cotas e IRPFM.
  - **Colombia:** con `colombiaTaxPack` se muestran patrimonio, ganancia ocasional, dividendos y los
    formularios 210 y 160.
  - En los dos países: todas las secciones del documento del paquete y exportación XLSX, CSV por informe e
    impresión a PDF.

## Respuesta a la revisión ronda 3

Revisión: `reviews/web-r3.md`.

| Brecha | Arreglo |
|---|---|
| W30 (alta) | El worker de pdf.js (`pdfjs-dist/legacy/build/pdf.worker.min.mjs?url`) se emite como recurso del build y se registra antes de leer un PDF o el PDF de un `.eml`. Un error de lectura ya no sugiere una contraseña (eso llega aparte, como `needsPassword`). E2E sobre `vite preview` con `nota-sinacor.pdf`, `extracto-trii.pdf` y un `.eml` con la nota adjunta. |
| W31 (alta) | Al salir del ejemplo se borran sus series de precios, tasas e índices. Si un portafolio real se ve sin el ejemplo, la app ignora toda serie de ejemplo. En la vista «Todos» con el ejemplo conservado, los activos reales que solo tienen precio de ejemplo se marcan en Avisos y en el Informe. Después de importar, o al registrar un activo sin precios reales, la actualización se dispara de inmediato (sin esperar los 5 minutos). |
| W32 | Índice y tasa de referencia según la moneda: BRL usa Ibovespa, CDI/Selic e IPCA; COP usa COLCAP, IBR e IPC. Nunca se cae al IBR. Si falta la serie, se dice «CDI no disponible», y el Informe ya no muestra «Real (vs —)». |
| W33 | Al importar, la cuenta de un corredor ya existente («XP INVESTIMENTOS CCTVM S/A» frente a «XP») se une a la del portafolio (`sameBroker`); los corredores conocidos usan su nombre canónico (`normalizeBrokerName`). Si una compra quedó sin aporte y el aporte está en otra cuenta del mismo portafolio, Diagnóstico ofrece «Usar la cuenta «XP»» en vez de crear un aporte. |
| W34 | «Registrar pago» abre un diálogo con fecha y monto (prellenados con el principal más la multa y la Selic). «DARF a pagar» solo suma las DARF pendientes y vencidas. |
| W35 | En el primer uso, el idioma sigue al navegador (pt-BR → portugués). |
| W36 | Los avisos de impuestos ya no muestran nombres internos de opciones (`config.meta`, `creditEstimatedIrrf`, `foreignCashCountry`…). |
| W37 | Al imprimir, la fila Total sale una sola vez, al final de la tabla. |
| W38 | Un 403 de IBKR explica que el servidor necesita `API_TOKEN` (o `ALLOW_LOCAL_ADMIN=1` en local) y `SYNC_SECRET`. La tarjeta trae los pasos y el comando para configurar el servidor. |
| W39 | «Crear aporte en esa fecha» registra un aporte en la moneda base del portafolio más el cambio a la moneda de la compra, con la tasa del día (por ejemplo, COP → USD con la TRM). Si no hay tasa, el aporte queda en la moneda de la compra. |
| W20, W10 | Hechos después de la revisión: ver la ronda 2 (ECharts diferido y enlace de solo lectura). |

