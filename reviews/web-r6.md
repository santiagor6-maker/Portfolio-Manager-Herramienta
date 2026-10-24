# Revisión web — ronda 6 (`apps/web`)

- **Revisor:** «Revisor E» (independiente, solo lectura).
- **Fecha:** 24 de octubre de 2026.
- **Rama:** `claude/lucid-edison-hw6cla` (HEAD `4f1c47a`). Incluye `1bb70a6` y `4f1c47a` (razón de las bonificações de B3).
- **Referencias:**
  - `reviews/web-r5.md`: 7,9 frente a 8,0, una brecha alta (D1), medias W49–W51 y bajas W52–W54.
  - `reviews/web-design-r1.md`: línea base de diseño (D1–D25).
- **Skills aplicadas:**
  - `visualization-review`: reglas P0, P1 y P2.
  - `dataviz`: `validate_palette.js --pairs all` en claro y oscuro.
  - `dashboard-design`: jerarquía de KPIs y prueba de 5 segundos.
  - `table-design`: prioridad de columnas, alineación y si las tablas caben.
  - `run`: lanzar y manejar la app real.
- **Evidencia:** `RW6 = /tmp/claude-0/-home-user-Portfolio-Manager-Herramienta/8b757dea-bb3a-58bd-aa07-26758394d338/scratchpad/review-web6/`. Allí están:
  - los scripts `*.mjs`;
  - las capturas `shots/*.png`, el PDF del informe y los XLSX fiscales;
  - los registros `e2e.log`, `e2e2.log`, `unit.log`, `tsc.log`, `build.log`, `br1.log`, `br2.log`, `co1.log`, `co2.log`, `co3.log`, `taxbr.log` y `stale.log`;
  - los fixtures adversariales `fx/whale-co.csv`, `fx/whale-br.csv` y `fx/nvda-real.csv`.

## Veredicto

**No aprobado.**

**D1 está corregida de verdad.** Se probó con cifras de hasta 11 dígitos (COP 91.506.770.388, −$ 8.568.345.718):

- 7 anchos (1920, 1440, 1366, 1280, 1024, 390 y 360 px);
- es y pt;
- COP, BRL, USD y EUR;
- claro y oscuro;
- zoom del 125 %.

Ningún KPI se parte dentro del número ni se recorta. El caso exacto de R5 (pt, ejemplo, 1280 px) ahora se ve limpio: «+COP 704.126», «+COP 21.081.632», «+COP 85.032.008». W49, W50, W52, W45 y los parciales D16, D19, D21 y D22 también quedan cerrados.

Aparece, sin embargo, una **brecha alta nueva, W55**. Un inversionista que compró NVDA antes del split 10:1 de junio de 2024 ve en el Resumen:

- «Valor total USD 2.183.091» cuando vale ≈ USD 21 M;
- un precipicio del −85 % en el gráfico;
- **«Avisos: Todo en orden»**.

El split está detectado, pero solo en la bandeja de Movimientos y en una etiqueta de Rendimiento. Lo mismo pasa con 230 proventos anunciados: Proventos dice «Ainda não há proventos». La cifra principal queda falsa y el panel de avisos la avala. Es un fallo P0 de integridad.

También hay brechas medias nuevas:

- **W56:** la prioridad de columnas oculta «Cantidad», «Aportes» y «Dividendos» y deja columnas de ceros.
- **W57:** la cifra encaja, pero se encoge hasta 12,6 px, y la notación compacta en español mezcla «M» y «MRD».

| | Puntaje |
|---|---|
| **Portafolio Pro web (nuestro)** | **8,0 / 10** (R5 7,9) |
| **Sharesight (referencia, el mejor competidor)** | **8,0 / 10** |

**Cómo mejora la nota:**
- **≈ 8,3:** con W55 corregida (eventos pendientes en Avisos y splits aplicados o bloqueantes).
- **≈ 8,5:** con W56 y W57 también. Eso supera a Sharesight para el inversionista de Colombia y Brasil.

### Comparación con los competidores

Los puntajes de los competidores salen de documentación pública y conocimiento previo; no se verificaron en vivo.

