# @pm/core — motor de cálculo de Portafolio Pro

Motor puro (sin I/O) que convierte movimientos + precios + tasas de cambio en posiciones, caja
multi-divisa, valoración, ganancias realizadas/no realizadas, tabla mensual, TWR/MWR, riesgo y
asignación. El contrato está en `src/types.ts` (tipos) y `src/api.ts` (funciones).

```
npx vitest run packages/core        # 160 pruebas
npx tsc -p packages/core --noEmit   # typecheck
```

## API

| Función | Qué hace |
|---|---|
| `createMarketData({ prices, fx, manualPrices })` | Datos de mercado en memoria con búsqueda binaria y *fill-forward*. Devuelve además `pricePoint`, `fxPairs`, `instrumentIds`, `priceAt/fxAt` (por número de día). |
| `validateTransactions(txs, instruments, { today? })` | Errores y advertencias (ver códigos abajo). |
| `valuePortfolio(input, date)` | `Valuation`: posiciones con lotes, caja por divisa, valor total, pesos, `missingPrices`, `missingFx`. |
| `computeHoldings`, `computeCash` | Atajos de `valuePortfolio`. |
| `realizedGains(input, from?, to?)` | Ganancia realizada por lote cerrado, en moneda del instrumento y en base (FX histórico en compra y venta), `holdingDays`. |
| `incomeEvents(input, from?, to?)` | Dividendos e intereses: bruto, retención, neto, neto en base. |
| `monthlyPerformance(input, { from?, to?, benchmarks?, asOf?, twrMethod? })` | Tabla mensual (una fila por mes calendario). |
| `performanceSummary(input, period, asOf, custom?)` | MTD/QTD/YTD/1M/3M/6M/1Y/3Y/5Y/SI/CUSTOM. |
| `valueSeries(input, { from, to, step })` | Serie diaria/semanal/mensual: valor, capital neto aportado y TWR acumulado (0 en `from`). |
| `riskMetrics(monthly, { riskFreeAnnual?, benchmarkMonthly?, benchmarkId? })` | Volatilidad, Sharpe, Sortino, drawdown máximo, beta, correlación, mejor/peor mes. |
| `allocation(valuation, instruments, by)` | Por `assetClass`, `country`, `currency`, `sector`, `exchange`, `instrument`, `account`. |
| `xirr(flows)` | TIR anualizada (Actual/365). |
| `ledgerDiagnostics(input)` *(nuevo)* | Caja negativa, sobreventas, instrumentos desconocidos, FX faltante. |
| `externalFlows(input)` *(nuevo)* | Flujos externos explícitos e implícitos, en moneda original y en base. |
| `createDemoData()` *(nuevo)* | "Portafolio de ejemplo" (ver abajo). |

`EngineInput.options` (nuevo, opcional):

| Opción | Defecto | Efecto |
|---|---|---|
| `implicitCashFlows` | `true` | Si una compra (o comisión, conversión…) no tiene caja suficiente en esa divisa, el faltante se registra como **aporte implícito** ese día. Así funciona un portafolio donde el usuario solo registra operaciones. Con `false` la caja queda negativa (margen) y se reporta en `ledgerDiagnostics`. |
| `sellProceeds` | `'cash'` | `'withdraw'`: el neto de cada venta se trata como **retiro implícito** (para quien no lleva la caja). |
| `twrMethod` | `'daily'` | `'modifiedDietz'` como alternativa. |
| `costMethod` | `portfolio.costMethod` | Permite simular FIFO vs. promedio. |
| `asOf` | hoy (hora local) | Fecha de corte del mes en curso. |

Opciones añadidas en la ronda 2 (todas opcionales): `implicitFx` (`'fromBaseCash'` por defecto),
`tradePriceObservations` (true), `autoRedeemAtMaturity` (true), `staleDays` ({listed: 7, manual: 45}),
`filter.accounts`, `inflationIndex`, `indices`, `benchmarkKinds`. Detalle en "Respuesta a la revisión ronda 1".

Campos opcionales añadidos a `types.ts` (aditivos): `Holding.accountQuantities` y
`CashBalance.accountAmounts` (cantidades/saldos por cuenta, usados por `allocation(…, 'account')`), y los
de la ronda 2 listados al final.

## Libro de movimientos

