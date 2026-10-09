# Revisión `packages/tax` — Ronda 6

**Revisor:** agente revisor (solo lectura; no construí este paquete)
**Fecha:** 2026-10-09
**Alcance:** las correcciones de T52–T56 y casos adversariales nuevos:

- una venta repartida en tres custodias con costos distintos;
- el límite mensual de R$ 35 mil cuando una venta se reparte entre Brasil y el exterior;
- un activo en tránsito al 31/12 vendido en enero;
- entradas huérfanas seguidas de venta;
- emparejamiento tardío, varias salidas hacia una entrada, y una llegada en dos partes.

## Veredicto

**APROBADO.** Verifiqué ejecutando código que **los 5 gaps de la ronda 5 están corregidos**: P1–P9 dan exactamente lo esperado. Los casos nuevos más exigentes también salen bien:

- la venta repartida en tres custodias, cada parte con su costo;
- el límite de R$ 35 mil, que solo cuenta la parte brasileña;
- el activo en tránsito al 31/12 vendido en enero, con continuidad entre "situação anterior" y "atual";
- varias salidas hacia una entrada, y la llegada en dos partes.

**No queda ningún gap de severidad alta.** Los gaps nuevos son de severidad media o baja y están en la política de costo de las entradas sin pareja y del emparejamiento tardío (T57, T58): en esos casos se emite o se calcula un DARF sin pedir confirmación, aunque con aviso.

| | Puntaje |
|---|---|
| **Nuestro paquete (`@pm/tax`)** | **8,5 / 10** (6 → 7,5 → 8 → 8 → 8 → 8,5) |
| **Mejor competidor para este trabajo: Gorila (Brasil)** | **7 / 10** |

`approved = true`: nuestro puntaje (8,5) supera al del competidor (7) y no hay gaps de severidad alta.

### Pruebas ejecutadas

- `npx vitest run packages/tax` → **175/175 pruebas pasan** en 9 archivos.
- `npx tsc -p packages/tax --noEmit` → **0 errores**.
- Volví a correr los 16 scripts de las rondas 1 a 5 y todos terminan bien. Comparé las salidas con las de la ronda 5: solo cambió `r2-bens`, y es el cambio esperado (la cripto con custodia no confirmada ahora queda con localización vacía y el aviso `CRYPTO_LOCATION_UNKNOWN`).
- Escribí escenarios nuevos en `r6-adversarial.ts` (Q1–Q7) y `r6-q8.ts`.

---

## Verificación de los gaps de la ronda 5

| Gap | Estado | Evidencia (resultado real) |
|---|---|---|
| T52 Venta repartida entre custodias | **Corregido** | **P5b:** se reparte en 0,5 por GCAP (costo 100.000, DARF retenido) y 0,5 por Lei 14.754 (costo 150.000, impuesto 11.250); Bens e Direitos en 0. **P5** da lo mismo. **Q1** (tres custodias, venta de 1,0 sin cuenta): Brasil 0,4 con costo 80.000, desconocida 0,3 con costo 90.000 y exterior 0,3 con costo 120.000; las tres fichas de Bens e Direitos en 0 y DARF retenido. **Q6** (indicando Binance, que solo tiene 0,3): exterior 0,3 confirmado y Brasil 0,7 con DARF retenido |
| T53 Emparejamiento de traslados | **Corregido** | **P1** (1→N): costo 100.000, impuesto 18.750. **P3** (entrada anotada antes): costo 200.000. **P7** (comisión de 3%): costo completo con `TRANSFER_FEE_ASSUMED`. **P8** (11 días): costo 200.000. **Q7** (N→1, 0,5 de Mercado Bitcoin + 0,5 de Kraken hacia Ledger): costo 250.000. **Q8** (llegada en dos partes 0,92 + 0,08): costo total 200.000. **Pero ver T58** |
| T54 Traslados el mismo día | **Corregido** | **P4:** Ledger con costo 200.000 (Brasil, 37.500 retenido) y Binance con 300.000 (exterior, 22.500), como corresponde |
| T55 Activo en tránsito al 31/12 | **Corregido** | **P9 y Q3:** Bens e Direitos 2025 muestra "1,00 BTC-USD EM TRÂNSITO em 31/12/2025" con costo 200.000. En 2026 el mismo ítem tiene situação anterior 200.000 y atual 0, y la venta de enero tributa por Lei 14.754 con costo 200.000 e impuesto 37.500 |
| T56 Venta sin unidades | **Corregido** | **P6:** se infiere la llegada (`TRANSFER_IN_INFERRED`) con costo 200.000 y queda una venta en GCAP con el DARF retenido. **Q2a:** con una venta repartida en R$ 30.000 en Brasil y R$ 30.000 en el exterior, el mes queda exento (solo cuenta la parte brasileña). **Q2b:** sumando otra venta brasileña de R$ 10.000 se llega a R$ 40.000, más que el límite, y se calcula impuesto de 3.450 |

