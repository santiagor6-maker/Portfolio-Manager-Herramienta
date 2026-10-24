# Revisión web — ronda 7 (`apps/web`)

- **Revisor:** «Revisor E» (independiente, solo lectura).
- **Fecha:** 24 de octubre de 2026.
- **Rama:** `claude/lucid-edison-hw6cla` (HEAD `428a76a`).
- **Referencias:**
  - `reviews/web-r6.md`: 8,0 frente a 8,0; brecha alta W55; medias W56 y W57; bajas W58–W60, W53, W54, W20 y W10.
  - `reviews/web-design-r1.md`: línea base de diseño.
  - README de `apps/web`, sección «Respuesta a la revisión ronda 6».
- **Skills aplicadas:**
  - `visualization-review` (P0, P1 y P2);
  - `dataviz`;
  - `dashboard-design` (jerarquía y prueba de 5 segundos);
  - `table-design` (prioridad de columnas);
  - `run` (app real con Playwright).
- **Evidencia:** `RW7 = /tmp/claude-0/-home-user-Portfolio-Manager-Herramienta/8b757dea-bb3a-58bd-aa07-26758394d338/scratchpad/review-web7/`.
  - Scripts `*.mjs`. Los de W55 son `w55a.mjs`, `w55multi.mjs`, `w55paths.mjs`, `w55paths2.mjs`, `w55more.mjs`, `amer2.mjs` y `after5.mjs`.
  - Capturas `shots/*.png`.
  - Registros `e2e.log`, `unit.log`, `tsc.log`, `br1.log`, `br2.log`, `co1.log`, `co2.log`, `co3.log` y `taxbr.log`.
  - Fixtures nuevos: `fx/nvda-b.csv`, `fx/splits-us.csv` y `fx/amer3.csv`.

## Veredicto

**No aprobado.**

**W55, el caso de R6, está corregida:** 10.000 NVDA compradas antes del split 10:1 muestran ahora un aviso rojo sobre los KPIs con «Registrar split». Un clic (incluso un doble clic sobre ese botón) escribe **un solo** SPLIT y el valor pasa de USD 2,18 M a USD 21,17 M. Avisos ya no dice «Todo en orden». También quedan cerradas W53, W56, W58, W59, W60 y W20, y W54 en el Resumen.

Al probar W55 de forma adversarial aparecieron, sin embargo, **tres brechas altas**:

1. **W61:** el mismo split, registrado desde el panel «Diagnóstico del motor» con un **doble clic**, se graba **dos veces**: 1.000.000 NVDA, **USD 211 M**, sin ningún aviso. «Criar aporte nessa data» duplica el aporte de la misma forma.
2. **W62:** los **grupamentos de B3** 1:25, 1:30 y 1:100 (BHIA3, IRBR3, AMER3) llegan del proveedor como «SPINOFF a revisar», y la web los descarta. Con 2.000 AMER3 compradas en 2022, el Resumen dice **«Tudo certo»**, Posições muestra 2.000 acciones (son 20) y el valor está **100 veces** por encima.
3. **W63:** el nuevo diseño de tarjeta del teléfono (etiqueta a la izquierda, cifra a la derecha), aplicado también a rejillas de dos columnas:
   - **corta la cifra** «$ 34.182.38**|**4» en Impuestos a 390 px, que es la regresión de D1;
   - lleva las cifras a 12–13,8 px;
   - parte etiquetas («Acumulad», «Rentabilid»).

Brechas medias:
- **W64:** con NVDA en dos portafolios, «Todos» registra el split solo en uno y oculta el aviso del otro durante la sesión.
- **W65:** «+ Nuevo portafolio» en Importar escribe en el portafolio existente.

| | Puntaje |
|---|---|
| **Portafolio Pro web (nuestro)** | **7,9 / 10** (R6 8,0) |
| **Sharesight (el mejor competidor)** | **8,0 / 10** |