Orden dentro del mismo día (estable según el orden de entrada):
`SPLIT/STOCK_DIVIDEND` (fecha ex: se aplican primero) → `DEPOSIT/TRANSFER_IN` → `FX_CONVERSION` → `BUY` →
`DIVIDEND/INTEREST/RETURN_OF_CAPITAL` → `SELL` → `FEE/TAX` → `TRANSFER_OUT/WITHDRAWAL` → redención automática
al vencimiento. **Las cantidades negociadas el día ex de un split van en unidades posteriores al split**
(como las reporta el broker); el validador advierte `SPLIT_SAME_DAY_TRADE`.

Fechas: solo `YYYY-MM-DD` exacto. Un valor con hora o zona horaria (p. ej. `toISOString()`) se rechaza
(`INVALID_DATE`) en el libro y en el validador; la UI debe construir la fecha con componentes locales.

Efecto en caja (en la moneda de la fila):

| Tipo | Caja | Flujo externo |
|---|---|---|
| `DEPOSIT` / `WITHDRAWAL` | ± monto (comisiones aparte) | Sí |
| `BUY` | − (monto + comisiones + impuestos) | Implícito si falta caja |
| `SELL` | + (monto − comisiones − impuestos) | Solo con `sellProceeds: 'withdraw'` |
| `DIVIDEND` / `INTEREST` | + (bruto − retención − comisiones) | No (es rendimiento) |
| `FX_CONVERSION` | − `amount` (+comisiones) en `currency`; + `toAmount` en `toCurrency` (si falta, tasa de mercado) | No |
| `FEE` / `TAX` | − monto (TAX negativo = devolución) | No |
| `RETURN_OF_CAPITAL` | + monto | No |
| `TRANSFER_IN/OUT` de títulos | Solo comisiones | Sí, **a valor de mercado** del día |

Montos: si falta `amount` en BUY/SELL se usa `quantity × price / priceMultiplier` (bonos cotizados por 100).
Si el instrumento cotiza en otra moneda que la fila, el costo se convierte a la moneda del instrumento con
la tasa de mercado del día.

### Métodos de costo

- **FIFO** (defecto legal en Colombia): las ventas consumen los lotes más antiguos.
- **LIFO**: los más recientes.
- **AVERAGE** (preço médio, Brasil): cada compra recalcula el costo unitario promedio de todos los lotes
  abiertos; las ventas no lo cambian. Los lotes se conservan en orden FIFO solo para fechas/días de tenencia.

Comisiones e impuestos de transacción se **capitalizan** en el costo de la compra y se **restan** del
producto de la venta. Ejemplo (preço médio): compra 100 @ 30 + 10, compra 200 @ 33 + 20 ⇒ promedio
9.630/300 = 32,10; vende 150 @ 35 − 15 ⇒ neto 5.235; ganancia promedio 5.235 − 4.815 = 420
(FIFO: 570; LIFO: 270).

- `SPLIT` con `ratio` r: cantidad × r, costo unitario ÷ r (costo total igual). r = 0,1 es un *reverse split* 1×10.
- `STOCK_DIVIDEND`: con `quantity` agrega esas acciones; con `ratio` r agrega r acciones por acción
  (factor 1 + r). Costo total igual, salvo que se informe `amount` (costo atribuido de la *bonificação*).
- `RETURN_OF_CAPITAL`: reduce el costo base a prorrata; el exceso sobre el costo es ganancia realizada.
- `TRANSFER_IN`: crea lotes al `price` dado (o al precio de mercado si no hay precio).
- Costo en moneda base: `tx.fxRateToBase` (tasa realmente ejecutada: TRM, PTAX, broker) si existe y se
  reporta en la moneda base del portafolio; si no, la tasa de mercado del día de la operación.
- Cantidades: los lotes mantienen precisión completa; al cerrar lotes se usa tolerancia 1e-9 (un lote a
  menos de 1e-9 de lo que falta por vender se cierra completo) y las cantidades se reportan redondeadas a 1e-9.

## Valoración

Valor de una posición = `cantidad × precio / priceMultiplier × FX(moneda→base)`. El precio
(`Holding.priceSource`) es, en este orden:

1. la observación más reciente en o antes de la fecha entre el **cierre de mercado/manual** y el **precio de
   una compra o venta** registrada (`'market'` o `'trade'`; el mismo día gana el cierre). Las
   transferencias no se usan como precio porque traen el costo histórico;
