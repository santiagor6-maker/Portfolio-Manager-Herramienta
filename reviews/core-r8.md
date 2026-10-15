# Revisión del motor de cálculo (`packages/core`), ronda 8

Revisor externo. Solo lectura sobre el código. Fecha: 2026-10-15.
Base: `reviews/core-r7.md`, la sección "Respuesta a la revisión ronda 7" de `packages/core/README.md` y
`src/review-r7.test.ts`.

## Veredicto

**Aprobado de nuevo.**

- 261/261 pruebas pasan y `tsc` no da errores.
- Los 21 scripts de las rondas 1–7 pasan, salvo los esperados ya aceptados (S2a, S2b, F1, F4).
- **C52, C53, C54, C55 y C56 quedan resueltos.**
- **La suposición más delicada se sostiene con datos reales:** `@pm/market-data` devuelve cierres **tal
  como se negociaron** por defecto (`adjust: 'none'`). Lo comprobé en vivo con NVDA:
  1.208,88 el 2024-06-07 y 121,79 el 2024-06-10. Con datos diarios reales y el split registrado en la
  fecha ex, core **no ajusta dos veces**: la serie diaria es continua (12.089 → 12.179).

No hay hallazgos altos. Quedan dos medios:

- **C58:** un split registrado uno o dos días antes o después del salto real (por ejemplo en la
  fecha de registro o de entrega) multiplica o divide el valor por 10 en esos días, **sin ningún
  diagnóstico**. Si hay un flujo ese día, el TWR del mes cambia de 11,9 % a 51,9 %.
- **C59:** el contrato `PriceSeries` no dice si una serie viene ajustada por splits. Las rutas
  degradadas de market-data (Yahoo sin historial de splits, respaldos stooq/FMP) pueden entregar
  series ajustadas, y core las valora como si fueran tal como se negociaron.

| | Puntaje (0–10) |
|---|---|
| **Nuestro motor (`@pm/core`)** | **8,3** |
| **Mejor competidor para este caso: Portfolio Performance** | **8,0** |

`approved = true`: el puntaje supera al del competidor y no hay hallazgos altos.

Scripts nuevos en
`/tmp/claude-0/-home-user-Portfolio-Manager-Herramienta/8b757dea-bb3a-58bd-aa07-26758394d338/scratchpad/review-core/`:
`r8-live.mts` (consulta real a Yahoo a través de `@pm/market-data`), `r8-a.ts` y `r8-b.ts`.

---

## 1. Suposición de precios sin ajustar: lo más importante

| Prueba | Resultado |
|---|---|
| `MarketDataService.history({ symbol: 'NVDA', interval: '1d' })`, en vivo | Cierres tal como se negociaron: …1.208,88 (06-07), **121,79 (06-10)**, 120,91… Acción `SPLIT` ratio 10 con fecha 2024-06-10. La web pide `adjust` por defecto (`'none'`). |
| WEGE3.SA 2023–2026, en vivo | Sin splits reales en el rango; el split de WEGE3 del demo es sintético. |
| 1a: NVDA real, split registrado el 06-10 | Valor diario continuo (12.244, 12.100, 12.089 → 12.179, 13.091). **Sin doble ajuste.** |
| 1e: NVDA real solo con fin de mes (31-may 1.096,33, 28-jun 123,54) | El 15-jun la posición vale 10.963,30 = 100 acciones × 109,633, el cierre ajustado por el split registrado. **C52 resuelto con datos reales.** *(La diferencia del TWR de junio con un depósito el 20-jun es la limitación conocida de precios escasos, no el split.)* |
| Demo WEGE3 el 2024-04-20 | 19,63 y 7.713.721 (antes 39,26 y 15.427.442). |
| 1d: serie **ajustada** (ruta degradada) | Valor pre-split **1.224 en vez de 12.244** (÷10). Solo aparece `TRADE_PRICE_UNIT_SUSPECT` en la compra. Ver **C59**. |
| 1b/1c: split registrado **un día antes o después** del salto | 06-07 a 06-09: **120.888** (×10); 06-10: **1.218** (÷10). Sin diagnóstico. Con un depósito el 06-07, **MTD 51,87 % frente a 11,88 %**. Ver **C58**. |

## Arreglos verificados (5)

| ID | Verificación independiente |
|---|---|
| C52 | F: 10.000 el 15-feb y TWR 0. Demo: 7.713.721. A2: grupamento registrado, compra a 10,2 sin `UNIT_SUSPECT`, valor 11.220 y MTD +2 %. NVDA real, diaria y de fin de mes (tabla anterior). |
| C53 | A1 y 4a: 10× real con 3 precios en días distintos, valor correcto, con avisos `UNIT_SUSPECT` y `CONFIRMED_BY_RUN` en el resumen. 4b: ÷10 real aceptado. 4d: ×100 nunca se acepta solo (por diseño, con aviso). 4c: un error ×10 repetido en 3 días distintos se acepta (9,93 millones), pero con los dos avisos en filas y resumen. No se distingue de un 10× real; es un compromiso aceptable porque se avisa. |
| C54 | B1 (−50 %), B4 y B5 (cripto −75 %): sin avisos. B2/B3 (razones 3 y 2): solo diagnóstico informativo. A4: ÷1.000 da `POSSIBLE_REDENOMINATION`. |
| C55 | E2: CPLE11 en el orden de market-data da 100 CPLE3 + 400 CPLE6, con el costo de 4.000 repartido por valor (762 / 3.238) y `COST_FRACTION_ESTIMATED`. |
| C56 | E1: un solo PFCIBEST de 50 a precio de mercado, con `INSTRUMENT_RENAMED`. 2a: un `TICKER_CHANGE` explícito entre el par renombrado (la web no lo canonicaliza) no se duplica ni se pierde: 100 PFCIBEST y TWR 42,9 %. 2b: `tickerRenames: false` respeta el id viejo. **Efectivo de fusión por cobrar:** CPLE5 → CPLE3 con R$ 774,90 pagaderos el 2026-01-05. Diciembre +7,749 % (el efectivo cuenta), enero 0 % (cobrarlo no es un flujo). La compra del 29-dic no se financia con lo que está por cobrar (implícito 500). La cascada cuadra. En USD con FX 4.100 → 4.200, enero = FX exacto y `fxGainBase` 110.000. |

