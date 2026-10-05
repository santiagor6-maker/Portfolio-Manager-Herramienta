# @pm/core — motor de cálculo de Portafolio Pro

Motor puro (sin I/O) que convierte movimientos + precios + tasas de cambio en posiciones, caja
multi-divisa, valoración, ganancias realizadas/no realizadas, tabla mensual, TWR/MWR, riesgo y
asignación. El contrato está en `src/types.ts` (tipos) y `src/api.ts` (funciones).

```
npx vitest run packages/core        # 89 pruebas
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

Campos opcionales añadidos a `types.ts` (aditivos): `Holding.accountQuantities` y
`CashBalance.accountAmounts` (cantidades/saldos por cuenta, usados por `allocation(…, 'account')`).

## Libro de movimientos

Orden dentro del mismo día (estable según el orden de entrada):
`DEPOSIT/TRANSFER_IN` → `FX_CONVERSION` → `BUY` → `SPLIT/STOCK_DIVIDEND` → `DIVIDEND/INTEREST/RETURN_OF_CAPITAL` → `SELL` → `FEE/TAX` → `TRANSFER_OUT/WITHDRAWAL`.

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

Valor de una posición = `cantidad × precio / priceMultiplier × FX(moneda→base)` con precio y FX del
último dato en o antes de la fecha. Sin precio ⇒ se valora **al costo** (y aparece en `missingPrices`).
Sin FX en o antes de la fecha ⇒ se usa la primera tasa posterior y la divisa aparece en `missingFx`.
`totalCostBase` = costo histórico de los títulos + caja a valor actual.

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

El periodo se parte en sub-periodos en **cada día con flujo externo** y se encadenan:

```
TWR = Π (1 + r_i) − 1
tramo sin flujos [a, b]:   r = V(b) / V(a) − 1
día con flujo f:           r = (V(f) + SALIDAS_f) / (V(f−1) + ENTRADAS_f) − 1
```

`V(d)` es el valor al cierre del día `d` (todas las operaciones del día aplicadas). Convención (igual que
Portfolio Performance): **las entradas ocurren al inicio del día y las salidas al final**. Así una compra
grande financiada con un aporte el mismo día no "presta" su diferencia intradía al capital anterior (evita
picos espurios cuando el usuario solo registra operaciones), y un retiro no diluye el rendimiento del día.
Los flujos se convierten a base con la tasa de mercado del día del flujo. Si el denominador es ≤ 0,01
(portafolio vacío o negativo) el sub-periodo aporta 0.

`Modified Dietz` (opción `twrMethod: 'modifiedDietz'`), un cálculo por periodo:
`r = (V1 − V0 − ΣF) / (V0 + Σ w·F)`, `w = (D − t)/D`, con `t` = días desde el inicio hasta el inicio del
día del aporte (o el final del día del retiro).

Acumulado: producto encadenado de los meses. Anualizado (solo si el periodo supera 365 días):
`(1 + TWR)^(365,25/días) − 1`.

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
TWR, TWR acumulado, local/divisa y retorno de los *benchmarks* (precio convertido a base:
`P1·X1 / (P0·X0) − 1`; usa `portfolio.benchmarks` si no se pasan).

### Resumen por periodo

`from` = primer día incluido; el valor inicial es el cierre del día anterior. 1M desde 2024-03-31 ⇒
`from` = 2024-03-01. Periodos anteriores al inicio se recortan a la fecha de inicio.
`realizedGainBase` = ventas del periodo; `unrealizedGainBase` = **variación** de la ganancia no realizada
en el periodo (en SI coincide con la total). `mwr` = XIRR con valor inicial como aporte, flujos externos y
valor final.

### MWR / XIRR

`Σ a_i (1 + r)^(−(d_i − d_0)/365) = 0`. Newton–Raphson con varios puntos de partida y, si falla,
bisección sobre un intervalo con cambio de signo en (−1, 10⁶]. Devuelve `undefined` sin solución
(todos los flujos del mismo signo, un único flujo, todo el mismo día).

## Riesgo

Sobre los TWR mensuales (se omiten meses vacíos): volatilidad = desviación muestral × √12; Sharpe =
(media de exceso mensual × 12) / volatilidad, con `rf` mensual = (1 + rf)^(1/12) − 1; Sortino con
desviación a la baja respecto a rf; drawdown máximo sobre el índice de cierres mensuales (inicio = mes del
pico, fin = mes del valle); beta y correlación contra `benchmarkMonthly` (alineado con las filas) o contra
el primer benchmark de las filas.

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
  recurre a la triangulación en fechas anteriores.

## Validación

Errores: `INVALID_DATE`, `MISSING_CURRENCY`, `UNKNOWN_TYPE`, `MISSING_INSTRUMENT`, `UNKNOWN_INSTRUMENT`,
`NEGATIVE_QUANTITY`, `MISSING_QUANTITY`, `MISSING_PRICE`, `NEGATIVE_AMOUNT`, `INVALID_RATIO`, `OVERSELL`
(considera splits), `MISSING_TO_CURRENCY`, `DUPLICATE_ID`.
Advertencias: `FUTURE_DATE`, `DUPLICATE_IMPORT` (mismo `importHash`), `CURRENCY_MISMATCH`, `ZERO_AMOUNT`,
`SAME_CURRENCY_CONVERSION`. El motor no se detiene: limita sobreventas a lo que hay y lo reporta.

## Datos de ejemplo

`createDemoData()` devuelve "Portafolio de ejemplo" (base COP, residencia CO, FIFO): Ecopetrol,
PFBCOLOM, ISA, PETR4, ITUB4, WEGE3, AAPL, MSFT, VOO, ASML, IBE (+ ICOLCAP como benchmark), tres
cuentas (Trii, Interactive Brokers, XP), aportes, compras durante 3 años, dividendos con retención,
un split 2:1 de WEGE3, conversiones de divisa, dos ventas y un retiro; series de fin de mes 2023-01 a
2026-09 (USD/COP 3.700–4.400, USD/BRL 4,8–5,8, EUR/USD 1,05–1,15). **Precios, tasas, dividendos y el
split son sintéticos** (deterministas), no datos históricos. `input` está listo para el motor y `isDemo`
es `true` para mostrar una etiqueta en la UI.

## Rendimiento

Un portafolio de 10 años, 2.000 movimientos y 40 instrumentos con precios diarios genera la serie
diaria completa en ~0,1–0,2 s (prueba `perf.test.ts`, límite 1,5 s): el libro se procesa de forma
incremental una sola vez y cada valoración usa búsqueda binaria.

## Pendientes / limitaciones conocidas

- Los lotes son por portafolio (no por cuenta); las cantidades por cuenta solo se usan para asignación.
- No hay manejo de *cash in lieu* en reverse splits (las fracciones se conservan).
- Las acciones corporativas (`CorporateAction`) del proveedor no se aplican automáticamente; deben
  registrarse como movimientos `SPLIT`/`DIVIDEND`.
- Ventas en corto no soportadas (se reportan como sobreventa).
