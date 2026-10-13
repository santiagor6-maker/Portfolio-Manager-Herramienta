# Revisión `packages/tax` — Ronda 8

**Revisor:** agente revisor (solo lectura; no construí este paquete)
**Fecha:** 2026-10-13
**Alcance:**

- las correcciones de T61–T63;
- casos límite de DARF: varios códigos en el mismo mes, pagos parciales, pago anticipado por otro monto, acumulación bajo R$ 10 al cambiar de año, interacción con el mínimo del 6015;
- la resolución de tránsitos frente a un depósito real posterior;
- la integración con el contrato de `@pm/core`: `IncomeEvent.taxesEstimated`, `Transaction.amountIsNet` y los `subtype` de SPLIT y DIVIDEND.

## Veredicto

**SE RETIRA LA APROBACIÓN.** Verifiqué ejecutando código que **T61, T62 y T63 están corregidos**, y los 20 scripts de las rondas 1 a 7 no muestran regresiones. Pero la revisión del contrato de core, que se pidió en esta ronda, dejó ver un problema que viene de antes:

- **`packages/tax` ignora los `subtype` de `SPLIT`** (`TICKER_CHANGE`, `MERGER`, `SPINOFF`) que el contrato define desde la ronda 2 de core. Con un cambio de ticker real, como BCOLOMBIA → CIBEST en 2025, o con una fusión en la B3, la venta del ticker nuevo queda **sin costo y sin impuesto** (en Colombia como "pendiente de costo"; en Brasil se toma como venta en corto, sin DARF). Además, el ticker viejo **sigue figurando en el patrimonio y en Bens e Direitos** como si no se hubiera tocado (T64, alta).

Estos datos son válidos según el contrato y los importadores los van a producir. Por eso le asigno la misma severidad que a T4 y T47: una venta real que queda sin tributar y una tenencia fantasma.

**Respuesta a la pregunta sobre core:** `packages/tax` **nunca toma como real una retención estimada**, porque no lee `IncomeEvent`: trabaja directamente sobre `Transaction.taxes`. Pero **ignora `Transaction.amountIsNet`** (T67) y **`subtype: 'JCP'`** (T66), así que un interés registrado neto se declara como si fuera bruto, sin retención y sin aviso, y un JCP marcado solo por `subtype` se declara como dividendo exento.

| | Puntaje |
|---|---|
| **Nuestro paquete (`@pm/tax`)** | **8 / 10** (8,5 → 8 por la integración con el contrato) |
| **Mejor competidor para este trabajo: Gorila (Brasil)** | **7 / 10** |

`approved = false`: aunque 8 es mayor que 7, hay un gap de severidad **alta** (T64).

### Pruebas ejecutadas

- `npx vitest run packages/tax` → **214/214 pruebas pasan** en 11 archivos.
- `npx tsc -p packages/tax --noEmit` → **0 errores**.
- Volví a correr los **20 scripts** de las rondas 1 a 7 y todos terminan bien. Comparé las salidas con las de la ronda 7; solo cambiaron las esperadas:
  - el DARF ahora trae estado, meses incluidos y datos del Sicalc;
  - el régimen anterior a 2024 incluye los DARF 4600 y 0190;
  - en Q5, el tránsito de más de 12 meses queda excluido con `CRYPTO_TRANSIT_STALE`;
  - el XLSX tiene más columnas.
- Escribí escenarios nuevos:
  - `r8-darf.ts` y `r8-darf2.ts` (D1–D8, sobre DARF y tránsitos);
  - `r8-contract.ts` (C1–C5, sobre el contrato de core).

---

## Verificación de los gaps de la ronda 7