| Competidor | Puntaje | Dónde nos ganan | Dónde les ganamos |
|---|---|---|---|
| **Sharesight** | 8,0 | Aplica splits y dividendos automáticamente desde el proveedor; sincronización con más de 200 corredores; acceso compartido con el asesor | Impuestos CO/BR (DARF con multa y Selic, Bens e Direitos, F-160/210), mapa mensual con efecto precio/divisa, notas SINACOR, local-first, sin conexión |
| **Kubera** | ≈7,5 | Patrimonio total con bancos y cripto; multi-dispositivo | TWR/TIR mensual, impuestos, efecto divisa, informe compartible cifrado |
| **Delta (eToro)** | ≈7,4 | App móvil pulida; sincronización de corredores y exchanges; splits y dividendos automáticos | Impuestos CO/BR, seguimiento mensual, análisis de divisa, privacidad local |
| **Snowball Analytics** | ≈7,2 | Analítica y calendario de dividendos que se registran solos; sincronización | Seguimiento mensual, impuestos, notas BR, efecto divisa |
| **Morningstar (Investor / Portfolio Manager)** | ≈7,1 | X-Ray de exposición, calificaciones y datos de fondos | Mercados CO/BR, impuestos locales, multi-divisa real, idiomas |
| **Ghostfolio** | ≈7,0 | Código abierto, autoalojable, multi-dispositivo | Impuestos, informe PDF/enlace, mapa mensual, efecto divisa |

## Cómo se probó

- **Verificaciones previas** (sobre `4f1c47a`):
  - `npx tsc --noEmit -p apps/web`: sin errores.
  - `npm test -w @pm/web`: **121/121** (18 archivos).
  - **E2E:** **54 aprobadas y 1 omitida** (`live`), dos veces: antes y después de `1bb70a6`/`4f1c47a`.
    - Se corrió una copia de `apps/web/e2e` en `RW6/e2erun` con Chromium `/opt/pw-browsers/chromium`, contra el build propio servido en :4311.
    - `git status` quedó limpio.
- **Build y servidores:**
  - `vite build` con configuración propia hacia `RW6/dist`, servido con `vite preview` en **:4310** (`/api` → :8910).
  - Servidor de datos en **:8910**: `CORS_ORIGIN=http://localhost:4310`, `RATE_LIMIT_PER_MIN=0`, `SNAPSHOT_EXCHANGES=none`, caché en frío.
  - Datos reales de Yahoo, TRM, IBR, IPC y UVR. BCB, IBGE, FRED y BCE no responden desde este contenedor, así que aparece «CDI não disponível».
  - Los dos servidores se detuvieron al terminar.
- **D1, de forma adversarial** (`kpiscan.mjs`, `sticky-compact.mjs`, `resize.mjs`, `slownav.mjs`, `stale-title.mjs`, `printtest.mjs`):
  - **Portafolios «ballena»:**
    - COP 9.876.543.210 de aporte más ECOPETROL, PFCIBEST y NVDA, que da $ 82.365.239.020 con «Este mes» −$ 8.568.345.718;
    - BRL 98.765.432,10 más VALE3, PETR4 y MGLU3, que da R$ 143.852.932,10, o COP 91.506.770.388 visto en COP.
  - **Matriz:** es y pt × COP, BRL, USD y EUR × 1920, 1440, 1366, 1280, 1024, 390 y 360 px × claro y oscuro × zoom 125 % (ventanas de 1280, 1366, 1440 y 1920).
  - **Páginas:** Resumen, Mensual, Rendimiento, Divisas, Impuestos y Metas.
  - **Qué se midió:** líneas reales con `getClientRects`, recorte (`scrollWidth`), tamaño de letra calculado y estado compacto.
  - **Transiciones:** cambio de moneda, navegación SPA, carga lenta de un chunk, captura de página completa, impresión a PDF y menú del teléfono.
- **Brasileño** (perfil `br`, navegador pt-BR):
  - asistente en BRL y aporte de R$ 100.000;
  - importación de `b3-negociacao.xlsx`, `nota-sinacor.pdf` (nota 99887766 en revisión, −10,00) y `nota-xp-2024-03-08.pdf` (16 operaciones, day trade y EMBR3→EMBJ3, CCRO3→MOTV3, TRPL4→ISAE4);
  - Resumen y Mensual en BRL, EUR, COP y USD;
  - Impostos 2024, 2023 y 2026: DARF vencida, diálogo con cambio de fecha y pago, Bens e Direitos y XLSX;
  - bandeja de eventos corporativos con bonificações tras `1bb70a6`.
