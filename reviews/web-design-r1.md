# Revisión de diseño y UX web — ronda 1 (`apps/web`)

- **Revisor:** «Revisor de diseño» (solo lectura).
- **Fecha:** 23 de octubre de 2026.
- **Referencia:** `reviews/web-r4.md` (revisión funcional: 7,8 frente a 8,0 de Sharesight).
- **Skills aplicadas:**
  - `dataviz`: validador de paleta, anti-patrones, color por entidad, marcas y figuras.
  - `visualization-review`: reglas P0, P1 y P2.
  - `dashboard-design`: jerarquía de KPIs y prueba de 5 segundos.
  - `table-design`: alineación, precisión, filas de total y encabezados.
  - `data-visualization`: tipo de gráfico, regla del 10 % y contraste.

  Los contrastes y las paletas se calcularon con `check_contrast.py`, `check_palette.py` y `validate_palette.js`; no se estimaron a ojo.
- **Evidencia:** en `SH = /tmp/claude-0/-home-user-Portfolio-Manager-Herramienta/8b757dea-bb3a-58bd-aa07-26758394d338/scratchpad/design-audit/shots/`.
  - **Capturas completas:** 104, con el nombre `{es|pt}-{light|dark}-{1440|390}-{página}.png`.
  - **Recortes:** `crop-*.png`.
  - **Otras pruebas:** `sticky-*.png`, `m-*.png` y `pt-1280-dashboard.png`.
  - **Scripts:** `shots.mjs`, `overflow.mjs`, `sticky.mjs`, `trunc.mjs` y `ptleak.mjs`, en la carpeta padre.

## Veredicto

**No aprobado.**

| | Puntaje visual/UX |
|---|---|
| **Portafolio Pro web** | **7,1 / 10** |
| **Sharesight** | **8,0 / 10** |

La base es buena:

- tokens de diseño coherentes y un modo oscuro bien elegido, no invertido;
- tablas con números alineados a la derecha y `tabular-nums`;
- cada gráfico tiene «Ver datos» y un resumen con `aria-describedby`;
- mapa de calor mensual con el valor impreso en cada celda;
- ECharts se carga en diferido.

Varios fallos visibles en uso real bajan la nota:

1. A 1280 px, en portugués, **los números principales se cortan con «…»** («COP 396.779.1…»).
2. El gris `--muted` **no llega a AA** en texto normal y está en 221 usos, más los ejes de los gráficos.
3. Las tablas largas (Mensual con 46 filas, Movimientos con 100) **pierden el encabezado al desplazarse**.
4. El KPI «Este mes» muestra **$ 0 / 0,00 %** cuando los precios son del mes anterior. El mes en curso aparece como «0,0 %» en el mapa de calor, igual que un mes plano.
5. Las áreas se rellenan sobre ejes que no empiezan en cero.
6. Los colores se asignan por rango, no por entidad.

Sharesight es menos vistoso, pero no corta cifras ni pierde encabezados, y su tarjeta principal es clara: valor + rentabilidad del periodo.

**Nota esperada con D1–D8 corregidas: ≈8,2.** Con D9–D14 también: ≈8,6.

## Cómo se probó

- **Build y servidores:**
  - build propio con `vite build --outDir …/design-audit/dist`;
  - `vite preview` en el puerto 4290, con una configuración propia que envía `/api` al 8890;
  - servidor de datos en el 8890 con `CORS_ORIGIN=http://localhost:4290`;
  - portafolio de ejemplo integrado.
- **Navegador:** Playwright con Chromium en `/opt/pw-browsers`.
  - 13 páginas × {1440, 390} × {claro, oscuro} × {es-CO, pt-BR}.
  - Escaneo de desbordamiento horizontal (`scrollWidth`).
  - Detección de `.truncate` cortado a 1280 px.
  - Encabezados *sticky* tras desplazar 1.400 px.
  - Búsqueda de textos en español dentro de la interfaz en portugués.
