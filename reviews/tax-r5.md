# Revisión `packages/tax` — Ronda 5

**Revisor:** agente revisor (solo lectura; no construí este paquete)
**Fecha:** 2026-10-08
**Alcance:** las correcciones de T47–T51 y casos adversariales sobre el nuevo seguimiento de unidades por custodia: traslados parciales, comisión de red, dos traslados el mismo día, venta en el límite entre custodias, pares mal emparejados o huérfanos, y traslados que cruzan el fin de año.

## Veredicto

**NO APROBADO.** Verifiqué **los 5 gaps de la ronda 4 como corregidos** ejecutando código: los escenarios K1, r4-k1b y K3–K9 dan exactamente lo esperado. Pero el nuevo motor de custodia sigue sin **repartir una venta entre custodias**. Si una venta supera las unidades de la custodia que se le asigna, la parte que sobra **desaparece del impuesto** y la otra custodia **sigue mostrando unidades ya vendidas** en Bens e Direitos. Esto pasa incluso con datos coherentes: 0,5 BTC en Mercado Bitcoin, 0,5 en Binance y la venta de 1,0 sin cuenta (T52, alta).

Además, el emparejamiento de traslados es frágil: falla con un traslado en dos partes, con el ingreso anotado antes que la salida el mismo día, con una comisión mayor al 2% o con más de 10 días. En todos esos casos el costo queda en 0 y el impuesto se sobrestima (T53). Hay dos problemas más: dos traslados el mismo día se cruzan entre regímenes (T54) y un activo en tránsito al 31/12 desaparece de Bens e Direitos (T55).

| | Puntaje |
|---|---|
| **Nuestro paquete (`@pm/tax`)** | **8 / 10** (6 → 7,5 → 8 → 8 → 8) |
| **Mejor competidor para este trabajo: Gorila (Brasil)** | **7 / 10** |

`approved = false`: queda un gap de severidad **alta** (T52).

### Pruebas ejecutadas

- `npx vitest run packages/tax` → **162/162 pruebas pasan** en 8 archivos.
- `npx tsc -p packages/tax --noEmit` → **0 errores**.
- Volví a correr los 14 scripts de las rondas 1 a 4. Todos terminan bien. Comparé las salidas con las de la ronda anterior: solo cambian A7b y la ficha de Binance, y en los dos casos el cambio es el esperado (aviso `CRYPTO_OUTFLOW_ROUTED_TO_HOLDINGS` y localización vacía con `CRYPTO_LOCATION_UNKNOWN`).
- Escribí escenarios nuevos en `r5-adversarial.ts` (P1–P9) y `r5-p1b.ts`.

---

## Verificación de los gaps de la ronda 4

| Gap | Estado | Evidencia (resultado real) |
|---|---|---|
| T47 Venta sin cuenta o con cuenta distinta | **Corregido (los casos reportados)** | K1 (venta sin cuenta) y r4-k1b ("MercadoBitcoin S.A."): DARF 4600 de R$ 37.500, aviso `CRYPTO_OUTFLOW_ROUTED_TO_HOLDINGS`, y en Bens e Direitos el BTC vendido queda en 0. **Pero ver T52** |
| T48 Costo en traslados | **Corregido (caso simple)** | K3 (Mercado Bitcoin → Binance): costo R$ 200.000 e impuesto R$ 37.500. K4 (→ Ledger): costo trasladado y DARF retenido. P1b (traslado de la mitad): costo R$ 100.000. P2 (comisión de red de 0,001 BTC más US$ 20): costo R$ 200.000 sobre 0,999. **Pero ver T53, T54 y T55** |
| T49 Reconocimiento de venues | **Corregido** | K5: "MercadoBitcoin S.A." y "mercado-bitcoin" dan brasil; "Coinbase Pro" da exterior; "OKX Brasil" y "Bitso" dan brasil, marcados `needs-verification` |
| T50 País del custodio | **Corregido** | K6: Binance queda con localización vacía y el aviso `CRYPTO_LOCATION_UNKNOWN`; Coinbase y Kraken salen como US |
| T51 Fechas como número de serie | **Corregido** | K9: el XLSX con fecha 46101 da `periodo` 2026-03-20 y se toma el ítem DIVIDENDO PETR4 de 500 |

**Corregidos y verificados: 5 de 5** (T47, T48, T49, T50, T51).

---

## Gaps nuevos

### T52 — ALTA — Una venta que supera las unidades de una custodia no se reparte

- **Evidencia:** en `brazil/classify.ts` (`routeCryptoByCustody`, rama `holders.length > 1`), toda la venta se asigna a una sola custodia (la nombrada o "brasil"). Luego `units[b] = Math.max(0, units[b] - q)` y el costo se limita con `Math.min(1, q / units[b])`. Lo que excede no descuenta nada de las otras custodias.
- **P5b (datos coherentes):** 0,5 BTC comprados en Mercado Bitcoin (R$ 100.000) y 0,5 en Binance (R$ 150.000); venta de 1,0 a US$ 90.000 **sin cuenta**.
  - Obtenido: GCAP solo con 0,5 (ventas de R$ 225.000, impuesto 18.750, DARF retenido), `error:OVERSELL`. La otra mitad (R$ 225.000) no tributa en ningún régimen, y **Bens e Direitos sigue mostrando 0,5 BTC con costo de R$ 150.000** al 31/12/2026.
  - Esperado: repartir 0,5 + 0,5 (o todo como Brasil con el costo de las dos custodias), con el DARF retenido y aviso. Nada debe quedar fuera.
