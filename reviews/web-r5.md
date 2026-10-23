# Revisión web — ronda 5 (`apps/web`)

- **Revisor:** «Revisor E» (independiente, solo lectura).
- **Fecha:** 23 de octubre de 2026.
- **Rama:** `claude/lucid-edison-hw6cla` (HEAD `14f95f1`).
- **Referencias:**
  - `reviews/web-r4.md`: funcional, 7,8 frente a 8,0, brechas W40–W48.
  - `reviews/web-design-r1.md`: diseño, 7,1 frente a 8,0, brechas D1–D25.
- **Skills aplicadas:**
  - `visualization-review`: reglas P0, P1 y P2.
  - `dataviz`: `validate_palette.js` en claro y oscuro, con pares adyacentes y con todos los pares.
  - `dashboard-design`: prueba de 5 segundos y jerarquía.
  - `table-design`: encabezados, alineación y si las tablas caben.
  - `run`: lanzar y manejar la app real.
  - Los contrastes se calcularon con `check_contrast.py`, no a ojo.
- **Evidencia:** `RW5 = /tmp/claude-0/-home-user-Portfolio-Manager-Herramienta/8b757dea-bb3a-58bd-aa07-26758394d338/scratchpad/review-web5/`. Allí están los scripts `*.mjs`, las capturas `shots/*.png`, el PDF del informe y los XLSX fiscales, y los registros `e2e.log`, `unit.log` y `build.log`.

## Veredicto

**No aprobado.**

Se cerró la brecha alta funcional W40. El cambio de moneda ya nunca muestra ceros: dice «Convirtiendo a BRL…» y, sin tasa, pone «—» con aviso en KPIs, Mensual e Informe.

Sigue abierta una brecha alta, **D1**, que el README da por corregida. Las cifras principales ya no llevan «…», pero ahora **se parten en mitad del número**:

- en pt-BR a 1280 px: «+COP 21.081.⏎632», «+COP 85.032.⏎008» y «+COP 704.12⏎6»;
- en es a 1280 px: «+$ 21.081.63⏎2»;
- en un portafolio BRL a 1280 y 1366 px: «+R$ 11.583,3⏎9»;
- a 390 px pasa lo mismo.

La prueba e2e de D1 solo busca elipsis, así que no detecta el corte.

Además aparecen tres brechas medias nuevas:

- precios sin actualizar sin ningún aviso, con meses «0,00 %» inventados (W49);
- índice COLCAP para un portafolio en BRL al abrir Mensual directamente (W50);
- tablas «esenciales» que todavía se salen a 1440/1280 px (W51).

| | Puntaje |
|---|---|
| **Portafolio Pro web (nuestro)** | **7,9 / 10** (R4 funcional 7,8; diseño R1 7,1) |
| **Sharesight (referencia)** | **8,0 / 10** |

**Cómo mejora la nota:**
- **≈ 8,2:** con D1 corregida de verdad (cifra en una sola línea y formato compacto si no cabe).
- **≈ 8,4:** con W49–W51 también. Eso supera a Sharesight para el inversionista de Colombia y Brasil, porque Sharesight no tiene impuestos de esos dos países, ni seguimiento mensual con efecto precio/divisa, ni lectura de notas de corretagem.

### Comparación con los demás competidores

Los puntajes salen de documentación pública y conocimiento previo; no se verificaron en vivo en esta ronda.