La ronda arregla mucho: columnas, compacto en español, desbordes, textos, carga inicial y el caso NVDA. Pero introduce una regresión de D1 en el teléfono y deja dos caminos por los que la cifra principal queda falsa en silencio (×100 hacia arriba). Por eso la nota baja una décima.

**Cómo mejora la nota:**
- **≈ 8,3:** con W61, W62 y W63 corregidas.
- **≈ 8,5:** con W64 y W65 también, por encima de Sharesight.

### Comparación con los competidores

Los puntajes de los competidores salen de documentación pública y conocimiento previo; no se verificaron en vivo.

| Competidor | Puntaje | Dónde nos ganan | Dónde les ganamos |
|---|---|---|---|
| **Sharesight** | 8,0 | Splits, grupamentos y dividendos aplicados solos y una sola vez; 200+ corredores; acceso del asesor | Impuestos CO/BR (DARF con multa/Selic, Bens e Direitos, F-160/210), mapa mensual con efecto precio/divisa, notas SINACOR, local-first |
| **Kubera** | ≈7,5 | Patrimonio total con bancos y cripto; multi-dispositivo | TWR/TIR mensual, impuestos, efecto divisa, informe cifrado |
| **Delta (eToro)** | ≈7,4 | App móvil pulida (sus tarjetas no recortan cifras); sincronización con corredores y exchanges | Impuestos CO/BR, seguimiento mensual, privacidad local |
| **Snowball Analytics** | ≈7,2 | Dividendos y eventos que se registran solos | Seguimiento mensual, impuestos, notas BR |
| **Morningstar (Investor / Portfolio Manager)** | ≈7,1 | X-Ray de exposición, datos de fondos | Mercados CO/BR, impuestos, multi-divisa real, idiomas |
| **Ghostfolio** | ≈7,0 | Código abierto, autoalojable, multi-dispositivo | Impuestos, informe PDF/enlace, mapa mensual, efecto divisa |

## Cómo se probó

- **Verificaciones previas** (HEAD `428a76a`):
  - `npx tsc --noEmit -p apps/web`: sin errores.
  - `npm test -w @pm/web`: **130/130** (19 archivos).
  - **E2E:** **60 aprobadas y 1 omitida** (`live`).
    - Se corrió una copia de `apps/web/e2e` en `RW7/e2erun` con Chromium `/opt/pw-browsers`, contra el build propio en :4321.
    - `git status` quedó limpio.
- **Servidores:**
  - build propio en `RW7/dist`, servido con `vite preview` en **:4320** (`/api` → :8920);
  - servidor de datos en **:8920** con caché en frío y datos reales (Yahoo, TRM, IBR, IPC);
  - BCB, IBGE, FRED y BCE no responden desde el contenedor, así que aparece «CDI não disponível»;
  - los dos servidores se detuvieron al terminar.
- **W55, de forma adversarial:**
  1. **NVDA 10:1 en un solo portafolio** (USD): aviso, KPIs y Avisos antes; **doble clic** en «Registrar split»; filas SPLIT en IndexedDB; recarga; bandeja; Posiciones.
  2. **NVDA en dos portafolios** (10.000 en «Cartera A» y 5.000 en «Portafolio 2»): aviso en «Todos» y en cada portafolio; registro desde «Todos» y desde «Portafolio 2»; filas SPLIT por portafolio; sesión y recarga.
  3. **Diagnóstico frente a bandeja:** abrir «Diagnóstico del motor», **doble clic real** en «Registrar split 10:1» y después la bandeja.
  4. **Otras razones:**
     - WMT 3:1 (2024-02-26), que es una razón «débil» por precios pero viene del proveedor;
     - CMG 50:1 (2024-06-26);
     - AMER3 (grupamento 100:1, 2024-08-27).

     Se revisaron las acciones del proveedor para MGLU3, IRBR3, OIBR3, CASH3 y BHIA3 en `/api/batch`.
  5. **Lectura de código:**
     - `lib/pendingEvents.ts`: deduplicación, regla `info`/`warning`, la expresión `accepted because`;
     - `components/DiagnosticsPanel.tsx`;
     - `pages/Dashboard.tsx`;
     - `packages/core/src/ledger.ts` (umbral «strong»);
     - `packages/market-data/src/corporate.ts`.
