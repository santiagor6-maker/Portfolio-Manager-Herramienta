# Revisión del motor de cálculo (`packages/core`), ronda 1

Revisor externo, sin participación en la construcción. Solo lectura sobre el código.
Fecha: 2026-10-05.

## Veredicto

**No aprobado.** El motor es limpio, rápido y está bien tipado. El TWR diario coincide con un
recálculo independiente por fuerza bruta hasta 1e-12, y la separación local/divisa por mes suma
exactamente el TWR. Pero las pruebas adversariales encontraron **dos errores de exactitud que
cambian los números que ve el usuario** (TWR con precios escasos o en días con flujo; split el mismo
día que una compra) y **vacíos funcionales graves para un inversionista de Colombia o Brasil**: no
hay devengo de renta fija (CDT/CDB), no hay rentabilidad real ni comparación contra CDI/IPCA y no
hay rentabilidad por posición. Hoy no está al nivel de Portfolio Performance ni de Sharesight para
este caso de uso.

| | Puntaje (0–10) |
|---|---|
| **Nuestro motor (`@pm/core`)** | **5,5** |
| **Mejor competidor para este caso: Portfolio Performance** | **8,0** |

`approved = false`: el puntaje no supera al del competidor y hay hallazgos de severidad alta.

Comprobaciones hechas:
- `npx vitest run packages/core`: 89/89 pruebas pasan. También pasan con `TZ=America/Bogota`,
  `Pacific/Kiritimati` (UTC+14) y `Pacific/Pago_Pago` (UTC−11).
- `npx tsc -p packages/core --noEmit`: sin errores (código de salida 0).
- 7 scripts adversariales en
  `/tmp/claude-0/-home-user-Portfolio-Manager-Herramienta/8b757dea-bb3a-58bd-aa07-26758394d338/scratchpad/review-core/`
  (`s1-lots-splits.ts` … `s7-more.ts`, ejecutados con `npx tsx`). Resultado: 44 PASS y 10 FAIL, más
  varios hallazgos registrados en consola.

Fuentes de metodología:
- Fórmula TTWROR de Portfolio Performance, verificada en su código fuente (`ClientIndex.java`):
  `delta = (thisValuation + outbound) / (valuation + inbound) − 1`.
- Sharesight: retorno anualizado ponderado por capital (AYI), separado en ganancia de capital,
  dividendos y ganancia por divisa (blog y ayuda de Sharesight).
- Ghostfolio: ROAI (retorno sobre la inversión promedio ponderada en el tiempo).
- Wealthfolio: TWR diario encadenado más atribución por divisa.
- Gorila: renta fija privada (CDB/LCI/LCA/debêntures) con benchmarks CDI, IPCA, IGPM e IFIX, e
  integración con B3.

El sitio de ayuda de PP y el de Sharesight estaban bloqueados por el proxy. Lo que no pude
verificar en línea (Kubera, Snowball, detalles de Gorila y Kinvo) se basa en mi conocimiento.

---

## Mejor que los competidores

1. **TWR diario exacto y auditable.** Se parte el periodo en cada día con flujo y se encadena con la
   misma convención que PP. Lo recalculé de forma independiente día por día en un caso
   COP/USD con depósitos, conversiones, compras, ventas, retiro y dividendo (S2a): los 4 meses
   coinciden con error menor a 1e-12. Incluye Modified Dietz como alternativa, verificado a mano en S7b.
2. **Separación local/divisa del TWR por mes que suma exactamente.** S4c: con solo caja en USD y la
   tasa USD/COP pasando de 4.000 a 4.200, local = 0 % y divisa = 5 %. Ni PP ni Sharesight dan esta
   separación en porcentaje mes a mes en una tabla.
3. **Caja multi-divisa real y FX robusto.** Hay una caja por divisa, triangulación vía USD/EUR,
   búsqueda en anchura (BFS) de rutas y normalización de cotizaciones en centavos (GBp/ZAc/ILA).
   `fxRateToBase` permite registrar la TRM o PTAX ejecutada.
4. **Métodos de costo intercambiables.** FIFO, LIFO y promedio (preço médio) se pueden alternar
   para simular. La bonificação con *custo atribuído* funciona (S7c: 110 acciones, costo 1.050).
