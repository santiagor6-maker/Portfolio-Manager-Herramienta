# @pm/core — motor de cálculo de Portafolio Pro

Motor puro (sin I/O) que convierte movimientos + precios + tasas de cambio en posiciones, caja
multi-divisa, valoración, ganancias realizadas/no realizadas, tabla mensual, TWR/MWR, riesgo y
asignación. El contrato está en `src/types.ts` (tipos) y `src/api.ts` (funciones).

```
npx vitest run packages/core        # 218 pruebas
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
Cada lote se valora como `precio ancla × F(ancla → fecha)`. El ancla es el último precio de mercado o
manual posterior a la apertura del lote; si no hay, el precio de compra del lote. Los precios manuales
mandan y reinician el devengo desde su fecha. Las compras de otros lotes **no** re-anclan, porque cada CDT o
CDB es su propio contrato. El devengo para en `maturity`.

Cupones e intereses periódicos (ronda 4): un `INTEREST` (o `DIVIDEND/COUPON`) sobre un instrumento con
devengo **saca el monto bruto del valor devengado**. Cada lote se re-ancla en la fecha de pago en
`valor devengado − su parte del cupón`. Así el valor, el valor líquido y la redención solo incluyen el interés
devengado desde el último pago. Ejemplos: un CDT del 12 % con pago trimestral da TWR ≈ 11,1 % (neto de
retención), no 20,2 %; un bono con cupón semestral vale ≈ 1.100, no 1.148,81.
Ronda 5: el cupón se reparte entre las unidades de la fecha de registro (`quantity` de la transacción, o la
tenencia antes de una venta en los 15 días previos si explica mejor el monto: `COUPON_RECORD_DATE_UNITS`). La
reducción se limita al interés causado (desde el ancla o en el periodo del cupón, máximo un año); el exceso es
ingreso, el principal no se toca y se avisa `COUPON_EXCEEDS_ACCRUED_INTEREST`. Un interés sin `taxes` cuyo monto
coincide con el causado neto de retención (`CO_RETENCION`, `BR_IR_REGRESSIVE`) se toma como neto y se infiere
la retención (`INTEREST_NET_ASSUMED`).

Vencimiento (ronda 3):
- El pago se espera el siguiente día hábil del calendario del instrumento.
- Si el usuario registra una venta o redención **en o después del vencimiento**, ese registro es el pago real,
  con su retención, y no hay redención automática. Si llega después de `settlementWindowDays` días hábiles
  (5 por defecto), se informa `LATE_REDEMPTION` (ronda 4). Si el interés del vencimiento ya se registró como
  `INTEREST`, la redención automática paga solo el capital más lo devengado después, y se informa
  `INTEREST_ALREADY_RECORDED`.
- Si no la registra, el motor redime automáticamente al valor devengado, **neto de la retención estimada**,
  y la ganancia realizada queda marcada `estimated`.

Impuestos sobre el rendimiento (`taxRegime`). La regla por defecto sigue la jurisdicción del instrumento
(retención en la fuente):
- **`BR_IR_REGRESSIVE`**: IOF los primeros 30 días e IR de 22,5 % / 20 % / 17,5 % / 15 % según el plazo.
- **`CO_RETENCION`**: 4 % sobre los intereses (configurable con `withholdingRate`).
- **`EXEMPT`**: LCI, LCA, CRI, CRA e incentivadas.

Con eso, `Holding.accruedTaxBase` y `Holding.netMarketValueBase` dan el valor líquido, y
`Valuation.totalNetMarketValueBase` el total neto. Los instrumentos con devengo exentos o sin impuesto
siempre traen neto = bruto e impuesto 0.

```
fijo (CDT E.A., prefixado):      F = (1 + tasa)^(t)           t por base de días
indexado (% del CDI, IBR):        F = Π (1 + p·r_día) × (1 + spread)^(t)
indexado (IPCA+, UVR+):           F = I(b)/I(a) × (1 + spread)^(t)
t: ACT/365 = días/365 (CDT colombiano E.A.); ACT/ACT = años calendario; BUS/252 = días hábiles/252 con el
calendario ANBIMA (Brasil; por defecto para CDI/SELIC y BRL); ACT/360; 30/360.
"% del índice" sobre una tasa anual escala la tasa DIARIA: (1 + p·((1+r)^(1/252) − 1))^du.
```

Calendarios (`calendars.ts`, generados por algoritmo a partir de la Pascua):
- **ANBIMA / B3:** Carnaval, Viernes Santo, Corpus Christi, feriados nacionales y Consciencia Negra desde
  2024.
- **Colombia:** Ley Emiliani, con los festivos trasladados al lunes, Jueves y Viernes Santo.

Se usan en BUS/252, en la extrapolación del CDI, y para mover vencimientos al siguiente día hábil.

Ejemplo: CDT de 10.000.000 COP al 12 % E.A. comprado el 2024-01-02 vale 10.000.000 × 1,12^(364/365) =
11.196.523 el 2024-12-31. CDB 110 % do CDI: `10.000 × Π(1 + 1,1 × CDI_día)` sobre los días hábiles. Sin datos
del índice ⇒ se valora al valor de compra y se informa `missingIndex`. En meses aún no publicados (IPCA/IPC)
el devengo continúa con la última variación publicada y la posición se marca `estimated`
(`Valuation.estimatedIndex`).

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

`V(d)` = valor al cierre del día `d`, con todas las operaciones aplicadas.

`P(f)` = valor **antes** de los flujos. Se toman las posiciones al cierre de `f−1` **más las acciones
corporativas de inicio de día de `f`** (split, bonificación, spin-off, fusión; ronda 3). Se valoran con los
precios y la FX del día `f`; los instrumentos negociados ese día van a su primer precio de operación, salvo
que ese precio sea atípico. Junto con el uso del precio de
la operación como observación, esto da exactamente el retorno del activo en los casos de la revisión: precios
solo de fin de mes 100 → 125 con una compra a mitad de mes a 120 ⇒ **+25 %**; 100 → 105 (compra al cierre) →
110 ⇒ **+10 %**. Un aporte que queda en caja no se lleva el movimiento del día de las posiciones existentes.

Precios de operación atípicos (rondas 3 a 5):
- Un precio que se desvía más de `tradePriceTolerance` (30 % por defecto, el doble en cripto, ampliado con la
  raíz del número de meses de distancia) del cierre o precio anterior **y** del cierre de confirmación (el del
  mismo día o el siguiente, a cualquier distancia) no se usa como precio, y se informa `TRADE_PRICE_OUTLIER`.
- Si el cierre de confirmación está dentro de la tolerancia, el precio se acepta sin aviso.
- Sin cierre de confirmación, un precio fuera de la banda dura (×3 / ÷3 de la referencia, ×5 en cripto,
  ampliada si la brecha pasa de un año, aun con referencias muy antiguas) no se usa hasta que el usuario lo
  confirme con `priceConfirmed` (`TRADE_PRICE_OUTLIER`). Dentro de la banda, se acepta y se informa
  `TRADE_PRICE_UNCONFIRMED` para que la UI pida confirmación. Así un fondo que sube 40 % o BTC +45 % se valoran
  bien.
- Ambos avisos llegan también a `MonthlyRow.warnings` y `PerformanceSummary.warnings` (`CODIGO:<ids>`).
- Tampoco se usan las operaciones de menos del 0,5 % de la posición cuando hay un cierre en la misma semana.
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
En fusiones, escisiones y cambios de ticker, el tramo al inicio del día es
`(P + entregado) / (V(f−1) + recibido) − 1`: lo entregado es el valor final del origen y el inicial de la
resultante.

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
~0,5 s (prueba `perf.test.ts`, límite 1,5 s). `createEngine(input)` memoriza el libro y una cadena diaria de
valores e índice TWR: cualquier periodo es `I(b)/I(a) − 1`. El valor diario usa una ruta sin asignaciones de
memoria para posiciones normales.

Caché segura (ronda 3):
- `createEngine` toma una **copia** de la entrada.
- Las funciones de la API reutilizan motores solo si el **contenido** es idéntico: un hash estructural de
  todos los campos de los movimientos, instrumentos, portafolio, opciones y moneda de reporte, más la
  identidad del objeto de datos de mercado. Por eso las ediciones sobre el mismo objeto, `options.asOf` o
  `baseCurrency` se reflejan siempre.
- Todo lo que se devuelve es una copia nueva: la UI puede ordenar, invertir o mutar sin efectos.
- Cuando cambian los precios hay que pasar un nuevo `MarketData`; los de `createMarketData` son inmutables.
  Un `MarketData` propio que cambia en sitio debe incrementar `revision` (ronda 4). Sin `revision`, nunca se
  usa la caché para él.
- El hash es incremental: cada fila guarda sus valores y solo se re-hashean las que cambiaron. Con 30.000
  movimientos cuesta ~5 ms por llamada.
- **Para la web se recomienda un `createEngine(input)` explícito**: ~0,5 ms por resumen, sin hash.

Con 30.000 movimientos y 150 instrumentos (escenario S6), los 11 resúmenes tardan ~0,7 s, incluido el hash
de contenido en cada llamada; en la ronda 1 eran 1,74 s.

## Pendientes / limitaciones conocidas

- Los lotes son por portafolio (no por cuenta). Para rentabilidad por cuenta usar `options.filter.accounts`
  (cada cuenta se analiza como un portafolio propio, con sus flujos implícitos).
- Feriados: solo nacionales (no regionales ni cierres extraordinarios de bolsa).
- Renta fija: los cupones periódicos llegan como acciones corporativas `DIVIDEND/COUPON` (sugeridas como
  `INTEREST`); no hay curva de mercado (marcación a mercado solo con precios manuales). Los impuestos de
  renta fija son estimaciones para mostrar; los cálculos oficiales están en `packages/tax`.
- Ventas en corto no soportadas (se reportan como sobreventa).
- Consolidar varios portafolios: pasar la unión de sus movimientos con un `Portfolio` sintético.

## Respuesta a la revisión ronda 1

Revisión: `reviews/core-r1.md`. Los escenarios del revisor (S1a…S7f) quedaron como pruebas de regresión en
`src/review-r1.test.ts`; además hay suites nuevas `fixedincome`, `indices`, `positions`, `corporate` y
`engine`. Total en esa ronda: 160 pruebas.

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

## Respuesta a la revisión ronda 2

Revisión: `reviews/core-r2.md`; estos cambios forman la **ronda 3** del motor. Los escenarios del revisor
(`r2-a` … `r2-f`) quedaron como pruebas de regresión en `src/review-r2.test.ts`. Total: **190 pruebas**,
que pasan también con `TZ=America/Bogota` y `TZ=Pacific/Kiritimati`. Las pruebas de `apps/web` (40) pasan
y todos los paquetes dependientes compilan sin errores.

| Hallazgo | Severidad | Arreglo |
|---|---|---|
| C22 Split/spin-off + flujo el mismo día | Alta | El valor antes del flujo `P(f)` usa el estado "cierre de f−1 + acciones corporativas de inicio de día de f" (`Ledger.applyStartOfDay`) en la cadena diaria, la tabla mensual y `positionPerformance`. En posiciones, las reestructuraciones son flujos de inicio de día (`startInBase/startOutBase`). R1a, R1b y R1c = 0 % exactos. |
| C23 Caché insegura | Alta | `createEngine` copia la entrada. La API busca motores por **hash de contenido** (todos los campos de los movimientos, instrumentos, portafolio, opciones, moneda, identidad del mercado; LRU de 8). Las salidas se devuelven como copias (`structuredClone`). E1–E4 pasan: edición en sitio, `asOf`, `baseCurrency`, `reverse()` de la UI. |
| C24 La redención automática pisa el pago real | Alta | El vencimiento se paga el siguiente día hábil (calendario de la moneda). Una venta o redención registrada dentro de `settlementWindowDays` días hábiles (5) reemplaza la redención automática. Si no hay registro, la redención automática es **neta de la retención estimada** y queda `estimated`. F2: caja = 11.152.000, sin `OVERSELL`. |
| C4 Rentabilidad real a hoy | Media | Los meses sin IPC/IPCA publicado usan la última variación (proyección geométrica, máximo 62 días) y se marcan con `inflationEstimated`. El resumen informa `inflationThrough`. YTD, 1Y y SI "a hoy" ya tienen `realTwr`. |
| C25 Precio de operación con error de digitación | Media | Detector de atípicos frente al cierre o precio anterior y al cierre siguiente (`tradePriceTolerance`, 30 %). No se usa como precio y se informa `TRADE_PRICE_OUTLIER`. Las operaciones mínimas (< 0,5 % de la posición) no reemplazan cierres de la misma semana. R2: febrero −0,89 % (antes +900 %). |
| C26 JCP + dividendo con la misma fecha ex | Media | Deduplicación por (instrumento, tipo, ventana ex/pago, subtipo o monto ±2 % o precio por acción); cada registro empareja una sola acción; los duplicados del proveedor se informan como `DUPLICATE_ACTION`. Retención sugerida y editable: JCP 15 %, dividendos de EE.UU. 30 % (`withholding`). |
| C27 `applyCorporateActions` cuadrático | Media | Un solo ordenamiento y un barrido cronológico con índices por instrumento y búsqueda binaria: O((n+m) log n). 30.000 movimientos × 200 acciones: 34 ms (antes 2,9 s). 2.000 acciones en < 1 s (prueba). |
| C28 Efectivo de fusión en la posición equivocada | Media | El efectivo es una enajenación parcial de la empresa **de origen**: se realiza una fracción del costo, `efectivo / (efectivo + valor de las acciones nuevas)`, y el resto pasa a la resultante. En posiciones va como flujo de inicio de día. K5: A = 0, B = +20, C = +50; realizado total = 70. |
| C29 BUS/252 sin feriados | Media | Calendarios ANBIMA (Brasil) y Ley Emiliani (Colombia) generados desde la Pascua (`calendars.ts`). Se usan en BUS/252, en la extrapolación del CDI, para mover vencimientos y en la ventana de liquidación. F5: 253 días hábiles en 2024. |
| C30 `implicitFx` tomaba caja de otra cuenta | Media | El faltante y la conversión implícita se financian solo con la caja de la **misma cuenta** (más la caja sin cuenta). Si la caja en moneda base está en otra cuenta, se informa `IMPLICIT_FX_OTHER_ACCOUNT`. La moneda de financiación (`fundingCurrency`: la del primer depósito o la del portafolio) no depende de la moneda de reporte. E5: la suma por cuenta es igual al consolidado. |
| C31 Valor líquido de renta fija | Media | `fitax.ts`: IR regresivo + IOF (Brasil) y retención del 4 % (Colombia), según la jurisdicción del instrumento (`taxRegime`, `EXEMPT` para LCI/LCA). Campos `Holding.accruedTaxBase`, `netMarketValueBase` y `Valuation.totalNetMarketValueBase`. |
| C32 Devengo IPCA+ plano en el mes no publicado | Baja | El devengo continúa con la última variación publicada; `Holding.estimated` y `Valuation.estimatedIndex`. Una compra unos días antes del primer nivel publicado se proyecta hacia atrás. |
| C33 % de un índice anual | Baja | Se escala la tasa diaria: `(1 + p·((1+r)^(1/252) − 1))^du`. F4 coincide con la convención de mercado usando días ANBIMA. |
| C34 `Engine.asOf` en UTC | Baja | Usa `todayIso()` (fecha local), igual que la tabla mensual. |
| C35 Metas desconectadas | Baja | `goalProjection` acepta `inflation`, `indexContributions` y `realTerms`. Nuevo `goalProjectionForPortfolio(input, asOf, opts)` / `Engine.goalProjection`: usa el valor actual, el aporte promedio de 12 meses, el TWR anualizado, la volatilidad histórica y la inflación de la moneda base. |

También en esta ronda, por pedido de market-data:
- `CorporateAction {type: 'DIVIDEND', subtype: 'COUPON'}` se sugiere como **`INTEREST`** (cupones NTN-B y
  NTN-F).
- Una fusión llega como `SPLIT/MERGER` más un `DIVIDEND/EXTRAORDINARY` del mismo instrumento y la misma fecha
  ex con el efectivo por acción (CPLE6 → R$ 0,7749). Se combinan en un único `SPLIT/MERGER` con
  `amount = unidades × efectivo por acción`, y el dividendo queda como `ABSORBED_IN_MERGER`.
- Los campos de `CorporateAction` que pidió market-data (`STOCK_DIVIDEND`, `subtype`, `exDate`, `payDate`,
  `currency`, `targetInstrumentId`, `costFraction`, `reviewRequired`, `source`, `note`) están en el contrato.

Correcciones detectadas al integrar con `apps/web`:
- El régimen de retención de renta fija ya no depende de la moneda de reporte.
- La moneda de financiación de la conversión implícita tampoco depende de ella.

La vista consolidada de la web usa como base la moneda de reporte, y los pesos de asignación deben ser
iguales en cualquier moneda.

Esperados del revisor que cambian por diseño (las pruebas usan el valor corregido):
- **F1:** la redención automática ahora es neta de la retención estimada del 4 %. Además, 2024-01-02 →
  2025-01-02 son 366 días en ACT/365. Para un CDT que paga exactamente la tasa en un año calendario se usa
  `dayCount: 'ACT/ACT'`.
- **F4:** se cuentan días hábiles ANBIMA y no lunes a viernes.
- **F8:** la segunda compra del mismo bono ya no re-ancla el primer lote, porque cada lote devenga su propio
  contrato.

Cambios aditivos al contrato:
- `DayCount` agrega `'ACT/ACT'`.
- `AccrualSpec` agrega `taxRegime`, `withholdingRate` y `settlementWindowDays`.
- `Holding` agrega `accruedTaxBase`, `netMarketValueBase` y `estimated`.
- `Valuation` agrega `estimatedIndex` y `totalNetMarketValueBase`.
- `RealizedGain` agrega `estimated`.
- `MonthlyRow` agrega `inflationEstimated`; `PerformanceSummary` agrega `inflationEstimated` e
  `inflationThrough`.
- `RiskMetrics` agrega `monthsUsed`, `maxDrawdownStartDate` y `maxDrawdownEndDate`.
- `CorporateAction` agrega los campos indicados arriba.
- `EngineOptions` agrega `tradePriceTolerance` y `fundingCurrency`.
- Funciones nuevas: `goalProjectionForPortfolio` y `Engine.goalProjection`.
- Módulos nuevos: `calendars.ts` y `fitax.ts`.

Ningún campo existente cambió de significado. Los cambios de comportamiento son los arreglos descritos:
- el estado antes del flujo incluye las acciones corporativas;
- la redención es neta de retención estimada;
- los atípicos no se usan como precio;
- la caja de financiación es la de la misma cuenta;
- BUS/252 usa feriados.

## Respuesta a la revisión ronda 3

Revisión: `reviews/core-r3.md`; estos cambios forman la **ronda 4** del motor. Los escenarios del revisor
(`r3-a`, `r3-b`, `r3-c`) quedaron como pruebas en `src/review-r3.test.ts`. Total: **203 pruebas**, que pasan
también con `TZ=America/Bogota` y `TZ=Pacific/Kiritimati`. `apps/web` (54 pruebas) pasa, y los paquetes
dependientes compilan sin errores. Los scripts de las rondas 1–3 del revisor pasan, salvo los tres esperados
que el revisor aceptó como cambios de diseño (F1, F4, F8).

| Hallazgo | Severidad | Arreglo |
|---|---|---|
| C36 Cupones e intereses contados dos veces | Alta | Un `INTEREST`/`COUPON` sobre un instrumento con devengo saca el bruto del valor devengado y re-ancla cada lote en la fecha de pago (`LotState.anchorDay`). El valor, el neto de impuestos y la redención automática solo cubren lo devengado desde el último pago. H1: TWR 11,1 % (antes 20,2 %), exacto frente a la cadena calculada a mano. H2: 1.097,58 ≈ 1.100 (antes 1.148,81). G3c: caja 11,155 M (antes 12,31 M) con `INTEREST_ALREADY_RECORDED`. |
| C37 Atípicos rechazaban movimientos reales | Media | Se rechaza solo con evidencia de los dos lados (precio anterior **y** cierre siguiente). Sin cierre posterior se acepta con `TRADE_PRICE_UNCONFIRMED`. La tolerancia es el doble para cripto. G4: fondo +40 % → 15.400 y TWR 40 %. G4b: BTC +45 % → 45 %. R2 (error de digitación) sigue rechazado. |
| C38 TWR por posición en cambio de ticker o fusión | Media | La entrega se valora al **último cierre propio de la empresa de origen** (menos el efectivo de la fusión); la diferencia con el precio de la resultante es el retorno de la resultante. G2: OLD 0 / 0 %, NEW +100 / 10 %, coherentes con el retorno en dinero. |
| C39 Redención registrada tarde | Baja | Cualquier venta o redención registrada en o después del vencimiento reemplaza la estimación; fuera de la ventana se informa `LATE_REDEMPTION`. G3a: caja 11.152.000, sin `OVERSELL`. |
| C40 Exentos sin valor líquido | Baja | Todo instrumento con devengo trae `accruedTaxBase = 0` y `netMarketValueBase = valor` cuando es exento o sin impuesto, y `Valuation.totalNetMarketValueBase` existe siempre que haya renta fija. |
| C41 `MarketData` mutable y costo del hash | Baja | Nuevo campo opcional `MarketData.revision`, incluido en el hash; un `MarketData` propio sin `revision` nunca usa la caché (H5: 1.500 tras la nueva cotización). El hash es incremental por fila y sin cierres en el camino caliente: 30.000 movimientos pasan de ~25–45 ms a ~5 ms por llamada, y siguen detectando ediciones en sitio. Se documenta `createEngine` como la vía recomendada para la web. |

Cambios aditivos al contrato:
- `MarketData` agrega `revision?`.
- `LotState` agrega `anchorDay?`; es interno.
- Diagnósticos nuevos: `TRADE_PRICE_UNCONFIRMED`, `LATE_REDEMPTION`, `INTEREST_ALREADY_RECORDED` y
  `COUPON_EXCEEDS_ACCRUAL`.

## Respuesta a la revisión ronda 4

Revisión: `reviews/core-r4.md`; estos cambios forman la **ronda 5** del motor. Los escenarios del revisor
(`r4-a`, `r4-b`) quedaron como pruebas en `src/review-r4.test.ts`. Total: **218 pruebas**, que pasan también
con `TZ=America/Bogota` y `TZ=Pacific/Kiritimati`. `apps/web` (54 pruebas) pasa, y todos los paquetes
compilan sin errores. Los scripts del revisor de las rondas 1–4 pasan, salvo los esperados que el revisor
aceptó como cambios de diseño (F1, F4, S2).

| Hallazgo | Severidad | Arreglo |
|---|---|---|
| C44 Precios de operación sin confirmar | Media | El cierre de confirmación es el del mismo día o el **siguiente, a cualquier distancia** (antes, 62 días). Si confirma el precio, se acepta sin aviso (T4: caída real del −52 %, sin diagnóstico). Sin cierre que confirme, hay una **banda dura**: más de ×3 o menos de ÷3 frente a la referencia (×5 en cripto, más ancha si la brecha pasa de un año). Fuera de la banda, el precio no se usa hasta que el usuario lo confirme con `Transaction.priceConfirmed`; se informa `TRADE_PRICE_OUTLIER`. La banda se aplica también con referencias de más de 400 días. Los avisos llegan a `MonthlyRow.warnings` y `PerformanceSummary.warnings` como `TRADE_PRICE_OUTLIER:<id>` / `TRADE_PRICE_UNCONFIRMED:<id>`. Un precio sin confirmar sigue avisando en los meses posteriores mientras no llegue un cierre. T1: MTD −8,2 % y valor 101.000 (antes +900 % y 1.010.000), con aviso en el resumen. T2: febrero −0,1 % (antes −90 %). T3: valor 100.100 con `TRADE_PRICE_OUTLIER`. |
| C42 El cupón podía comerse el principal | Media | El cupón se reparte entre las unidades de la fecha de registro. Se usa `quantity` de la transacción si viene; si no, se mira la tenencia antes de una venta o compra en los 15 días previos al pago, cuando esa tenencia explica mejor el monto (`COUPON_RECORD_DATE_UNITS`). La reducción de cada lote se limita al interés causado: desde su ancla, o sobre el periodo del cupón (desde el cupón anterior, la emisión o como máximo un año, lo que cubre el interés comprado a precio sucio). El exceso es ingreso, el principal queda intacto y se avisa `COUPON_EXCEEDS_ACCRUED_INTEREST`. J2: 1.000 (antes 951,33). J4: 1.000 y, un año después, 1.100 (antes 995 y 1.094,50). |
| C38 Fusión → cambio de ticker | Media | El tramo de entrega al inicio del día es `(P + entregado) / (V(f−1) + recibido) − 1`: el valor entregado es el valor final del origen y el valor inicial de la resultante. P1: B +20 en dinero y TWR +2,04 % (antes 0 %). C 5 %, A 0 %. La suma por posición sigue igual al portafolio (70). |
| C43 Interés registrado neto | Baja | Aplica a instrumentos con `CO_RETENCION` o `BR_IR_REGRESSIVE` cuando falta `taxes`. Si el monto coincide (±2 %) con el interés causado neto de la retención esperada, y no con el bruto, se registra como neto: bruto = monto × causado / (causado − retención), y la retención inferida pasa a `taxes`. Se avisa `INTEREST_NET_ASSUMED`. J6: 10.000.000 (antes 10.003.869). Un monto bruto se deja como está. |

Cambios aditivos al contrato:
- `Transaction.priceConfirmed?` confirma un precio de operación y omite los controles de atípicos.
- `EngineMarket.pricePointAfter` (interno) devuelve el primer cierre posterior a un día.
- Diagnósticos nuevos: `COUPON_RECORD_DATE_UNITS`, `COUPON_EXCEEDS_ACCRUED_INTEREST` (reemplaza a
  `COUPON_EXCEEDS_ACCRUAL`) e `INTEREST_NET_ASSUMED`.
- Avisos nuevos en filas y resúmenes: `TRADE_PRICE_OUTLIER:<ids>` y `TRADE_PRICE_UNCONFIRMED:<ids>`.
