# Revisión del motor de cálculo (`packages/core`), ronda 2

Revisor externo. Solo lectura sobre el código. Fecha: 2026-10-06.
Base: `reviews/core-r1.md` y la sección "Respuesta a la revisión ronda 1" de `packages/core/README.md`.

## Veredicto

**No aprobado, pero hay un salto grande.** De los 21 hallazgos de la ronda 1 verifiqué
**20 como resueltos** con mis propios scripts. El que sigue abierto es C4, que queda resuelto solo
en parte. En funciones, el motor ahora supera a Portfolio Performance para un inversionista de
Colombia o Brasil:

- renta fija por devengo;
- % del CDI;
- rentabilidad real;
- cascada en dinero que cuadra al peso;
- rentabilidad por posición;
- acciones corporativas.

Sin embargo, las pruebas nuevas encontraron **3 problemas de severidad alta**. Dos de ellos son
regresiones introducidas por los propios arreglos:

1. **Split o spin-off en un día con flujo: el TWR se rompe** (−25 % en un mes con precio plano).
2. **La caché del motor devuelve resultados viejos o corruptos** cuando el llamador modifica los
   datos en el mismo objeto, o modifica lo que el motor devolvió.
3. **La redención automática al vencimiento reemplaza el pago real** que registra el usuario. Así se
   pierde la retención en la fuente y aparece un `OVERSELL`.

| | Puntaje (0–10) |
|---|---|
| **Nuestro motor (`@pm/core`)** | **7,0** (ronda 1: 5,5) |
| **Mejor competidor para este caso: Portfolio Performance** | **8,0** |

`approved = false`: el puntaje no supera al del competidor y hay 3 hallazgos altos.

Comprobaciones hechas:
- `npx vitest run packages/core`: 160/160 pruebas pasan. `npx tsc -p packages/core --noEmit` no da
  errores.
- Volví a ejecutar los 7 scripts de la ronda 1. Escribí 6 nuevos (`r2-a-twr.ts`,
  `r2-b-fixed.ts`, `r2-c-index.ts`, `r2-d-corp.ts`, `r2-e-cache.ts`, `r2-f-misc.ts`) en
  `/tmp/claude-0/-home-user-Portfolio-Manager-Herramienta/8b757dea-bb3a-58bd-aa07-26758394d338/scratchpad/review-core/`.

### Sobre los dos esperados que el constructor disputa

- **S2a. Tiene razón.** Mi fuerza bruta usaba la convención anterior: "entrada al inicio del día".
  Con la convención nueva (el día se parte en el momento de las operaciones), la tabla mensual y el
  resumen coinciden entre sí hasta 1e-9 (R3). La vista en USD es coherente con la vista en COP
  multiplicada por la FX: febrero, marzo y abril difieren 0,00e+0.
- **S2b. Tiene razón en lo esencial.** Mi esperado de 10 % suponía que el aporte de 4.000 pagaba un
  saldo negativo (margen). Con la semántica nueva, el faltante del retiro es un aporte implícito no
  registrado. Entonces no hay valores negativos, enero da 10 % y en febrero los 4.000 quedan como caja
  ociosa. **2,16 % es el TWR correcto** bajo esa convención, y la convención es razonable para un
  usuario que solo registra operaciones. Además queda el aviso `WITHDRAWAL_EXCEEDS_CASH`. Lo doy
  por resuelto.

---

## Arreglos verificados (20)

