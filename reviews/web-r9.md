# Revisión web — ronda 9 (`apps/web`)

- **Revisor:** «Revisor E» (independiente, solo lectura).
- **Fecha:** 24 de octubre de 2026.
- **Rama:** `claude/lucid-edison-hw6cla` (HEAD `6f36f85`).
- **Referencias:**
  - `reviews/web-r8.md`: 8,1 frente a 8,0; alta W68; bajas W69, W70 y W10.
  - README de `apps/web`, sección «Respuesta a la revisión ronda 8».
  - Commits desde `20ffd34`, con la opción nueva `isolatePortfolios` del motor.
- **Skills aplicadas:**
  - `visualization-review`;
  - `dataviz`;
  - `dashboard-design`;
  - `table-design`;
  - `run` (app real con Playwright).
- **Evidencia:** `RW9 = /tmp/claude-0/-home-user-Portfolio-Manager-Herramienta/8b757dea-bb3a-58bd-aa07-26758394d338/scratchpad/review-web9/`.
  - Scripts `*.mjs`, entre ellos:
    - `sum.mjs`, con la comparación «Todos» = suma;
    - `transfer.mjs`, con un traslado entre portafolios;
    - `taxtodos.mjs`, `w55multi.mjs`, `twosplits.mjs`, `grup.mjs` e `inferred.mjs`.
  - Exportes de cada vista en `out/sum/`:
    - `*-mensual.csv` y `*-pos.csv`;
    - `*-kpis.txt`, `*-rend.txt`, `*-div.txt` y `*-divisas.txt`.
  - Capturas `shots/*.png`.
  - Registros `e2e.log`, `unit.log`, `unit-all.log`, `tsc.log`, `br1.log`, `br2.log`, `co1.log`, `co2.log`, `co3.log` y `taxbr.log`.

## Veredicto

**Aprobado.**

**W68 está corregida de raíz.** Con dos portafolios en monedas y métodos de costo distintos que comparten NVDA (split 10:1), ITUB4 (bonificações del 10 % y del 3 %) y AMER3 (grupamento 1:100), **«Todos» es la suma exacta de los portafolios**:

- **KPIs:** $ 771.134.439 + $ 439.403.245 = **$ 1.210.537.684**, y lo mismo para la ganancia total, el mes y el año.
- **Tabla mensual:** los 48 meses cuadran al peso en valor inicial, aportes, dividendos, comisiones, ganancia y valor final.
- **Posiciones:** misma cantidad y mismo valor en NVDA, ITUB4, PETR4, ECOPETROL y AMER3.
- **Dividendos y efecto divisa:** cuadran.
- **Otras cosas que cuadran:** el traslado de acciones entre portafolios, el CDT vencido, y Bens e Direitos en «Todos» (30 AMER3, 1.699,5 ITUB4, 1.500 NVDA).
- **Caso exacto de R8:** «Todos» vale USD 31.767.486 = 21.169.491 + 10.597.995, sin el falso «Posible duplicado».

**W69 y W70 están cerradas.** Las vistas de un solo portafolio no cambian: los recorridos brasileño y colombiano dan las mismas cifras que en R8.

Queda **una brecha media nueva, W71**. En «Todos» se usa el método de costo del primer portafolio para todos. Por eso el costo de ECOPETROL (FIFO en su portafolio) sale con costo promedio: la ganancia no realizada y el efecto precio difieren en $ 450.001. El valor, la ganancia total, la TWR y la tabla mensual no cambian.

| | Puntaje |
|---|---|
| **Portafolio Pro web (nuestro)** | **8,3 / 10** (R8 8,1) |
| **Sharesight (el mejor competidor)** | **8,0 / 10** |

**Supera estrictamente a Sharesight y no quedan brechas altas.** La limitación declarada de los impuestos consolidados (efectivo por fracciones y fusiones aproximados, porque el paquete de impuestos está congelado) queda fuera del alcance de la web. Se pondera como baja (W72).

### Comparación con los competidores

Los puntajes de los competidores salen de documentación pública y conocimiento previo; no se verificaron en vivo.

