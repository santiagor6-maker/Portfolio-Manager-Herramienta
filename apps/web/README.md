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

- `src/__tests__/r4.test.ts` — `series.seed` (M37), pedido por id y rechazo de respuestas de otro activo o
  moneda, factor de unidad y split sugerido (core R7).
- `e2e/regression-r4.spec.ts` — W33 (cuenta «XP» frente a «XP INVESTIMENTOS CCTVM S/A»), W34 (DARF con
  fecha y monto; la KPI excluye las pagadas, con `e2e/fixtures/br-darf.csv`), W37 (Total impreso una
  vez), W38 (403 de IBKR explicado), W39 (aporte en BRL + cambio a USD) y las notas en revisión de los
  importadores R5.

- `src/__tests__/emailInbox.test.ts` y `e2e/email-inbox.spec.ts` — buzón de correo: borradores, vista
  previa con deduplicación, confirmación por `ids` y mensajes para 401/403/503.

- `src/__tests__/r5.test.ts` y `src/__tests__/r5-design.test.ts` — ronda 5 (W40–W48, W43) y diseño
  (colores por entidad, marcas redondas, mes en curso, escala del mapa de calor, importes sin símbolo).
- `e2e/regression-r5.spec.ts` — W40 con el servidor simulado (par USD/BRL que llega tarde o nunca),
  W46 (enlace `e2` y cambio de `#` sin recargar), W47 (tabla del informe sin desbordar), W48 (marcas en
  el informe y en el enlace), D1 (KPI sin cortar a 1280 px) y D3 (encabezado fijo en Mensual).

- `src/__tests__/r6.test.ts` — ronda 6: cobertura de precios (W49), textos fiscales y de importación
  (W45/W53), notas de eventos corporativos, ejes de tiempo y de importes, decimales de precio (D16).
- `e2e/regression-r5.spec.ts` (ronda 6) — D1 contando las líneas reales de cada KPI a 1280/1366/1440/390 px
  en es y pt con COP/BRL/USD, W49 (actualización interrumpida → aviso y reintento al abrir), W50 (`/mensual`
  en frío con BRL → Ibovespa), W51 (tablas que caben a 1280/1440 px en es-COP y pt-BRL, columnas ocultas
  con aviso) y W54 (teléfono).

Totales: 115 pruebas unitarias (17 archivos) y 54 pruebas e2e (+1 en vivo que se omite sin servidor).
Todas las e2e corren contra el build de producción (`vite preview`).

Capturas en `e2e/screenshots/`.

## Pendiente / limitaciones conocidas

- La sincronización entre dispositivos es solo por respaldo cifrado (AES-GCM + PBKDF2) y por el
  informe HTML autocontenido; no hay servidor de sincronización.
- No hay conexión automática con corredores ni con B3/CEI; los movimientos entran a mano, por CSV/XLSX
  o por PDF (notas SINACOR, extractos colombianos, CDT).
- La serie IBR de los datos de ejemplo termina en septiembre; «% del IBR» se calcula con los meses
  cubiertos y la interfaz muestra «datos hasta …».
- Mientras el mes en curso no tiene precios, el Resumen muestra el último mes cerrado y Mensual marca
  el mes «en curso» (D4); el motor sigue devolviendo 0 % para ese mes.
- W42: el paquete de impuestos (congelado) solo lee movimientos; un CDT vencido sin redención
  registrada se avisa en Impuestos con un botón para registrarla. Los intereses causados por cobrar al
  31-dic de un CDT vigente no entran al patrimonio fiscal.
- W40: la protección contra tasas faltantes está en la web (`services/fxCoverage.ts`); el motor sigue
  convirtiendo a 0 cuando falta una tasa (gap C8 de core).
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

### Integración posterior a la ronda 3 (paquetes)

- **Datos de mercado (M37):**
  - el último cierre antes de la ventana llega como `series.seed`; se guarda en su fecha y nunca pisa un
    cierre existente;
  - los precios se piden por id de instrumento (`XETR:DTE`);
  - se rechaza una respuesta de otro listado o de otra moneda (por ejemplo, DTE de NYSE en USD) y queda
    como fuente fallida.