| ID | Verificación independiente |
|---|---|
| C1 | S3a = 25 %, S3b = 25 %, S7b = 10 %, S2d = 50 % exactos. La tabla mensual coincide con el resumen (cadena diaria) hasta 1e-9 en un portafolio aleatorio de 3 divisas y 120 movimientos (R3). *Ver C22: regresión nueva en días con split.* |
| C2 | S1a: 30 acciones, ganancia 0. S1e: 0 acciones fantasma. |
| C3 | CDT 12 % E.A. ACT/365 = 11.196.523,06 exacto. CDB 110 % do CDI con CDI diario (SGS 12) exacto en 260 días. IPCA+6 % devenga. El precio manual re-ancla (F7 exacto). La redención automática funciona. *Ver C24, C29, C31 y C32.* |
| C5 | `positionPerformance`: la suma de los retornos por posición + divisa de caja + costos sueltos = ganancia del portafolio hasta 1e-6 (R3). *Ver C28 (fusiones).* |
| C6 | S5g: la caja queda en 1.000, no 1.500. |
| C7 | S2b sin valores negativos; umbral relativo; avisos `DEGENERATE_SUBPERIOD`. |
| C8 | Base EUR sin datos: `missingFx` en filas y resumen. El par directo viejo pierde frente a la triangulación fresca (S5c: 672,73). |
| C9 | Cascada exacta en todos los meses de R3 y en S4d (2.237.080 = suma de componentes). `RealizedGain.fxGainBase` = 400.000 en S7f. |
| C10 | `filter.accounts`, `NEGATIVE_ACCOUNT_QTY`. *Ver C30.* |
| C11 | Cash in lieu (K4 exacto); fusión + cambio de ticker conservan costo y fecha de compra (K5: realizado 70); dividendo posterior a un split usa las cantidades post-split (K3). *Ver C26, C27 y C28.* |
| C12 | S7a: TWR 10 %, aportes 4.000.000 (sin duplicar). |
| C13 | Benchmark de retorno total igual al portafolio con el mismo ETF y su dividendo. |
| C14 | La fecha con hora se rechaza en el libro (`INVALID_DATE`); ya no cambia de mes. |
| C15 | S4b: TWR = TWR anualizado = MWR = 20 % en 2024 (año bisiesto). `mwrPeriod`, `multipleRoots`. |
| C16 | `monthsUsed` = 4: se excluye el mes parcial. |
| C17 | `stalePrices` marca un precio de 2021 usado en 2024. |
| C18 | `fxSpreadBase` = 80.000 en una conversión con 2 % de spread. |
| C19 | `INCOME_WITHOUT_POSITION` en el libro y en el validador. |
| C20 | 30.000 movimientos: 11 resúmenes en 0,68 s (antes 1,74 s); serie diaria de 15 años en 2 ms con el motor ya calentado. *Ver C23: la caché introduce riesgos.* |
| C21 | `goalProjection`: valor futuro y aporte requerido coinciden con la fórmula de anualidad (K7). *Ver C35.* |

## Mejor que los competidores

1. **Renta fija por devengo más índices de tasa.** CDT E.A., CDB % CDI, IPCA+ y re-anclaje con precio
   manual, junto con "% del CDI" por mes y por periodo. Esto iguala a Gorila y Kinvo en renta fija, y
   ninguno de los dos tiene multi-divisa real.
2. **Cascada en dinero que cuadra exactamente.** Realizada + no realizada + ingresos + divisa de caja
   + spread + costos sueltos + transferencias + acciones corporativas + diferencia de tasa ejecutada.
   Más fina que la de Sharesight (capital/dividendos/divisa) y que la de PP.
3. **TWR con el día partido en la operación**, más precios de operación como observación. Es correcto
   aun con precios solo de fin de mes. PP usa entradas al inicio del día y falla en S3a.
4. **Separación local/divisa del TWR mensual** y divisa en dinero en ventas realizadas, no realizadas
   y caja.
5. **Rentabilidad por posición** con TWR, IRR, IRR del periodo y parte en divisa, y que reconcilia con
   el total.
6. **Base de días coherente (ACT/ACT)** en TWR, MWR e IRR, con aviso de raíces múltiples.
7. **Rendimiento.** Con 30.000 movimientos, todo el tablero tarda menos de 1 s.

## Peor que los competidores

1. **Corporate action + flujo el mismo día rompe el TWR** (C22). PP no tiene este problema.
2. **Riesgo de datos viejos o corruptos por la caché** (C23). PP y Sharesight no tienen este tipo de
   error.
3. **Vencimientos de renta fija** (C24). Gorila y Kinvo concilian con el pago real y muestran el valor
   líquido (C31).
4. **Rentabilidad real de los periodos que terminan hoy:** casi nunca disponible, por el rezago del IPC
   (C4).
5. **Calendario de días hábiles:** sin festivos ANBIMA (C29). Gorila y Kinvo usan el calendario oficial.

---

## Hallazgos abiertos

### C4 (persiste, baja a MEDIA) — La rentabilidad real casi nunca existe para periodos que terminan hoy
- **Dónde:** `indices.ts:51-67` (series de nivel con tolerancia 0, sin extrapolación) y
  `engine.ts:291-299`.