| Competidor | Puntaje | Dónde nos ganan | Dónde les ganamos |
|---|---|---|---|
| **Sharesight** | 8,0 | Sincronización con más de 200 corredores, eventos y dividendos aplicados solos, acceso del asesor, método de costo por portafolio en la vista consolidada | Impuestos CO/BR (DARF con multa/Selic, Bens e Direitos con grupamentos, F-160/210), mapa mensual con efecto precio/divisa, notas SINACOR, consolidación multi-moneda que cuadra al peso, local-first |
| **Kubera** | ≈7,5 | Patrimonio total con bancos y cripto; multi-dispositivo | TWR/TIR mensual, impuestos, efecto divisa, eventos corporativos |
| **Delta (eToro)** | ≈7,4 | Sincronización con corredores y exchanges; app nativa | Impuestos CO/BR, seguimiento mensual, eventos B3, privacidad local |
| **Snowball Analytics** | ≈7,2 | Dividendos y eventos automáticos | Seguimiento mensual, impuestos, notas BR, multi-moneda |
| **Morningstar (Investor / Portfolio Manager)** | ≈7,1 | X-Ray de exposición y datos de fondos | Mercados CO/BR, impuestos, multi-divisa, idiomas |
| **Ghostfolio** | ≈7,0 | Código abierto, autoalojable, multi-dispositivo | Impuestos, informe PDF/enlace, mapa mensual, efecto divisa |

## Cómo se probó

- **Verificaciones previas** (HEAD `6f36f85`):
  - `npx tsc --noEmit` en `apps/web`, `packages/core`, `packages/importers`, `packages/market-data` y `packages/tax`: sin errores.
    - `tsc -b` en la raíz no funciona porque no hay `tsconfig.json` raíz; no es un cambio de esta ronda.
  - `npm test -w @pm/web`: **155/155** (21 archivos).
  - `npx vitest run` en la raíz: **1.317 aprobadas y 19 omitidas** (85 archivos).
  - **E2E:** **69 aprobadas y 1 omitida** (`live`).
    - Se corrió una copia de `apps/web/e2e` en `RW9/e2erun` con Chromium `/opt/pw-browsers`, contra el build propio en :4341.
  - `git status` quedó limpio.
- **Servidores:**
  - build propio en `RW9/dist`, servido con `vite preview` en **:4340** (`/api` → :8940);
  - servidor de datos en **:8940** con caché en frío y datos reales;
  - los dos servidores se detuvieron al terminar.
- **«Todos» = suma** (`sum.mjs`):
  - **«Trii COP»** (COP, FIFO):
    - aporte de $ 50 M, USD 20.000 y R$ 30.000;
    - 1.000 AMER3;
    - ECOPETROL: 4.000 a $ 2.500 + 4.000 a $ 2.200, y **venta de 3.000** a $ 2.600;
    - 500 ITUB4;
    - 100 NVDA;
    - CDT de Bancolombia importado del PDF (vence el 09/01/2025).
  - **«XP BRL»** (BRL, costo promedio), creado con «+ Nuevo portafolio»:
    - R$ 100.000 y USD 10.000;
    - 2.000 AMER3 y 1.000 ITUB4;
    - PETR4: 500 a R$ 24 + 500 a R$ 32, y **venta de 400** a R$ 38;
    - 50 NVDA.
  - **En «Todos»:**
    - «Registrar los 2 splits» (NVDA y AMER3 «en 2 portafolios»);
    - «Registrar todos» en la bandeja (179 eventos: 175 dividendos y 4 bonificações).
  - **Exportes de cada vista** («Trii», «XP», «Todos») en COP: CSV de Mensual y de Posiciones, más los KPIs de Resumen, Rendimiento, Dividendos, Divisas y Avisos.
  - **Comparación con Python**, celda por celda.