| Competidor | Puntaje | Dónde nos ganan | Dónde les ganamos |
|---|---|---|---|
| **Sharesight** | 8,0 | Sincronización con más de 200 corredores, acceso compartido en vivo con el asesor, cifras siempre legibles | Impuestos CO/BR, mapa mensual, notas SINACOR, local-first, sin conexión |
| **Kubera** | ≈7,5 | Agregación bancaria y patrimonio total, sincronización entre dispositivos | Rentabilidad mensual (TWR/TIR), impuestos, efecto divisa |
| **Gorila / Kinvo** | ≈7,5 | Lectura automática de B3 (área del inversionista) y app nativa | Varios países y monedas, efecto divisa, Colombia |
| **Portfolio Performance** | ≈7,3 | Profundidad analítica y muchos importadores PDF europeos | Web/PWA, idiomas, impuestos CO/BR, usabilidad |
| **Snowball Analytics** | ≈7,2 | Analítica de dividendos y sincronización con corredores | Seguimiento mensual, impuestos, notas BR |
| **Ghostfolio** | ≈7,0 | Código abierto, autoalojable, sincronización | Impuestos, informe PDF, mapa mensual, efecto divisa |

## Cómo se probó

- **Verificaciones previas:**
  - `npx tsc --noEmit -p apps/web`: sin errores.
  - `npm test -w @pm/web`: **105/105** (16 archivos).
  - **E2E:** **47 aprobadas y 1 omitida** (`live`).
    - Se corrió una copia de `apps/web/e2e` en `RW5/e2erun` con Chromium `/opt/pw-browsers/chromium`, contra el build propio servido en :4301. Así las capturas no tocaron el repositorio.
    - `git status` quedó limpio.
- **Build y servidores:**
  - `vite build --outDir RW5/dist`, servido con `vite preview` en **:4300** (`RW5/vite.preview.mjs`, con `/api` → :8900).
  - Servidor de datos en **:8900**: `CORS_ORIGIN=http://localhost:4300`, `RATE_LIMIT_PER_MIN=0`, `CACHE_DIR=RW5/cache`, `SNAPSHOT_EXCHANGES=none`.
  - Datos reales de Yahoo, TRM, IBR, IPC y UVR. BCB, IBGE, FRED y BCE no responden desde este contenedor, así que CDI, IPCA, Selic, CPI y HICP fallan.
  - Los dos servidores se detuvieron al terminar.
- **Primer render** (`first2.mjs`, Resource Timing):
  - **Primera visita** (siembra el ejemplo): KPIs visibles a los **773 ms**, con **800 kB** de JS/CSS descomprimidos antes de los KPIs (incluye el worker del motor, 118 kB) y **1.368 kB** a los 8 s. ECharts (568 kB) llega después.
  - **Visita siguiente:** KPIs a los **548 ms** con **559 kB**.
  - No se pudo reproducir la cifra de 520 kB del README.
- **Brasileño** (perfil `br`, navegador pt-BR):
  - asistente en BRL y aporte de R$ 100.000 el 02-01-2023;
  - importación de `b3-negociacao.xlsx`, `nota-sinacor.pdf` (nota 99887766 en revisión, diferencia −10,00) y `nota-xp-2024-03-08.pdf` (16 operaciones, day trade y EMBR3→EMBJ3, CCRO3→MOTV3, TRPL4→ISAE4);
  - Resumen y Mensual en BRL, EUR, COP y USD, con el tiempo de conversión medido;
  - Impostos 2023, 2024 y 2026: DARF vencida, diálogo con cambio de fecha, pago, Bens e Direitos y XLSX.
- **Colombiano** (perfil `co`, es):
  - asistente en COP y aporte de $ 30 M;
  - importación de `extracto-trii.pdf`, `cdt-bancolombia.pdf` y `extracto-trii.csv` por SPA, esperando cada actualización;
  - Mensual en COP, BRL y USD;
  - **MXN con la tasa bloqueada** (`nofx.mjs`);
  - Impuestos 2024 y 2025 con «Registrar redención estimada»;
  - Informe en pantalla y en PDF (`shots/co-report.pdf`, 3 páginas);
  - enlace sin contraseña y con contraseña, contraseña errónea, `hashchange` en la misma pestaña y enlace alterado.
