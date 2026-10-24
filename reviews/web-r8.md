# Revisión web — ronda 8 (`apps/web`)

- **Revisor:** «Revisor E» (independiente, solo lectura).
- **Fecha:** 24 de octubre de 2026.
- **Rama:** `claude/lucid-edison-hw6cla` (HEAD `fb5d70a`).
- **Referencias:**
  - `reviews/web-r7.md`: 7,9 frente a 8,0; altas W61–W63; medias W64 y W65; bajas W66, W67 y W10.
  - README de `apps/web`, sección «Respuesta a la revisión ronda 7».
- **Skills aplicadas:**
  - `visualization-review`;
  - `dataviz`;
  - `dashboard-design`;
  - `table-design`;
  - `run` (app real con Playwright).
- **Evidencia:** `RW8 = /tmp/claude-0/-home-user-Portfolio-Manager-Herramienta/8b757dea-bb3a-58bd-aa07-26758394d338/scratchpad/review-web8/`.
  - Scripts `*.mjs`, entre ellos:
    - `grup.mjs` (grupamentos), `w55multi.mjs` y `todos.mjs` (varios portafolios);
    - `inferred.mjs` (split inferido) y `twosplits.mjs` (dos splits en 7 días);
    - `dbl.mjs` (doble clic), `twins.mjs` (movimientos idénticos legítimos) y `newpf2.mjs` (importar a un portafolio nuevo);
    - `phonekpi.mjs` y `kpiscan.mjs`.
  - Capturas `shots/*.png`.
  - Registros `e2e.log`, `unit.log`, `tsc.log`, `br1.log`, `br2.log`, `co1.log`, `co2.log`, `co3.log` y `taxbr.log`.

## Veredicto

**No aprobado.**

La ronda cierra las tres brechas altas de R7:

- **W61:** todas las escrituras de un clic que probé con doble clic escriben una sola vez.
- **W62:** AMER3 1:100, IRBR3 1:30 y BHIA3 1:25 se avisan y se registran bien, con Bens e Direitos correcto.
- **W63:** ninguna cifra KPI se corta ni baja de 16 px, en 15 páginas a 390 y 360 px.

También cierra W65, W66 y casi todo W67. Las reglas de duplicados no son demasiado agresivas: dos aportes y dos compras idénticos el mismo día, por importación o por formulario, se conservan.

Pero **la corrección de W64 deja una brecha alta, W68**. Desde «Todos», «Registrar split» graba el split de NVDA en los dos portafolios, como se pedía. Cada portafolio queda bien (USD 21,17 M y USD 10,60 M), pero **la vista «Todos» muestra 1.500.000 NVDA y «Valor total USD 316.563.486»**, diez veces la suma real (≈ USD 31,8 M). Lo mismo sale en Posiciones y en el Informe, y persiste al recargar. Avisos solo dice «Posible duplicado: Split de NVDA del 10/06/2024 ya se importó».

La causa es que «Todos» une los movimientos de todos los portafolios en un único libro por activo, así que dos splits correctos (uno por portafolio) se aplican dos veces. Lo mismo pasa con las bonificações de una acción que está en dos corredoras.

| | Puntaje |
|---|---|
| **Portafolio Pro web (nuestro)** | **8,1 / 10** (R7 7,9) |
| **Sharesight (el mejor competidor)** | **8,0 / 10** |

El puntaje ya supera a Sharesight, pero **queda una brecha alta**, así que no se aprueba. Con W68 corregida, la nota sería ≈ 8,4 y se aprobaría.

### Comparación con los competidores

Los puntajes de los competidores salen de documentación pública y conocimiento previo; no se verificaron en vivo.

| Competidor | Puntaje | Dónde nos ganan | Dónde les ganamos |
|---|---|---|---|
| **Sharesight** | 8,0 | La vista consolidada de varios portafolios siempre cuadra; eventos aplicados solos; 200+ corredores | Impuestos CO/BR (DARF con multa/Selic, Bens e Direitos con grupamentos, F-160/210), mapa mensual con efecto precio/divisa, notas SINACOR, local-first, aviso de split pendiente en un clic |
| **Kubera** | ≈7,5 | Patrimonio total con bancos y cripto; multi-dispositivo | TWR/TIR mensual, impuestos, efecto divisa, informe cifrado |
| **Delta (eToro)** | ≈7,4 | Sincronización con corredores y exchanges; app nativa | Impuestos CO/BR, seguimiento mensual, privacidad local, eventos B3 |
| **Snowball Analytics** | ≈7,2 | Dividendos y eventos automáticos | Seguimiento mensual, impuestos, notas BR |
| **Morningstar (Investor / Portfolio Manager)** | ≈7,1 | X-Ray de exposición y datos de fondos | Mercados CO/BR, impuestos, multi-divisa, idiomas |
| **Ghostfolio** | ≈7,0 | Código abierto, autoalojable, multi-dispositivo | Impuestos, informe PDF/enlace, mapa mensual, efecto divisa |