- **Core R7:**
  - `TRADE_PRICE_UNIT_SUSPECT` con «Corregir a …» (divide por el factor sugerido) y «Confirmar precio»;
  - `POSSIBLE_UNRECORDED_SPLIT` con «Registrar split N:1», con la proporción tomada de los dos cierres;
  - `TRADE_PRICE_CONFIRMED_BY_RUN` ahora como aviso, con «Confirmar precio».
  - Los tres tienen etiquetas y textos en es/pt/en y salen como insignia en el mes y en el resumen.
- **Importadores R5:**
  - las notas en revisión (`noteChecks`) muestran las líneas sin leer, el líquido de la nota, lo
    calculado y la diferencia, con una sugerencia;
  - para cada nota: «Aceptar la nota» (`acceptNotes`), «Ingresar la operación a mano» u «Omitir»;
  - los avisos del archivo (`UNPARSED_LINE`, `SECURITY_ANSWER_CONFLICT`…) se muestran arriba de la
    vista previa;
  - la unión de cuentas usa `normalizeBrokerName` / `sameBroker` de `@pm/importers`.
- **Importar por correo** (servidor: `POST /api/inbox/email`, `GET/DELETE /api/inbox/email/drafts`):
  - en Importar se muestran la dirección de reenvío (`importar+<token>@…`, la define `INBOX_RECIPIENTS`)
    y los pasos para configurar el servidor, con el id del portafolio listo para copiar;
  - los borradores de correos reenviados pasan por `importTransactionBatch` (deduplicación) y la misma
    vista previa, y se confirman por `ids`;
  - el menú muestra una insignia de pendientes (se revisa al abrir la app una vez que el buzón se usó);
  - hay mensajes claros para 401/403/503.
- **Core R8:**
  - «Registrar split» usa los campos estructurados del diagnóstico (`data.splitRatio`, `dateTo`), sin
    leer el texto; el mensaje queda solo como respaldo;
  - también se cubre `POSSIBLE_REDENOMINATION`.
- **Core R8 (contrato):**
  - **Tickers renombrados:** se usa la misma tabla que el motor (`tickerRenames` de `@pm/core`).
    - Al crear activos y movimientos se guarda el id vigente (PFBCOLOM → PFCIBEST), salvo en las filas
      `TICKER_CHANGE`.
    - El buscador y el catálogo ofrecen el activo vigente con «antes PFBCOLOM».
    - Posiciones y la ficha del activo muestran «antes …», y un enlace con el id viejo abre el activo
      vigente.
    - `INSTRUMENT_RENAMED` y `RENAMED_TICKER_MIXED` ofrecen «Pasar los movimientos a PFCIBEST».
  - **Efectivo de fusión por cobrar:** la tabla de efectivo muestra la columna «Por cobrar»
    (`CashBalance.receivable`). Al aceptar una propuesta de fusión se puede fijar `cashPayDate`.
  - **Nuevos códigos:** `MERGER_CASH_PENDING`, `COST_FRACTION_ESTIMATED` (permite escribir la fracción
    oficial) y `CORPORATE_ACTION_WITHOUT_POSITION`, con textos en es/pt/en armados desde
    `Diagnostic.data`. Los códigos que traen `data` ya no se leen del mensaje.


## Respuesta a la revisión ronda 4 (`reviews/web-r4.md`) y a la revisión de diseño R1 (`reviews/web-design-r1.md`)

- **W40 (alta) — moneda de reporte sin tasa:**
  - al cambiar de moneda se pide en el acto `USD/<moneda>` (`refreshMarketData({ force: true, fx })`,
    sin el límite de 2–5 min) y, si el análisis aún reporta monedas sin ruta, también esas;
  - mientras tanto, «Convirtiendo a BRL…» y *skeletons* en todas las páginas (`useConversion`);
  - sin tasa: «—» en KPIs, tabla mensual, gráficos, informe y resumen personalizado, aviso con
    «Reintentar», sin diferencias contra índices (`fxMissing` + `blankUnconvertible`).
- **W41:** los Avisos del Resumen usan `describeIssue` (OVERSELL y demás códigos de validación en es/pt/en).
- **W42:** CDT vencido sin redención → aviso en Impuestos con «Registrar redención estimada» (interés
  bruto con su retención + venta del capital al vencimiento, desde la estimación del motor).
- **W43:** nombres de notas («SID NACIONAL ON») reemplazados por el catálogo (al importar y una vez al
  abrir), más emisoras B3 en el catálogo y tabla de CNPJ (`lib/b3Cnpj.ts`) pasada como `cnpjByIssuer`.