2. renta fija con `accrual`: devengo por lote (`'accrual'`, ver abajo);
3. sin ninguna observación: **al costo** (`'cost'`, aparece en `missingPrices`).

Sin FX en o antes de la fecha ⇒ se usa la primera tasa posterior y la divisa aparece en `missingFx` (también
en `MonthlyRow.missingFx` y `PerformanceSummary.missingFx`; nunca ceros silenciosos). Un precio más viejo que
`staleDays` (7 días listados, 45 manuales/fondos/renta fija) marca `Holding.stale` y `Valuation.stalePrices`.
`totalCostBase` = costo histórico de los títulos + caja a valor actual.

### Renta fija por devengo (CDT, CDB, LCI/LCA, Tesouro, TES)

`Instrument.accrual = { kind, annualRate?, index?, spread?, percentOfIndex?, dayCount?, maturity?, issueDate? }`.
Cada lote se valora como `precio ancla × F(ancla → fecha)`; el ancla es el último precio de mercado/manual u
operación posterior a la apertura del lote, o el precio de compra del lote (los precios manuales mandan y
reinician el devengo desde su fecha). El devengo para en `maturity`, donde la posición se **redime
automáticamente** a su valor devengado (ganancia realizada, caja).

```
fijo (CDT E.A., prefixado):      F = (1 + tasa)^(t)           t por base de días
indexado (% del CDI, IBR):        F = Π (1 + p·r_día) × (1 + spread)^(t)
indexado (IPCA+, UVR+):           F = I(b)/I(a) × (1 + spread)^(t)
t: ACT/365 = días/365 (CDT colombiano E.A.); BUS/252 = días hábiles/252 (Brasil; por defecto para CDI/SELIC
y BRL); ACT/360; 30/360.
```

Ejemplo: CDT de 10.000.000 COP al 12 % E.A. comprado el 2024-01-02 vale 10.000.000 × 1,12^(364/365) =
11.196.523 el 2024-12-31. CDB 110 % do CDI: `10.000 × Π(1 + 1,1 × CDI_día)` sobre los días hábiles. Sin datos
del índice ⇒ se valora al valor de compra y se informa `missingIndex`.

### Descomposición precio vs. divisa (ganancia no realizada en base)

Para cada posición, con `MV` = valor de mercado en moneda del instrumento, `C` = costo en moneda del
instrumento, `CB` = costo en base a FX histórico, `X0 = CB / C` (FX histórico promedio ponderado por
costo) y `X1` = FX de la fecha de valoración:

```
priceGainBase = (MV − C) × X0        efecto precio, medido a la tasa histórica
fxGainBase    = MV × (X1 − X0)       efecto divisa sobre el valor actual
priceGainBase + fxGainBase = MV·X1 − C·X0 = MV·X1 − CB = unrealizedGainBase   (exacto)
```

Ejemplo: inversionista colombiano compra 10 AAPL @ 100 USD con USD/COP 4.000 (costo 4.000.000 COP).
Precio 120 y USD/COP 4.500 ⇒ valor 5.400.000; ganancia 1.400.000 = precio (120−100)·10·4.000 =
800.000 + divisa 1.200·(4.500−4.000) = 600.000. El término cruzado (precio × divisa) queda en el efecto divisa.

## Rentabilidad

### TWR (tiempo ponderado) — método por defecto `daily`

El periodo se parte en sub-periodos en **cada día con flujo externo** y se encadenan. Convención final
(ronda 2): **el día con flujo se parte en el momento de las operaciones**.

```
TWR = Π (1 + r_i) − 1
tramo sin flujos [a, b]:   r = V(b) / V(a) − 1
día con flujo f:           r_a = P(f) / V(f−1) − 1                      (mercado hasta la operación)
                           r_b = V(f) / (P(f) + ENTRADAS − SALIDAS) − 1  (de la operación al cierre)
                           si P + ENTRADAS − SALIDAS ≈ 0 (salida total): r_b = (V(f) + SALIDAS)/(P(f) + ENTRADAS) − 1
```