- **Traslado de acciones entre portafolios** (`transfer.mjs`): `TRANSFER_OUT` de 100 AAPL en «IBKR» y `TRANSFER_IN` en «Schwab», más una venta en «Schwab».
- **Re-pruebas:**
  - W68 con el caso de R8 (`w55multi.mjs`);
  - W69: dos splits en 4 días (`twosplits.mjs`);
  - W70: grupamentos en pt (`grup.mjs`) y split inferido en Avisos (`inferred.mjs`);
  - impuestos en «Todos» (`taxtodos.mjs`).
- **Regresión de las vistas de un solo portafolio:**
  - **Brasileño** (pt, BRL): B3 XLSX, SINACOR y XP; Resumen en BRL, EUR, COP y USD; Impostos 2024, 2023 y 2026 con DARF y XLSX.
  - **Colombiano** (es, COP): Trii PDF, CDT y Trii CSV; Mensual en COP, BRL y USD; Impuestos 2025 con redención; Informe y PDF; enlaces sin y con contraseña, contraseña errónea y enlace alterado.
  - Las cifras son idénticas a las de R8: R$ 121.341,52; $ 39.806.729; DARF de R$ 110,82 → R$ 92,93; patrimonio fiscal de $ 34.182.384.
  - **Teléfono:** 15 páginas a 390 px (es, oscuro), a 360 px (pt, claro) y en «Todos» a 390 px.
  - **Matriz de KPIs** de «Todos»: 1920–1024 px en oscuro, más zoom 125 %.
  - **Otras:** columnas, desbordes a 360 px, doble clic (formulario, «Nuevo» portafolio, meta, «Registrar todos», «Criar aporte»), W49, W50, primer render (748 kB y KPIs a los 594 ms) y PWA sin conexión.

## Estado de las brechas anteriores

| ID | Estado | Evidencia |
|---|---|---|
| **W68** (alta) | **Cerrada** | Detalle en la tabla siguiente. Caso de R8: «Todos» USD 31.767.486 = 21.169.491 + 10.597.995, también tras recargar, sin «Posible duplicado». Con la mezcla de métodos de costo queda W71. |
| W69 (baja) | **Cerrada** | Con el 10:1 del 10-06 y el 2:1 inyectado del 14-06, «Registrar los 2 splits» graba **los dos**. |
| W70 (baja) | **Cerrada** | pt: «3 grupamentos não registrados… IRBR3: grupamento 1:30…» y nota «Grupamento ×0,0333». es: «AMER3: contrasplit 1:100». Avisos para un split inferido: «NVDA: posible split 10:1… (deducido de los precios, sin confirmar)». |
| W10 (baja) | **Abierta** | Sin sincronización entre dispositivos ni con corredores o B3. |

**Detalle W68** (comparación de `out/sum/*`, en COP):

| Qué | «Trii COP» + «XP BRL» | «Todos» | Diferencia |
|---|---|---|---|
| Valor total | 771.134.439 + 439.403.245 | 1.210.537.684 | 0 |
| Ganancia total | 592.596.042 + 292.891.455 | 885.487.497 | 0 |
| Este mes / En el año | −96.350.767 − 43.843.829 / −29.687.967 − 6.254.221 | −140.194.596 / −35.942.188 | 0 |
| Mensual (48 meses × 6 columnas) | suma | igual | máx. 0,00 |
| NVDA / ITUB4 / AMER3 / PETR4 | 1.500 / 1.699,5 / 30 / 600 acciones | iguales | 0 en cantidad y valor |
| Dividendos netos 2026 / 12 meses / retención | 2.145.641 + 2.352.797 / 3.060.947 + 4.531.300 / 511.556 + 255.778 | 4.498.438 / 7.592.247 / 767.334 | 0 |
| Efecto divisa (posiciones abiertas) | −379.741.402 − 208.671.092 | −588.412.494 | 0 |
| TWR / TIR | +331,92 % y +199,91 % / +44,48 % y +31,82 % | +272,42 % / +39,20 % | Entre las dos, como corresponde |
| Ganancia no realizada | 594.331.825 + 297.125.948 | 891.007.772 | **−450.001 (W71)** |
| Traslado AAPL IBKR → Schwab | 28.779,40 + 28.622,80 USD | 57.402,20 USD | 0 |