- **Validador de paleta (`validate_palette.js`):**
  - **Claro:** separación CVD PASS (ΔE 9,1). El gris de la serie 8 queda bajo el piso de croma; aceptable porque es «Otros». **Aviso de contraste:** aqua 2,74:1, amarillo 2,11:1 y magenta 2,62:1 sobre blanco.
  - **Oscuro:** pasa todo excepto el gris.
- **Par ganancia/pérdida:**
  - `#047857` / `#c2312f`: protanopía ΔE 14,1, distinguible solo con codificación redundante;
  - `#34d399` / `#f87171`: deuteranopía ΔE 18,5.

## Lo que ya está a nivel de los mejores

- **Mapa de calor** año × mes con columna anual y referencia por año. Al pulsar un mes se va a su fila, y el valor siempre está impreso, así que el color nunca es la única señal.
- **Señales de cambio** (`Delta`) con flecha y signo, no solo color.
- **Tabla mensual:**
  - separadores de año;
  - total compuesto (no sumado) en los porcentajes;
  - columnas «Esencial / Completa»;
  - densidad compacta;
  - en el teléfono, una tarjeta por mes.
- **Modo oscuro** con su propia paleta: las 8 series dan ≥3:1 sobre `#111723`. El texto apagado oscuro da 5,14:1.
- **Rendimiento percibido:** *skeletons* en los KPIs y el gráfico, ECharts cargado al quedar libre el navegador, y la página anterior atenuada (opacidad 0,6) al cambiar de moneda, sin parpadeo.

## Brechas (ordenadas por severidad)

### D1 — alta — Los KPIs principales se cortan con «…»

- **Qué pasa:** `Kpi` aplica `truncate` al valor y al subtítulo (`apps/web/src/components/ui.tsx:168-169`).
- **Evidencia:**
  - A 1280 px en pt-BR, los cuatro números del Resumen salen cortados: «COP 396.779.1…», «+COP 21.081.…», «+COP 85.032.…» (`SH/crop-pt-1280-dashboard-240-140.png`).
  - En Divisas, «+COP 57.767.897» también se corta.
  - A 1440 px en es, Rendimiento corta «IPC del periodo: +27,31 % · i…» y «IBR del periodo: +47,78 % · …» (`SH/es-light-1440-rendimiento.png`).
- **Regla que viola:** integridad P0 (la cifra no se puede leer) y la prueba de 5 segundos.
- **Arreglo** en `ui.tsx:168`:
  - quitar `truncate` del valor y usar `text-[clamp(18px,1.7vw,24px)] leading-tight break-words`;
  - opcionalmente, `formatMoney({compact})` solo cuando el ancho no alcance (`ResizeObserver`);
  - en `ui.tsx:169`, cambiar `truncate` por `line-clamp-2`.

### D2 — alta — El texto apagado no llega a AA en modo claro

- **Qué pasa:** `--muted: #7a8396` (`apps/web/src/index.css:19`) da:
  - **3,81:1** sobre blanco;
  - **3,55:1** sobre `--bg`;
  - **3,46:1** sobre `--surface-2`, que es el fondo de **todos los encabezados de tabla** (11,5 px en mayúsculas, `index.css:287-296`);
  - **3,22:1** sobre `--surface-3`.
- **Alcance:**
  - 221 usos de `text-muted`: subtítulos, costo promedio, fechas de precio, notas al pie;
  - etiquetas de eje de ECharts (`charts.tsx:21` usa `t.muted` a 11 px).
- **Regla que viola:** P0 #4 (contraste de texto 4,5:1).
- **Arreglo:**
  - `--muted: #5f687b`, que da 5,60 / 5,22 / 5,08 / 4,73:1 sobre los cuatro fondos;
  - si se quiere un gris más claro para trazos, crear un token aparte `--muted-mark: #7a8396` para marcas, no para texto;
  - el modo oscuro (`#8189a0`) ya pasa.

### D3 — alta — Las tablas largas pierden el encabezado al desplazarse

