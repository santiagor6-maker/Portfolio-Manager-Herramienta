# Revisión `packages/tax` — Ronda 9

**Revisor:** agente revisor (solo lectura; no construí este paquete)
**Fecha:** 2026-10-14
**Alcance:**

- las correcciones de T64–T70;
- **comparar de forma directa la semántica de `common/corporate.ts` con el ledger de core**, pasando los mismos escenarios por `@pm/core` (`realizedGains` y `computeHoldings`) y por los ledgers de tax, y comparando el costo de cada lote;
- cadenas de reorganizaciones (fusión → cambio de ticker → escisión), posiciones repartidas entre cuentas, cripto (MATIC → POL entre custodias) y montos netos;
- verificar en fuentes la tarifa del JCP de 17,5% desde 2026.

## Veredicto

**APROBADO de nuevo.** Verifiqué ejecutando código que **los 7 gaps de la ronda 8 están corregidos**. La comparación con core dio **coincidencia exacta**:

- en Colombia (FIFO), las ventas, los lotes y el costo por lote al centavo;
- en la B3 (preço médio), las posiciones y los resultados;
- en el exterior (Lei 14.754), la parte en efectivo de la fusión, en USD y en BRL;
- también con un ratio fraccionario (1/3) y con el respaldo sin precio del destino (efectivo / costo).

Los 23 scripts de las rondas anteriores no muestran regresiones. **No hay gaps de severidad alta.** Encontré dos gaps de severidad baja (T71, T72).

**JCP 17,5% desde 2026: confirmado.** La LC 224/2025, publicada el 26-dic-2025, modifica el art. 9º, § 2º de la Lei 9.249/1995: la retención pasa del 15% al 17,5% y se aplica en la fecha de pago o crédito. Rige desde el 1-ene-2026; el impuesto de renta no está sujeto a la noventena. Lo confirman Demarest, Mayer Brown, Rolim y Felsberg (WebSearch; el texto de Planalto no se pudo abrir porque WebFetch sigue bloqueado). El 20% "desde 2028" que citan algunas fuentes corresponde a la CSLL de las financieras, no al JCP. El paquete aplica 15% hasta 2025 y 17,5% desde 2026, toma la fecha de crédito (T31) y deja 2027/2028 como `needs-verification`. Es correcto.

| | Puntaje |
|---|---|
| **Nuestro paquete (`@pm/tax`)** | **8,5 / 10** (vuelve de 8 a 8,5) |
| **Mejor competidor para este trabajo: Gorila (Brasil)** | **7 / 10** |

`approved = true`: 8,5 es mayor que 7 y no hay gaps de severidad alta.

### Pruebas ejecutadas

- `npx vitest run packages/tax` → **243/243 pruebas pasan** en 12 archivos.
- `npx tsc -p packages/tax --noEmit` → **0 errores**.
- Volví a correr los **23 scripts** de las rondas 1 a 8 y todos terminan bien. Comparé las salidas con las de la ronda 8; solo cambian las esperadas:
  - campo `balance` en los DARF;
  - S3 pasa a `paga_parcial`;
  - D3, D4a, D4b, D5, D6c y D8 dan los resultados corregidos;
  - C1–C5 dan los resultados esperados.
- Escribí escenarios nuevos:
  - `r9-corporate.ts` (comparación tax contra core: cadena en Colombia y la B3, y MATIC → POL);
  - `r9-corp2.ts` (ratio 1/3 y fusión con efectivo en USD);
  - `r9-net.ts` (JCP y cupón del Tesouro registrados netos).

---

## Verificación de los gaps de la ronda 8