5. **Flujos implícitos.** Para el usuario que solo registra operaciones (Ghostfolio exige otro
   modelo; PP exige registrar la caja).
6. **Rendimiento.** Con 30.000 movimientos, 150 instrumentos, 15 años de precios diarios y 4 divisas:
   tabla mensual en 0,2 s y serie diaria en 0,7 s (S6).
7. **Fechas internas como números de día UTC.** No hay errores de zona horaria dentro del motor.
8. **Diagnósticos del libro y validación con códigos estables.** `ledgerDiagnostics`, más
   validación que tiene en cuenta los splits al detectar sobreventas.

## Peor que los competidores

1. **Usa precios obsoletos en lugar del precio de la operación** en los días con flujo (C1).
   Sharesight y Ghostfolio usan el precio de la operación en esa fecha.
2. **Split + compra el mismo día:** el motor inventa acciones (C2). PP aplica el split a las
   operaciones anteriores a la fecha.
3. **Renta fija por devengo:** no existe (C3). Gorila y Kinvo la tienen de serie (CDB % CDI, IPCA+, prefijado).
4. **Rentabilidad real y benchmarks de tasa:** no existen (C4). Gorila compara contra CDI, IPCA e
   IGPM; PP permite series de IPC.
5. **Rentabilidad por posición:** no hay TWR/IRR por activo ni retorno total con dividendos (C5).
   Es lo central de Sharesight, PP, Ghostfolio y Gorila.
6. **Descomposición en dinero que no cuadra:** el resumen no reconcilia y no hay ganancia por
   divisa en las ventas realizadas (C9). Sharesight reconcilia capital + dividendos + divisa = total.
7. **Acciones corporativas automáticas:** no existen (C11). Sharesight y Gorila las aplican solas.
8. **Vistas por cuenta:** no hay rentabilidad por cuenta (C10). Sharesight, PP, Ghostfolio, Kubera
   y Gorila sí la tienen.

---

## Hallazgos (numerados)

### C1 — ALTA — El TWR se distorsiona en días con flujo: usa precios obsoletos (fill-forward) y supone que las entradas ocurren al inicio del día, ignorando el precio de la operación
- **Dónde:**
  - `performance.ts:159-169`: `r = (V(f)+OUT)/(V(f-1)+IN) − 1`.
  - `valuation.ts:37`: `marketPrice` hace fill-forward.
  - `ledger.ts:390-401`: la compra no registra su precio como observación de mercado.