| Gap | Estado | Evidencia (resultado real) |
|---|---|---|
| T61 DARF 4600 igual que el 6015 | **Corregido** | **r7-s1:** dos meses de R$ 3,75 ya no generan DARF (quedan acumulados). **D5:** 3,75 + 3,75 + 7,5 dan un DARF de R$ 15 en mayo que incluye marzo, abril y mayo. **D6:** el acumulado de octubre y noviembre de 2025 sale en enero de 2026 (R$ 11,25). **D7:** el 6015 (R$ 6) y el 4600 (R$ 7,5) se acumulan cada uno por su lado. **S3:** `paga_em_atraso` más `DARF_UNDERPAID`. **D1:** cada pago va a su código. **D2:** un pago sin código solo salda el 6015 y el 4600 queda `vencida` (R$ 3.797,40 con recargos). **Pero ver T68 y T69** |
| T62 Costo no confirmado en Bens e Direitos | **Corregido** | **S4:** "(custo provisório — confirmar)" en 2025 y 2026. **S5:** "(custo pendente — informar custo de aquisição)". **S4c**, con el costo confirmado por nota, sale sin marca. En todos los casos con `BENS_COST_NOT_CONFIRMED` |
| T63 Tránsitos indefinidos | **Corregido** | **Q5:** en 2026 el ítem queda en 0 con `error:CRYPTO_TRANSIT_STALE`. **D8:** con "alienado" la salida desaparece de Bens e Direitos y un depósito posterior queda con costo pendiente. **D8c:** con `confirmedTransfers` el costo de 200.000 llega a Binance. **Pero ver T70** |

**Corregidos y verificados: 3 de 3** (T61, T62, T63).

---

## Gaps nuevos

### T64 — ALTA — Se ignoran los SPLIT con `subtype` TICKER_CHANGE o MERGER: venta sin costo ni impuesto, y ticker viejo fantasma

- **Evidencia:** `grep subtype packages/tax/src` no tiene ningún resultado fuera de las pruebas. Los ledgers de Colombia y la B3 aplican cualquier `SPLIT` como `qty *= ratio` sobre el **mismo** instrumento e ignoran `targetInstrumentId`. El contrato (`packages/core/src/types.ts`, `subtype`) dice que en MERGER y TICKER_CHANGE "all lots move to targetInstrumentId … cost and open dates preserved".
- **C1 (Colombia):** BCOLOMBIA ×1.000 comprado en 2023 a 30.000 COP; `SPLIT TICKER_CHANGE` → CIBEST el 20-may-2025; venta de 500 CIBEST a 40.000.
  - Esperado: costo de 15M, compra el 2023-01-10, Art. 36-1.
  - Obtenido: venta **`pendiente_costo` con costo 0**, error `OVERSELL`, y en el patrimonio **siguen 1.000 BCOLOMBIA por 30M**.
- **C2 (B3):** BRML3 ×3.000 a R$ 10; `SPLIT MERGER` → ALOS3 con ratio 1/3; venta de 1.000 ALOS3 a R$ 25.
  - Esperado: −R$ 5.000 (pérdida compensable).
  - Obtenido: se toma como **venta en corto** (`SHORT_OR_MISSING_HISTORY`), sin resultado, y en Bens e Direitos **siguen 1.000 BRML3 por R$ 30.000**.
- **Fix:** en los ledgers de Colombia, la B3, el exterior y cripto:
  - MERGER y TICKER_CHANGE mueven las unidades (× `ratio`), el costo y las fechas de compra a `targetInstrumentId`;
  - SPINOFF (T65) crea los lotes en el destino con `costFraction` del costo y conserva las fechas de compra.
  - Agregar pruebas con C1 y C2.

### T65 — MEDIA — Se ignora el SPINOFF

- **C3:** 1.000 GGBR4 (R$ 20.000) con `SPLIT SPINOFF` → SPIN3, `ratio` 1 y `costFraction` 0,1.
  - Esperado en Bens e Direitos: GGBR4 por R$ 18.000 y SPIN3 ×1.000 por R$ 2.000.
  - Obtenido: **GGBR4 ×1.000 por R$ 20.000 y SPIN3 no aparece**. Además, una venta futura de SPIN3 se tomaría como venta en corto.
- **Fix:** lo mismo que en T64.

### T66 — MEDIA — `subtype: 'JCP'` no se usa al clasificar proventos

- **C4:** un `DIVIDEND` con `subtype: 'JCP'`, R$ 1.000, sin `taxes` y sin nota.
  - Obtenido: tipo **DIVIDENDO, línea 09 (exento)** e IRRF esperado 0.
  - El JCP es de tributación exclusiva (línea 10) con un IRRF esperado de R$ 175 (17,5% en 2026).
- La heurística por nota o por tasa de retención falla justo cuando el importador trae el subtipo pero no la retención.
- **Fix:** `subtype === 'JCP'` debe tener prioridad sobre cualquier heurística. Si falta la retención, avisar con `IRRF_MISMATCH` o `JCP_IRRF_MISSING`.

### T67 — MEDIA — `amountIsNet` se ignora: un interés neto se declara como bruto, sin retención y sin aviso