- **W44:** el diálogo de DARF recalcula multa + Selic al cambiar la fecha (salvo monto editado) y muestra el desglose.
- **W45:** alertas fiscales sin duplicados, números y fechas en el formato del idioma, aviso de PTAX
  una sola vez («Entendido»).
- **W46:** HTML compactado, formato cifrado `e2` (sal|iv|cifrado en un solo base64url, ≈ +60
  caracteres sobre el enlace sin contraseña; `e1` sigue abriendo) y la vista compartida reacciona a `hashchange`.
- **W47/D25:** la tabla mensual del informe dice la moneda una vez (sin símbolo por celda), encabezados
  que se parten y contenedor con desplazamiento propio.
- **W48:** † precio atípico y ‡ aporte implícito en el informe y en el enlace, con leyenda.
- **W20:** el motor ya no está en el primer pintado (semilla del ejemplo y cálculo de respaldo
  diferidos, tabla de renombres sin el índice de `@pm/core`). Medición del revisor R5: 559 kB antes de los
  KPIs en visitas siguientes; la primera visita (que siembra el ejemplo y arranca el worker) llega a 800 kB.
- **Diseño:** D1 cifras sin «…», D2 `--muted` AA, D3 encabezados y totales fijos, D4 último mes
  cerrado, D5 sin áreas sobre ejes que no empiezan en 0, D6 colores por entidad, D7–D9 tablas que
  caben, D10 mapa de calor (tokens, 45 % en oscuro, opción azul/naranja en Ajustes, escala anual
  ±24 %), D11 series 3–5 más oscuras (validador de paleta: todo PASS), D12 TWR única en Divisas, D13
  KPI principal, D14 colores de estado solo para resultados, D15–D24 detalles de formato, leyendas,
  etiquetas, banderas como código de país, totales y textos.

## Respuesta a la revisión ronda 5 (`reviews/web-r5.md`)

- **D1 (alta):** la cifra de cada KPI va en una sola línea (`white-space: nowrap`) y su fuente se ajusta
  al ancho de la tarjeta (`FitValue`, mínimo 12 px); si aun así no cabe, se muestra en notación compacta
  con la cifra completa en el *tooltip*. En el teléfono cada KPI ocupa su fila. La e2e cuenta las líneas
  reales del texto (`getClientRects`).
- **W49:** la actualización de precios deja una marca (`refreshPending`) que solo sobrevive si la recarga
  la interrumpe; al abrir se reintenta sin esperar el límite, y cada 10 min con la pestaña visible. Avisos
  muestra «N activos sin cotización de mercado desde …· Actualizar». Los meses sin ningún cierre se marcan
  «sin precio» en Mensual y no cuentan en el KPI ni en las barras de 12 meses.
- **W50:** Mensual solo guarda como estado la elección explícita del índice; si no, sigue a la moneda.
- **W51:** columnas por prioridad (`components/fitColumns.tsx`): cuando la tabla no cabe, se ocultan las
  menos importantes con una nota «Columnas ocultas por falta de espacio · Mostrar todas»; al imprimir
  se ven todas. Importes de Mensual sin símbolo (la moneda va en el subtítulo).
- **W52:** «Rentabilidad acumulada» muestra por defecto portafolio + índice de la moneda + tasa + inflación,
  con etiquetas al final de cada línea y *chips* para añadir los demás; cada índice conserva su color y
  los colores se asignan evitando los pares que fallan `validate_palette.js --pairs all`.
- **W53:** meses de los ejes en el idioma, notas de eventos corporativos y razones (×1,03) traducidas,
  números y fechas de los avisos de importación en el formato local, «(1 + 0,00 %)».
- **W54:** en el teléfono, «Primeros pasos» en una línea con el siguiente paso y el primer gráfico dentro
  de la primera pantalla.
- **Parciales:** D16 (decimales de precio por moneda, ejes sin etiquetas repetidas), D19 (etiquetas
  directas en «Rentabilidad acumulada»), D21 (leyenda del donut y símbolos), D22 (frescura en Ajustes y
  punto verde solo tras descargar), W45 (un aviso por año agrupado y sin nombres internos).

## Respuesta a la revisión ronda 6 (`reviews/web-r6.md`)