- **Otros:**
  - **Teléfono:** 390 px en claro (pt) y oscuro (es), 13 páginas, `scrollWidth`.
  - **PWA sin conexión:** `setOffline` en 7 rutas.
  - **Escritorio:**
    - desbordes y cortes a 1440 y 1280 px (`overflow.mjs`);
    - detección de saltos de línea dentro de un número en `.kpi-value` a 1024, 1280, 1366, 1440 y 1920 px (`kpiwrap.mjs`);
    - encabezados *sticky* (`sticky.mjs`);
    - escaneo de formatos (`fmtscan.mjs`).
  - **Recarga justo después de importar** (`stale.mjs`).
  - Se revisaron a ojo las capturas, sobre todo `ptdemo-dash-1280.png`, `br-dash-1280.png`, `m-ptdemo-light-dash.png`, `stale-dash.png`, `br-mensual-BRL.png`, `offline-rendimiento.png`, `co-report.png` y `crop-*.png`.

## Estado de las brechas anteriores

### Funcionales (W)

| ID | Estado | Evidencia |
|---|---|---|
| **W40** (alta) | **Cerrada** | **Con red:** BRL→EUR muestra «[Convirtiendo…]» y cifras en 6,7 s; COP→BRL tarda 19,5 s con el servidor en frío. Nunca aparece un 0 (`br2.mjs`, `co2.mjs`). **Sin tasa** (MXN bloqueado): «—» en KPIs, mapa, tabla e informe, más el aviso «Sin tasa COP/MXN · Reintentar» (`nofx.mjs`, `shots/co-nofx-MXN.png`). |
| W41 | **Cerrada** | Avisos en pt: «Venda de 20 VALE3 em 02/01/2023 maior que a posição (0)…». |
| W42 | **Cerrada** | 2025: banner «El CDT … venció el 9 de ene de 2025…» con «Registrar redención estimada ($ 11.064.414)». Tras pulsarlo, el patrimonio fiscal pasa de $ 33.117.970 a $ 34.182.384 y el botón desaparece. Limitación conocida: en 2024 faltan los intereses causados por cobrar (README). |
| W43 | **Cerrada** | Bens e Direitos con «Companhia Siderúrgica Nacional ON», «Motiva ON (antes CCR)» y CNPJ en todas las acciones. ETF y FII quedan con «—». |
| W44 | **Cerrada** | La DARF de mar-2024 vale R$ 110,82 a hoy; con fecha 31-12-2024 pasa a R$ 92,93 (Selic de R$ 22,98 a R$ 5,09) y queda «Paga em atraso». |
| W45 | **Parcial (baja)** | Ya no hay duplicados exactos ni punto decimal. Quedan «Alguns parâmetros de 2023 / 2024 / 2025 / 2026 estão marcados para verificação» (4 líneas en 2026) y el nombre interno «ver gcapPre2024» en 2023. |
| W46 | **Cerrada** | Enlace de 4.867 caracteres (4.924 con contraseña). `hashchange` en la misma pestaña pasa a «Informe protegido». Contraseña errónea → «Contraseña incorrecta». Enlace alterado → «El enlace está incompleto o dañado». |
| W47 | **Cerrada** | La tabla del informe cabe a 1440 px y en PDF A4 apaisado («Cifras en COP», sin símbolo por celda). |
| W48 | **Cerrada** | «Abr de 2026†» y «Ago de 2026†» con la leyenda «† Precio atípico…» en pantalla, en el PDF y en el enlace. |
| W20 | **Parcial (baja)** | Primera visita: 800 kB antes de los KPIs (en R4 eran 746). Visita siguiente: 559 kB. KPIs en 0,55–0,77 s, lo que es bueno. |
| W10 | **Abierta (baja)** | Sigue sin haber sincronización entre dispositivos. |

### Diseño (D)