- **Qué pasa:** `.table th { position: sticky; top: 0 }` no funciona. Su contenedor `overflow-x-auto` crea un contexto de desplazamiento que no se mueve en vertical.
- **Evidencia:** en Mensual, tras desplazar 1.400 px, se ven 10 columnas numéricas sin nombre: aportes, dividendos, ganancia, valor, rentabilidad, acumulada, efectos, COLCAP y diferencia (`SH/sticky-mensual.png`, `th.top = −984`). En Movimientos, `th.top = −1049` con 100 filas.
- **Dónde:**
  - `apps/web/src/pages/Monthly.tsx:368`
  - `apps/web/src/pages/Transactions.tsx:213`
  - `apps/web/src/components/DataTable.tsx:68` (sin `maxHeight`)
- **Regla que viola:** `table-design`, «los encabezados deben acompañar la lectura de la columna»; P1 de carga cognitiva.
- **Arreglo:**
  - darle al contenedor `max-h-[calc(100dvh-7rem)] overflow-auto`, para que el *sticky* funcione dentro del contenedor y se conserve el desplazamiento horizontal;
  - o, en escritorio, usar `overflow-x: clip` en el contenedor con `th { top: 56px }` (la altura del *header* de la app, `Layout.tsx:411`);
  - aplicar lo mismo a `tfoot` (Total *sticky* abajo).

### D4 — alta — «Este mes $ 0 · 0,00 %» y el mes en curso pintado como un mes plano

- **Qué pasa:** con los precios al 30 de septiembre y la fecha en 23 de octubre, el KPI que más le importa a un usuario mensual dice **$ 0 / 0,00 %**, sin ninguna explicación (`SH/es-light-1440-dashboard.png`).
- **Arrastre a los gráficos:**
  - en el mapa de calor, octubre de 2026 sale como «0,0 %», gris y con la misma forma que un mes real (`SH/crop-es-dark-1440-mensual-270-340.png`);
  - el gráfico de 12 meses muestra la barra de octubre en 0 con su punto de referencia.
- **Dónde:**
  - `apps/web/src/pages/Dashboard.tsx:90-95`
  - `Monthly.tsx:529-548` (celda)
  - `Dashboard.tsx:52` (`last12` incluye el mes parcial)
- **Regla que viola:** P0 #2/#13 (encuadre engañoso) y `dashboard-design` («qué necesita primero el usuario»).
- **Arreglo:**
  - **KPI:** si `stalePrices` o el mes no tiene precios propios, la etiqueta pasa a «Último mes cerrado (sept. 2026)» con el TWR y la ganancia de esa fila, como hace `Monthly.tsx:136-138`. Se añade un subtítulo «oct. en curso: sin precios nuevos».
  - **Celda del mes en curso:** borde punteado, el texto «en curso» y sin color de calor.
  - **Gráfico de 12 meses:** excluir el mes parcial de `last12`, o dibujarlo con `decal` rayado y la etiqueta «parcial».

### D5 — alta — Áreas rellenas sobre ejes que no empiezan en cero

- **Qué pasa:** «Valor vs. aportado» usa `scale: true` con `areaStyle` (`apps/web/src/components/charts.tsx:79` y `:93-105`). El eje empieza en $50 M, así que el área exagera el crecimiento de 90 M a 397 M (`SH/es-light-1440-dashboard.png`).
- **Otros casos iguales:**
  - historial FX (`Currencies.tsx:80` y `:181`, `LineChart` con `scale` por defecto en `true`): área sobre 3.690–3.870;
  - precio del activo (`Instrument.tsx:51`);
  - SVG del Informe, que rellena hasta `min*0.97` (`apps/web/src/pages/Report.tsx:591` y `:614`).
- **Regla que viola:** P0 #2 (línea base truncada en marcas de área) y el anti-patrón de integridad de `dataviz`.
- **Arreglo:**
  - en `LineChart` (`charts.tsx:358`), aplicar `areaStyle` solo si `scale === false`;
  - en `ValueChart`, quitar el área, o poner `yAxis.min: 0` cuando se muestre el área;
  - en `Report.tsx:614`, borrar el `path` de relleno o anclarlo a `y(0)` con un mínimo de 0.

### D6 — media — El color sigue al rango, no a la entidad