- **Colombiano** (perfil `co`, es):
  - asistente en COP y aporte de $ 30 M;
  - importación de `extracto-trii.pdf`, `cdt-bancolombia.pdf` y `extracto-trii.csv`;
  - Mensual en COP, BRL y USD;
  - **MXN con la tasa bloqueada** (`nofx.mjs`);
  - Impuestos 2025 y 2024 con «Registrar redención estimada»;
  - Informe en pantalla y en PDF;
  - enlace sin y con contraseña, contraseña errónea, `hashchange` y enlace alterado.
- **Otros:**
  - **Split realista:** 10.000 NVDA a USD 142,65 el 05-01-2023 (`split.mjs`, `split2.mjs`).
  - **Recarga a mitad de actualización** (`stale.mjs`, W49).
  - **`/mensual` en frío con BRL** (`bench.mjs`, W50).
  - **Columnas ocultas y desplazamiento** a 1440 y 1280 px (`hidden.mjs`, `overflow.mjs`, `sweep.mjs`).
  - **Teléfono a 390 px**, claro y oscuro, en 13 páginas (`phone.mjs`), y **360 px** en 8 páginas.
  - **PWA sin conexión** (`offline.mjs`).
  - **Primer render** (`first2.mjs`).
  - **Paleta:** `validate_palette.js --pairs all` sobre las combinaciones por defecto de «Rentabilidad acumulada».
  - **Escaneo de textos** en es y pt (`texts6.mjs`).
  - Se revisaron a ojo las capturas, sobre todo:
    - `v-demo-pt-pt-BR-1280_.png`, `kpi-whale-br-pt-BR-COP-dark-1280_.png`, `kpi-whale-co-es-CO---light-1280_.png`;
    - `whale-co-dash-1440.png`, `br-dash-BRL.png`, `nvda-dash.png`, `hid-br-1440-pos.png`, `inbox-br-1280.png`;
    - `v-co-es-CO-1440_rendimiento.png`, `m-co-dark-dash.png` y `dash-print-br-1.png`.

## Estado de las brechas anteriores

### Funcionales (W)

| ID | Estado | Evidencia |
|---|---|---|
| **W49** (media) | **Cerrada** | `stale.mjs`: la recarga a 1,5 s de importar dispara un nuevo `/api/batch` a los 0,3 s del arranque, y a los 60 s hay precios del 23/10/2026. Resumen: «R$ 66.906,31», «No mês +5,34 %». Los meses sin cierre se marcan «sin precio». |
| **W50** (media) | **Cerrada** | `/mensual` en frío y navegando: Ibovespa. Al pasar a USD, S&P 500. En el Colombiano, BRL → Ibovespa y USD → S&P 500. |
| **W51** (media) | **Cerrada en lo que pedía** (sin barra horizontal) | A 1280 y 1440 px, Posiciones, Mensual, Movimientos, Dividendos y «Por periodo» caben, con la nota «Columnas ocultas… Mostrar todas». **Pero** la prioridad elegida oculta columnas esenciales (ver W56) y la bandeja de eventos sí se desborda (W59). |
| **W52** (baja) | **Cerrada** | Por defecto: Portafolio, índice de la moneda, tasa e inflación, con *chips* para añadir Ibovespa, S&P y MSCI y etiquetas al final de cada línea. Las combinaciones COP (`#2a78d6/#eb6834/#0e9384`) y BRL (`#2a78d6/#c2457a/#9a6b00`) dan **ALL CHECKS PASS** con `--pairs all`, en claro y en oscuro. La inflación va punteada en gris, con etiqueta. |
| **W53** (baja) | **Parcial (baja → W60)** | Corregido: meses de los ejes en el idioma, notas de bonificação en pt («Bonificação de 33,33% em ações…»; GOAU4 ya coincide con +33,33 % tras `1bb70a6`), «−2.010,60 / −2.000,60», «(1 + 0,00%)». Queda «…não atribuídos ao à vista: **0.07.**» en la vista previa de SINACOR. |
| **W54** (baja) | **Parcial (baja)** | «Primeros pasos» ya ocupa una línea. Pero los 3 KPIs secundarios van ahora uno por fila (commit `7183768`), así que el primer gráfico empieza en y = 782–788 de 844: se ve el título y la leyenda, no el trazo. |
| W45 | **Cerrada** | Una línea por grupo («Alguns parâmetros de 2023, 2024, 2025, 2026…») y «veja a seção GCAP 4600» en lugar de `gcapPre2024`. |
| W20 | **Parcial (baja)** | Primera visita: 811 kB de JS/CSS antes de los KPIs (en R5 eran 800) y KPIs a los 740 ms. |
| W10 | **Abierta (baja)** | Sigue sin haber sincronización entre dispositivos ni con corredores o B3. |

