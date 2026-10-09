# Revisión `packages/tax` — Ronda 7 (confirmación)

**Revisor:** agente revisor (solo lectura; no construí este paquete)
**Fecha:** 2026-10-09
**Alcance:** confirmar que los ajustes de T57–T60 no rompieron nada y buscar regresiones en tres puntos:

- el límite de R$ 35 mil con partes retenidas;
- si un DARF confirmado puede quedar pagado de más o de menos entre meses;
- cómo pasan los costos provisorios a Bens e Direitos y al año siguiente.

## Veredicto

**SIGUE APROBADO.** Verifiqué ejecutando código que **los 4 gaps de la ronda 6 están corregidos**. Ningún escenario de las rondas 1 a 6 empeoró: las salidas que cambiaron lo hicieron como estaba previsto. **No apareció ningún gap de severidad alta.**

Encontré tres gaps nuevos de severidad media o baja:

- el DARF 4600 de cripto no tiene el manejo que ya existe para el DARF 6015: mínimo de R$ 10, conciliación de pagos y multa por atraso (T61);
- los costos provisorios no se marcan en la ficha de Bens e Direitos (T62);
- una salida huérfana no confirmada queda "em trânsito" indefinidamente (T63).

| | Puntaje |
|---|---|
| **Nuestro paquete (`@pm/tax`)** | **8,5 / 10** (sin cambio) |
| **Mejor competidor para este trabajo: Gorila (Brasil)** | **7 / 10** |

`approved = true`: 8,5 es mayor que 7 y no hay gaps de severidad alta.

### Pruebas ejecutadas

- `npx vitest run packages/tax` → **193/193 pruebas pasan** en 10 archivos.
- `npx tsc -p packages/tax --noEmit` → **0 errores**.
- Volví a correr los **18 scripts** de las rondas 1 a 6 y todos terminan bien. Comparé las salidas con las de la ronda 6; las únicas diferencias son las esperadas:
  - A7b ahora informa `darfHeldAmount: 30000`;
  - en P6, la llegada inferida pasados los 90 días queda con costo provisorio y el DARF retenido (`CRYPTO_SALE_COST_PROVISIONAL`), y `TRANSFER_MATCHED_LATE` pasa a nivel warning;
  - el XLSX tiene una columna más (`valor_retido`).
- Escribí escenarios nuevos en `r7-adversarial.ts` (S1–S6) y `r7-s1.ts`.

---

## Verificación de los gaps de la ronda 6

| Gap | Estado | Evidencia (resultado real) |
|---|---|---|
| T57 Depósito huérfano | **Corregido** | **Q4:** impuesto de 67.500 visible y DARF retenido. **Q4b:** costo provisorio de 300.000 y 22.500 retenidos, con `CRYPTO_SALE_COST_PROVISIONAL`. **S4c:** al confirmar con la nota `[custo: 2021-01-10 @ 20000]`, el costo pasa a 50.000 y se emite un DARF de 26.250, que coincide con mi cálculo |
| T58 Emparejamiento tardío | **Corregido** | **Q5:** no hay emparejamiento automático después de 10,5 meses; la entrada conserva su valor (costo 500.000, impuesto 0) y aparece `TRANSFER_MATCH_PROPOSED` como warning. **S6:** con `confirmedTransfers` el costo de 200.000 se traslada (impuesto 37.500) y desaparece el "em trânsito". **S6b:** `brazilTaxPack` reenvía la opción. **Pero ver T63** |
| T59 DARF separado | **Corregido** | **Q2b:** DARF de 750 (ETH confirmado) y 2.700 retenidos, con `CRYPTO_EXEMPTION_DEPENDS_ON_UNCONFIRMED` y `CRYPTO_DARF_PARTIAL`. **S2:** una venta confirmada de R$ 40.000 y una de billetera de R$ 20.000 dan DARF de 3.000 sobre la parte confirmada y 1.500 retenidos |
| T60 Avisos de más | **Corregido** | Q7 y Q8 ya no dan avisos de ambigüedad ni de costo desconocido; los costos siguen siendo 250.000 y 200.000 |

**Corregidos y verificados: 4 de 4** (T57, T58, T59, T60).

