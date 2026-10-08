# Revisión del motor de cálculo (`packages/core`), ronda 3

Revisor externo. Solo lectura sobre el código. Fecha: 2026-10-07.
Base: `reviews/core-r2.md` y la sección "Respuesta a la revisión ronda 2" de `packages/core/README.md`.

## Veredicto

**Todavía no aprobado, pero cerca.** Verifiqué ejecutando código los **15 arreglos** declarados
(C4 y C22–C35), y los 15 están resueltos. Todos los escenarios de las rondas 1 y 2 pasan, salvo los
tres esperados que el constructor cambió por diseño. Más abajo explico por qué los acepto.

Las pruebas nuevas encontraron un problema de severidad alta que el modelo de devengo arrastra desde
la ronda 2 y que ahora la sugerencia de cupones agrava:

- **Los cupones e intereses periódicos de la renta fija se cuentan dos veces.** Un CDT de interés
  trimestral (muy común en Colombia) da un TWR de **20,2 % en lugar de ≈ 11,5 %**.
- Además, el nuevo detector de precios atípicos rechaza movimientos reales grandes (C37), y en una
  reestructuración hay inconsistencias por posición (C38).

| | Puntaje (0–10) |
|---|---|
| **Nuestro motor (`@pm/core`)** | **7,8** (ronda 1: 5,5; ronda 2: 7,0) |
| **Mejor competidor para este caso: Portfolio Performance** | **8,0** |

`approved = false`: queda un hallazgo alto (C36) y el puntaje aún no supera al del competidor.

Comprobaciones hechas:
- `npx vitest run packages/core`: 190/190 pruebas pasan. `npx tsc -p packages/core --noEmit` no da
  errores.
- Volví a ejecutar los 13 scripts de las rondas 1 y 2 con `TZ=America/Bogota`, y escribí `r3-a.ts`,
  `r3-b.ts` y `r3-c.ts` en
  `/tmp/claude-0/-home-user-Portfolio-Manager-Herramienta/8b757dea-bb3a-58bd-aa07-26758394d338/scratchpad/review-core/`.

### Esperados que el constructor cambió por diseño: los tres son correctos

- **F1. Correcto.**
  - Del 2024-01-02 al 2025-01-02 hay 366 días; en ACT/365 eso da 1,12^(366/365).
  - La redención automática neta de la retención estimada del 4 % da 11.155.338,90: interés bruto
    1.203.478 menos 48.139.
  - La retención aparece en `taxesBase` del mes (48.139) y la ganancia queda marcada `estimated`, así
    que no se pierde el dato fiscal.
  - Quien necesite pagar exactamente la tasa en un año calendario tiene `ACT/ACT`.
- **F4. Correcto.** El calendario ANBIMA de 2024 incluye el 20 de noviembre (Lei 14.759/2023). Lo
  verifiqué contra la lista oficial de feriados de ANBIMA: 2024 tiene 253 días hábiles, y de
  2024-01-02 a 2024-12-31 hay 252 en el intervalo semiabierto. 110 % del CDI anual del 14,5 %
  escalando la tasa diaria da (1 + 1,1·(1,145^(1/252) − 1))^252 × 10.000 = **11.606,05**, igual que
  el motor.
- **F8. Correcto para contratos de devengo (CDT/CDB).** Cada lote es su propio contrato: 2.148,67 =
  1.048,67 + 1.100. Para un bono negociable sin serie de mercado, dos lotes del mismo título quedan
  valorados distinto el mismo día. Es aceptable, porque basta un precio de mercado o manual para
  re-anclar todos los lotes (F7 sigue exacto).

---

## Arreglos verificados (15)