## Cómo se probó

- **Verificaciones previas** (HEAD `fb5d70a`):
  - `npx tsc --noEmit -p apps/web`: sin errores.
  - `npm test -w @pm/web`: **146/146** (20 archivos).
  - **E2E:** **66 aprobadas y 1 omitida** (`live`).
    - Se corrió una copia de `apps/web/e2e` en `RW8/e2erun` con Chromium `/opt/pw-browsers`, contra el build propio en :4331.
    - `git status` quedó limpio.
- **Servidores:**
  - build propio en `RW8/dist`, servido con `vite preview` en **:4330** (`/api` → :8930);
  - servidor de datos en **:8930** con caché en frío y datos reales;
  - los dos servidores se detuvieron al terminar.
- **Doble clic** (`dbl.mjs`, sobre copias de los perfiles):
  - formulario «Agregar»;
  - «Agregar y nuevo» con dos clics separados por 350 ms;
  - «Nuevo» portafolio en Ajustes;
  - guardar meta;
  - confirmar importación;
  - «Registrar redención estimada»;
  - «Registrar todos» de la bandeja (230 proventos);
  - «Criar aporte nessa data»;
  - guardar el pago de DARF;
  - «Registrar split» del aviso;
  - «Sí, registrar» del split inferido;
  - confirmar la importación a un portafolio nuevo.

  Las alertas y la lista de seguimiento se revisaron en el código: `once` desde `0c6c13e` y `put` por instrumento.
- **Duplicados legítimos:**
  - `twins.csv` con dos aportes y dos compras idénticos el mismo día;
  - dos aportes idénticos por formulario;
  - dos splits distintos de NVDA en 4 días, inyectando una segunda acción del proveedor con `page.route`.
- **Grupamentos:**
  - `/api/batch` para AMER3, IRBR3, BHIA3, MGLU3, CMG y NVDA;
  - recorrido completo en pt-BR con 30.000 IRBR3 a R$ 0,70, 2.000 AMER3 a R$ 11,50 y 25.000 BHIA3 a R$ 0,46: aviso, doble clic, Posições, Rentabilidade y Bens e Direitos.
- **Varios portafolios:**
  - NVDA en «Cartera A» (10.000) y en «Portafolio 2» (5.000);
  - registro desde «Todos»;
  - vistas por portafolio y «Todos», con recarga;
  - Posiciones, Informe y Avisos en «Todos».
- **Split inferido:** proveedor sin acciones de split (`page.route`), aviso «Posible split», confirmación y doble clic.
- **Importar a un portafolio nuevo:**
  - nombre «Schwab USD» y moneda USD, con doble clic en confirmar;
  - vista previa abandonada sin confirmar.
- **Brasileño** (pt, BRL): asistente; B3 XLSX, SINACOR y XP; Resumen en BRL, EUR, COP y USD; Impostos 2024, 2023 y 2026 con DARF y XLSX.
- **Colombiano** (es, COP): Trii PDF, CDT y Trii CSV; Mensual en COP, BRL y USD; Impuestos 2025 con redención; Informe y PDF; enlaces sin y con contraseña, contraseña errónea, `hashchange` y enlace alterado.
- **Matriz de KPIs:**
  - portafolios «ballena» en es y pt;
  - 1920, 1440, 1366, 1280 y 1024 px en claro y oscuro, más zoom 125 %;
  - **teléfono:** 15 páginas a 390 px (es oscuro, ballena pt oscuro) y a 360 px (pt claro, ballena es claro).
- **Regresiones:** columnas (W56), desbordes a 360/768/1024 px (W59), textos (W60), jurisdicción de impuestos (W66), recarga a mitad de actualización (W49), `/mensual` en frío (W50), PWA sin conexión y primer render (742 kB y KPIs a los 607 ms).

## Estado de las brechas anteriores