- **Brasileño** (pt, BRL):
  - asistente;
  - B3 XLSX, nota SINACOR y nota XP;
  - Resumen en BRL, EUR, COP y USD;
  - Impostos 2024 (DARF vencida → «Paga em atraso» R$ 92,93), 2023 y 2026, con XLSX.
- **Colombiano** (es, COP):
  - Trii PDF, CDT y Trii CSV;
  - Mensual en COP, BRL y USD;
  - MXN sin tasa;
  - Impuestos 2025 con redención estimada;
  - Informe en pantalla y en PDF;
  - enlace sin y con contraseña, contraseña errónea, `hashchange` y enlace alterado.
- **Matriz de KPIs:**
  - portafolios «ballena» COP 81.437.103.106 y R$ 143.852.932,10, en es y pt;
  - COP, BRL, USD y EUR;
  - 1920, 1440, 1366, 1280, 1024, 390 y 360 px;
  - claro, oscuro y zoom 125 %;
  - páginas Resumen, Rendimiento, Impuestos y Divisas.
- **Teléfono:** 390 px (es, oscuro) y 360 px (pt, claro) en 10 páginas, buscando cifras recortadas, tamaños por debajo de 16 px y etiquetas cortadas.
- **Regresiones:**
  - W49: recarga a mitad de la actualización;
  - W50: `/mensual` en frío;
  - W56: columnas ocultas a 1440 y 1280 px;
  - W59: desbordes a 360, 768, 1024 y 1280 px;
  - textos en es y pt;
  - captura de página completa (W58);
  - primer render (W20);
  - PWA sin conexión;
  - doble clic en las acciones del Diagnóstico;
  - Importar a «+ Nuevo portafolio».
- **Capturas revisadas a ojo**, entre otras:
  - `nvda1-before.png`, `nvda5-diag-open.png`, `nvda2-banner-Todos.png`;
  - `crop-co-imp-390.png`, `crop-co-div-390.png`;
  - `m-co-dark-390-mensual.png`, `m-co-dark-390-dash.png`;
  - `br-dash-BRL.png`, `inbox-br-1280.png`, `us-splits-dash.png` y `amer-dash.png`.

## Estado de las brechas anteriores