- **W55 (alta):** los eventos pendientes ya no quedan escondidos en Movimientos (`lib/pendingEvents.ts`,
  `usePendingEvents()`). Un split sin registrar de una posición abierta (del proveedor o inferido del
  historial con aviso confirmado) es un aviso rojo sobre los KPIs con «Registrar split» en un clic
  (`services/suggestions.ts`; el inferido solo en el portafolio del aviso, sin doble registro) y una
  *chip* «split pendiente» en Posiciones. Avisos cuenta los splits, la bandeja y los precios con posible
  error de unidad: nunca «Todo en orden» con eventos pendientes. Proventos y la tarjeta de dividendos
  listan los proventos anunciados con «Registrar todos».
- **W56:** las columnas que se ocultan por espacio siguen una prioridad por página; primero las que son
  todo cero o copia de otra (`lib/columnStats.ts`). Cantidad, aportes y dividendos nunca se ocultan.
- **W57/W58:** la cifra del KPI nunca baja de 16 px (20 px la principal); por debajo pasa a notación
  compacta, medida sobre copias ocultas, así que se recalcula en cada ajuste (redimensionar o captura de
  página completa no la dejan «pegada»). Las tarjetas de una fila comparten el tamaño. En español la
  notación compacta usa «M» y «mil» («$ 8.568 M»), nunca «MRD».
- **W59:** sin desplazamiento horizontal en Divisas a 360 px (las *chips* de fuente se parten), en el mapa
  de calor con meses de tres cifras (tabla fija, sin decimal desde ±100 %) ni en la bandeja de eventos a
  1280 px (la nota va en su propia línea).
- **W60 (cierra W53):** «0,07.» al final de una frase, «à vista», «1 activo nuevo» (plurales), fechas ISO
  en nombres de activos (CDT «vence 09/01/2025») en el formato local, aviso de precios sin comandos de
  desarrollo (el comando queda en Ajustes) y sin restaurar «sin conexión» de la sesión anterior; los
  resúmenes de gráficos no anuncian fechas futuras.
- **W54:** en el teléfono, las tarjetas secundarias son de una fila (etiqueta a la izquierda, cifra a la
  derecha) y el área del primer gráfico empieza dentro de 390×844.
- **W20:** la primera visita carga solo el generador de datos de ejemplo del motor (no el motor entero) y
  arranca el *worker* mientras se abre la base: ~750 kB antes de los KPIs (antes ~830) y KPIs en ~600 ms.
- Pruebas: `src/__tests__/r7.test.ts` (unitarias) y `e2e/regression-r7.spec.ts` (NVDA 10:1, proventos de
  Brasil, columnas, tamaños de KPI, desbordes, textos). Totales: 130 unitarias y 60 e2e (1 omitida, la
  prueba en vivo contra el servidor real).

## Respuesta a la revisión ronda 7 (`reviews/web-r7.md`)

- **W61 (alta):** todas las escrituras de un clic son idempotentes (`lib/writeGuard.ts`).
  - Un candado por grupo de botones (`useGuardedAction`) ignora el segundo clic aunque llegue antes de que el botón se deshabilite.
  - `addTransactionsOnce` (`db/repo.ts`) comprueba si el evento ya existe y lo escribe dentro de una misma transacción de lectura y escritura. La clave es portafolio, tipo, instrumento y fecha; un split o un dividendo en acciones a ±7 días cuenta como el mismo evento, y en los movimientos de efectivo también cuentan importe, cuenta, subtipo y nota.
  - Se aplica a «Registrar split», «Crear aporte», «Corregir unidad», «Registrar todos», el aviso del Resumen, «Rescatar», el pago de DARF, el asistente, «Nuevo portafolio», la confirmación de la importación y las alertas.
  - Avisos marca un split grabado dos veces y ofrece «Eliminar duplicados».
- **W62 (alta):** `packages/market-data/src/corporate.ts` clasifica como SPLIT los factores 1:k y k:1 de cualquier tamaño y todo factor menor que 1 en B3 (AMER3 1:100, IRBR3 1:30, BHIA3 1:25, CMG 50:1).
  - En la web, los grupamentos que ya estaban en caché como «SPINOFF a revisar» se convierten en contrasplits.
  - Los eventos del proveedor que no se pueden clasificar, de posiciones abiertas, se muestran en el Resumen con «Revisar» e «Ignorar», cuentan en Avisos y la bandeja los describe en el idioma.