| ID | Verificación independiente |
|---|---|
| C4 | YTD al 2024-04-20 con IPC hasta febrero: `inflation` 3,97 %, `inflationEstimated: true`, `inflationThrough: 2024-02-29`, `realTwr` presente. Más allá de 62 días deja de proyectar (correcto). En I2 el `realTwr` desde el inicio ahora existe. |
| C22 | R1a, R1b y R1c = 0 % en la tabla, el resumen y por posición. Variantes nuevas: grupamento + cash in lieu + depósito = 0 %; split de una acción en USD + compra con FX +5 % = **5 % exacto, local 0 %**, posición 5 %; bonificação + venta total + retiro el mismo día = 0 %. |
| C23 | E1–E4 pasan: edición en sitio, reemplazo de una fila, `options.asOf`, `reverse()` y mutación de una posición devuelta, `portfolio.baseCurrency`. `createEngine` toma una instantánea (H4). |
| C24 | F2: caja = 11.152.000 (el pago real), sin `OVERSELL`. Un vencimiento en festivo colombiano (lunes de Reyes 2025-01-06) se paga el 2025-01-07, con `estimated`. *Ver C39.* |
| C25 | R2: el error de digitación da −0,89 % (antes +900 %) con `TRADE_PRICE_OUTLIER`. *Ver C37: regresión con movimientos reales.* |
| C26 | K1: se sugieren el JCP (20, IR 15 % = 3) y el dividendo (50). |
| C27 | 30.000 movimientos × 200 acciones: 77 ms (antes 4 s). |
| C28 | K5: A = 0 (TWR 0), C = +50; el realizado total se conserva. *Ver C38.* |
| C29 | Prefixado al 12 % por un año = 11.205,04 = 10.000 × 1,12^(253/252) con el calendario ANBIMA correcto. Festivos colombianos de la Ley Emiliani revisados: 18 por año, con los traslados al lunes correctos. |
| C30 | E5: la suma por cuenta (8.000.000) es igual al consolidado, con `IMPLICIT_FX_OTHER_ACCOUNT`. Es coherente: la compra en IBKR no pudo financiarse con la caja de Trii. |
| C31 | CDB 12 %: valor líquido exacto con IOF día 20 (33 %) + IR 22,5 %, y con IR 20 %, 17,5 % y 15 % en sus tramos. Total líquido mixto CDB + LCI correcto. *Ver C40.* |
| C32 | IPCA+6 %: abril sigue devengando con la última variación (10.288 → 10.357) y queda marcado como estimado. |
| C33 | F4 coincide con la convención de mercado (ver arriba). |
| C34 | `Engine.asOf` = fecha local, igual a `todayIso()`. |
| C35 | `goalProjectionForPortfolio` funciona con el demo (valor actual, aportes, TWR, volatilidad) y `goalProjection` acepta `inflation`, `indexContributions` y `realTerms`. |

## Mejor que los competidores

1. **Renta fija por devengo con calendario y tributación.** CDT E.A. (ACT/365 y ACT/ACT), CDB % CDI con
   días ANBIMA, IPCA+ con mes estimado, vencimiento al siguiente día hábil, valor bruto y líquido (IR
   regresivo + IOF, retención del 4 %). Ni PP ni Sharesight tienen esto; Gorila y Kinvo sí, pero sin
   multi-divisa.
2. **Multi-divisa de verdad**, con separación local/divisa del TWR por mes y divisa en dinero
   (realizada, no realizada y caja). Un split en USD con FX +5 % da exactamente 5 % "todo divisa".
3. **Cascada en dinero que cuadra exactamente**, más fina que la de Sharesight.
4. **TWR con el día partido en la operación**, correcto con precios de fin de mes, splits y
   reestructuraciones el mismo día.
5. **% del CDI, retorno real con IPC/IPCA estimado y marcado**, benchmarks de retorno total.
6. **Rentabilidad por posición** que reconcilia con el total; métricas de riesgo; metas conectadas al
   portafolio.
7. **Robustez de datos:** validación, diagnósticos con severidad, `missingFx`, precios viejos, atípicos,
   rutas FX por frescura y caché segura.

## Peor que los competidores