| ID | Estado | Evidencia |
|---|---|---|
| **D1** (alta) | **No corregida** | `break-words` (`ui.tsx:172`) cambió la elipsis por un salto **dentro del número**. **pt demo:** a 1280 px hay 3 KPIs partidos y a 1440 px, 2. **es demo:** a 1280 px hay 2. **Portafolio BRL:** a 1280 y 1366 px hay 2. A 390 px también (`m-ptdemo-light-dash.png`). Los subtítulos siguen cortados: «inflación publicada hasta Se…». |
| D2 | **Cerrada** | `--muted #5f687b`: 5,60 / 5,22 / 5,08 / 4,73:1 sobre los cuatro fondos. En oscuro, `#8189a0`: 5,14 y 4,84:1. |
| D3 | **Cerrada** | Mensual (49 filas) y Movimientos (100 filas) conservan el encabezado dentro de su contenedor; el Total queda *sticky*. |
| D4 | **Cerrada** | «Último mes cerrado (Sept de 2026)» con «Oct de 2026 en curso: sin precios nuevos». La celda «en curso» va punteada y sin color. Ver W49 para el caso sin precios. |
| D5 | **Cerrada** | No hay áreas sobre ejes que no empiecen en 0 (`charts.tsx:90` y `:352`). El SVG del informe va sin relleno. |
| D6 | **Cerrada** | `seriesColors.ts`: COP/Colombia en azul y Brasil en verde azulado en todas las vistas. Ver W52 sobre los pares que ahora quedan juntos. |
| D7 | **Cerrada** | `scrollWidth` = 390 en las 13 páginas, en claro y en oscuro. |
| D8 | **Cerrada** | «Por activo» con el símbolo en negrita y el nombre en una segunda línea; las columnas caben. |
| D9 | **Parcial (media → W51)** | A 1440 px (es, ejemplo), Movimientos sigue ocultando «Cuenta / corredor» y «Acciones» (`scrollWidth` 1289 frente a 1130). A 1280 px oculta también «Costos». |
| D10 | **Cerrada** | Hay opción azul/naranja en Ajustes, 35 % en oscuro y la leyenda dice «Columna Año: misma escala hasta ±24 %». |
| D11 | **Cerrada** | Todas las series dan ≥ 3:1 en claro y en oscuro; el validador da PASS para los pares adyacentes. |
| D12 | **Cerrada** | Divisas muestra «Precio (posiciones abiertas)» y «TWR +42,49 % ≈ (1 +59,85 %) × (1 −10,97 %) − 1 · sin el término cruzado diario». |
| D13 | **Cerrada** (con un detalle en W54) | KPI principal a dos columnas. Rendimiento agrupado en «Rentabilidad» y «Riesgo». |
| D14 | **Cerrada** | Las columnas Dividendos y Acumulada van en tinta neutra. |
| D15 | **Cerrada** | Columnas «Ef. precio» y «Ef. divisa» separadas y ordenables. |
| D16 | **Parcial (baja)** | Ejes de tiempo de ECharts en inglés en es y pt («Apr», «Sep», «Oct»). En `stale-dash.png` el eje repite «R$ 50,1 mil» tres veces. Ver W53. |
| D17 | **Cerrada** | Las banderas son chips «CO», «BR» y «US». |
| D18 | **Cerrada** | Hay fila Total en Dividendos «Por país» y en Pagos. |
| D19 | **Parcial (baja)** | La leyenda ya dibuja las líneas punteadas, pero no hay etiquetas directas. «Rentabilidad acumulada» tiene 7 series solo con leyenda (W52). |
| D20 | **Cerrada** | «Dividendos por mes» muestra el año elegido frente al anterior. |
| D21 | **Parcial (baja)** | La leyenda del donut corta «38,8» a 1280 px y causa desplazamiento horizontal de la página (`scrollWidth` 1295), en pt con el ejemplo y en el portafolio BRL. «ECOPETROL» se corta en Dividendos a 1440 px. |
| D22 | **Parcial (baja)** | Desapareció «Cálculo del motor». Sigue la tarjeta «Frescura de datos» de media fila con 5 índices «falhou» (CPI y HICP en un portafolio BRL). El encabezado muestra un punto verde «Sin actualizar» junto a «Conectado · Aún no se han descargado precios». |
| D23 | **Cerrada** | Ya no se declara Inter; los KPIs usan cifras proporcionales. |
| D24 | **Cerrada** | `common.selectAll`, marca traducida y sin «Precio ()». |
| D25 | **Cerrada** | La vista previa del informe cabe. |