| ID | Estado | Evidencia |
|---|---|---|
| **W55** (alta) | **Cerrada en el caso de R6, con derivados abiertos (W61, W62 y W64)** | **NVDA en un portafolio:** aviso rojo «Split sin registrar en una posición: NVDA: split 10:1 del 10 de jun de 2024…» con «Registrar split». Un doble clic sobre ese botón escribe **1** fila SPLIT y el valor pasa de USD 2.183.091 a USD 21.169.491. Posições muestra la *chip* «split pendiente». Avisos cuenta los splits y la bandeja («236 eventos corporativos ou proventos anunciados a registrar»); Proventos y la tarjeta de dividendos muestran «230 proventos anunciados não registrados · Registrar». **WMT 3:1 y CMG 50:1:** aviso con «Registrar los 2 splits». **AMER3:** nada (W62). |
| W56 (media) | **Cerrada** | Posições (pt) a 1440 px oculta solo «Ef. preço» (igual a «Ganho»); a 1280 px, también «Ef. câmbio». Mensal (pt) a 1280 px: Aportes/resgates y Proventos visibles; ocultas «Ef. preço», «Ef. câmbio» y «Acumulada». |
| W57 (media) | **Cerrada en escritorio; regresión en el teléfono (W63)** | Escritorio: un solo tamaño por fila (17,6/17,6/17,6 px a 1440 px; 16,2 px a 1280 px). Compacto en español: «+$ 61.876 M», sin «MRD»; en pt, «+COP 11,7 bi». Teléfono: ver W63. |
| W58 (baja) | **Cerrada** | Tres capturas de página completa seguidas no activan el compacto («+R$ 3.730,04» se mantiene). Hay protección para ancho 0 en `ui.tsx:226`. |
| W59 (baja) | **Cerrada** | Divisas a 360 px: `scrollWidth` 360 (perfiles `co` y ejemplo). Mapa de calor con meses de tres cifras: sin desborde a 768, 900, 1024 ni 1100 px. Bandeja a 1280 px: «Registrar» visible y sin barra. |
| W60 (baja) | **Cerrada** | «…não atribuídos à vista: 0,07.», «Se agregó 1 activo nuevo», sin fechas ISO en Movimientos, sin «npm run dev:server» en los avisos (MXN bloqueado: solo «Sin tasa COP/MXN · Reintentar»), resúmenes con «(24 de oct de 2026)». |
| W53 (baja) | **Cerrada** | Ver W60. |
| W54 (baja) | **Cerrada en el Resumen; regresión en otras páginas (W63)** | Resumen a 390 px: secundarias en una fila (etiqueta a la izquierda, cifra a la derecha) y el área del gráfico empieza en y ≈ 752–785 de 844. |
| W20 (baja) | **Cerrada** | Primera visita: **732 kB** antes de los KPIs (811 en R6) y KPIs a los **666–677 ms**. |
| W10 (baja) | **Abierta** | Sin sincronización entre dispositivos ni con corredores o B3. |

Sin regresiones en:

- W49 (reintento inmediato tras la recarga);
- W50 (Ibovespa en frío, S&P 500 en USD);
- W40 (MXN sin tasa → «—»);
- impuestos CO/BR, informe y enlace;
- PWA sin conexión;
- desktop D1 (0 cifras con más de una línea o recortadas en toda la matriz de escritorio).

## Mejor que la competencia

1. **Split pendiente visible y reparable en un clic desde el Resumen**, con la cifra correcta al instante y una *chip* en Posiciones.
2. **Impuestos de Colombia y Brasil** con DARF recalculada, Bens e Direitos con CNPJ, CDT vencido y XLSX.
3. **Seguimiento mensual con efecto precio/divisa** y columnas que, cuando falta espacio, sacrifican primero lo redundante.
4. **Notas de corretagem en PDF**, enlaces cifrados, PWA sin conexión, tres idiomas y modo oscuro.

## Peor que la competencia

1. **Eventos corporativos.** Sharesight aplica splits y grupamentos una sola vez y de forma automática. Aquí un doble clic lo duplica (W61), los grupamentos de B3 de 1:25 en adelante se pierden (W62) y varios portafolios quedan a medias (W64).
2. **Teléfono:** cifras cortadas y etiquetas partidas en Impuestos, Mensual, Dividendos y Rendimiento (W63). Delta y Sharesight nunca cortan una cifra en el móvil.
3. **Importar a un portafolio nuevo** escribe en otro (W65).
4. **Sin sincronización con corredores ni multi-dispositivo** (W10).

## Brechas nuevas

### W61 — alta — Un doble clic en «Registrar split 10:1» del Diagnóstico registra el split dos veces (×100) sin aviso; «Criar aporte» también se duplica

**Pasos:**

1. **Split** (`w55paths2.mjs`, `shots/nvda5-diag-open.png`):
   1. Portafolio con 10.000 NVDA a USD 142,65 (05-01-2023).
   2. En Movimientos, abrir «Diagnóstico del motor»: muestra «Posible split sin registrar… [Registrar split 10:1]».
   3. Hacer doble clic en el botón.
2. **Aporte** (`dep2.mjs`): en el perfil brasileño, doble clic en «Criar aporte nessa data».