`V(d)` = valor al cierre del día `d` (todas las operaciones aplicadas). `P(f)` = valor **antes** de los flujos:
las posiciones al cierre de `f−1` valoradas con los precios del día `f`, salvo los instrumentos negociados ese
día, que se valoran a su (primer) precio de operación, y con la FX del día `f`. Junto con el uso del precio de
la operación como observación, esto da exactamente el retorno del activo en los casos de la revisión: precios
solo de fin de mes 100 → 125 con una compra a mitad de mes a 120 ⇒ **+25 %**; 100 → 105 (compra al cierre) →
110 ⇒ **+10 %**. Un aporte que queda en caja no se lleva el movimiento del día de las posiciones existentes.
Los flujos se convierten a base con la tasa de mercado del día del flujo. Un denominador ≤ 1e-9 × la escala
de los flujos del portafolio (o negativo) hace que el sub-periodo aporte 0 y se informa en `warnings`
(`DEGENERATE_SUBPERIOD`, `NEGATIVE_VALUE_SUBPERIOD`).

`Modified Dietz` (opción `twrMethod: 'modifiedDietz'`), un cálculo por periodo:
`r = (V1 − V0 − ΣF) / (V0 + Σ w·F)`, `w = (D − t)/D`, con `t` = días desde el inicio hasta el inicio del
día del aporte (o el final del día del retiro).

Acumulado: producto encadenado de los meses. Anualizado (solo si el periodo dura al menos un año), con
**años calendario (ACT/ACT)**: `(1 + TWR)^(1/años) − 1`, donde 2023-12-31 → 2024-12-31 es exactamente 1 año
aunque 2024 sea bisiesto. La misma convención se usa en el MWR, así que en un año exacto sin flujos
TWR = TWR anualizado = MWR.

### Retorno local vs. divisa (por mes)

Para cada sub-periodo `[a, b]` el retorno local revalora las posiciones de `b` con la **FX de `a`**
(precios de `b`): `rL = V(b @ FX a) / V(a) − 1` (flujos también a FX de `a`). En el mes:

```
localReturn = Π(1 + rL) − 1
fxReturn    = twr − localReturn       (suman exactamente el TWR; incluye el término cruzado)
```

Ejemplo: 10 AAPL, precio 100→110, USD/COP 4.000→4.400: TWR 21 %, local 10 %, divisa 11 %.
Para un inversionista colombiano esto muestra cuánto vino de la devaluación del peso.

### Tabla mensual

Cada fila: valor inicial (cierre del mes anterior), valor final (cierre del mes, o `asOf` en el mes en curso),
flujos netos (aportes − retiros + transferencias de entrada − salida + implícitos), ingresos netos de
retención, comisiones, impuestos (incluye retenciones, para información), ganancia = final − inicial − flujos,
TWR, TWR acumulado, local/divisa y retorno de los *benchmarks* (usa `portfolio.benchmarks` si no se pasan).
Además (ronda 2): ganancia realizada, variación no realizada, efecto divisa en dinero (`fxGainBase`), spread
de conversiones (`fxSpreadBase`), inflación y TWR real (`realTwr = (1 + twr)/(1 + π) − 1`, acumulado real),
retorno de índices de tasa y "% del índice" (`indexReturns`, `percentOfIndex`, p. ej. % do CDI), `partial`
para el mes en curso y calidad de datos (`missingFx`, `missingPrices`, `stalePrices`, `warnings`).

Benchmarks: instrumento de precio (`P1·X1 / (P0·X0) − 1`, ajustado por splits de `corporateActions`),
retorno total (dividendos de `corporateActions` reinvertidos en la fecha ex, o serie ya ajustada con
`benchmarkKinds[id] = 'total'`) o índice de tasa (CDI, IBR…). `benchmarkKinds` en la fila dice cuál se usó.

### Resumen por periodo

`from` = primer día incluido; el valor inicial es el cierre del día anterior. 1M desde 2024-03-31 ⇒
`from` = 2024-03-01. Periodos anteriores al inicio se recortan a la fecha de inicio.
`realizedGainBase` = ventas del periodo; `unrealizedGainBase` = **variación** de la ganancia no realizada
en el periodo (en SI coincide con la total). `mwr` = XIRR (ACT/ACT, anualizada) con valor inicial como
aporte, flujos externos y valor final; `mwrPeriod` = la misma tasa sin anualizar (la que debe mostrarse en
periodos menores a un año); `mwrMultipleRoots` avisa si la ecuación tiene varias raíces.