| ID | Estado | Evidencia |
|---|---|---|
| **W61** (alta) | **Cerrada** | Doble clic → una sola escritura en: formulario (1 fila), «Agregar y nuevo» (1), «Nuevo» portafolio (1 → 2), meta (1), importación (+2), redención de CDT (+2, interés y venta), «Registrar todos» (0 → 230 proventos), «Criar aporte» (1 → 2), DARF (1 fila TAX), aviso de split (1 por portafolio) e inferido (1). Las duplicidades legítimas se conservan: 2 aportes y 2 compras idénticas por importación, y 2 aportes idénticos por formulario. |
| **W62** (alta) | **Cerrada** | El proveedor devuelve SPLIT 0,01 / 0,0333 / 0,04 para AMER3, IRBR3 y BHIA3. Aviso «3 desdobramentos não registrados…»; doble clic → 3 filas «Grupamento ×0,01…»; Posições 20 AMER3 (−99,42 %), 1.000 IRBR3 y 1.000 BHIA3; Patrimônio pasa de R$ 2.083.858 a R$ 73.740,60; Bens e Direitos «AMER3 20,00 ações… preço médio R$ 1.150,05». Ver W70 por el texto «desdobramento». |
| **W63** (alta) | **Cerrada** | Fase de teléfono (15 páginas × 4 perfiles): 0 cifras recortadas y 0 por debajo de 16 px. Impuestos a 390 px: «$ 33.117.970» entero en dos columnas (`m-co-dark-390-impuestos.png`). Mensual: etiquetas completas (`m-co-dark-390-mensual.png`). Las cifras compactas solo aparecen cuando hace falta («+$ 61.876 M», «$ 19.680 M» en la ballena a 360 px). |
| W64 (media) | **Cerrada por portafolio; deriva en W68 (alta) en «Todos»** | «Todos» dice «(en 2 portafolios)» y graba un SPLIT en cada uno. «Cartera A» queda en USD 21.169.491 y «Portafolio 2» en USD 10.597.995, sin aviso en ninguno. |
| W65 (media) | **Cerrada** | «+ Nuevo portafolio» con «Schwab USD / USD» y doble clic → un portafolio nuevo con 2 movimientos; «Portafolio Colombia» no cambia. Una vista previa abandonada no crea nada. |
| W66 (baja) | **Cerrada** | Los portafolios BRL abren en «DARF a pagar»; los COP, en «Patrimonio fiscal». Pestañas «CO Colômbia / BR Brasil». |
| W67 (baja) | **Cerrada en lo esencial** | El motor ya devuelve `data.unitFactor` y `data.accepted`. Sin acciones del proveedor, NVDA muestra «Posible split sin registrar… Lo deducimos de los precios de cierre… Confírmalo» con «Revisar y registrar» → «¿Registrar NVDA 10:1? Sí, registrar». Las notas de columnas usan el nombre corto («Ef. preço»). Queda el texto de Avisos (W70). |
| W10 (baja) | **Abierta** | Sin sincronización entre dispositivos ni con corredores o B3. |

**Sin regresiones** en:

- D1 en escritorio: 0 KPIs con más de una línea o recortados; mínimo de 16 px con zoom 125 %;
- W49, W50, W56, W58, W59 y W60;
- impuestos CO/BR, informe, enlaces y PWA sin conexión.

## Mejor que la competencia

1. **Eventos corporativos de B3 y EE. UU.** con aviso en el Resumen, registro en un clic idempotente y efecto inmediato en Bens e Direitos. Un split que solo se deduce de los precios pide confirmación.
2. **Impuestos de Colombia y Brasil** en la jurisdicción de cada portafolio.
3. **Seguimiento mensual** con efecto precio/divisa y columnas que se adaptan sin perder lo esencial.
4. **Cifras siempre legibles** de 1920 a 360 px, en dos idiomas, cuatro monedas, oscuro y zoom.
5. **Local-first:** PWA sin conexión, enlaces cifrados y tres idiomas.

## Peor que la competencia

1. **La vista consolidada «Todos» multiplica los splits y las bonificações** de una acción presente en varios portafolios (W68). Sharesight consolida sin errores.
2. **Sin sincronización con corredores ni multi-dispositivo** (W10).
3. **Dos eventos distintos del mismo activo a menos de 7 días** se reducen a uno sin avisar (W69).

## Brechas nuevas

### W68 — alta — «Todos» aplica dos veces el split (o la bonificação) de una acción presente en dos portafolios: 1.500.000 NVDA y USD 316 M