**Resultado del split:**
- **IndexedDB:** dos filas `SPLIT XNAS:NVDA 2024-06-10 ×10` («Split sugerido por el historial de precios»).
- **Resumen** (`after5.mjs`, `shots/nvda5-dash-double.png`):
  - «Valor total **USD 211.033.491,00**», cuando el valor real es ≈ USD 21,1 M;
  - ningún aviso rojo;
  - Avisos solo muestra «15 eventos… por registrar»;
  - el Diagnóstico queda vacío.
- **Posiciones:** **1.000.000** NVDA a costo USD 1,4265.

**Resultado del aporte:** dos aportes «2023-03-10 1605 BRL» idénticos.

El aviso rojo del Resumen y la bandeja sí están protegidos (`busy` y `applied`), pero estos botones no.

**Causa:**
- `components/DiagnosticsPanel.tsx:191` (`record-split`) y `:153` (`create-deposit`) no tienen estado `busy`/`disabled` ni comprobación de que el evento ya exista;
- `recordSplit` (`DiagnosticsPanel.tsx:24-29`) escribe sin buscar un SPLIT existente del mismo instrumento y fecha;
- el motor no avisa de dos SPLIT del mismo instrumento el mismo día.

**Corrección:**
- `busy` y `disabled` en todas las acciones de un clic del Diagnóstico;
- `recordSplit` y `createDepositFor` idempotentes (no escribir si ya existe un SPLIT o un aporte con la misma clave);
- en el motor o en la web, un aviso «SPLIT duplicado» cuando hay dos el mismo día;
- prueba e2e con `dblclick()` en cada acción.

### W62 — alta — Los grupamentos de B3 de 1:25, 1:30 y 1:100 se pierden: «Tudo certo» con la posición 100 veces por encima

**Pasos** (`w55more.mjs amer pt-BR BRL amer3.csv`, `amer2.mjs`):
1. Portafolio BRL (pt) con 2.000 AMER3 a R$ 11,50 (05-12-2022).
2. Americanas hizo un grupamento 100:1 el 27-08-2024: el cierre pasa de R$ 0,05 a R$ 7,00.

**Resultado:**
- **Resumen:** sin aviso rojo, **«Avisos: Tudo certo · Todos os ativos têm preço e câmbio»**, «Patrimônio R$ 40.260,00».
- **Posições:** **2.000 AMER3** a R$ 6,63, R$ 13.260. En realidad son 20 acciones (R$ 132,60).
- **Rentabilidade:** TWR −19,48 %, cuando la real es ≈ −99 %.
- **Movimentações:** solo una fila «27/08/2024 · Revisar · AMER3 · **SPLIT (SPINOFF)** — classificação incerta: registre manualmente se aplicar», con códigos internos en inglés y sin botón.
- **Mismo problema en el proveedor:**
  - IRBR3, grupamento 30:1 (2023-01-25, R$ 0,93 → R$ 22,06);
  - BHIA3, grupamento 25:1 (2023-12-15, R$ 0,50 → R$ 11,17).

  Los de 10:1 (MGLU3, OIBR3, CASH3) sí llegan como SPLIT 0,1.

**Causa:**
- `packages/market-data/src/corporate.ts:75-86`: un factor con `num` o `den` mayor que 20 se trata como SPINOFF con `reviewRequired`, aunque el comentario dice «fuera de Brasil»;
- `apps/web/src/lib/pendingEvents.ts:49` descarta `subtype === 'SPINOFF'`, y los `review` no cuentan en Avisos (`pages/Dashboard.tsx`);
- el detector de precios del motor (`packages/core/src/ledger.ts:597-602`) no reconoce saltos de ×22–×140 (tolerancia del 3 %);
- `components/SuggestionsInbox.tsx:98` muestra `a.type` y `a.subtype` sin traducir.