- **Qué pasa:** `AllocationDonut` ordena por valor y pinta `series[i]` (`charts.tsx:193` y `:209`). La consecuencia:
  - Colombia, COP y Acciones siempre son azules y «Estados Unidos/USD» naranja, solo por ser primero y segundo;
  - si el USD supera al COP el mes siguiente, **los colores se intercambian**, y el usuario que aprendió «COP = azul» lee al revés;
  - las barras de «Distribución» del Informe hacen lo mismo.
- **Regla que viola:** la regla no negociable de `dataviz` «Color follows the entity, never its rank» (anti-patrón *Recolor-on-filter*).
- **Arreglo:** usar un mapa estable por clave:
  - divisas: COP→1, USD→2, BRL→3, EUR→4, …;
  - países y clases: por un orden fijo o por la clave guardada en el portafolio;
  - «Otros» siempre en la serie 8;
  - se aplica en `charts.tsx:190-194` y `:205-210`, y en el bloque de distribución de `Report.tsx`.

### D7 — media — Scroll horizontal de la página a 390 px en Dividendos e Importar

- **Medición:** `scrollWidth` de 536 px (es) y 608 px (pt) en Dividendos; 534 px en Importar.
- **Causas:**
  - la tabla «Por país» no está dentro de un contenedor con `overflow-x-auto` (`apps/web/src/pages/Dividends.tsx:164-165`);
  - las *chips* de formatos tienen `white-space: nowrap` y textos largos como «Trii, tyba, Davivienda Corredores, …» (`apps/web/src/pages/Import.tsx:328`, `index.css:259`).
- **Evidencia:** `SH/m-div-country.png` (la columna «TASA» se corta en el borde).
- **Arreglo:**
  - envolver la tabla en `<div className="overflow-x-auto">` o, en el teléfono, convertirla en lista;
  - en `Import.tsx:328`, añadir `max-w-full truncate` a la *chip* con `title={p.broker}`.

### D8 — media — Dividendos «Por activo» oculta sus columnas numéricas a 1440 px

- **Qué pasa:** el nombre largo, con `white-space: nowrap` («Grupo Cibest S.A. Preferencial (antes Bancolombia PFBCOLOM)»), empuja «12 meses», «S/ costo» y «S/ valor» fuera de la tarjeta. Se ve «12 MESE» y «$ 2.805.75…» (`SH/es-light-1440-dividendos.png`).
- **Dónde:** `apps/web/src/pages/Dividends.tsx:217-220`.
- **Regla que viola:** `table-design`, los datos numéricos deben dominar.
- **Arreglo:** símbolo en negrita y el nombre en una segunda línea `block max-w-[260px] truncate text-xs` con `title`, como se hace en Posiciones.

### D9 — media — Movimientos no cabe en 1440 px

- **Qué pasa:** a 1440 px, «Retención/Impuestos», «Cuenta», «Portafolio» y las acciones quedan detrás de una barra de desplazamiento horizontal que solo aparece al final de 100 filas (`SH/crop-es-light-1440-movimientos-270-200.png`).
- **Causa:** la columna «Portafolio» se muestra con «Todos» aunque solo haya un portafolio (`apps/web/src/pages/Transactions.tsx:235`).
- **Arreglo:**
  - mostrar la columna Portafolio solo si hay más de un portafolio;
  - unir Comisiones y Retención en una sola columna «Costos» con desglose en el *tooltip* (`:232-233`);
  - pasar las acciones a un menú «⋯»;
  - tras D3, el contenedor con altura máxima deja la barra horizontal a la vista.

### D10 — media — Mapa de calor: contraste en oscuro, escala anual distinta y par rojo/verde