**Pasos** (`w55multi.mjs nvda2 Todos`, `todos.mjs`, `todos2.mjs`):
1. «Cartera A» con 10.000 NVDA (05-01-2023) y «Portafolio 2» con 5.000 NVDA (01-03-2023).
2. En «Todos», pulsar «Registrar split». El aviso dice «(en 2 portafolios)».

**Resultado:**

| Vista | Valor total | Correcto |
|---|---|---|
| «Cartera A» | USD 21.169.491 | Sí |
| «Portafolio 2» | USD 10.597.995 | Sí |
| **«Todos»** | **USD 316.563.486** | **No** (≈ USD 31,8 M) |

- **Posiciones en «Todos»:** **1.500.000 NVDA** (son 150.000) a costo USD 1,7177, con «+12.181,71 %».
- **Informe:** «Valor final USD 316.563.486».
- **Avisos:** solo «Posible duplicado: Split de NVDA del 10/06/2024 ya se importó», que es un texto engañoso: no es un duplicado ni una importación.
- **Tras recargar:** sigue igual.
- **Alcance:**
  - pasa también si el usuario registra el split en cada portafolio por separado, que es el camino correcto;
  - el código de bonificação (`stockDividend`) usa el mismo libro por activo, así que un brasileño con ITSA4 en XP y en Clear tendría el bônus aplicado dos veces en «Todos»;
  - «Todos» es la vista por defecto con más de un portafolio.

**Causa:**
- `apps/web/src/services/analysis.ts:209-218` (`buildEngineInput`): para `'all'`, pasa **todos** los movimientos a un solo portafolio ficticio;
- `packages/core/src/ledger.ts:1241-1250`: `split()` escala el libro **del activo** (`this.book(inst.id).scale(r)`) sin distinguir el portafolio de origen, y `stockDividend` hace lo mismo;
- dos filas SPLIT (una por portafolio) multiplican por r².

**Corrección:**
- en la vista consolidada, calcular cada portafolio por separado y sumar valoraciones, flujos y series (la TWR consolidada a partir de los flujos agregados);
- o, como mínimo, unir los eventos corporativos por (activo, fecha, razón) antes de pasar los movimientos al motor;
- quitar el aviso `DUPLICATE_IMPORT` para eventos de portafolios distintos;
- e2e: NVDA en dos portafolios, registro desde «Todos» y desde cada vista, y el valor de «Todos» igual a la suma de los dos.

### W69 — baja — Dos eventos distintos del mismo activo a menos de 7 días se reducen a uno sin avisar

**Pasos** (`twosplits.mjs`): con `page.route` se añade al proveedor un SPLIT 2:1 de NVDA el 2024-06-14, además del 10:1 del 2024-06-10.

**Resultado:**
- El aviso dice «2 splits sin registrar… Registrar los 2 splits».
- Al pulsar, se graba **solo el 10:1**. El 2:1 se descarta sin mensaje y el aviso desaparece, también después de recargar.

El caso es sintético; es raro en la práctica, porque la tolerancia de ±7 días busca unir el mismo evento con fecha anunciada y fecha efectiva.

**Causa:** `db/repo.ts:180-214` (`near()`, tolerancia de `EVENT_DATE_TOLERANCE_DAYS = 7` por tipo, `lib/writeGuard.ts`), sin tener en cuenta la razón.

**Corrección:** considerar «el mismo evento» solo con la misma razón, y avisar cuando se descarta una fila («El split 2:1 del 14/06 se omitió: ya hay uno el 10/06»).

### W70 — baja — Textos de eventos

- **pt:** los grupamentos se anuncian como «IRBR3: **desdobramento** 1:30… não registrado» (`i18n/pt.r5.ts:97-99` y `:116`). En portugués, un desdobramento aumenta las acciones; un 1:30 es un **grupamento**, que es como lo graba la nota («Grupamento ×0,0333»).
- **Avisos para un split inferido:** repite el texto de certeza «NVDA: split 10:1 … sin registrar. Hasta registrarlo, la cantidad, el valor y la rentabilidad están mal» (`pages/Dashboard.tsx:542-546`), mientras el aviso de arriba dice «Posible split… Confírmalo».
- **«Posible duplicado… ya se importó»** para dos splits de portafolios distintos (W68).

**Corrección:** usar «grupamento» cuando la razón es menor que 1 y el texto «posible» también en Avisos cuando el split se deduce de los precios.

## JSON

Ver `reviews/web-r8.json`: el campo `gaps` incluye todas las brechas abiertas.