- **Evidencia (I2):** IPCA publicado hasta marzo y `asOf` 2024-04-30. En el resumen desde el inicio,
  `inflation` y `realTwr` son `undefined`. Como el IPC/IPCA del mes en curso se publica entre 8 y 12
  días después de terminar el mes, **YTD, 1Y y desde el inicio "a hoy" nunca muestran el retorno
  real**. Los meses históricos de la tabla sí funcionan (I3 exacto: 4,048 % real en enero).
- **Arreglo:** calcular el retorno real hasta el último IPC publicado e informar `inflationThrough`, o
  extrapolar con la última variación mensual y marcarlo con `inflationEstimated`.

### C22 — ALTA (nuevo, regresión) — Un split o spin-off el mismo día que un flujo rompe el TWR
- **Dónde:**
  - `engine.ts:193-195`: `runner.applyUntil(d - 1)` antes de valorar `P(f)`.
  - `performance.ts:200-201`: `req(f - 1, f, …)`.
  - `positions.ts:80`.

  El valor antes del flujo, `P(f)`, usa las cantidades **antes** del split, pero los precios del
  día ex ya son **posteriores** al split. El SPLIT tiene rango −1 y debería formar parte del estado
  "antes de las operaciones".
- **Evidencia (`r2-a-twr.ts`):**
  - **R1a.** 10 acciones a 100. Split 2:1 el 15-feb y compra de 10 a 50 ese día (precio plano en
    términos posteriores al split). **TWR de febrero −25 %**, cuando debería ser 0 %. Lo mismo en el
    resumen MTD y en `positionPerformance`.
  - **R1b.** Split + depósito el mismo día: **−25 %**.
  - **R1c.** Spin-off (100 pasa a 80 + 20) + depósito: **−11,1 %**.

  Con `implicitCashFlows` activo por defecto, cualquier compra el día ex dispara el problema.
- **Arreglo:** construir el estado previo al flujo como "cierre de f−1 + acciones corporativas de f"
  (aplicar el rango −1 antes de valorar `P`) en `buildDaily`, `computePeriods` y `positions`.
  Agregar R1a, R1b y R1c como pruebas.

### C23 — ALTA (nuevo, regresión de C20) — La caché del API ignora cambios hechos sobre el mismo objeto y comparte objetos devueltos
- **Dónde:** `engine.ts:385-404`. La firma compara solo referencias y la longitud; `valuation()` y
  `monthly()` devuelven el objeto guardado en caché.
- **Evidencia (`r2-e-cache.ts`):**
  - **E1.** Editar `txs[0].quantity = 20`, o reemplazar `txs[0]` por otro objeto con el mismo
    arreglo y la misma longitud: el motor sigue devolviendo **10**.
  - **E2.** Cambiar `options.asOf` sobre el mismo objeto: la tabla no se extiende.
  - **E3.** `rows.reverse()` en la UI hace que la siguiente llamada devuelva las filas invertidas. Y
    `holding.quantity = 999` queda guardado en la caché.
  - **E4.** Cambiar `portfolio.baseCurrency` no tiene efecto: devuelve 4.000.000 COP en vez de
    1.000 USD.

  El README lo advierte ("tratar las entradas como inmutables"), pero las funciones del API se
  documentan como puras y nada protege contra el error. Los números quedan mal **sin aviso**.
- **Arreglo:**
  - Que el API sin estado no use caché implícita (la caché solo con `createEngine` explícito), o
    que la firma incluya un contador de versión o un hash del contenido.
  - Devolver copias, o aplicar `Object.freeze` en profundidad en desarrollo.

### C24 — ALTA (nuevo) — La redención automática al vencimiento reemplaza el pago real registrado por el usuario
- **Dónde:** `ledger.ts:309-321` (el vencimiento se procesa en su fecha) y `ledger.ts:966-1029`.
- **Evidencia (F2):** un CDT vence el sábado 2025-01-04 y el banco paga el lunes 2025-01-06 un neto
  de 11.152.000, después de una retención del 4 % sobre los intereses. El usuario registra la
  `SELL` como la muestra su extracto. Resultado:
  - el motor redime el sábado por 11.203.478 en bruto;
  - la venta real queda como **`OVERSELL`** y no se registra;
  - la caja queda **sobrestimada en 51.478**;
  - la retención desaparece y la ganancia realizada queda mal.

  `validateTransactions` no dice nada. Los vencimientos en fin de semana o festivo, la liquidación
  T+1 y la retención en CDT (Colombia) e IR en CDB (Brasil) son el caso normal, no una excepción.