- **Contraste en oscuro:** las celdas fuertes mezclan `--pos` al 65 % y dan `#289170` con texto `#edf0f5`, que es **3,42:1 (no pasa AA)**. En el móvil, el nombre del mes `--text-2` sobre esa celda da **2,05:1** (`Monthly.tsx:547`).
- **Escala anual:** la columna «Año» usa `heatStyle(y.annual / 3)` (`Monthly.tsx:578` y `:593`). Ese mismo color significa ×3 respecto a la leyenda «Escala», y no se explica.
- **Par de colores:** el divergente es verde↔rojo, que con protanopía da ΔE 14,1. El valor está impreso, pero `dataviz` pide un divergente cálido/frío (azul↔rojo o azul↔naranja) con punto medio gris.
- **Arreglo:**
  - en `heatStyle` (`Monthly.tsx:61-69`), limitar la mezcla al 45 % en oscuro, o usar texto `#0b0b0b` cuando `strength > 0.6` (5,04:1);
  - escala anual propia con su leyenda, o la misma escala con tope del 24 %;
  - ofrecer un divergente azul/naranja como opción de accesibilidad.

### D11 — media — Series bajo 3:1 dibujadas como líneas finas punteadas o barras sin etiqueta

- **Qué pasa** (modo claro):
  - IBR va en aqua `#1baf7a` (2,74:1), punteado de 1,5 px, en «Rentabilidad acumulada» (`apps/web/src/pages/Performance.tsx:102`, `charts.tsx:356`);
  - en Dividendos, «estimado» usa aqua y el año 2026 usa amarillo `#eda100` (2,11:1), en barras sin etiqueta directa.
- **Regla que viola:** P0 #5 (contraste de marcas). El validador da aviso de contraste, que obliga a etiquetas visibles; la tabla «Ver datos» está plegada.
- **Arreglo:**
  - en las líneas, usar un tono más oscuro de la misma rampa: aqua `#0d8a5f` (4,36:1) y amarillo `#9a6b00` (4,69:1), con 2 px;
  - añadir `endLabel` con el nombre de la serie;
  - punteado solo para referencias (inflación).

### D12 — media — Cifras que no cuadran en Divisas e Informe

- **Divisas:**
  - KPIs «Por precio +$ 79,7 M / Por divisa −$ 21,9 M» frente a la cascada «Efecto precio +$ 82,6 M / Efecto divisa −$ 26,0 M»;
  - KPI «TWR = precio × divisa **+42,32 %**» frente al TWR de **+42,49 %** en el Resumen, Mensual y Rendimiento.
- **Informe:** «Total combinado +5,69 %» frente a «TWR +5,65 %».

Son las mismas etiquetas con números distintos y sin definición (`SH/es-light-1440-divisas.png`, `SH/es-light-1440-informe.png`).

- **Dónde:** `apps/web/src/pages/Currencies.tsx:101-114`.
- **Regla que viola:** P1 #12/#13 (métricas sin definir).
- **Arreglo:**
  - renombrar a «Precio (posiciones abiertas)» y «Divisa (posiciones abiertas)»;
  - en el KPI compuesto, mostrar «TWR +42,49 % = precio +59,85 % × divisa −10,97 % + interacción +0,17 %», o una nota «≈, sin el término cruzado diario».

### D13 — media — Jerarquía de KPIs plana

- **Escritorio:** el Resumen tiene 4 tarjetas de igual peso, Rendimiento 10 y Mensual 5. No hay cifra principal.
- **Teléfono:** las 4 tarjetas ocupan ≈470 px apiladas antes del primer gráfico (`SH/es-light-390-dashboard.png`).
- **Lo que falta:** un usuario mensual necesita primero «Valor + cambio desde el último cierre», y eso no existe.
- **Dónde:** `Dashboard.tsx:68` y `Performance.tsx`, en los KPIs.
- **Regla que viola:** `dashboard-design`, de 1 a 3 KPIs principales grandes a la izquierda, el resto de contexto.
- **Arreglo:**
  - **Resumen:** tarjeta principal «Valor total» en `xl:col-span-2` con «vs. cierre de sept.» y una *sparkline* de 12 meses; las otras tres más pequeñas. En el teléfono, `grid-cols-2` para las secundarias.
  - **Rendimiento:** agrupar en dos filas rotuladas, «Rentabilidad» (TWR, TIR, Real, % índice) y «Riesgo» (Volatilidad, Caída, Sharpe, Sortino, Beta).