---

## Hallazgos abiertos

### C58 — MEDIA (nuevo) — Un split registrado en una fecha distinta de la del salto de precio no genera ningún aviso
- **Dónde:** el detector `POSSIBLE_UNRECORDED_SPLIT` no se aplica cuando **sí** hay un `SPLIT`
  registrado "alrededor". Nada compara la fecha registrada con la del salto observado ni con la fecha
  del split que trae el proveedor.
- **Evidencia (`r8-a.ts` 1b/1c, `r8-b.ts`, con precios reales de NVDA):**
  - Registrado el **06-07** (fecha de entrega o de registro, como aparece en algunos extractos o en la
    "data com" de B3): el valor vale ×10 durante 3 días.
  - Registrado el **06-11**: ÷10 el 06-10.
  - **Con un depósito el 06-07, el MTD sale 51,87 % en vez de 11,88 %.**
  - Diagnósticos: ninguno.
- **Arreglo:** si hay un `SPLIT`/`STOCK_DIVIDEND` registrado y el salto de los cierres (o el split del
  proveedor) cae en otra fecha cercana (±5 días hábiles) con la misma razón, avisar
  `SPLIT_DATE_MISMATCH`. Mejor aún: proponer o usar la fecha ex del proveedor. Agregar 1b, 1c y r8-b
  como pruebas.

### C59 — MEDIA (nuevo, contrato) — `PriceSeries` no indica si la serie viene ajustada por splits; core la asume tal como se negoció
- **Dónde:** `types.ts` (`PriceSeries` no tiene `basis`).
  - `@pm/market-data` sí conoce la base (`PriceBasis = 'as-traded' | 'split-adjusted'`, notas
    "closes may be split-adjusted" en `providers/yahoo.ts:264`, `keyed.ts:91` y `stooq.ts:56`).
  - `apps/web/src/services/marketData.ts` no propaga ni la base ni las notas.
- **Evidencia (1d):** con una serie ajustada (Yahoo sin historial de splits, o respaldo stooq/FMP sin
  objetivo en Yahoo) y el split registrado, los días anteriores al split valen **1.224 en vez de
  12.244 (÷10)**. La cascada y el TWR de esos meses quedan mal. El único rastro es un
  `TRADE_PRICE_UNIT_SUSPECT` en la compra.
- **Arreglo:** agregar `PriceSeries.basis?: 'as-traded' | 'split-adjusted'` al contrato. Core
  des-ajusta las series `split-adjusted` con los splits registrados o del proveedor, o las marca
  `PRICE_BASIS_ADJUSTED`. La web propaga la base que entrega market-data.

### C60 — BAJA (nuevo) — Los ids canonicalizados en las salidas difieren de los de la entrada; tax no usa la tabla de renombres
- **Evidencia (2c):** con un conjunto que solo tiene `XBOG:PFBCOLOM`, core devuelve `realizedGains`,
  `incomeEvents` y las posiciones con **`XBOG:PFCIBEST`**. La web lo resuelve con
  `withRenamedAliases` y canonicaliza al guardar (`db/repo.ts`). `packages/tax`, en cambio, calcula
  con los ids de las transacciones y no consulta `tickerRenames`. La prueba de paridad
  (`review-r9.test.ts`, 9 pruebas, pasa) cubre reorganizaciones explícitas, no renombres puros. Un
  conjunto sin canonicalizar (importado antes de R8, o usado fuera de la web) reporta PFBCOLOM en tax y
  PFCIBEST en core.
- **Arreglo:** que tax canonicalice con `renamedTickerId`, o que core exponga `renamedFrom` en
  `Holding`, `RealizedGain` e `IncomeEvent`. Agregar un renombre puro a la prueba de paridad.

### C57 (persiste, baja) — Convención del VNA de ANBIMA
Solo se documentó. La desviación sigue entre −0,05 % y −0,31 % frente a la convención de ANBIMA. Se
resuelve con el VNA diario de ANBIMA como índice `level` cuando market-data lo entregue.

---

## Comparación con los competidores

Con los splits ajustados, las units, los renombres y el efectivo de fusión por cobrar resueltos, el
motor vuelve a superar a Portfolio Performance para el inversionista de Colombia o Brasil:

- renta fija completa;
- % del CDI y retorno real;
- multi-divisa local/divisa;
- cascada que cuadra;
- calidad de datos con avisos accionables;
- reorganizaciones de B3 (units, fusiones con efectivo por cobrar, renombres) mejor modeladas que en PP.

Sharesight y Gorila siguen por delante en la aplicación automática de eventos y la conciliación con
extractos. C58 y C59 son precisamente las costuras entre los datos del proveedor y lo que registra el
usuario.