## Mejor que la competencia

1. **Moneda de reporte robusta.** Descarga el par que falta, mantiene el estado «Convirtiendo…» y, sin tasa, pone «—» en todas las páginas y en el informe. Sharesight y Kubera convierten, pero no explican qué pasa cuando falta la tasa.
2. **Impuestos de Colombia y Brasil en una sola app:**
   - DARF con multa y Selic recalculadas según la fecha de pago;
   - Bens e Direitos con CNPJ;
   - CDT vencido con redención estimada en un clic;
   - Formularios 210 y 160 con XLSX.
3. **Notas de corretagem en PDF** con conciliación del líquido, day trade y cambios de código.
4. **Mensual con calidad del dato**, que viaja al informe y al enlace (†, ‡).
5. **Local-first, PWA sin conexión, tres idiomas y modo oscuro AA.**

## Peor que la competencia

1. **Cifras principales que se parten a 1280/1366 px y en el teléfono** (D1). Sharesight nunca corta su valor principal.
2. **Precios.** Sharesight los actualiza en el servidor. Aquí una actualización interrumpida deja el portafolio valorado a precio de compra, sin aviso (W49).
3. **Sin sincronización con corredores ni con B3, y sin multi-dispositivo** (W10). IBKR y el buzón de correo requieren montar un servidor.
4. **Tablas anchas** que todavía necesitan desplazamiento horizontal a 1440 px (W51), y un gráfico de 7 series difícil de leer (W52).

## Brechas nuevas

### W49 — media — Precios de mercado sin descargar sin ningún aviso: meses «0,00 %» inventados

**Pasos** (`stale.mjs`, `shots/stale-dash.png`):
1. Perfil nuevo en pt-BR y asistente en BRL.
2. Importar `nota-xp-2024-03-08.pdf`.
3. Unos 1,5 s después de «Importar», volver a abrir la app. Basta con recargar, cerrar la pestaña o importar otro archivo con una carga completa.
4. Esperar 60 s.

**Resultado:**
- **Encabezado:** «Não atualizado» con el punto verde.
- **KPIs:**
  - «Patrimônio R$ 50.158,68 · Cotações de 8 de mar. de 2024»;
  - «Último mês fechado (Set de 2026) R$ 0,00 · 0,00 %»;
  - «No ano R$ 0,00 · 0,00 %».
- **Gráfico:** «Valor vs. aportado» plano durante 2,5 años.
- **Mapa mensual:** 0,0 % en todos los meses.
- **Posiciones:** precios del 08/03/2024.
- **Avisos:** solo «Venda de 150 BBSE3…», nada sobre los precios.
- **Duración:** no se recupera mientras la pestaña siga abierta. La actualización automática solo corre al abrir la app (`main.tsx:45`) y respeta 2 minutos desde `lastAttempt`.

Lo mismo pasó en el recorrido brasileño (`br2.mjs`): durante más de 2 minutos con la app abierta, el portafolio tuvo 0 series de precios.

**Causa:**
- `services/marketData.ts:151-157` guarda `lastAttempt` antes de que termine el lote (≈ 9–13 s en frío). Una carga interrumpida bloquea la siguiente actualización automática.
- `pages/Import.tsx:164` lanza la actualización sin dejar constancia de que quedó pendiente.
- `pages/Dashboard.tsx:394-398` solo avisa de precios viejos para activos con `pricing === 'manual'`. Los activos con precio automático valorados al precio de la operación no generan aviso.