Cascada en dinero que **cuadra exactamente** (cada residuo tiene nombre):

```
gainBase = realizedGainBase + unrealizedGainBase + incomeBase
         + fxCashGainBase            revaluación de la caja en divisas
         + fxConversionResultBase    conversiones vs. tasa de mercado (spread, negativo = costo)
         + otherCostsBase            comisiones e impuestos sueltos (FEE, TAX, comisiones de aportes/conversiones)
         + transferAdjustmentBase    transferencias: costo traído vs. valor de mercado del flujo
         + corporateActionAdjustmentBase   costo atribuido en bonificaciones
         + rateDifferenceBase        tasa ejecutada (fxRateToBase / moneda de la operación) vs. tasa de mercado
fxGainBase = divisa realizada + Δ divisa no realizada + fxCashGainBase;  priceGainBase = el resto de capital
```

`feesBase` es informativo: las comisiones de compra/venta ya están dentro de las ganancias.

### Rentabilidad real e índices

Series en `MarketDataInput.indexSeries` (`IndexSeries`): `level` (IPC/IPCA número índice, UVR),
`periodRate` diario (CDI/Selic de BCB SGS 12/11, % por día hábil) o mensual (IPCA SGS 433, IPC DANE),
`annualRate` (IBR, DTF, CDI anualizado). Todo se convierte en un nivel acumulado `C(d)`; el retorno entre dos
fechas es `C(b)/C(a) − 1`. La inflación por defecto según la moneda base: COP → `IPC_CO`, BRL → `IPCA`,
USD → `CPI_US`, EUR → `HICP_EA` (`inflationIndex` la cambia o la desactiva con `null`). Índices de tasa por
defecto: BRL → CDI, COP → IBR (`indices` los cambia). La inflación y los benchmarks **no se extrapolan** más
allá del último dato publicado (el mes sin IPC queda sin `realTwr`); el devengo de renta fija sí.

### Rentabilidad por posición

`positionPerformance(input, periodo, asOf)` da por instrumento: valores inicial y final, invertido,
retirado, ingresos, comisiones, ganancia realizada, variación no realizada, parte en divisa,
`totalReturnBase = final − inicial − invertido + retirado + ingresos`, TWR (mismo corte del día en la
operación; los dividendos salen al cierre), TWR anualizado, IRR (XIRR ACT/ACT) y `irrPeriod`.

### MWR / XIRR

`Σ a_i (1 + r)^(−t_i) = 0`, con `t_i` en años: Actual/365 en `xirr()` (compatible con Excel) o ACT/ACT
(`xirrEx(flows, { dayCount: 'ACT/ACT' })`, la que usa el motor). Newton–Raphson con varios puntos de partida y,
si falla, bisección sobre un intervalo con cambio de signo en (−1, 10⁶]. Devuelve `undefined` sin solución
(todos los flujos del mismo signo, un único flujo, todo el mismo día). `xirrEx` también informa
`multipleRoots` cuando el VPN cruza cero más de una vez (p. ej. −100, +230, −132).

## Riesgo

Sobre los TWR mensuales (se omiten meses vacíos): volatilidad = desviación muestral × √12; Sharpe =
(media de exceso mensual × 12) / volatilidad, con `rf` mensual = (1 + rf)^(1/12) − 1; Sortino con
desviación a la baja respecto a rf; drawdown máximo sobre el índice de cierres mensuales (inicio = mes del
pico, fin = mes del valle) o, con `dailySeries` (salida de `valueSeries`), sobre el índice diario con fechas
exactas; beta y correlación contra `benchmarkMonthly` (alineado con las filas) o contra el primer benchmark
de las filas. El mes parcial en curso se excluye salvo `includePartial: true` (`monthsUsed` lo informa).

## Asignación

Las posiciones sin precio usan el costo. La caja es la clase `cash`, se agrupa por su propia divisa en
`currency`, por el país de la divisa en `country` (COP→CO, BRL→BR, USD→US, EUR→EU…) y como
`cash:COP` en `instrument`. `account` reparte por cantidad/saldo en cada cuenta. Etiquetas por defecto en
español; la UI puede traducir por `key`.

## Datos de mercado

- Precios: búsqueda binaria con *fill-forward*; los precios manuales reemplazan a los del proveedor en la
  misma fecha. Cotizaciones en centavos (GBp/GBX, ZAc, ILA) se normalizan a la unidad mayor.