### D14 — media — Colores de estado usados para cosas que no son estado

Verde «ganancia» aplicado a datos que no son ganancias:

- toda la columna Dividendos (`Monthly.tsx:165`);
- toda la columna «Acumulada» (`:180`);
- la barra «Aportes netos» de la cascada (`Currencies.tsx:245`);
- los «Últimos pagos» del Resumen (`Dashboard.tsx:304`).

Además, la ganancia cero se pinta en verde (`Monthly.tsx:167`, `>= 0`).

- **Regla que viola:** la regla del 10 % y el anti-patrón «Status color used for a non-status series».
- **Arreglo:**
  - dividendos y acumulada en `text-ink`/`text-ink-2`;
  - aportes con `var(--series-1)` o en gris neutro;
  - `tone()` con tres estados (>0, <0, =0 apagado).

### D15 — baja — Abreviaturas «P / D» en Posiciones solo explicadas en `title`

- **Qué pasa:** la columna «Precio / Divisa» muestra «P +$ … / D −$ …». El significado solo aparece al pasar el ratón, y ordenar solo ordena por divisa (`apps/web/src/pages/Positions.tsx:170-196`).
- **Arreglo:** dos columnas ordenables, «Ef. precio» y «Ef. divisa», como en Mensual, o subetiquetas visibles en el encabezado.

### D16 — baja — Formatos inconsistentes de números y fechas

- **Observaciones de impuestos:**
  - números sin separador: «retención registrada 250976 COP»;
  - fechas ISO: «al 2025-12-31» (`packages/tax/src/colombia/report.ts:888` y `:921`);
  - salen en español en la interfaz pt.
- **Resumen de impuestos:** COP con 2 decimales («$ 302.389.159,58»), cuando el resto de la app usa 0.
- **«Ver datos» de `LineChart`:** fechas ISO crudas y encabezado vacío (`charts.tsx:368-372`).
- **Eje FX:** dos decimales («3.870,00», `Currencies.tsx:79` ignora `axis`).
- **Movimientos:** la columna Precio mezcla 0 y 4 decimales.
- **Informe:** marcas de eje no redondas («$404,7 M / $372,1 M», `Report.tsx:596`).
- **Arreglo:**
  - en el motor, devolver códigos con parámetros y formatearlos en `apps/web/src/lib/taxText.ts`;
  - `formatDate` en las tablas de datos;
  - `formatFxRate(v, locale, axis ? 0 : 2)`;
  - marcas «redondas» (1-2-5) en el SVG del informe.

### D17 — baja — Banderas emoji en Windows

- **Qué pasa:** `flagEmoji` (`apps/web/src/lib/labels.ts:23-27`) usa indicadores regionales. Windows no dibuja banderas y muestra «CO», «US», «BR» como letras sueltas, y en Colombia y Brasil la mayoría usa Windows.
- **Dónde se ve:** Posiciones, Dividendos por país, Lista e InstrumentPicker.
- **Arreglo:** SVG en línea para los ≈12 países del catálogo, o una *chip* con el código de 2 letras.

### D18 — baja — Faltan filas de total

- **Dónde:**
  - Dividendos «Por país» (bruto/retenido/neto, `Dividends.tsx:175-201`);
  - «Pagos {año}» (`:251-273`);
  - Impuestos «Detalle del patrimonio» (valor fiscal y mercado).
- **Además:** la fila Total de Posiciones deja vacío «Peso», que debería decir 100 %.
- **Regla que viola:** `table-design`, totales en negrita separados por una línea fina.
- **Arreglo:** añadir un `<tfoot>` con las sumas.

### D19 — baja — Leyendas separadas que no reflejan el estilo de línea

- **Qué pasa:** con 3 o 4 series («Valor vs. aportado», «Rentabilidad acumulada») se usa una leyenda arriba a la derecha con icono `rect` sólido, aunque las series sean punteadas (`charts.tsx:48-53` y `:332`).
- **Regla que viola:** P1 #11 (con ≤5 series, etiquetar directamente).
- **Arreglo:** `endLabel: { show: true, formatter: '{a}' }` en cada serie y leyenda con el icono de la línea real.