1. **Renta fija con cupones o intereses periódicos** (C36). Gorila y Kinvo modelan el flujo de cupones
   (CDB/CDT con juros periódicos, NTN-B, NTN-F); nuestro motor cuenta el cupón dos veces.
2. **Activos muy volátiles con precios escasos** (C37). PP y Sharesight usan el precio de la operación
   sin rechazarlo.
3. **Acciones corporativas:** siguen siendo sugerencias por confirmar. Sharesight y Gorila las aplican
   solas.

---

## Hallazgos abiertos

### C36 — ALTA (nuevo) — Los cupones e intereses periódicos de un instrumento con devengo se cuentan dos veces
- **Dónde:**
  - `pricing.ts` (`accruedLotValues`) capitaliza todo el periodo sin restar los pagos.
  - `ledger.ts` (`income_`) acredita el INTEREST a la caja sin tocar el valor devengado del lote.
  - `corporate.ts` ahora sugiere `DIVIDEND/COUPON` como `INTEREST` (NTN-B, NTN-F).
  - La redención automática paga capital + **todo** el interés devengado.
- **Evidencia (`r3-b.ts`, `r3-a.ts`):**
  - **H1.** CDT de 10 millones al 12 % E.A. que paga intereses trimestrales (registrados como
    INTEREST con retención del 4 %). Al 2024-12-31 la posición vale **11.193.066** (como si no hubiera
    pagado nada) más **827.636** en caja de cupones, total **12.020.702**. Lo real es ≈ 11.115.000.
    **TWR YTD 20,2 % en lugar de ≈ 11,5 %.**
  - **H2.** Un bono prefixado al 10 % con su cupón semestral sugerido por `applyCorporateActions`:
    1.100 + 48,81 = **1.148,81**, cuando debería ser ≈ 1.100. El cupón se cuenta dos veces.
  - **G3c.** Si el importador registra el interés del CDT al vencimiento como INTEREST (el extracto
    dice "abono intereses CDT" y "cancelación capital"), la redención automática vuelve a pagar el
    interés: caja **12.307.339** en vez de 11.152.000. Sin diagnóstico.
- **Por qué es alta:** el CDT con pago periódico (mensual o trimestral) es el producto de renta fija
  más común de la persona natural en Colombia, y NTN-B/NTN-F pagan cupón semestral. El error infla
  el valor, el TWR, la cascada y la redención.
- **Arreglo:**
  - Un INTEREST/COUPON sobre un instrumento con `accrual` debe **reducir el valor devengado del lote**
    en el monto bruto (re-anclar en `valor − cupón` en la fecha de pago).
  - O modelar el calendario de cupones (`couponFrequency`: periodo vencido) y valorar solo el
    devengado desde el último pago.
  - La redención automática debe pagar el capital más el devengado desde el último cupón, y advertir
    `INTEREST_ALREADY_RECORDED` si ya existe el interés del vencimiento.
  - Agregar H1, H2 y G3c como pruebas.

### C37 — MEDIA (nuevo, regresión de C25) — El detector de atípicos rechaza movimientos reales grandes cuando no hay un cierre posterior o solo hay precios de operación
- **Dónde:** `ledger.ts:296-304`. Basta `d1 === true && d2 !== false`: sin un cierre siguiente, la
  desviación frente al precio anterior decide sola. La tolerancia es 30 % × √(meses).
- **Evidencia (G4):**
  - Un fondo o activo privado con solo precios de operación sube de verdad 40 % en 6 semanas (compra a
    100 y luego a 140). El motor marca `TRADE_PRICE_OUTLIER` y lo valora a 100: **valor 11.000 en vez
    de 15.400, TWR de febrero −3,5 % en vez de +40 %.**
  - BTC con cierres de fin de mes y una compra +45 % en el mes en curso: **TWR −3,9 % en vez de
    ≈ +45 %.**

  Esto reintroduce el problema de la ronda 1 (C1) para cripto, small caps y fondos manuales, que son
  frecuentes entre inversionistas de la región.