### Diseño (D)

| ID | Estado | Evidencia |
|---|---|---|
| **D1** (alta) | **Cerrada** | `FitValue` (`ui.tsx:196`) con `nowrap` y ajuste al ancho. En toda la matriz, 0 KPIs con más de una línea y 0 recortados. Ver la línea 1 de la tabla siguiente. Quedan efectos secundarios: tamaños mínimos y notación compacta (W57) y compacto «pegajoso» (W58). |
| D9 | **Cerrada** | Movimientos cabe a 1440 px en es y a 1280 px oculta solo «Cuenta / corredor», con nota. |
| D16 | **Cerrada** | Decimales de precio por moneda y ejes sin etiquetas repetidas. Quedan fechas ISO dentro del nombre de un CDT (W60). |
| D19 | **Cerrada** | Etiquetas directas al final de cada línea en «Rentabilidad acumulada». |
| D21 | **Cerrada** | La leyenda del donut cabe a 1280 px en pt con el ejemplo (Colômbia 38,8 %… Zona do euro 1,9 %), sin desplazamiento de la página. En Dividendos a 1440 px no se corta ningún símbolo. |
| D22 | **Cerrada** | La frescura de datos pasó a Ajustes. El ejemplo muestra un punto gris con «Não atualizado». Ver W60 sobre un error de un solo par que se presenta como «servidor no disponible». |

**Detalle D1** (mismo portafolio, `kpiscan.mjs`):

| Caso | 1440 | 1366 | 1280 | 1024 | 390 / 360 |
|---|---|---|---|---|---|
| pt demo en COP (caso de R5) | 1 línea | 1 línea | **1 línea** (antes «+COP 21.081.⏎632») | 1 línea | 1 línea |
| es, ballena COP | 1 línea; 32 / 19,8 / 21,1 / 17,6 px | 1 línea | 1 línea; 30,7 / 16,2 / 17,4 / 14,5 px | 1 línea; 18 px | 1 línea; 24 / 18 px |
| pt, ballena en COP | 1 línea; 15,2 px | 1 línea; 14 px | 1 línea; **12,6 px** (W57) | 1 línea | 1 línea |
| pt, ballena BRL | 1 línea; 17,5 px | 1 línea | 1 línea; 14,4 px | 1 línea | 1 línea |
| es y pt con zoom 125 % | 1 línea; 18 px | 1 línea | 1 línea | — | — |
| Oscuro | igual que en claro | | | | |

## Mejor que la competencia

1. **Cifras principales robustas en cualquier ancho:** una sola línea, sin «…» ni saltos, con valores de 11 dígitos, en 4 monedas, 2 idiomas, oscuro y zoom.
2. **Moneda de reporte robusta:** «Convirtiendo a BRL…» (19 s en frío para BRL/COP) y, sin tasa, «—» en KPIs, mapa, tabla e informe, con «Reintentar».
3. **Impuestos de Colombia y Brasil:**
   - DARF vencida de R$ 110,82 que pasa a R$ 92,93 al cambiar la fecha de pago;
   - Bens e Direitos con CNPJ;
   - CDT vencido con redención estimada en un clic ($ 33.117.970 → $ 34.182.384);
   - XLSX.
4. **Notas de corretagem en PDF** con conciliación del líquido, day trade y cambios de código. Bonificações con la razón correcta después de `1bb70a6`.
5. **Rentabilidad acumulada legible:** 4 series con etiquetas y colores validados, y *chips* para el resto, frente a las 7 series de R5.
6. **Local-first:** PWA sin conexión (7 rutas), enlace cifrado y tres idiomas.

## Peor que la competencia

1. **Eventos corporativos y dividendos.** Sharesight, Delta y Snowball los aplican solos. Aquí hay que confirmarlos en una bandeja escondida en Movimientos, y **el Resumen dice «Todo en orden» con el valor un 90 % por debajo** (W55).
2. **Tablas que ocultan lo esencial y muestran ceros:** «Cantidad» y «Aportes» ocultas; «Ef. câmbio» con 0,00 en un portafolio de una sola moneda (W56).
3. **Jerarquía de los KPIs con cifras grandes:** letra de 12,6 px igual a la etiqueta, tres tamaños en una fila y compacto «MRD» poco claro en español (W57).
4. **Sin sincronización con corredores ni con B3, y sin multi-dispositivo** (W10).