- **Por qué importa:** con `implicitCashFlows: true` (el valor por defecto, "la mayoría solo
  registra operaciones") **cada compra es un día con flujo**. El caso central del producto es
  mensual, y muchos activos de mercados emergentes (FIC, CDT, fondos, acciones poco líquidas de la
  BVC) solo tienen precio de fin de mes.
- **Evidencia (`s3-sparse-prices.ts`, `s7-more.ts`):**
  - **S3a.** Precios solo a fin de mes: 100 (31-ene) y 125 (29-feb). Se tienen 10 acciones y se
    compran 10 más el 15-feb a 120. El portafolio es solo esa acción, así que cualquier TWR
    correcto de febrero es **+25 %**. **Resultado real: 13,64 %.** Modified Dietz da 18,5 %. Ese día
    el valor queda en 2.000 cuando el usuario acaba de pagar 1.200 por la mitad.
  - **S3b.** Se venden 5 a mitad de mes a 120 y se retira lo obtenido. **Esperado 25 %, resultado 37,5 %.**
  - **S7b.** Hay precio el mismo día de la compra (105) y el anterior es fill-forward (100). Los
    datos van de 100 a 110, así que **lo esperado es 10 %; resultado 8,20 %.** Aun con precios
    diarios completos, la convención "entrada al inicio del día" atribuye al dinero nuevo el
    movimiento del día en que se compró al cierre. Eso sesga el TWR en cada compra.
- **Arreglo:**
  1. Usar el precio de la operación (BUY/SELL/TRANSFER) como observación de precio del instrumento
     en esa fecha cuando no hay un dato de mercado ese mismo día (como Ghostfolio y Sharesight).
  2. Para los flujos implícitos que financian una compra, usar la convención de fin de día:
     `r = (V(f) − IN + OUT)/V(f−1) − 1`, o partir el día al precio de la operación.

  Con ambos cambios S3a y S7b dan 25 % y 10 % exactos (lo verifiqué a mano). Hay que agregar estos
  tres casos como pruebas.

### C2 — ALTA — Un split el mismo día que una compra multiplica la compra (acciones fantasma); la venta del mismo día no se multiplica (inconsistente)
- **Dónde:** `ledger.ts:26-41`. `TYPE_RANK`: BUY = 2 se procesa antes que SPLIT = 3, y SELL = 5
  después. `validate.ts:136` replica el mismo orden, así que el validador tampoco lo detecta.
- **Evidencia (`s1-lots-splits.ts`):**
  - **S1a.** 10 acciones a 100. Split 2:1 el 01-mar. El mismo 01-mar se compran 10 acciones a 50
    (unidades posteriores al split, como las reporta cualquier broker en la fecha ex). Esperado
    30 acciones con costo 1.500 y ganancia 0. **Resultado: 40 acciones y ganancia no realizada de
    +500 (+33 %).**
  - **S1e.** Con el mismo caso, una venta de 30 al día siguiente deja **10 acciones fantasma** y la
    validación devuelve `[]`.
- **Arreglo:** aplicar SPLIT/STOCK_DIVIDEND al **inicio** de la fecha ex (rango menor que BUY), igual
  en el libro y en el validador. Documentar que las cantidades de ese día van en unidades
  posteriores al split.

### C3 — ALTA — No hay renta fija por devengo (CDT, CDB, LCI/LCA, Tesouro, TES): se valora al costo para siempre
- **Dónde:** `valuation.ts:110-119` (sin precio ⇒ costo). No hay ningún modelo de tasa, indexador
  ni cupón en `types.ts`.
- **Evidencia (S5e, `s5-tz-misc.ts`):** un CDT de 10.000.000 COP al 12 % E.A. comprado el
  2024-01-02 vale **10.000.000** el 2024-12-31 y el TWR YTD da **0 %**. Lo esperado era
  ≈ 11.196.523 y ≈ 11,95 %. Solo aparece en `missingPrices`.
- **Impacto:** para un inversionista colombiano o brasileño la renta fija suele ser del 30 % al
  70 % del portafolio. Gorila y Kinvo la valoran "na curva" (prefijado, % del CDI, IPCA+).
- **Arreglo:** agregar un modelo de instrumento de renta fija con tasa, base de días (365/252 hábiles
  en Brasil), indexador (prefijado, %CDI, %IBR, IPCA+/UVR+, DTF+), fechas de cupón y vencimiento.
  Valorar por devengo cuando no haya precio y emitir el flujo de vencimiento. Esto requiere un
  cambio aditivo del contrato coordinado con `main`.

### C4 — ALTA — No hay rentabilidad real (IPC/IPCA) ni benchmarks de tasa (CDI, Selic, IBR, DTF, UVR)
- **Dónde:** `performance.ts:268-275` (`benchmarkValue` solo admite una serie de **precio** de
  instrumento). No hay ninguna función de deflactación en `api.ts`.
- **Impacto:** en Brasil la referencia por defecto de cualquier inversionista es el "% do CDI"
  (Gorila, Kinvo, Status Invest). En Colombia, con inflación de 5 % a 13 % entre 2022 y 2024, la
  rentabilidad nominal en COP engaña.
- **Arreglo:**
  - Agregar `realReturn` (deflactar el TWR mensual con una serie de índice:
    `(1+r)/(1+π) − 1`) y la columna `realTwr`.
  - Agregar benchmarks de **tasa** acumulada (series diarias de CDI/IBR, capitalizadas con 252
    días hábiles) y "% del benchmark".

### C5 — ALTA — No hay rentabilidad por posición (TWR/IRR por activo, retorno total con dividendos y ventas realizadas)
- **Dónde:** `Holding` (`types.ts:233-254`) solo trae la ganancia **no realizada**. No hay una API
  que diga "PETR4 me dio X % anual incluyendo dividendos y lo ya vendido".
- **Impacto:** es la vista principal de Sharesight (por posición: capital + dividendos + divisa,
  anualizado) y también existe en PP (IRR/TTWROR por título), Ghostfolio y Gorila.
- **Arreglo:** agregar `positionPerformance(input, period)` que reutilice `computePeriods` filtrando
  el libro por instrumento. Los flujos de la posición son compras, ventas, dividendos e impuestos.
  Debe devolver TWR, IRR, ganancia de capital, ingresos y ganancia por divisa.

### C6 — MEDIA — Una venta que excede la posición acredita en caja el producto completo (dinero fantasma)
- **Dónde:** `ledger.ts:408-412`. `credit(net)` se ejecuta **antes** de saber cuánto se emparejó.
  El README dice "limita sobreventas a lo que hay".
- **Evidencia (S5g):** se compran 10 a 100 y se venden 15 a 100. La caja queda en **1.500** por 10
  acciones que valían 1.000, una ganancia fantasma de +500 que entra al TWR.
- **Arreglo:** acreditar solo `net × matched/q`, o bien registrar el excedente como posición corta
  explícita o como una partida separada.

### C7 — MEDIA — Un retiro mayor que la caja crea apalancamiento oculto y TWR absurdos; el umbral `DENOM_EPS = 0,01` es absoluto y no depende de la divisa
- **Dónde:** `ledger.ts:330-335` (`allowImplicit = false` en WITHDRAWAL) y `performance.ts:35`.
- **Evidencia (S2b):** se deposita 1.000, se compra, y se retiran 5.000. La tabla de enero muestra
  un valor final de **−3.900 COP**. En febrero la acción sube 10 %, pero **el TWR de febrero sale
  110 %** porque el denominador queda en 100 tras un depósito de 4.000.
- **Arreglo:** con `implicitCashFlows: true`, tratar el faltante de un retiro como un aporte implícito
  previo (lo más probable es un depósito no registrado) o rechazarlo. Además, definir el umbral del
  denominador de forma relativa: por ejemplo, `|den| < 1e-6 × max(|flujos|, |V|)` ⇒ subperiodo
  nulo con advertencia, en vez de 0,01 unidades de cualquier divisa.

### C8 — MEDIA — Cambiar a una moneda base sin datos FX devuelve ceros en silencio, y un par directo obsoleto gana sobre una triangulación fresca
- **Dónde:** `valuation.ts:47-51` (caja sin tasa ⇒ 0) y `market.ts:220-223` (las rutas se prueban
  en orden, sin límite de antigüedad).
- **Evidencia:**
  - **S4c.** El mismo portafolio en base EUR, sin serie EUR, da **todas las filas en 0 y TWR 0**.
    `MonthlyRow` y `PerformanceSummary` no traen ninguna bandera `missingFx`.
  - **S5c.** Hay un par directo BRL/COP cuyo último dato es de 2024-01-01 y USD/COP y USD/BRL
    frescos de 2026. El motor usa **800** el 2026-06-01, cuando la triangulación fresca da
    **672,7**: un error del 19 %.
- **Arreglo:**
  - Agregar `missingFx` y `stalePrices` a `MonthlyRow` y `PerformanceSummary` (cambio aditivo).
  - Al elegir la ruta FX, preferir la de dato más reciente cuando la ruta directa tenga más de N
    días de antigüedad.

### C9 — MEDIA — La descomposición en dinero no cuadra y no hay ganancia por divisa en ventas realizadas ni en la tabla mensual
- **Dónde:** `performance.ts:402-429`, `RealizedGain` (`types.ts:276-288`) y `MonthlyRow` (solo
  porcentajes local/divisa).
- **Evidencia:**
  - **S4d.** `gainBase` 2.237.080 frente a `realized + unrealizedΔ + income` = 2.139.020. Hay un
    residuo oculto de **98.060 COP** (efecto divisa sobre la caja en USD y comisiones sueltas).
  - **S7f.** Una venta a precio constante con USD/COP de 4.000 a 4.400 tiene `gainBase` 400.000,
    pero no hay forma de decir que el 100 % fue divisa.
  - `feesBase` suma comisiones que ya están capitalizadas en el costo y en las ganancias.
- **Arreglo:** devolver una cascada que cuadre exactamente:
  `ganancia = precio + divisa(títulos) + divisa(caja) + ingresos − comisiones/impuestos sueltos`.
  Agregar `fxGainBase` y `priceGainBase` a `RealizedGain` y la columna `fxGainBase` en dinero a
  `MonthlyRow`.

### C10 — MEDIA — No hay vistas por cuenta ni consolidadas con rentabilidad; los lotes son por portafolio y las cantidades por cuenta pueden quedar negativas sin diagnóstico
- **Dónde:** `ledger.ts:290-294` y `allocation.ts:75-82`.
- **Evidencia (S5i):** se compran 10 en la cuenta A y se venden 4 en la cuenta B. Resultado:
  `accountQuantities = {A: 10, B: −4}`. La asignación por cuenta muestra A = 1.000 y B = 0, sin
  ningún diagnóstico.
- **Arreglo:** agregar la opción `filter: { accounts?: string[] }` en `EngineInput.options` (TWR,
  tabla mensual y resumen por cuenta) y un diagnóstico `NEGATIVE_ACCOUNT_QTY`. Documentar cómo
  consolidar varios portafolios.

### C11 — MEDIA — Las acciones corporativas no se aplican automáticamente y faltan tipos de evento
- **Dónde:** `CorporateAction` existe en `types.ts:198-206`, pero ningún módulo lo usa. No hay
  spin-off, fusión/canje, cambio de ticker, *cash in lieu* (S1d deja 3,333333333 acciones tras un
  grupamento 1:3 de 10) ni subscrição. El JCP se registra como DIVIDEND y no se distingue.
- **Arreglo:** agregar `applyCorporateActions(transactions, actions)` que genere SPLIT/DIVIDEND
  sugeridos sin duplicar los registrados. Agregar un subtipo `JCP` para los reportes, y tipos
  `SPINOFF` y `MERGER` con reparto del costo.

### C12 — MEDIA — Un depósito en COP seguido de una compra en USD sin fila de conversión duplica los aportes y reduce el TWR a la mitad
- **Dónde:** `ledger.ts:266-282`. El faltante se calcula por divisa y nunca toma de la caja en la
  moneda base.
- **Evidencia (S7a):** se depositan 4.000.000 COP y se compran 10 AAPL a 100 USD. Los flujos quedan
  `DEPOSIT COP 4.000.000 + IMPLICIT_DEPOSIT USD 1.000`, es decir **8.000.000 de aportes**. El TWR
  sale **5 %** cuando la acción subió 10 %.
- **Arreglo:** agregar `implicitFx: 'fromBaseCash'`. Cuando falte caja en la divisa de la compra y
  sobre caja en la base, generar una conversión implícita a tasa de mercado en lugar de un aporte.

### C13 — MEDIA — Los benchmarks son solo de precio (sin dividendos), mientras el portafolio es retorno total
- **Dónde:** `performance.ts:332-340`.
- **Evidencia (S7e):** el mismo ETF como posición y como benchmark da portafolio +1,5 % y
  benchmark 0 %, porque el dividendo solo cuenta en el portafolio.
- **Arreglo:** admitir series de retorno total (precio ajustado) o reinvertir los dividendos del
  benchmark. Marcar el tipo de benchmark (`price` | `total` | `rate`).

### C14 — BAJA — Fechas con hora y zona horaria: el motor acepta en silencio lo que el validador rechaza
- **Dónde:** `dates.ts:11-16` (`isoToDay` toma `slice(0,10)`) frente a `validate.ts:52`.
- **Evidencia (S5a, `TZ=America/Bogota`):** una compra del 31-mar a las 8 p. m. hora local,
  serializada con `toISOString()`, queda como `2024-04-01T01:00:00.000Z`. El validador marca
  `INVALID_DATE`, pero el libro la procesa en **abril**: cambia de mes en la tabla mensual. En
  Tokio, el mismo patrón la deja en el día correcto.
- **Arreglo:** que el libro rechace o normalice cualquier valor que no sea `YYYY-MM-DD` exacto
  (diagnóstico `INVALID_DATE`), y documentar que la UI debe construir las fechas con componentes
  locales. `todayIso()` está bien, porque usa la fecha local.

### C15 — BAJA — Anualización inconsistente y MWR anualizado en periodos cortos sin aviso
- **Dónde:** `performance.ts:430` (365,25 y solo si los días son más de 365) y `xirr.ts:25`
  (Actual/365).
- **Evidencia:**
  - **S4b.** En 1Y de 2024 (año bisiesto, 366 días), `twr` = 20,00 %, `twrAnnualized` = 19,955 % y
    `mwr` = 19,94 % sin flujos. Los tres deberían ser iguales.
  - **S2e.** Un 1 % en un día da un XIRR de **3.678 %**. En S2c, el MWR desde el inicio en 4 meses
    da 193 %. `PerformanceSummary.mwr` se presenta junto al TWR del MTD sin advertencia. Con dos
    raíces (−100, +230, −132) devuelve una sin avisar.
- **Arreglo:** usar una sola convención (años calendario exactos o Actual/365 en todo). Devolver
  `mwrPeriod` (sin anualizar) para periodos de menos de un año, como hace Sharesight con su método
  conservador, y agregar `mwrMultipleRoots`.

### C16 — BAJA — Las métricas de riesgo incluyen el mes parcial en curso y el drawdown solo usa cierres mensuales
- **Dónde:** `risk.ts:23-27`.
- **Evidencia (S4e):** un mes de 2 días entra en la volatilidad anualizada y en el Sharpe como si
  fuera un mes completo.
- **Arreglo:** excluir por defecto la fila parcial (`asOf` antes de fin de mes) y ofrecer un drawdown
  con la serie diaria (`valueSeries`).

### C17 — BAJA — No hay señal de precio obsoleto
- **Dónde:** `valuation.ts:99-109`.
- **Evidencia (S5d):** se usa en 2024-06-30 un precio de 2021-01-04 y `missingPrices = []`.
- **Arreglo:** agregar `stalePrices` a la valoración, con un umbral configurable (p. ej. 7 días para
  acciones listadas y 45 para manuales).

### C18 — BAJA — Costos implícitos: el spread de conversión FX no se reporta como costo
- **Evidencia (S4g):** una conversión con un spread de −2 % aparece correctamente como −2 % de TWR,
  pero `feesBase = 0`. El usuario no ve cuánto le cobró el broker por la conversión.
- **Arreglo:** calcular `fxSpreadBase = amount × tasaMercado − toAmount` como costo informativo.

### C19 — BAJA — Un dividendo sin posición no genera advertencia
- **Evidencia (S5h):** un DIVIDEND de un instrumento con 0 acciones no produce diagnóstico ni
  advertencia.
- **Arreglo:** agregar la advertencia `INCOME_WITHOUT_POSITION`.

### C20 — BAJA — Cada llamada re-ejecuta el libro desde cero
- **Evidencia (S6):** con 30.000 movimientos, los 10 `performanceSummary` del panel tardan
  **1,74 s** (cada resumen re-ejecuta 4 libros). La tabla mensual tarda 0,2 s.
- **Arreglo:** agregar `createEngine(input)` con libro y valoraciones memorizados, para atender todos
  los periodos con una sola pasada.

### C21 — BAJA — No hay seguimiento de metas ni proyección de aportes
- **Arreglo:** agregar `goalProjection({ target, date, monthlyContribution, expectedReturn })` sobre
  `valueSeries`, con escenarios. Kubera y Ghostfolio (calculadora FIRE) lo tienen de forma parcial.

---

## Prioridad recomendada para la ronda 2

1. C2 (orden del split, 1 línea más pruebas) y C1 (precio de la operación más convención de fin
   de día para compras; agregar S3a, S3b y S7b como pruebas).
2. C6, C7, C8 y C12: errores silenciosos que producen números falsos.
3. C3 y C4: renta fija por devengo, CDI/IPCA/IPC y rentabilidad real. Son la diferencia frente a
   Gorila y Kinvo.
4. C5 y C9: rentabilidad por posición y cascada en dinero que cuadre. Son la diferencia frente a
   Sharesight.