- **P5 (venta de 1,0 indicando Binance, que solo tiene 0,5):** Lei 14.754 solo sobre 0,5 (impuesto 11.250); la otra mitad queda sin tributar y Mercado Bitcoin sigue con 0,5 fantasma.
- **Fix:** si `q` supera las unidades de la custodia elegida, consumir el saldo de las demás custodias, empezando por la nombrada y luego Brasil por conservadurismo. Generar una fila de venta por cada parte con su costo, avisar y retener el DARF de las partes ambiguas. Agregar pruebas con P5 y P5b.

### T53 — MEDIA — El emparejamiento de traslados es frágil y el costo queda en 0

Con el aviso `TRANSFER_COST_UNKNOWN`, el costo queda en 0 en estos casos:

| Caso | Resultado | Esperado |
|---|---|---|
| P1: 1,0 sale de Mercado Bitcoin y entra 0,5 a Binance + 0,5 a Ledger | Venta en Binance con costo 0; impuesto **33.750** | Costo 100.000; impuesto 18.750 |
| P3: mismo día, el `TRANSFER_IN` aparece antes que el `TRANSFER_OUT` en la lista | Costo 0; impuesto **67.500** | Costo 200.000; impuesto 37.500 |
| P7: comisión de 3% (1,0 → 0,97) | Costo 0; impuesto 65.475 | Costo de 0,97 de los 200.000 |
| P8: ingreso 11 días después de la salida | Costo 0; impuesto 67.500 | Costo 200.000 |

- **Evidencia:** el emparejamiento solo acepta una entrada por cada salida, exige que la cantidad esté entre 98% y 100%, una ventana de 10 días y `t.date >= out.date`. Además, el recorrido procesa las transacciones en el orden de la lista dentro de un mismo día, sin poner primero las salidas.
- **Fix:**
  - procesar `TRANSFER_OUT` antes que `TRANSFER_IN` el mismo día;
  - permitir que una salida se reparta en varias entradas (y al revés), dividiendo el costo de forma proporcional;
  - cuando no haya par, usar el costo medio de la custodia de origen más probable (la única con saldo) en vez de 0, con aviso;
  - hacer la tolerancia y la ventana configurables.

### T54 — MEDIA — Dos traslados el mismo día cruzan costos entre regímenes

- **Escenario P4:** 1 BTC en Mercado Bitcoin (R$ 200.000) y 1 en Kraken (R$ 300.000). El mismo día, Mercado Bitcoin → Ledger y Kraken → Binance (en la lista, la entrada a Binance aparece antes que la de Ledger). Se venden las dos.
  - Obtenido: Ledger queda con costo **300.000** (debería ser 200.000) y Binance con **250.000** (debería ser 300.000). Hay dos errores:
    - el emparejamiento tomó la primera entrada de la lista sin mirar la custodia;
    - `brazilForeignAnnualReport` procesa ese día el `TRANSFER_IN` antes que el `TRANSFER_OUT` (por el `TYPE_ORDER` de `sortTransactions`), así que promedia el costo que llega con el del lote que sale.
  - Impuestos: Brasil 22.500 retenido (debería ser 37.500) y exterior 30.000 (debería ser 22.500).
- **Fix:**
  - preferir pares en los que la custodia de origen o destino coincida con la cuenta y, si no se puede decidir, avisar con `TRANSFER_PAIR_AMBIGUOUS`;
  - en los reportes por régimen, procesar las salidas antes que las entradas el mismo día cuando haya `transferBasis`.

### T55 — MEDIA — Un activo en tránsito al 31/12 desaparece de Bens e Direitos

- **Escenario P9:** compra en Mercado Bitcoin, salida el 30-dic-2025 y entrada en Binance el 2-ene-2026.
  - Obtenido: **Bens e Direitos 2025 no tiene ningún ítem 08.**
  - El BTC (costo R$ 200.000) seguía siendo del contribuyente al 31/12 y falta en la declaración. En 2026 sí aparece.
- **Fix:** mientras un par emparejado esté abierto al cierre del año, mantener las unidades en la custodia de origen (o en una línea "em trânsito") con su costo.

### T56 — BAJA — Una venta sin unidades no deja ningún registro pendiente

- **Escenario P6:** salida de Mercado Bitcoin sin entrada registrada y luego venta de 1 BTC por R$ 450.000 con cuenta "Ledger".
  - Obtenido: ningún reporte la muestra, solo `error:OVERSELL`. No hay fila "pendiente de costo" (Colombia sí la tiene: `pendiente_costo`) y las ventas tampoco cuentan para el límite de R$ 35 mil del mes.
- **Fix:** registrar la venta con costo pendiente, contar el valor vendido en el límite del mes y retener el DARF hasta que se complete el costo.

---

## Competidores

No cambió nada desde la ronda 4. Lo que hace este paquete en cripto (custodia por cuenta, Lei 14.754 frente a GCAP, traslados con costo) supera a Gorila y Kinvo, que son débiles en cripto, y se acerca a las herramientas especializadas en cripto (Koinly, CoinTracker), que siguen los traslados con un emparejamiento más tolerante. T52 a T55 son justamente los casos que esas herramientas resuelven bien. En el resto (B3, renta fija, exterior, IRPFM, Colombia) se mantiene el análisis de la ronda 4.

## Para aprobar en la ronda 6

1. Corregir **T52** (repartir la venta entre custodias, nunca dejar unidades fantasma) con pruebas de P5 y P5b.
2. Corregir **T53–T55** (salidas antes que entradas el mismo día, traslados 1→N, costo de respaldo y activos en tránsito al 31/12). Son de severidad media y no bloquean, pero se recomiendan.

Con T52 corregido no quedan gaps altos y, como 8 es mayor que 7, la revisión se aprobaría.