**Corregidos y verificados: 5 de 5** (T52, T53, T54, T55, T56).

---

## Gaps nuevos

### T57 — MEDIA — Una entrada sin pareja genera un DARF sin confirmar el costo

- **Q4:** `TRANSFER_IN` de 1 BTC a Mercado Bitcoin, sin salida ni precio (depósito externo), y luego la venta de 1 BTC por R$ 450.000.
  - Obtenido: costo 0, ganancia de 450.000 y **DARF 4600 de R$ 67.500 emitido** (no retenido), solo con el aviso `TRANSFER_COST_UNKNOWN`.
- **Q4b:** igual, pero la entrada tiene precio (60.000).
  - Obtenido: ese valor de mercado se usa como costo (R$ 300.000) y se emite un DARF de 22.500.
  - El valor del depósito no es el costo de adquisición: si la compra original fue más barata, el impuesto queda subestimado.
- Esto no es coherente con T56, donde una venta sin unidades queda como "custo pendente" con el DARF retenido.
- **Fix:** si la entrada no tiene pareja y no hay `transferBasis`, tratar sus unidades como de costo pendiente: calcular y mostrar el impuesto, **pero retener el DARF** hasta que el usuario confirme el costo, igual que en T56. Usar el valor del depósito solo como propuesta.

### T58 — MEDIA — El emparejamiento tardío no tiene límite y puede pisar el valor de la entrada

- **Q5:** salida de Mercado Bitcoin el 15-ene-2025 (por ejemplo, una venta o un regalo por fuera) y, 10,5 meses después, una entrada no relacionada en Binance con precio de US$ 100.000 (R$ 500.000).
  - Obtenido: se emparejan "tarde" y se toma el costo de Mercado Bitcoin (R$ 200.000), aunque la entrada traía su propio valor. Resultado: ganancia de 250.000 e impuesto de **37.500**, contra ganancia negativa e impuesto 0 si se usara el valor de la entrada.
  - El único aviso es `info:TRANSFER_MATCHED_LATE`.
- **Fix:**
  - fijar un límite máximo para el emparejamiento tardío (por ejemplo, 90 días);
  - fuera de la ventana preferente, avisar con nivel `warning` y pedir confirmación;
  - no reemplazar el valor explícito de una entrada sin confirmación.

### T59 — BAJA — Una parte ambigua retiene el DARF de todo el mes

- **Q2b:** la venta de ETH en Mercado Bitcoin está confirmada, pero como la venta de BTC del mismo mes tiene una parte ambigua, **se retiene todo el DARF 4600 del mes** (3.450).
- Es conservador, pero si el usuario no resuelve el aviso, deja de pagar a tiempo la parte que sí está confirmada (multa y Selic).
- **Fix:** mostrar dos montos: el DARF de las partes confirmadas, listo para pagar, y el monto retenido de las partes ambiguas.

### T60 — BAJA — Avisos de más en casos que no son ambiguos

- **Q7** (dos salidas hacia una entrada, con cantidades que coinciden) da `TRANSFER_PAIR_AMBIGUOUS`.
- **Q8** (llegada en dos partes) da `TRANSFER_COST_UNKNOWN` dos veces, aunque el costo total se trasladó completo (200.000).
- Avisar de más acostumbra al usuario a ignorar las alertas reales (T57, T58).
- **Fix:** emitir esos avisos solo si el costo final de alguna parte queda realmente indeterminado o varía según cómo se emparejen las transacciones.

---

## Competidores

- **Frente a Gorila (Brasil), el paquete es más completo:** B3 con corto, opciones (vencimiento, semanales, ejercicio) y futuros; renta fija y come-cotas; cripto con custodia por cuenta, traslados y Lei 14.754; exterior desde 2024 y régimen anterior con carnê-leão; IRPFM con redutor; DARF con multa y Selic; conciliación con informe, export de la B3 y pré-preenchida; XLSX.
- **Colombia no tiene competidor:** Formulario 210 con casillas, Formulario 160, Arts. 36-1, 153, 241 y 254-1, exógena.
- **En EE.UU.:** retención según tratado y riesgo de impuesto de sucesiones.
- **Lo que todavía falta para un 10:** ingesta directa sin archivo (Gorila y la ReVar leen la B3 automáticamente) y la validación con datos reales de usuarios.

## Recomendación

Aprobado para integrar. Para la ronda siguiente:

1. corregir T57 y T58, que son la última fuente de DARF emitidos sin confirmación;
2. resolver T59 y T60, que mejoran la usabilidad de los avisos.