**Corrección:**
- guardar `lastAttempt` solo al terminar, o marcar «actualización pendiente» en `meta` y reintentarla al arrancar;
- volver a intentar cada N minutos mientras haya activos con `priceDate` más vieja que el día hábil anterior;
- en Avisos, añadir «N activos sin cotización de mercado desde dd/mm/aaaa · Actualizar» para los activos con precio automático;
- en Mensual, no pintar como 0,0 % los meses sin precio propio: marcarlos «sin precio».

### W50 — media — Mensual compara un portafolio BRL contra COLCAP cuando se abre directamente

**Pasos** (`bench.mjs`, `shots/br-mensual-BRL.png`): con el portafolio BRL y la moneda en BRL, cargar `/mensual` en frío (recarga, marcador, PWA o enlace del Resumen abierto en otra pestaña).

**Resultado:**
- **Carga en frío:** el selector «Comparar com», la columna del mapa y la tabla muestran **COLCAP (ICOLCAP)** y «Diferença» contra COLCAP: Total +228,35 % frente al +16,73 % de la cartera.
- **Navegando dentro de la app:** sale **Ibovespa**.
- **Al cambiar a USD:** el índice no sigue a la moneda.

**Causa:** `pages/Monthly.tsx:126`: `useState(primaryBenchmark(settings.benchmarks, settings.reportingCurrency) ?? 'XBOG:ICOLCAP')` toma el valor inicial antes de que se carguen los ajustes (COP por defecto) y no se vuelve a calcular. El Resumen y el Informe calculan el índice en cada render y sí aciertan.

**Corrección:** guardar como estado solo la elección explícita del usuario (`useState<string | undefined>()`) y usar `bench = chosen ?? primaryBenchmark(...)`. Añadir una prueba e2e con `page.goto('/mensual')` en un portafolio BRL.

### W51 — media — Las tablas «esenciales» siguen necesitando desplazamiento horizontal a 1440/1280 px

**Pasos:** `overflow.mjs` con el ejemplo en es y con el portafolio BRL en pt.

**Resultado:** columnas ocultas detrás de una barra horizontal.

| Página | 1440 px | 1280 px |
|---|---|---|
| **Mensual (Esencial), portafolio BRL** | COLCAP y Diferença | Ef. câmbio, COLCAP y Diferença |
| **Mensual (Esencial), ejemplo es** | — | COLCAP y Diferencia |
| **Movimientos, ejemplo es** | Cuenta / corredor y Acciones | Costos, Cuenta / corredor y Acciones (el residuo de D9) |
| **Posiciones** | Peso | Ef. divisa y Peso |
| **Dividendos** | — | Neto (Por país) y S/ valor (Por activo) |
| **Rendimiento «Por periodo»** | Ganancia | Ganancia |

El README afirma que «la vista esencial cabe a 1440 px» (W3), y en pt con BRL no es así: los importes con 2 decimales («R$ 120.866,61») son más anchos.

**Causa:**
- `pages/Monthly.tsx:103` (`ESSENTIAL_COLUMNS` con 10 columnas numéricas) y `:377`;
- `pages/Transactions.tsx:213-240` (la fecha, el tipo y el activo con nombre largo ocupan ≈ 560 px);
- `pages/Positions.tsx` (columna de precio con dos líneas y fecha).

**Corrección:**
- en Mensual, quitar «Acumulada» de la vista esencial por debajo de 1440 px, o mostrar el índice y la diferencia en una sola columna «Índice (dif.)»;
- en BRL, usar importes sin decimales en las tablas mensuales, que es lo que ya hace el informe;
- en Movimientos, pasar «Cuenta» a un *tooltip* o subtítulo del activo y las acciones a un menú «⋯»;
- añadir una prueba e2e de `scrollWidth <= clientWidth` a 1280 px en es y en pt-BRL.