### Resultado de los tres puntos pedidos

- **Límite de R$ 35 mil con partes retenidas:** está bien resuelto. En Q2a, Brasil 30 mil más exterior 30 mil queda exento. En Q2b, la parte retenida sí cuenta para el límite (criterio conservador) y se avisa que el DARF confirmado de 750 podría ser restituible si esa parte no era de Brasil.
- **DARF confirmado pagado de más o de menos entre meses:** en la parte de cálculo no encontré errores; el DARF confirmado y el monto retenido nunca se mezclan (S2). Pero el DARF 4600 **no** tiene el mínimo de R$ 10 ni la conciliación de pagos, y eso sí puede dejarlo pagado de menos o fuera de tiempo (T61).
- **Costos provisorios hacia Bens e Direitos y el año siguiente:** la continuidad funciona. En S4, la "situação atual" de 2025 (300.000) coincide con la "anterior" de 2026, y al confirmar el costo (S4c) ambos años lo usan (100.000). Lo que falta es marcar en la ficha que el costo es provisorio (T62).

---

## Gaps nuevos

### T61 — MEDIA — El DARF 4600 de cripto no tiene mínimo, conciliación ni recargos por atraso

- **Escenario r7-s1:** ventas de R$ 182.000 por mes con ganancia de R$ 25.
  - Obtenido: **un DARF 4600 de R$ 3,75 en marzo y otro de R$ 3,75 en abril**.
  - Según la Lei 9.430/1996, art. 68, un DARF menor a R$ 10 no se paga: se acumula hasta llegar al mínimo. El Sicalc no emite DARF por menos de ese valor. Esa regla ya se aplica al 6015, pero no al 4600.
- **Escenario S3:** un DARF 4600 de marzo de R$ 3.000 pagado el 10-jun-2026 con la nota "DARF 4600 2026-03".
  - Obtenido: el mes de cripto **no tiene estado** (`pendente`/`paga`/`paga_em_atraso`/`vencida`), ni multa o juros, ni aviso `DARF_UNDERPAID`.
  - El pago atrasado no se concilia, y pagar solo el principal deja un saldo de multa y Selic sin informar.
- **Fix:** que los DARF 4600 (y el 0190 del carnê-leão) pasen por la misma lógica que el 6015: mínimo de R$ 10 acumulable (`includesMonths`), `matchDarfPayments` por código, `darfLateCharges` y `sicalcData` con la fecha de pago.

### T62 — BAJA — Bens e Direitos no marca los costos provisorios o pendientes en la ficha

- **S4:** un depósito huérfano con valor queda en Bens e Direitos 2025 como "1,00 BTC-USD, custo médio de aquisição." por R$ 300.000, sin indicar que es provisorio.
- **S5:** sin valor, la ficha queda con **R$ 0** y la misma descripción.
- Los avisos existen a nivel de reporte, pero la línea que el usuario copia a la DIRPF no lo dice.
- **Fix:** agregar "(custo provisório — confirmar)" o "(custo pendente)" en `discriminacao` y un campo `costStatus` en el ítem.

### T63 — BAJA — Una salida huérfana no confirmada queda "em trânsito" para siempre

- **Q5:** una salida de enero de 2025 (por ejemplo, un regalo o una venta por fuera) sin entrada confirmada sigue apareciendo en **Bens e Direitos 2026 como "1,00 BTC-USD EM TRÂNSITO em 31/12/2026"** por R$ 200.000, y seguirá en los años siguientes. Hay un aviso `TRANSFER_OUT_UNMATCHED` de nivel warning, pero el patrimonio declarado queda inflado mientras el usuario no lo resuelva.
- **Fix:** después de `transferMaxLateDays` o al cierre del año siguiente, pedir una decisión explícita (transferencia a terceros o venta por fuera, que debería registrarse como `SELL`), y no arrastrar el ítem en silencio de un año a otro.

---

## Recomendación

**Mantener la aprobación.** El paquete está listo para integrar. T61 es el único gap de severidad media: conviene corregirlo antes del primer mes con ventas de cripto reales, porque afecta la parte operativa del pago (DARF chicos, atrasados o pagados solo en parte). T62 y T63 son de presentación y se pueden dejar para después.