### D20 — baja — «Dividendos por mes» con 48 barras

- **Qué pasa:** 4 años × 12 meses de barras agrupadas (`Dividends.tsx:160`) no se pueden leer a 390 px (`SH/m-div-country.png`).
- **Regla que viola:** P1 #9 (sobrecarga).
- **Arreglo:** por defecto, año actual vs. anterior (2 series) con selector, o un mapa de calor año × mes reutilizando `Heatmap`.

### D21 — baja — Etiquetas cortadas a 1440 px

- **Dónde:**
  - «Estados Uni…» en la leyenda del donut (`charts.tsx:212`);
  - «ECOPETR…» en «Mayores movimientos» (`Dashboard.tsx:222`, `w-[86px]`);
  - «Dividendos e intere…» en la cascada (`Currencies.tsx:247`, columna de 140 px).
- **Arreglo:** `w-[96px]` o `min-w-max` en los símbolos, y una columna de 170 px o texto que pueda partirse en dos líneas.

### D22 — baja — Ruido técnico en el Resumen

- **Qué pasa:**
  - «Cálculo del motor: 94 ms» (`Dashboard.tsx:354-358`);
  - media fila dedicada a «Frescura de datos»;
  - mensajes que se contradicen: «Conectado» + «Aún no se han descargado precios» + «Sin actualizar» en el *header*.
- **Regla que viola:** `dashboard-design`, recortar el ruido.
- **Arreglo:** mover la frescura a un *popover* del botón de estado del *header* y el tiempo de cálculo a Ajustes → Diagnóstico.

### D23 — baja — Tipografía declarada pero no cargada

- **Qué pasa:** `'Inter'` está en la pila (`index.css:82`, `Chart.tsx:71`), pero no hay `@font-face`. En Linux cae a DejaVu, que es más ancha y agrava D1, y `font-feature-settings: 'cv11','ss01'` solo tiene sentido con Inter.
- **Además:** las cifras principales usan `tabular-nums` (`Money` siempre lleva `.num`), que es un anti-patrón de `dataviz` en cifras grandes aisladas.
- **Arreglo:**
  - incluir Inter variable `woff2` (cacheada por la PWA) o quitarla de la pila;
  - en `Kpi`, usar `font-variant-numeric: proportional-nums`.

### D24 — baja — i18n y textos de interfaz

- **`aria-label` fijos en español:** «Seleccionar todo» y «Seleccionar {key}» (`DataTable.tsx:77` y `:160`).
- **Marca fija:** «Local-first · multi-divisa» (`Layout.tsx:91`).
- **Alertas:** la etiqueta dice «Precio ()» cuando no hay activo (`apps/web/src/pages/Alerts.tsx:104`).
- **Importar:** *chips* de formatos duplicados (IB ×2, B3 ×3, DEGIRO ×2, Corretoras BR ×2) (`Import.tsx:327`).
- **Arreglo:**
  - claves `t('common.selectAll')`;
  - ocultar «()» si no hay moneda;
  - deduplicar por `broker+country`.

### D25 — baja — La vista previa del Informe se desborda

- **Qué pasa:** «Detalle mensual» es más ancho que la «hoja»: la columna COLCAP queda cortada y hay desplazamiento oculto (`Report.tsx:226`, `SH/es-light-1440-informe.png`).
- **Arreglo:** usar en la vista previa el mismo tamaño compacto de impresión (`font-size: 10.5px`), o mostrar «Esencial» y mover las columnas extra al anexo.

## Comparación con Sharesight (solo visual/UX)

**Ganamos en:**

- mapa de calor mensual;
- efecto precio/divisa por mes;
- modo oscuro;
- tablas de datos accesibles detrás de cada gráfico;
- local-first sin esperas.

**Perdemos en:**

- **legibilidad garantizada de las cifras principales** (D1, D2);
- **tablas largas con encabezado fijo** (D3);
- **el KPI del periodo** (D4);
- **coherencia de colores y números entre páginas** (D6, D12).