- **W63 (alta):** la tarjeta con la etiqueta a la izquierda y la cifra a la derecha solo se usa donde la tarjeta ocupa todo el ancho (`rowOnPhone`, en el Resumen).
  - El mínimo de 16 px (20 px la cifra principal) vale en todas las tarjetas. Si la cifra no cabe, pasa a notación compacta y, como último recurso, se muestra con elipsis y la cifra completa en el *tooltip*.
  - La e2e recorre seis páginas a 390 y 360 px.
- **W64:** los splits pendientes guardan la sugerencia de cada portafolio («en 2 portafolios»).
  - Desde «Todos», un split inferido se graba en todos los portafolios que tenían el activo antes de la fecha.
  - Lo ya registrado se oculta en cada vista de portafolio.
- **W65:** «+ Nuevo portafolio» en Importar pide nombre y moneda y crea el portafolio una sola vez, al confirmar.
- **W66:** Impuestos abre en la jurisdicción del portafolio: la residencia fiscal o, si no la hay, la de la moneda base (`lib/currencyDefaults.ts`). Las pestañas se traducen («Colômbia») y llevan las *chips* CO y BR.
- **W67:** el motor marca `TRADE_PRICE_UNIT_SUSPECT` con `data.unitFactor` y `data.accepted`, así que la web ya no lee el texto en inglés.
  - Un split que solo se deduce de los precios se muestra como «Posible split» y pide confirmación antes de grabarse.
  - La nota de columnas ocultas usa el nombre corto de la columna.
- **Pruebas:** `src/__tests__/r8.test.ts` (unitarias) y `e2e/regression-r8.spec.ts` (doble clic, AMER3, NVDA en dos portafolios, importar a un portafolio nuevo, KPIs en el teléfono, Impuestos).
  Totales: 146 pruebas unitarias de la web, 1.301 en el resto de paquetes (19 omitidas) y 66 e2e (1 omitida, la prueba en vivo).

## Respuesta a la revisión ronda 8 (`reviews/web-r8.md`)

- **W68 (alta):** «Todos» ya es la suma de los portafolios.
  - **Causa:** la vista consolidada pasa al motor los movimientos de todos los portafolios en un solo libro, y el motor aplicaba un split o una bonificação al libro entero del activo, una vez por cada portafolio que lo registraba. NVDA 10:1 en dos portafolios quedaba ×100.
  - **Corrección en `packages/core`:** una opción nueva y compatible, `isolatePortfolios`. Con ella, el motor guarda un libro de lotes por portafolio (`PortfolioBooks`) y la caja de cada portafolio, con sus cuentas y su caja sin asignar.
  - **Qué cambia:** un split, una bonificação, una venta FIFO o una reestructuración solo tocan los lotes de su portafolio. La caja de un portafolio ya no paga las compras de otro, y la conversión implícita usa la moneda de financiación de cada portafolio.
  - **Vencimientos:** la redención automática al vencimiento se hace por portafolio.
  - La valoración y las posiciones leen la suma.
  - **En la web:** `buildEngineInput` activa la opción en «Todos», y los *hashes* de importación van por portafolio, así que ya no aparece «Posible duplicado… ya se importó» entre portafolios.
  - **Impuestos:** el paquete de impuestos está congelado; para sus informes consolidados, `lib/consolidate.ts` une las copias de un mismo evento antes de pasarlas.
  - **Pruebas:** unitarias en el motor y en la web, y e2e con NVDA registrado desde «Todos» y desde cada portafolio, la bonificação de ITUB4 y el grupamento de AMER3 en dos portafolios. Comprueban que el valor de «Todos» es la suma de los dos.
- **W69:** dos eventos del mismo activo a menos de 7 días solo se consideran el mismo con la misma razón (1/3 y 0,3333 cuentan como la misma). Si se omite uno porque ya estaba registrado, se avisa.
- **W70:** si la razón es menor que 1, el texto usa la variante de contrasplit: «grupamento» en pt, «contrasplit» en es y «reverse split» en en. Se aplica al aviso del Resumen, a Avisos, a la *chip* de Posiciones y al Diagnóstico. Avisos presenta un split deducido de los precios como «posible».
- **Totales:** 155 pruebas unitarias en la web, 1.317 en el resto de paquetes (19 omitidas) y 69 e2e (1 omitida, la prueba en vivo).