## Mejor que la competencia

1. **Consolidación multi-moneda que cuadra al peso**, con eventos corporativos registrados una vez por portafolio desde «Todos» y traslados entre portafolios.
2. **Impuestos de Colombia y Brasil**: DARF con multa/Selic, Bens e Direitos con grupamentos y bonificações, Formularios 160/210 y CDT vencido.
3. **Seguimiento mensual con efecto precio/divisa**, mapa de calor y columnas que se adaptan sin perder lo esencial.
4. **Eventos de B3 y EE. UU. visibles** en el Resumen, con registro idempotente en un clic; un split inferido pide confirmación.
5. **Cifras siempre legibles** de 1920 a 360 px; local-first, PWA sin conexión, enlaces cifrados y tres idiomas.

## Peor que la competencia

1. **Sin sincronización con corredores ni multi-dispositivo** (W10). Es la mayor diferencia con Sharesight, Delta y Snowball.
2. **Método de costo único en «Todos»** (W71). Sharesight respeta el método de cada portafolio.
3. **Eventos y dividendos que hay que confirmar a mano.** Es una decisión de diseño explicada («Nada se aplica sin tu confirmación»), pero los competidores los aplican solos.

## Brechas nuevas

### W71 — media — «Todos» aplica a todos los portafolios el método de costo del primero

**Pasos** (`sum.mjs`):
- «Trii COP» con método FIFO: ECOPETROL 4.000 a $ 2.500 + 4.000 a $ 2.200, y venta de 3.000;
- «XP BRL» con costo promedio, el que asigna BRL por defecto.

**Resultado** (`out/sum/*-pos.csv`, `*-divisas.txt`):

| Dato de ECOPETROL | En «Trii COP» | En «Todos» |
|---|---|---|
| Costo de las 5.000 acciones | $ 11.312.500 (FIFO) | **$ 11.762.500** (promedio) |
| Ganancia no realizada | $ 2.662.500 | **$ 2.212.500** |

- **Efecto en Divisas** («Todos»): «Ganancia no realizada» y «Precio (posiciones abiertas)» quedan **$ 450.001 por debajo** de la suma. La ganancia realizada de la venta de 2024 se desplaza en la misma cantidad.
- **Lo que no cambia:** valor, ganancia total, TWR, tabla mensual y dividendos.
- **Qué portafolio manda:** depende de cuál queda primero en `ds.portfolios`. Aquí fue «XP BRL», el creado después.

**Causa:**
- `apps/web/src/services/analysis.ts:215`: `costMethod: ds.portfolios[0]?.costMethod`;
- `packages/core/src/lots.ts:66`: `PortfolioBooks` crea todos sus `LotBook` con un único `method`.

**Corrección:**
- pasar en `EngineOptions` el método de cada portafolio (`portfolioCostMethods`, junto a `portfolioBaseCurrencies`);
- que `PortfolioBooks.part()` cree cada `LotBook` con el método de su portafolio;
- e2e: un portafolio FIFO y otro con costo promedio, y la ganancia no realizada de «Todos» igual a la suma.

### W72 — baja — Impuestos consolidados en «Todos»: limitación declarada

El README avisa de que, en «Todos», el efectivo por fracciones (*cash in lieu*) y las fusiones se aproximan en los informes de impuestos, porque `packages/tax` está congelado y `lib/consolidate.ts` solo une las copias de un evento.

En las pruebas, Bens e Direitos de «Todos» da cantidades y costos correctos (30 AMER3 a costo R$ 34.502, 1.699,5 ITUB4, 1.500 NVDA). Impuestos queda fuera del alcance de esta revisión web y los informes por portafolio no se ven afectados, así que se pondera como baja.

**Corrección** (cuando se descongele `packages/tax`): calcular los informes consolidados por portafolio y sumarlos, o pasar `isolatePortfolios` al motor fiscal.

## JSON

Ver `reviews/web-r9.json`: el campo `gaps` incluye todas las brechas abiertas.