- **C5:** interés de un CDT colombiano de 9.600.000 COP con `amountIsNet: true` y sin `taxes`.
  - Obtenido: ingreso de **9.600.000 con retención 0**, sin ningún aviso.
  - Esperado: bruto de 10.000.000 y retención de 400.000 (4%), o como mínimo un `warning` pidiendo el certificado.
  - Lo mismo pasa con un interés o cupón de renta fija brasileña registrado neto.
- Este es el lado opuesto del cuidado que se pidió: tax no toma la retención estimada de core como si fuera certificada (bien), pero tampoco reconoce que el monto es neto. Termina declarando un ingreso menor y sin el crédito de retención, y no va a cuadrar con la exógena ni con el informe de rendimentos.
- **Fix:** si `amountIsNet` es `true` y no hay `taxes`, hay dos opciones:
  - calcular el bruto con la tarifa de retención del régimen, marcada como **estimada** (sin usarla como crédito certificado y con un aviso para pedir el certificado);
  - o, como mínimo, emitir un `warning` `INCOME_RECORDED_NET` y excluir la línea de las cifras "listas para declarar".

### T68 — MEDIA — Un DARF solo admite un pago: los pagos parciales o complementarios no se suman

- **D3:** DARF 4600 de R$ 3.000 pagado en dos partes (R$ 1.000 el 20-abr y R$ 2.000 el 28-abr, ambas con la nota "DARF 4600 2026-03").
  - Obtenido: estado `paga` con `paid: 1000` y un **`DARF_UNDERPAID` falso**. El segundo pago queda sin usar y no se informa.
  - Es habitual pagar el principal y después un DARF complementario con multa y juros.
- **D4a:** un pago anticipado de R$ 2.500 por R$ 3.000 da el estado **`paga`**, solo con el warning: el estado no refleja el saldo pendiente.
- **D4b:** un pago de más (R$ 3.500) no genera ningún aviso sobre el crédito, que se puede recuperar por PER/DCOMP.
- **Fix:**
  - sumar todos los pagos del mismo código y mes;
  - agregar el estado `paga_parcial` con el saldo, incluidos los recargos;
  - avisar el excedente (`DARF_OVERPAID`);
  - informar los pagos que no se imputaron a ningún DARF (`DARF_PAYMENT_UNMATCHED`).

### T69 — BAJA — DARF acumulado: el pago anotado con un mes anterior no se reconoce, y se pierde el acumulado de hace dos años

- **D5:** un DARF de R$ 15 que acumula marzo, abril y mayo, pagado con la nota "DARF 4600 2026-03", queda **`vencida`**, porque el pago solo se compara con el mes de emisión (mayo) y no con `includesMonths`.
- **D6c:** R$ 7,50 pendientes de nov/dic de 2024, ninguna venta en 2025 y R$ 3,75 en ene-2026. El reporte de 2026 solo recorre desde 2025, así que **no ve el acumulado de 2024** y no emite el DARF de R$ 11,25.
- **Fix:** comparar el mes del pago con `includesMonths`, y calcular el acumulado desde la primera venta, no solo desde el año anterior.

### T70 — BAJA — Un tránsito marcado "mantido" más un depósito real posterior se cuentan dos veces

- **D8:** salida de Mercado Bitcoin en enero de 2025 marcada como `"mantido"`, y entrada real de 1 BTC en Binance en abril de 2026.
  - Obtenido: Bens e Direitos 2026 muestra **dos** BTC: "EM TRÂNSITO" por R$ 200.000 y Binance con costo pendiente por R$ 0. Hay un `TRANSFER_MATCH_PROPOSED`, pero el patrimonio queda duplicado mientras el usuario no confirme.
- **Fix:** si la salida está marcada "mantido" y aparece una entrada compatible, aplicar el emparejamiento propuesto (o al menos no sumar las dos líneas) y pedir confirmación.

---

## Recomendación

Volver a aprobar cuando se corrija **T64**: MERGER, TICKER_CHANGE y SPINOFF moviendo lotes, costo y fechas a `targetInstrumentId`, en Colombia, la B3, el exterior y cripto. Es un caso real para el público colombiano (BCOLOMBIA → CIBEST en 2025). Junto con eso, conviene resolver T66 (JCP por subtipo) y T67 (`amountIsNet`), que son cambios chicos de integración con el contrato. T68 completa la conciliación de pagos de DARF.