- FX: misma divisa = 1; par directo; inverso; triangulación vía USD; vía EUR; y búsqueda en anchura hasta
  3 tramos. Las rutas se prueban en ese orden para cada fecha, así un par directo que empieza más tarde
  recurre a la triangulación en fechas anteriores; y si la ruta preferida tiene datos con más de
  `fxStaleDays` (7) días de antigüedad y otra ruta es más fresca, gana la más fresca.
- Índices de tasa e inflación (`indexSeries`) y acciones corporativas (`corporateActions`, para benchmarks
  de retorno total ajustados por splits).

## Validación

Errores: `INVALID_DATE`, `MISSING_CURRENCY`, `UNKNOWN_TYPE`, `MISSING_INSTRUMENT`, `UNKNOWN_INSTRUMENT`,
`NEGATIVE_QUANTITY`, `MISSING_QUANTITY`, `MISSING_PRICE`, `NEGATIVE_AMOUNT`, `INVALID_RATIO`, `OVERSELL`
(considera splits), `MISSING_TO_CURRENCY`, `DUPLICATE_ID`, `MISSING_TARGET`.
Advertencias: `FUTURE_DATE`, `DUPLICATE_IMPORT` (mismo `importHash`), `CURRENCY_MISMATCH`, `ZERO_AMOUNT`,
`SAME_CURRENCY_CONVERSION`, `SPLIT_SAME_DAY_TRADE`, `INCOME_WITHOUT_POSITION`, `INVALID_ACCRUAL`,
`INVALID_COST_FRACTION`. El motor no se detiene: limita sobreventas a lo que hay (y solo acredita la parte
emparejada) y lo reporta en `ledgerDiagnostics` (con `severity`: `NEGATIVE_CASH`, `WITHDRAWAL_EXCEEDS_CASH`,
`NEGATIVE_ACCOUNT_QTY`, `IMPLICIT_FX_CONVERSION`, `MATURITY_REDEEMED`, `MISSING_FX`, `INVALID_DATE`…).

## Datos de ejemplo

`createDemoData()` devuelve "Portafolio de ejemplo" (base COP, residencia CO, FIFO): Ecopetrol,
**Grupo Cibest preferencial (PFCIBEST, antes Bancolombia PFBCOLOM)**, ISA, PETR4, ITUB4, WEGE3, AAPL, MSFT,
VOO, ASML, IBE (+ ICOLCAP como benchmark), dos CDT valorados por devengo (12 % y 10,5 % E.A., redimidos
automáticamente al vencimiento), tres cuentas (Trii, Interactive Brokers, XP), aportes, compras durante 3
años, dividendos con retención, un split 2:1 de WEGE3, conversiones de divisa, dos ventas y un retiro; series
de fin de mes 2023-01 a 2026-09 (USD/COP 3.700–4.400, USD/BRL 4,8–5,8, EUR/USD 1,05–1,15) e índices IPC
(Colombia) e IBR. **Precios, tasas, índices, dividendos y el split son sintéticos** (deterministas), no datos
históricos. `input` está listo para el motor y `isDemo` es `true` para mostrar una etiqueta en la UI.

## Rendimiento

Un portafolio de 10 años, 2.000 movimientos y 40 instrumentos con precios diarios genera la serie
diaria completa en ~0,2 s y el tablero completo (10 resúmenes + rentabilidad por posición, motor nuevo) en
~0,6 s (prueba `perf.test.ts`, límite 1,5 s). `createEngine(input)` memoriza el libro y una cadena diaria de
valores e índice TWR: cualquier periodo es `I(b)/I(a) − 1`. Las funciones de la API usan un motor en caché
por objeto `input` (tratar las entradas como inmutables). Con 30.000 movimientos y 150 instrumentos
(escenario S6 del revisor) los 10 resúmenes bajaron de 1,74 s a 0,59 s.

## Pendientes / limitaciones conocidas

- Los lotes son por portafolio (no por cuenta). Para rentabilidad por cuenta usar `options.filter.accounts`
  (cada cuenta se analiza como un portafolio propio, con sus flujos implícitos).
- BUS/252 cuenta lunes a viernes sin calendario de feriados (el CDI diario de BCB sí trae solo días hábiles).
- Renta fija: no hay cupones periódicos automáticos ni curva de mercado (marcación a mercado solo con
  precios manuales); la redención automática usa el valor devengado.