## Brechas nuevas

### W55 — alta — El Resumen dice «Todo en orden» con un split sin registrar (valor −90 %) y 230 proventos sin registrar

**Pasos:**

1. **Split:** `split.mjs`, `shots/nvda-dash.png`.
   1. Perfil nuevo (es) con portafolio en USD.
   2. Importar `fx/nvda-real.csv`: aporte de USD 1.500.000 y compra de **10.000 NVDA a USD 142,65 el 05-01-2023** (precio real antes del split).
   3. Esperar la actualización de precios.
2. **Proventos:** el perfil brasileño de la sección «Cómo se probó» (`divpend.mjs`, `inbox.mjs`).

**Resultado del split:**

- **Resumen:**
  - «Valor total USD 2.183.091,00» y «Ganancia total +USD 683.090,00 (+45,54 %)». Con el split 10:1 del 10-06-2024 son 100.000 acciones, ≈ USD 21,1 M y una ganancia de ≈ +USD 19,7 M.
  - El gráfico «Valor vs. aportado» cae de USD 11 M a USD 1,4 M en un día.
  - **«Avisos: Todo en orden · Todos los activos tienen precio y tasa de cambio.»**
- **Posiciones:** 10.000 NVDA sin ninguna marca.
- **Dónde sí se avisa:** la etiqueta «Posible split sin registrar» en Rendimiento, el aviso del Diagnóstico y la fila «10/06/2024 Split NVDA ×10» dentro de «16 eventos corporativos por registrar» en Movimientos.

**Resultado de los proventos:**

- Movimentações muestra «**236 eventos corporativos a registrar**» (230 proventos y 6 bonificações).
- El Resumen dice «Ainda não há proventos» y la página Proventos dice «Ainda não há proventos · Registre proventos como movimentações (ou importe-os)», sin enlace a la bandeja. El retorno total excluye esos dividendos sin avisar.

**Causa:**

- `pages/Dashboard.tsx:371`: `diagErrors` solo cuenta diagnósticos con `severity === 'error'`. `POSSIBLE_UNRECORDED_SPLIT` es un aviso y no entra.
- `pages/Dashboard.tsx:377`: `total` no cuenta las sugerencias pendientes de `SuggestionsInbox`.
- `pages/Dividends.tsx:97`: el estado vacío no consulta la bandeja.
- `components/SuggestionsInbox.tsx`: solo se monta en `pages/Transactions.tsx:152`.

**Corrección:**

- **Splits:**
  - aplicar automáticamente los splits del proveedor que coinciden con `POSSIBLE_UNRECORDED_SPLIT` (cambio de cantidad determinista), con «Deshacer», como Sharesight;
  - o, como mínimo, un aviso **bloqueante** en el Resumen y en Posiciones: «NVDA: split 10:1 del 10/06/2024 sin registrar; la cantidad y el valor están mal · Registrar».
- **Avisos:** contar los diagnósticos que cambian la valoración (split, redenominación, precio en otra unidad) aunque sean avisos, y añadir «N eventos corporativos por registrar · Revisar» con un enlace a la bandeja.
- **Dividendos:** en Proventos y en el Resumen, «230 proventos anunciados sin registrar · Registrar todos».
- **Prueba e2e:** compra de NVDA antes de 2024-06-10 y verificar que «Todo en orden» no aparece.

### W56 — media — La prioridad de columnas oculta lo esencial y conserva columnas de ceros

**Pasos:** `hidden.mjs`, `mensual1280.mjs`, `shots/hid-br-1440-pos.png`, perfiles `br` (pt, solo BRL) y `co` (es, solo COP).

**Resultado:**

| Página | Ancho | Oculta | Pero muestra |
|---|---|---|---|
| Posições (pt) | **1440** | **Quantidade** | «Ef. câmbio» con R$ 0,00 en las 14 filas, y «Ef. preço» idéntico a «Ganho» |
| Posições / Posiciones | 1280 | Quantidade/Cantidad y Ef. câmbio | — |
| Mensal (pt) | 1440 | Acumulada | — |
| Mensal (pt) | 1280 | Acumulada, **Proventos**, **Aportes/resgates** y Valor inicial | «Ef. câmbio 0,00 %» en todos los meses, y «Ef. preço» igual a «Rent. mês» |
| Mensual (es) | 1280 | Acumulada y Dividendos | — |

