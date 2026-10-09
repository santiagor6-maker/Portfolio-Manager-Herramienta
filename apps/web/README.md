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

Totales: 54 pruebas unitarias (8 archivos) y 23 pruebas e2e (+1 en vivo que se omite sin servidor).

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