- **Arreglo:** redimir automáticamente solo si no hay una SELL o redención registrada del
  instrumento dentro de N días hábiles después del vencimiento (mirando hacia adelante en `ctx`), o
  marcar la redención automática como provisional y reemplazarla. Agregar la retención configurable
  (4 % en CDT Colombia; IR regresivo e IOF en Brasil).

### C25 — MEDIA (nuevo) — Un error de digitación en el precio de una operación ahora mueve la valoración y el TWR
- **Dónde:** `pricing.ts:46-53` (la observación de operación gana sobre un cierre más viejo) y
  `ledger.ts:222-246`.
- **Evidencia (R2):** posición de 1.000 acciones con precio manual 100. Se compra 1 acción
  "a 1.000" por error de digitación. **TWR de febrero +900 %, marzo −89,9 %**, valor a fin de
  febrero 1.001.000, sin advertencias ni diagnósticos. En la ronda 1 un error así solo afectaba el
  costo. Las métricas de riesgo y el mejor/peor mes quedan destruidos.
- **Arreglo:** detectar valores atípicos. Si el precio de la operación se desvía más de X % del último
  cierre o de la observación anterior, emitir `TRADE_PRICE_OUTLIER` y no usarlo como observación sin
  confirmación. No usar como observación las operaciones de cantidad mínima frente a la posición.

### C26 — MEDIA (nuevo) — `applyCorporateActions` descarta el segundo provento del mismo día (JCP + dividendo)
- **Dónde:** `corporate.ts:93-97`. Basta cualquier DIVIDEND del mismo instrumento a menos de 10 días,
  **incluidos los ya sugeridos en el mismo lote**.
- **Evidencia (K1):** ITUB4 con JCP de 0,20 y dividendo de 0,50, ambos con ex-date 2024-03-01. Se
  sugiere solo el JCP y el dividendo queda `ALREADY_RECORDED`. Además, el JCP sale sin el IR del 15 %
  retenido en la fuente.
- **Arreglo:** deduplicar por (instrumento, subtipo, fecha ex/pago, monto por acción ± tolerancia).
  Aplicar retenciones por defecto según residencia (JCP 15 %, dividendos US 30 %/15 %) como
  sugerencia editable.

### C27 — MEDIA (nuevo) — `applyCorporateActions` es cuadrático
- **Dónde:** `corporate.ts:26-57`. `heldBefore` ordena todos los movimientos en cada acción, y es
  recursiva en las fusiones.
- **Evidencia (K6):** 30.000 movimientos × 200 acciones = **4,0 s**. Extrapolado a 2.000 acciones
  (15 años de dividendos de 100 títulos), unos **40 s** con la UI bloqueada.
- **Arreglo:** ordenar una vez y hacer un barrido por instrumento con las acciones ordenadas por fecha.

### C28 — MEDIA (nuevo) — `positionPerformance` atribuye mal el efectivo de una fusión
- **Dónde:** `ledger.ts:775-784`. El efectivo de la fusión se registra como devolución de capital de
  la empresa **resultante** (`endOutBase` del target).
- **Evidencia (K5):** A (10 acciones a 100) se fusiona en 5 B + 20 COP. A muestra **TWR −100 % y
  −20**, y B muestra +20 de "retorno" que en realidad le pertenecía a A. El total cuadra, pero el
  reporte por activo engaña.
- **Arreglo:** registrar el efectivo como salida de la posición de origen al inicio del día, y no
  reducir con él el costo de la resultante salvo que así lo exija la regla fiscal configurada.

### C29 — MEDIA (nuevo) — BUS/252 sin calendario de festivos
- **Dónde:** `dates.ts:143-152` (solo lunes a viernes). Está documentado como limitación.
- **Evidencia (F5):** CDB prefixado al 12 % por un año da **11.250,48** sobre 10.000, cuando con 252
  días hábiles ANBIMA da ≈ 11.200: un error de +0,45 pp por año. También afecta el spread de
  IPCA+ y la extrapolación del CDI.