En un seguimiento **mensual**, cuánto aporté y cuánto cobré ese mes es más importante que un efecto divisa que es cero por construcción. Esto viola la regla de `table-design` de que los datos que importan dominan.

**Causa:**
- `pages/Positions.tsx:360`: `dropOrder` es `['qty', 'fxEffect', 'priceEffect']`, así que la cantidad sale primero;
- `pages/Monthly.tsx:160`: `['cumulative', 'income', 'flows', 'start', …, 'fx', 'pctIndex']` oculta aportes y dividendos antes que el efecto divisa;
- `components/fitColumns.tsx` no mira el contenido.

**Corrección:**
- antes de ocultar nada, quitar las columnas constantes, como «Ef. divisa» cuando el portafolio y la moneda de reporte son la misma o todas las celdas valen 0, y las duplicadas, como «Ef. precio» igual a «Ganancia» o a «Rent. mes»;
- después, ocultar por este orden: Acumulada → índice/diferencia → Ef. precio;
- **nunca** ocultar Cantidad, Aportes ni Dividendos.

### W57 — media — Cifras KPI de 12,6 px, tamaños distintos en una fila y notación compacta poco clara en español

**Pasos:** `kpiscan.mjs` con los portafolios «ballena» (`kpi-whale-br-pt-BR-COP-dark-1280_.png`, `kpi-whale-co-es-CO---light-1280_.png`, `whale-co-dash-1440.png`).

**Resultado:**
- **Letra mínima:** en pt con COP a 1280 px, «+COP 12.255.270.994» se ve a **12,6 px**, igual que su etiqueta (12 px) y **más pequeña que el % de abajo (13 px)**. La jerarquía se invierte y falla la prueba de 5 segundos.
- **Tamaños por tarjeta:** en una misma fila de KPIs secundarios hay 16,2 / 17,4 / 14,5 px (es, 1280 px) o 15,8 / 16,8 / 18 px (Rendimiento a 1024 px). Cada tarjeta se ajusta por separado.
- **Compacto en español** (Chromium, es-CO): «**−$8568,3 M**» (cuatro cifras sin separador), «+$789,6 M» y «**+$62,8 MRD**» en la misma fila. «MRD» (millardo) casi no se usa en Colombia, donde se dice «mil millones», «MM» o «billones». Además el compacto no lleva espacio después de «$», al revés que la cifra completa. En pt («R$ 3,7 mil», «8,6 bi») sí se entiende.
- **Sin respaldo compacto:** solo 4 de los 48 `<Kpi>` tienen `valueCompact` (`Dashboard.tsx:112-134`). Los demás bajan a 12 px y, si aun así no caben, se **recortan sin indicación** (`overflow-hidden` sin elipsis, `ui.tsx:232`).

**Causa:** `components/ui.tsx:208-215` (ajuste por tarjeta, `MIN_FIT = 12` en `:238`) y `lib/format.ts:61` (`notation: 'compact'` de Intl sin adaptación local).

**Corrección:**
- ajustar la fila entera al tamaño de la cifra que más espacio necesita;
- mínimo de 16 px para KPIs secundarios y 20 px para el principal; por debajo, pasar a compacto;
- compacto propio para es: «$ 8.568 M», «$ 62.804 M» o «$ 62,8 mil M», con una sola unidad por fila;
- `valueCompact` en todos los KPIs monetarios.

### W58 — baja — El modo compacto queda «pegado» después de una medición de ancho 0

**Pasos:** `stale-title.mjs` y `whale-setup3.mjs`, en Resumen a 1440 px. Basta con una captura de página completa (CDP `captureBeyondViewport`, la misma que usa «Capture full size screenshot» de DevTools). Los nodos registran `clientWidth = 0` durante un instante.

**Resultado:**
- «+R$ 3.730,04» pasa a «**+R$ 3,7 mil**», «+R$ 12,1 mil» y «+R$ 17,8 mil» (`shots/br-dash-BRL.png`), con 183 px de tarjeta donde la cifra completa cabe a 17,5 px.
- Sigue así indefinidamente con el mismo ancho. Solo vuelve al cambiar de moneda, porque el KPI se monta de nuevo.
- No se reprodujo al imprimir, con el menú del teléfono ni con una navegación lenta.