| Gap | Estado | Evidencia (resultado real) |
|---|---|---|
| T64 TICKER_CHANGE / MERGER | **Corregido** | **C1:** la venta de CIBEST usa costo de 15M y fecha 2023-01-10 (Art. 36-1), y el patrimonio solo tiene CIBEST. **C2:** ALOS3 da −5.000, sin corto, y BRML3 queda fuera de Bens e Direitos. **Cadena en Colombia** (fusión con efectivo de 3.000 y ratio 0,5 → cambio de ticker → escisión de 0,25 con 20% del costo → ventas): **los realizados y los lotes de tax coinciden al centavo con los de core**. Las filas de efectivo, con cantidad 0, cuestan 909,09 y 727,27 = 1/11 del costo; ZCCC tiene lotes de 150 por 3.490,91 y de 100 por 3.200 (compra el mismo día de la fusión); WDDD tiene lotes de 25, 62,5 y 25. **Cadena en la B3** con cuentas XP y BTG y fusión sin precio del destino (respaldo efectivo / costo, 3.000 / 20.000): resultados 0 / 8.700 / 1.600 y posiciones ZCCC3 450 por 7.200 y WDDD3 87,5 por 1.400, **iguales a core**. **MATIC → POL** entre custodias: Mercado Bitcoin con costo 5.000 (GCAP) y Binance con 10.000 (Lei 14.754); Bens e Direitos 2025 queda separado por custodia |
| T65 SPINOFF | **Corregido** | **C3:** GGBR4 por R$ 18.000 y SPIN3 ×1.000 por R$ 2.000. En las cadenas, WDDD hereda las fechas de la empresa original y `costFraction` coincide con core |
| T66 JCP por subtipo | **Corregido** | **C4:** tipo JCP, línea 10, IRRF esperado 175 y `JCP_IRRF_MISSING` |
| T67 `amountIsNet` | **Corregido** | **C5:** bruto de 10.000.000, retención de 400.000 estimada y **no** acreditada (`withheldCop` 0), con `INCOME_RECORDED_NET`. **r9-net:** el cupón del Tesouro neto de 85 a 490 días se lleva a un bruto de 103,03 (17,5%), con el IR estimado sin acreditar (`irrfTributaveis` 0). **Pero ver T72** |
| T68 Varios pagos por DARF | **Corregido** | **D3:** 1.000 + 2.000 da `paga`, sin aviso falso. **D4a:** un pago anticipado de 2.500 da `paga_parcial` con el saldo y sus recargos. **D4b:** un pago de 3.500 da `DARF_OVERPAID` (500). **S3:** solo el principal pagado tarde da `paga_parcial` |
| T69 DARF acumulado | **Corregido** | **D5:** un pago con la nota de marzo salda el DARF acumulado de mayo (`paga`). **D6c:** el acumulado de nov/dic de 2024 sale en enero de 2026 (R$ 11,25) |
| T70 Tránsito "mantido" | **Corregido** | **D8:** "mantido" más el depósito de abril de 2026 se emparejan con `TRANSFER_MATCH_APPLIED_MANTIDO`; Binance queda con costo 200.000 y no se cuenta dos veces. Con "alienado", el depósito queda con costo pendiente y sin propuesta |

**Corregidos y verificados: 7 de 7** (T64–T70).

### Comparación con core: resumen

| Escenario | Core | Tax | Resultado |
|---|---|---|---|
| Colombia, cadena con efectivo | realizados [0/909,09; 0/727,27; 500/7.272,73; 100/2.327,27; 100/1.454,55]; lotes ZCCC [150/3.490,91; 100/3.200], WDDD [25/363,64; 62,5/1.454,55; 25/800] | idéntico | coinciden |
| B3, cadena, cuentas, sin precio del destino | XAAA3 efectivo 3.000 contra costo 3.000; ZCCC3 300 → 4.800; WDDD3 100 → 1.600; posiciones 450/7.200 y 87,5/1.400 | idéntico (efectivo agregado en una sola fila) | coinciden |
| B3, fusión 1/3 sobre 1.000 | 0,333 por 10, venta de 333 con costo 9.990 | idéntico | coinciden (ver T71) |
| Exterior, fusión con US$ 1.000 en efectivo y ratio 2 | costo 909,09 USD / 4.545,45 BRL | idéntico; ganancia de 1.454,55 BRL | coinciden |

---

## Gaps nuevos

### T71 — BAJA — Una fusión con ratio fraccionario deja fracciones de acción sin el aviso de remate

- **E1:** fusión 1/3 sobre 1.000 acciones B3 → 333,333; después de vender 333 quedan **0,333 BBBB3 por R$ 10** en Bens e Direitos, sin aviso.
- El SPLIT común sí separa la fracción y avisa del leilão (`FRACAO_GRUPAMENTO`, T18). Core hace lo mismo (también deja 0,333), así que es coherente con core, pero en la B3 esas fracciones se rematan y la venta tributa.
- **Fix:** en MERGER y TICKER_CHANGE de la B3, aplicar el mismo tratamiento de fracciones que en el SPLIT, con el aviso para registrar la venta del remate.

### T72 — BAJA — La retención estimada del JCP neto entra en los totales y se acredita en el IRPFM

- **r9-net:** un JCP de 825 con `amountIsNet` se lleva a 1.000 bruto con IRRF 175 marcado `irrfEstimated: true`, pero **`totals.jcpIrrf` suma 175**, y `brazilIrpfmEstimate` lo usa como crédito ("IRRF sobre JCP").
- Esto contradice la política declarada en T67 (estimado y no acreditado) y lo que pidió el coordinador: que tax nunca use una retención estimada como si fuera real.
- El riesgo práctico es bajo, porque la retención del JCP es obligatoria a una tarifa fija, pero el crédito del IRPFM debería salir de un informe.
- **Fix:** separar `jcpIrrfEstimated` en los totales y, en el IRPFM, mostrar ese crédito como estimado (o pedir el informe para acreditarlo).

---

## Recomendación

**Aprobado.** La duplicación de la lógica de reorganizaciones en `common/corporate.ts` es una deuda técnica (si core cambia sus reglas, tax puede quedar desalineado). Recomiendo:

1. que core exporte una función pura de reorganización, o que se agregue una prueba de contrato que pase los escenarios de `r9-corporate.ts` por ambos paquetes y compare el costo por lote, para que una divergencia futura se detecte sola;
2. corregir T71 y T72 en la próxima ronda.