- Ventas en corto no soportadas (se reportan como sobreventa).
- Consolidar varios portafolios: pasar la unión de sus movimientos con un `Portfolio` sintético.

## Respuesta a la revisión ronda 1

Revisión: `reviews/core-r1.md`. Los escenarios del revisor (S1a…S7f) quedaron como pruebas de regresión en
`src/review-r1.test.ts`; además hay suites nuevas `fixedincome`, `indices`, `positions`, `corporate` y
`engine`. Total: 160 pruebas.

| Hallazgo | Severidad | Arreglo |
|---|---|---|
| C1 TWR con precios viejos en días con flujo | Alta | Los precios de compra/venta son observaciones de precio (menor prioridad que un cierre del mismo día). El día con flujo se parte en las operaciones: `P(f)` a precio de operación, `r_a = P/V(f−1)`, `r_b = V(f)/(P + IN − OUT)`. S3a = 25 %, S3b = 25 %, S7b = 10 %, S2d = 50 % exactos. Opción `tradePriceObservations`. |
| C2 Split el mismo día que una compra | Alta | SPLIT/STOCK_DIVIDEND tienen rango −1 (se aplican al inicio de la fecha ex) en el libro y en el validador; advertencia `SPLIT_SAME_DAY_TRADE`; documentado que las cantidades de ese día van post-split. |
| C3 Renta fija por devengo | Alta | `Instrument.accrual` (fijo E.A./prefixado, % de índice, índice + spread; ACT/365, BUS/252, ACT/360, 30/360; emisión y vencimiento). Devengo por lote, precios manuales re-anclan, redención automática al vencimiento, `missingIndex`. CDT 12 % E.A. y CDB 110 % do CDI probados a mano. |
| C4 Rentabilidad real y benchmarks de tasa | Alta | `IndexSeries` (`level`, `periodRate` diario/mensual, `annualRate`) en `MarketDataInput.indexSeries` y `MarketData.indexLevel`. `MonthlyRow.inflation/realTwr/cumulativeRealTwr/indexReturns/percentOfIndex`, `PerformanceSummary.inflation/realTwr/realTwrAnnualized/indexReturns/percentOfIndex`; índices como benchmarks (`'rate'`). Tipos enviados a `main` para market-data. |
| C5 Rentabilidad por posición | Alta | `positionPerformance()` → `PositionPerformance[]`: retorno total en dinero (realizado + no realizado + ingresos), parte divisa, TWR, IRR (y sin anualizar), retorno simple. |
| C6 Sobreventa con caja fantasma | Media | Solo se acredita la parte emparejada (`net × vendido/pedido`); diagnóstico `OVERSELL`. |
| C7 Retiro mayor que la caja; umbral absoluto | Media | Con flujos implícitos el faltante es un aporte implícito previo + `WITHDRAWAL_EXCEEDS_CASH`. Umbral relativo `1e-9 × escala de flujos`; sub-periodos degenerados aportan 0 y se informan en `warnings`. |
| C8 FX faltante silencioso; par directo viejo | Media | `missingFx`/`missingPrices`/`stalePrices`/`warnings` en `MonthlyRow` y `PerformanceSummary`; `MISSING_FX` en diagnósticos; selección de ruta FX por frescura (`fxStaleDays`). |
| C9 Cascada que no cuadra; divisa realizada | Media | Atribución por movimiento en el libro → cascada con residuos nombrados (`fxCashGainBase`, `fxConversionResultBase`, `otherCostsBase`, `transferAdjustmentBase`, `corporateActionAdjustmentBase`, `rateDifferenceBase`) que suma `gainBase` exacto (probado en todos los periodos del demo). `RealizedGain.priceGainBase/fxGainBase`; `MonthlyRow.realizedGainBase/unrealizedGainBase/fxGainBase`. |
| C10 Vistas por cuenta | Media | `options.filter.accounts` (TWR, tabla, resumen por cuenta); diagnóstico `NEGATIVE_ACCOUNT_QTY`; consolidación documentada. |
| C11 Acciones corporativas | Media | `applyCorporateActions(transactions, actions, instruments)` sugiere movimientos sin duplicar (dividendos al tamaño de la posición antes de la fecha ex, `payDate`, moneda propia, JCP; splits; bonificaciones; `reviewRequired` nunca se aplica). `Transaction.subtype` (`JCP`, `SPINOFF`, `MERGER`, `TICKER_CHANGE`) con `targetInstrumentId`/`costFraction`; *cash in lieu* en reverse splits con `amount`. Campos de `CorporateAction` pedidos por market-data añadidos. |
| C12 Aporte en COP + compra en USD | Media | `implicitFx: 'fromBaseCash'` (por defecto): convierte caja en la moneda base a tasa de mercado antes de crear un aporte implícito; diagnóstico `IMPLICIT_FX_CONVERSION`. S7a = 10 %. |
| C13 Benchmarks solo precio | Media | Retorno total con dividendos de `corporateActions` reinvertidos, ajuste por splits, `benchmarkKinds` (override y salida por fila). S7e: portafolio 1,5 % = benchmark 1,5 %. |
| C14 Fechas con hora | Baja | El libro rechaza lo que no sea `YYYY-MM-DD` exacto (`INVALID_DATE`), igual que el validador. |
| C15 Anualización inconsistente | Baja | ACT/ACT (años calendario) para TWR anualizado, MWR, IRR por posición; `years`, `mwrPeriod`, `mwrMultipleRoots`; `xirrEx` con `dayCount` y `multipleRoots`. S4b: TWR = anualizado = MWR. |
| C16 Mes parcial en riesgo | Baja | `MonthlyRow.partial`; `riskMetrics` lo excluye por defecto (`includePartial`); drawdown diario con `dailySeries` y fechas exactas. |
| C17 Precio obsoleto | Baja | `Holding.stale`, `Valuation.stalePrices`, umbrales `staleDays`. |
| C18 Spread de conversión | Baja | `MonthlyRow.fxSpreadBase` y `PerformanceSummary.fxConversionResultBase`. |
| C19 Dividendo sin posición | Baja | `INCOME_WITHOUT_POSITION` en el libro y en el validador. |
| C20 Cada llamada re-ejecuta el libro | Baja | `createEngine()` y caché por `input`: un libro y una cadena diaria para todos los periodos, series y posiciones. |
| C21 Metas y proyección | Baja | `goalProjection()` con escenarios pesimista/esperado/optimista, aporte requerido, meses hasta la meta y probabilidad. |