**Causa:**
- `components/ui.tsx:210-215`: no hay protección para `clientWidth === 0`, y `scrollWidth > 0 + 0,5` activa el compacto;
- `:223-230`: solo vuelve a la cifra completa si la tarjeta crece más de 24 px respecto del ancho que tenía ya en compacto;
- `:205`: el `title` solo se actualiza fuera del modo compacto.

**Corrección:**
- `if (!el.clientWidth) return;` en `fit`;
- decidir el compacto en cada ajuste midiendo la cifra completa en un clon fuera de pantalla, no con un estado que nunca se reinicia;
- actualizar `title` siempre desde la cifra completa.

### W59 — baja — Desplazamiento horizontal residual: Divisas a 360 px, mapa de calor a 768–1024 px y la bandeja de eventos a 1280 px

**Pasos:** `overflow.mjs`, `sweep.mjs` e `inboxshot.mjs`.

**Resultado:**
- **Divisas a 360 px (es):** `scrollWidth` de 395 (perfil `co`), 373 (ejemplo) y 379 (ballena). La *chip* «USD/COP · TRM (Banco de la República) · hace 16 minutos» no se parte. 360 px es un ancho muy común en Android de gama media en Colombia y Brasil.
- **Mapa de calor de Mensual con meses de tres cifras** («+124,3 %»): la página se desborda a 1024 px (1071) y a 768 px (811). Ni el ejemplo ni los portafolios normales llegan a ese caso.
- **Bandeja «eventos corporativos» a 1280 px:** la tabla mide 1134 px en una caja de 970, y **los botones «Registrar» de cada fila quedan fuera** (x = 1266 frente al borde de 1247). A 1440 px quedan rozando el borde. La causa es la nota larga de la bonificação, sin salto de línea (`inbox-br-1280.png`).

**Causa:**
- `pages/Currencies.tsx:211` con `.chip { white-space: nowrap }` (`index.css:280-292`);
- `pages/Monthly.tsx:604` (tabla `w-full` sin `table-fixed` y con cabecera «COLCAP (ICOLCAP)» que no se parte);
- `components/SuggestionsInbox.tsx:59-71`.

**Corrección:**
- `whitespace-normal h-auto` en las *chips* de fuente, o pasar la fuente a un *tooltip*;
- en el mapa de calor, `table-fixed` con `font-size` más pequeño a partir de 3 cifras, o un decimal menos;
- en la bandeja, la nota en una segunda línea (`whitespace-normal`) y las acciones en una columna fija.

### W60 — baja — Textos residuales (cierra lo que queda de W53)

| Dónde | Qué se ve | Origen |
|---|---|---|
| Vista previa de SINACOR (pt) | «…não atribuídos ao à vista: **0.07.**», con punto decimal y una preposición duplicada | `lib/taxText.ts:37`: el `(?![\d.,/])` impide localizar un número seguido del punto final de la frase. El texto viene de `packages/importers/src/i18n.ts:371` («ao à vista»). |
| Importar (es) | «Se agregaron **1 activos nuevos**» | `i18n/es.ts:397`, sin plural |
| Movimientos, Posiciones e Impuestos | «CDT Bancolombia S.A. 11,25% E.A. **vence 2025-01-09**» | Nombre del activo creado por el importador de CDT, con fecha ISO |
| Avisos y Informe | «Servidor de precios no disponible… **Inicia el servidor (npm run dev:server)**…» para un inversionista. Aparece tras un solo 503 del par MXN y sigue con el punto rojo al volver a abrir, aunque el servidor ya responde. | `i18n/es.ts:78` (y `pt.ts`/`en.ts:80`) |
| Resumen accesible de Rendimiento | «Portafolio: +20,63% (**31 de oct de 2026**)», una fecha futura (hoy es 24 de oct) | Fin de mes del mes en curso |

**Corrección:**
- en la expresión regular, usar `(?!\d|[.,]\d)`;
- usar el plural de i18next (`_one` / `_other`);
- `localizeDates` en los nombres de los activos;
- texto para el usuario («No pudimos descargar la tasa COP/MXN; reintentaremos») y el comando solo en Ajustes → Diagnóstico;
- fecha real del último dato.

## JSON

Ver `reviews/web-r6.json`: el campo `gaps` incluye todas las brechas abiertas, también las parciales que vienen de rondas anteriores.