- **Arreglo:** calendarios de festivos ANBIMA (Brasil) y de festivos colombianos como datos
  versionados, usados en BUS/252 y para mover vencimientos al siguiente día hábil.

### C30 — MEDIA (nuevo) — `implicitFx` toma caja de otra cuenta, y las vistas por cuenta no suman el consolidado
- **Dónde:** `ledger.ts:449-461`. Usa el saldo **total** en la moneda base y no el de la cuenta de la
  operación.
- **Evidencia (E5):** depósito de 4 millones COP en Trii y compra de AAPL en IBKR (con un giro en USD
  no registrado). Consolidado: 4.000.000. Con el filtro IBKR: 4.000.000; con el filtro Trii:
  4.000.000. **La suma por cuenta da 8.000.000, el doble.** La caja por cuenta queda Trii +4 millones
  e IBKR −4 millones.
- **Arreglo:** que la conversión implícita use solo la caja de la misma cuenta (o pase la regla a
  `implicitFx: 'fromBaseCashSameAccount'` por defecto) y emita un diagnóstico cuando cruce cuentas.

### C31 — MEDIA (nuevo) — No hay valor líquido (neto de impuestos) en renta fija
- **Evidencia (F9):** `Holding` no tiene `netMarketValue` ni `taxOnRedemption`. Un CDB en Brasil
  paga IR regresivo de 22,5 % a 15 % sobre la ganancia e IOF antes de 30 días; un CDT en Colombia, una
  retención del 4 %. Gorila y Kinvo muestran "valor bruto" y "valor líquido".
- **Arreglo:** agregar una regla fiscal por residencia (coordinada con `packages/tax`) y los campos
  `netMarketValueBase` y `accruedTaxBase` en la posición.

### C32 — BAJA (nuevo) — El devengo indexado a IPCA/IPC se aplana en el mes no publicado
- **Evidencia (I2):** entre el 31-mar y el 30-abr el IPCA+6 % solo devenga el 6 % (10.276,38 →
  10.328,79), y salta cuando se publica el IPCA de abril. El Tesouro IPCA+ y la UVR usan la
  proyección ANBIMA o la variación vigente.
- **Arreglo:** proyectar con la última variación mensual (o con una serie de proyección provista)
  y marcarlo como estimado.

### C33 — BAJA (nuevo) — "% del índice" sobre series `annualRate` escala la tasa anual en vez de la diaria
- **Evidencia (F4):** 110 % de un CDI anual del 14,5 % da 11.649,60, cuando la convención de mercado
  (110 % × tasa diaria) da 11.661,05: un error de −0,1 % por año.
- **Arreglo:** en BUS/252, convertir a tasa diaria, multiplicar por el porcentaje y recapitalizar.

### C34 — BAJA (nuevo) — `Engine.asOf` usa la fecha UTC; la tabla mensual usa la fecha local
- **Evidencia (E7):** con `TZ=Pacific/Kiritimati` a las 07:56 locales del 07-oct, `Engine.asOf` da
  2026-10-06 y `todayIso()` daría 2026-10-07.
- **Arreglo:** usar `todayIso()` también en `engine.ts:117`.

### C35 — BAJA (nuevo) — `goalProjection` no se conecta con el portafolio ni con la inflación
- **Evidencia (K7):** las fórmulas son correctas, pero el valor inicial es manual, no hay meta en
  términos reales, los aportes no se indexan al IPC y no se usan el retorno ni la volatilidad
  históricos del portafolio.
- **Arreglo:** agregar `goalProjection` desde `createEngine` (valor actual, aportes promedio,
  retorno/volatilidad históricos) con las opciones `inflation` e `indexContributions`.

---

## Prioridad para la ronda 3

1. **C22:** una línea en tres sitios más pruebas.
2. **C23:** quitar la caché implícita o versionarla, y congelar las salidas.
3. **C24:** conciliar el vencimiento con la redención registrada y agregar la retención.
4. C25, C26, C27, C28 y C30: errores silenciosos y rendimiento.
5. C4, C29, C31: rentabilidad real a hoy, calendario ANBIMA/Colombia y valor líquido. Con esto el
   motor quedaría por encima de PP para este caso.