**Corrección:**
- en `corporate.ts`, para B3 (`.SA`), tratar como grupamento (SPLIT `ratio = 1/k`) los factores 1:k con k entero cuando el precio salta ≈ k veces;
- en la web, contar los `review` de posiciones abiertas como aviso **rojo** en el Resumen («AMER3: evento de 27/08/2024 sin clasificar; si fue un grupamento 100:1, la cantidad está mal · Registrar grupamento 100:1 · Ignorar»);
- traducir el tipo;
- prueba e2e con AMER3, IRBR3 y BHIA3.

### W63 — alta — Teléfono: la tarjeta en una fila corta cifras y etiquetas en las rejillas de dos columnas (regresión de D1)

**Pasos** (`phonekpi.mjs`, `cropkpi.mjs`): perfiles `co` (es, oscuro) a 390 px y `br` (pt, claro) a 360 px, en 10 páginas.

**Resultado:**

| Página | 390 px (es) | 360 px (pt) |
|---|---|---|
| **Impuestos / Impostos** | «Patrimonio fiscal al…» **«$ 34.182.38»** (75 px de caja para 85 px de cifra, sin elipsis), a 12 px; «Dividendos (COP)» «$ 0» a 12 px (`crop-co-imp-390.png`) | «COP 90.919.715» **recortada** (67/104 px), a 12 px |
| **Mensual / Mensal** | Etiquetas «Rent. Sept de…» y **«Acumulad»**; cifras a 15,3 px (`m-co-dark-390-mensual.png`) | «Rent. Set de 2026» cortada; 13,6 px |
| **Dividendos** | «$ 75,6 mil» compacto a 13,8 px, aunque «$ 75.600» cabría a lo ancho; «Rentabilid sobre…» (`crop-co-div-390.png`) | — |
| **Rendimiento** | «Volatilidad» cortada | 15,8 px; «% do índice de juros» cortada |
| **Ballena (es) a 360 px** | Rendimiento 12 / 12 / 14,1 px; Impuestos «$ 19.680.404.427» recortada (67/113) | — |

El README dice que la cifra «nunca baja de 16 px», pero eso solo se cumple en los KPIs con `valueCompact`. El resto baja a `MIN_FIT` (12 px) y se recorta con `overflow-hidden`, sin elipsis.

**Causa:**
- `components/ui.tsx:179` aplica `max-sm:grid-cols-[minmax(0,1fr)_minmax(0,1.25fr)]` (etiqueta y cifra lado a lado) a **todos** los KPIs no principales, también dentro de rejillas de 2 columnas de 173 px;
- `:233-236`: sin `compactNode`, el tamaño baja a 12 px;
- `:250`: `overflow-hidden`.

**Corrección:**
- usar el diseño en una fila solo cuando la tarjeta ocupa todo el ancho (rejilla de 1 columna, como en el Resumen); en rejillas de 2 columnas, cifra debajo de la etiqueta, o una sola columna en el teléfono;
- `valueCompact` en todos los KPIs monetarios;
- si aun así no cabe, elipsis con `title`, nunca un recorte silencioso;
- e2e de `kpiProblems` a 390 y 360 px en Impuestos, Mensual, Dividendos y Rendimiento.

### W64 — media — NVDA en dos portafolios: «Todos» registra el split en uno solo y oculta el aviso del otro

**Pasos** (`w55multi.mjs nvda2 Todos` y `w55multi.mjs nvda3 "Portafolio 2"`):
- «Cartera A»: 10.000 NVDA;
- «Portafolio 2»: 5.000 NVDA a USD 230 (01-03-2023).

**Resultado:**
- **«Todos» antes del clic:** «Split sin registrar **en una posición**».
- **Tras el clic:** IndexedDB guarda **una** fila SPLIT, en «Cartera A». El aviso desaparece en todas las vistas, también en «Portafolio 2», que sigue en USD 1.104.795 cuando debería valer ≈ USD 10,6 M. El total de «Todos» queda en USD 31,8 M, ≈ USD 10 M por debajo.
- **Avisos:** sí sigue mostrando la línea del split, más abajo en la página.
- **Tras recargar:** el aviso rojo vuelve.
- **Registrando desde la vista «Portafolio 2»:** escribe en el portafolio correcto, sin escribir en el otro.