### W52 — baja — «Rentabilidad acumulada vs. índices»: 7 series solo con leyenda, pares que no se distinguen y color por rango

**Pasos:** en Rendimiento (`offline-rendimiento.png`), el gráfico tiene 7 series: Portafolio, COLCAP, Ibovespa, S&P 500, MSCI World, IBR e Inflación.

**Resultado** (`validate_palette.js --pairs all`):

| Par | Problema |
|---|---|
| Ibovespa `#0e9384` e IBR `#008300` | ΔE **13,8** con visión normal (piso 15): **FAIL** |
| MSCI `#c2457a` e Ibovespa `#0e9384` | ΔE **2,0** con deuteranopía: **FAIL** |
| En oscuro, `#9085e9` y `#3987e5` | ΔE 9,8 con visión normal |

- **Etiquetas:** no hay etiquetas al final de cada línea, y la serie del usuario no destaca (mismo grosor que las demás).
- **Color por rango:** los índices toman el color por posición (`Performance.tsx:100`, `colorIndex: i + 1`). Si se desactiva un índice en Ajustes, los demás cambian de color, lo que contradice D6.
- **Donut:** los colores fijos por entidad dejan Brasil (verde azulado) junto a Países Bajos (verde, por hash), un par que el validador solo aprobó para el orden original.

**Corrección:**
- por defecto, Portafolio más el índice de la moneda más la inflación, con un selector para añadir el resto (≤ 4 series);
- `endLabel` con el nombre de cada serie;
- la serie del portafolio a 2,5 px y el resto en gris;
- color de cada índice por id (`HOME_BENCHMARK`);
- revalidar con todos los pares las combinaciones que se dibujan juntas.

### W53 — baja — Textos y formatos que se escapan del idioma

| Dónde | Qué se ve | Origen |
|---|---|---|
| Ejes de tiempo de ECharts (Resumen, Divisas, Rendimiento, Activo) | Meses en inglés en es y pt: «Apr», «Sep», «Oct» | `charts.tsx:73` y `:333`, sin `axisLabel.formatter` local |
| Movimentações (pt) | Las bonificações del proveedor muestran «For IR the new shares carry the "custo atribuído"…» y «×1.03» | `packages/market-data/src/corporate.ts:70` |
| Movimentações (pt), GOAU4 | «Bonificação 1:1 (33.33 % em ações)», que se contradice: 1:1 sería 100 % | Redondeo de una razón decimal en `corporate.ts:46-48` |
| Vista previa de la importación (pt) | «…não atribuídos ao à vista: 0.07», «o líquido calculado (-2000.6) não confere com o da nota (-2010.6)», «de 2023-01-02» | — |
| Divisas | «≈ (1 +16,64 %) × (1 0,00 %) − 1»: falta el signo cuando el efecto es 0 | `Currencies.tsx:112` |
| Impostos 2023 | «ver gcapPre2024» | — |

**Corrección:**
- formateador de mes según el idioma en los ejes de tiempo;
- textos de eventos e importación armados en la web desde su código y sus datos, como ya hace `describeDiagnostic`;
- en `Currencies.tsx:112`, poner el operador fuera de `formatPct`.

### W54 — baja — Teléfono: el primer gráfico del Resumen queda debajo de dos pantallas

- **Medición** (390×844, `phone.mjs`): el primer gráfico empieza a 921–954 px.
- **Causa:** «Primeros pasos» (5 filas) y 4 KPIs.
- **Hueco:** los 3 KPIs secundarios en 2 columnas dejan una celda vacía (`m-co-dark-dash.png`).

**Corrección:**
- en el teléfono, plegar «Primeros pasos» a una línea con su progreso;
- mostrar los KPIs secundarios en una fila de 3, más compactos, o como lista.

## JSON

Ver `reviews/web-r5.json`: el campo `gaps` incluye todas las brechas abiertas, también las parciales que vienen de rondas anteriores.