- **Arreglo:**
  - Rechazar solo cuando hay evidencia en ambos lados (precio anterior **y** cierre posterior desvían).
  - Sin cierre posterior, aceptar con advertencia `TRADE_PRICE_UNCONFIRMED`.
  - Escalar la tolerancia por clase de activo (cripto, renta variable de baja liquidez) o por la
    volatilidad histórica.
  - Mostrar en la UI una confirmación "¿este precio es correcto?".

### C38 — MEDIA (nuevo) — En un cambio de ticker o fusión, el TWR por posición queda en 0 aunque el retorno en dinero sea positivo
- **Dónde:** `positions.ts`, flujos de inicio de día (`startInBase/startOutBase`). La entrega se
  valora al precio de la resultante, y el denominador del tramo queda degenerado.
- **Evidencia (G2):** OLD tiene su último cierre en 100 y NEW cierra en 110 el día del cambio. El
  portafolio da +10 % (correcto). Por posición, OLD tiene `totalReturnBase` = **+100 con TWR 0 %**
  y NEW tiene 0 y 0 %. En K5, B queda con +20 y TWR 0 %. El retorno en dinero y el porcentaje no
  concuerdan.
- **Arreglo:** valorar la entrega al cierre propio de la empresa de origen (la ganancia cae en la
  resultante), o al valor de la resultante pero calculando el tramo de origen como
  `(entrega)/(V(f−1)) − 1`. Agregar pruebas de consistencia: TWR = retorno en dinero / valor inicial
  cuando no hay flujos.

### C39 — BAJA (nuevo) — Una redención registrada fuera de la ventana de 5 días hábiles se descarta
- **Evidencia (G3a):** un CDT vence el 2025-01-03 y el usuario registra el pago el 2025-01-16 (8 días
  hábiles después). El resultado es `MATURITY_REDEEMED` + `OVERSELL`: el pago real se ignora y la caja
  queda con el estimado (11.155.339).
- **Arreglo:** un instrumento vencido no puede venderse después, así que **cualquier** SELL posterior al
  vencimiento de un instrumento redimido automáticamente debería reemplazar la estimación, con el aviso
  `LATE_REDEMPTION`.

### C40 — BAJA (nuevo) — Los instrumentos exentos (LCI/LCA) no traen campos de valor líquido
- **Evidencia (H3):** una LCI con `taxRegime: 'EXEMPT'` deja `netMarketValueBase`, `accruedTaxBase`
  y `Valuation.totalNetMarketValueBase` en `undefined` cuando todo el portafolio es exento. Con
  CDB + LCI mezclados, el total sí es correcto.
- **Arreglo:** llenar siempre neto = bruto e impuesto = 0 para los instrumentos con devengo exentos.

### C41 — BAJA (nuevo) — Caché con `MarketData` propios mutables, y costo de hashing
- **Evidencia:**
  - **H5.** Una implementación propia de `MarketData` (el contrato lo permite) a la que se agrega una
    cotización sobre el mismo objeto devuelve el valor viejo (1.000 en vez de 1.500), porque la caché
    usa la identidad del objeto de mercado.
  - Con 30.000 movimientos, cada llamada al API hashea la entrada en **≈ 25 ms**, frente a 0,4 ms con
    `createEngine`. El tablero de 11 resúmenes subió a 1,15 s (antes 0,68 s).
- **Arreglo:** un campo opcional `MarketData.revision` (o `version`) dentro del hash, y documentar
  `createEngine` como la vía recomendada para la web.

---

## Prioridad para la ronda 4

1. **C36:** cupones e intereses de renta fija con devengo. Es lo único que impide la aprobación por
   severidad.
2. C37 y C38: atípicos con confirmación en ambos lados; TWR por posición coherente en
   reestructuraciones.
3. C39–C41.

Con C36 y C37 resueltos, el motor quedaría por encima de Portfolio Performance para el inversionista
de Colombia o Brasil (puntaje esperado ≥ 8,5).