Escenarios del revisor cuyo "esperado" cambia por diseño:
- **S2a** (comparación con su fuerza bruta): su fuerza bruta usa la convención anterior (entrada al inicio
  del día); la prueba equivalente (`multicurrency.test.ts`) usa una fuerza bruta independiente con la
  convención nueva y coincide a 1e-10.
- **S2b** (retiro mayor que la caja): el faltante se registra como un aporte implícito, así que no hay valores
  negativos y enero da 10 %. Febrero da 2,16 % y no 10 %, porque el aporte de 4.000 del 05-feb queda en caja
  y diluye el retorno del mes. Es el TWR correcto con caja ociosa.

Cambios aditivos al contrato (`types.ts` / `api.ts`): `Instrument.accrual`, `AccrualSpec`, `DayCount`,
`IndexId`, `IndexPoint`, `IndexSeries`, `MarketData.indexLevel?`, `Transaction.subtype/targetInstrumentId/
costFraction`, `TransactionSubtype`, `CorporateAction` (`STOCK_DIVIDEND`, `subtype`, `exDate`, `payDate`,
`currency`, `targetInstrumentId`, `costFraction`, `reviewRequired`, `source`, `note`), `Holding.priceSource/
stale`, `Valuation.stalePrices/missingIndex`, `RealizedGain.priceGainBase/fxGainBase`, `IncomeEvent.subtype`,
campos opcionales de `MonthlyRow`, `PerformanceSummary` y `RiskMetrics`, `PositionPerformance`,
`GoalProjectionPoint`; `MarketDataInput.indexSeries/corporateActions/fxStaleDays`; opciones nuevas de
`EngineOptions`; funciones nuevas `createEngine`, `positionPerformance`, `applyCorporateActions`,
`goalProjection`, `xirrEx`. Ningún campo ni miembro de unión existente cambió de significado, salvo dos
correcciones documentadas arriba: el orden del split en el día (C2) y la convención del día con flujo (C1).