**Causa:**
- `lib/pendingEvents.ts:52-53`: la clave `instrumentId|date` une las sugerencias de los dos portafolios y conserva una sola;
- `pages/Dashboard.tsx:292-295`: el conjunto `applied` oculta esa clave en todas las vistas hasta que se desmonta.

**Corrección:**
- agrupar por instrumento y fecha, pero guardar **todas** las sugerencias (una por portafolio) y aceptarlas juntas;
- texto «en 2 portafolios»;
- incluir `portfolioId` en la clave de `applied`.

### W65 — media — «+ Nuevo portafolio» en Importar escribe en el portafolio existente

**Pasos** (`newpf.mjs`): en un perfil con «Portafolio Colombia», ir a Importar, elegir «Portafolio destino: + Nuevo portafolio» e importar `nvda-b.csv` (un aporte USD y una compra NVDA).

**Resultado:** no se crea ningún portafolio. «Portafolio Colombia» pasa de 13 a **15** movimientos: los de un corredor en USD terminan en el portafolio COP.

**Causa:** `pages/Import.tsx:67-71` (`resolvePortfolio`): con `'__new'`, si existe algún portafolio, devuelve `writable[0]`. Viene del primer commit.

**Corrección:** con `'__new'`, crear siempre un portafolio (pidiendo nombre y moneda en el mismo paso) y añadir una prueba e2e.

### W66 — baja — Impostos abre en Colombia para un portafolio BRL en pt

**Resultado:** en los tres perfiles brasileños (`taxdefault.mjs`), Impostos muestra primero «Patrimônio fiscal… **COP 90.919.715**». La pestaña dice «🇨🇴 **Colombia**» en pt, cuando debería ser «Colômbia».

**Causa:**
- `pages/Taxes.tsx:25`: el país depende de `taxResidence`, que el asistente no rellena para BRL;
- `:61`: etiqueta fija.

**Corrección:**
- si no hay `taxResidence`, usar el país de la moneda base del portafolio;
- etiquetas con i18n;
- *chips* «CO» y «BR» como en D17.

### W67 — baja — Acoplamiento frágil al texto del motor y avisos inferidos presentados como certeza

**Lectura del texto en inglés del motor:**
- `lib/pendingEvents.ts:20` decide si un `TRADE_PRICE_UNIT_SUSPECT` ya fue aceptado buscando `/accepted because/` en el mensaje (`packages/core/src/ledger.ts:506`, sin `data`);
- `DiagnosticsPanel.tsx:170` saca el factor con `unitFactor(d.message)`.

Si el motor cambia la redacción, los avisos aceptados volverían a contar en Avisos. El error iría hacia más avisos, no hacia el silencio, pero es una dependencia no tipada.

**Avisos inferidos como certeza:** un split **inferido de precios** (`source: 'prices'`) usa el mismo aviso rojo y el mismo texto («la cantidad, el valor y la rentabilidad están mal») y se registra en el mismo clic que uno del proveedor. Los saltos «débiles» (≤ 3:1, `info`) no avisan; está bien para no alarmar, pero sin proveedor un 2:1 real pasaría sin aviso.

**Además:** la nota de columnas ocultas en Posiciones usa la descripción larga («Parte do ganho explicada pela variação de preço na moeda do ativo») en vez del encabezado «Ef. preço».

**Corrección:**
- `data: { accepted: true, unitFactor }` en el motor;
- para `source: 'prices'`, el texto «Posible split…» con confirmación;
- nombre corto en la nota.

## JSON

Ver `reviews/web-r7.json`: el campo `gaps` incluye todas las brechas abiertas.
