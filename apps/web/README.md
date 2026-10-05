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
- `e2e/smoke.spec.ts` — Playwright: resumen con datos de ejemplo, cambio de moneda, página mensual,
  agregar un movimiento, validación, capturas de escritorio/teléfono/oscuro, sin scroll horizontal.
- `e2e/live.spec.ts` — actualización real desde el servidor de precios (si está corriendo).

Capturas en `e2e/screenshots/`.

## Pendiente / limitaciones conocidas

- Las fechas de dividendos «próximos» son una estimación (mismo mes del año anterior); no hay aún un
  calendario de dividendos anunciados del proveedor.
- La TWR del mes en curso queda en 0 % hasta que haya precios del mes (los datos de ejemplo terminan
  el 30-sep-2026).
- El bundle principal pesa ~990 kB (ECharts); se podría dividir más.
- Si el motor agrega `indexSeries`, instrumentos con causación (CDT) o rendimiento por posición, se
  pueden mostrar en Posiciones / Rendimiento sin cambiar el resto de la app.
