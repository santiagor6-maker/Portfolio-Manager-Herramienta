# Revisión del motor de cálculo (`packages/core`), ronda 6

Revisor externo. Solo lectura sobre el código. Fecha: 2026-10-13.
Base: `reviews/core-r5.md`, la sección "Respuesta a la revisión ronda 5" de `packages/core/README.md` y
`src/review-r5.test.ts`.

## Veredicto

**Se retira la aprobación hasta corregir C48.**

Lo que funciona:
- 232/232 pruebas pasan y `tsc` no da errores.
- Los 18 scripts de las rondas 1–5 pasan, salvo los esperados ya aceptados (S2a, S2b, F1, F4).
- **C43, C45, C46 y C47 quedan resueltos** en los casos que motivaron cada hallazgo.

Al atacar las heurísticas nuevas aparecieron problemas:

- **C48 (alta):** la confirmación por racha (`TRADE_PRICE_CONFIRMED_BY_RUN`) acepta como "evidencia
  independiente" justamente los errores sistemáticos que el detector debía atrapar:
  - dos ejecuciones parciales del mismo día con el mismo error ×10;
  - el separador de miles colombiano leído como decimal (÷1.000);
  - peniques leídos como libras (×100).

  El valor queda multiplicado o dividido por 10, 100 o 1.000 **sin ningún aviso en las filas ni en el
  resumen**, porque el diagnóstico es solo informativo. Es una regresión del arreglo C44 que había
  verificado en la ronda 5.
- **C49 (media):** la regla nueva "un pago entre 70 % y 98 % de lo causado salda todo"
  (`INTEREST_BELOW_ACCRUED`) borra la actualización por inflación del VNA en bonos IPCA+/UVR cuando la
  inflación es baja.

| | Puntaje (0–10) |
|---|---|
| **Nuestro motor (`@pm/core`)** | **7,9** (r5: 8,3) |
| **Mejor competidor para este caso: Portfolio Performance** | **8,0** |

`approved = false`: hay un hallazgo alto (C48) y el puntaje no supera al del competidor. Con C48
corregido, el motor vuelve a 8,3 o más y a la aprobación.

Todos los scripts, incluido el nuevo `r6-a.ts`, están en
`/tmp/claude-0/-home-user-Portfolio-Manager-Herramienta/8b757dea-bb3a-58bd-aa07-26758394d338/scratchpad/review-core/`.

---

## Arreglos verificados (4)

| ID | Verificación independiente |
|---|---|
| C43 | W3 (NTN-F con lotes de distinto plazo de IR, cupón neto sin `taxes`): valor 5.000,06 (antes 5.048,73). J6: 10.000.000 sin interés fantasma. |
| C45 | V1: confirmar en sitio o en una copia de la fila da 4.400 a través del API (antes 1.100). La prueba recorre todas las claves de `Transaction`. |
| C46 | V2 (1 → 3,5 → 4 → 4,2, solo precios de operación): 4.326 con `TRADE_PRICE_CONFIRMED_BY_RUN`. R4 (cripto ×6 con dos precios consistentes): MTD +525 %. V3 (un único precio ×6,25): sigue esperando confirmación, con aviso en el resumen. *Ver C48: falsos positivos.* |
| C47 | X1 y X2 (montos brutos al 96–97 % del causado): sin retención inventada y sin `INTEREST_NET_ASSUMED`. I3: el neto exacto del 20 % de IR con días ANBIMA se infiere con `taxesEstimated: true`, y el bruto con un día menos no se infiere. I4 (bono a descuento comprado con cupón a precio sucio de 986, debajo de la par): 4.939,91, el reparto correcto. |

---

## Hallazgos abiertos

### C48 — ALTA (nuevo, regresión de C44/C46) — La confirmación por racha valida errores sistemáticos de importación sin avisar
- **Dónde:** `ledger.ts:350-368`. Dos o más precios rechazados que concuerdan entre sí, y que ningún
  cierre posterior contradice (`d2 !== true`), se aceptan todos con un diagnóstico de severidad
  `info`. No se exige que vengan de días distintos, no hay un tope de razón frente a la referencia y el
  aviso no llega a `MonthlyRow.warnings` ni a `PerformanceSummary.warnings`.
- **Evidencia (`r6-a.ts`):**
  - **R1.** Una sola orden ejecutada en **dos ejecuciones parciales el mismo día**, ambas con el error
    ×10 (100 → 1.000), sin cierre posterior (mes en curso). Resultado: **MTD +900 %, valor 1.010.000
    en vez de 101.000**, `warnings` vacío. En la ronda 5 este caso (T1) quedaba en −8,2 % con aviso.
    Los importadores emiten una fila por ejecución, así que este es el caso normal.
  - **R2.** Separador de miles colombiano leído como decimal ("4.200" → 4,2) en dos compras de un
    instrumento sin serie de mercado. Resultado: **valor 510 en vez de ≈ 510.000 (−99,9 %), TWR de
    marzo −99,9 %**, sin aviso.
  - **R3.** Acción de Londres con precios en peniques importados como libras (×100) en dos compras del
    mes en curso. Resultado: **MTD +10.186 %**, sin aviso.

  Estos errores de unidad o de formato regional son la fuente más común de precios erróneos en
  importaciones, y son justo lo que el detector debía atrapar. Los casos reales que motivaron C46 (V2,
  R4) tienen razones de ×3 a ×6 y precios en días distintos.
- **Arreglo:**
  1. Solo cuentan como racha precios de **días distintos** (o de órdenes distintas); varias
     ejecuciones del mismo día son una sola evidencia.
  2. Un tope de razón: frente a la referencia, ×10 / ÷10 o más (y potencias de 10 exactas: ×100,
     ÷1.000) **nunca** se confirma automáticamente; exige `priceConfirmed` y avisa
     `TRADE_PRICE_UNIT_SUSPECT`.
  3. `TRADE_PRICE_CONFIRMED_BY_RUN` debe ser `warning` y propagarse a `MonthlyRow.warnings` y
     `PerformanceSummary.warnings`, como `TRADE_PRICE_OUTLIER`.
  4. Agregar R1, R2 y R3 como pruebas.

### C49 — MEDIA (nuevo, regresión de C43) — "Pago entre 70 % y 98 % de lo causado salda todo" borra la actualización por inflación en bonos indexados
- **Dónde:** `ledger.ts` (`payCoupon`, `INTEREST_BELOW_ACCRUED`). La regla no distingue el interés
  pagable (cupón sobre el principal actualizado) de la **actualización del principal** por IPCA o
  UVR, que se capitaliza y nunca se paga en el cupón.
- **Evidencia (I1):** NTN-B (IPCA+6 %) con IPCA de 0,12 % mensual. El cupón semestral (119,11) es el
  78,5 % de lo causado, así que entra en la banda y "salda todo". Valor después del cupón: **4.000,00
  en vez del VNA 4.028,89 (−0,7 %)**. Un año después vale **4.143,29 en vez de ≈ 4.177,95**: el error
  se acumula en cada cupón. Con un IPCA de 0,4 % mensual (J5) el cupón es el 55 % y no hay problema;
  el fallo aparece con inflación baja, como en los meses de 2023 o con la UVR colombiana en periodos de
  desinflación. I2 (TES UVR con UVR +5 %): el cupón es el 39 %, fuera de la banda, y queda bien.
- **Arreglo:** para `accrual.kind === 'indexed'` con índice de inflación (IPCA, UVR, IPC), la reducción
  máxima por cupón es el **componente de spread** sobre el principal actualizado. El factor del índice
  nunca se salda con un cupón. Aplicar la regla 70–98 % solo a la parte de spread o tasa fija.

### C50 — BAJA (nuevo) — No hay ninguna pista de un split no registrado
- **Evidencia (R5):** NVDA con un split 10:1 no registrado. Los cierres de mercado (no ajustados)
  bajan de 1.100 a 120 y la compra posterior es a 118. Resultado: **junio −89,1 %**, sin ninguna
  advertencia. Antes de C46 el rechazo de la compra al menos dejaba un `TRADE_PRICE_OUTLIER` que
  servía de pista.
- **Arreglo:** si el cierre o el precio cae (o sube) cerca de una razón entera (2, 3, 4, 5, 10, 20 o sus
  inversos) entre dos días consecutivos con datos, avisar `POSSIBLE_UNRECORDED_SPLIT`, y sugerir el
  split con `applyCorporateActions` si el proveedor lo tiene.

### C51 — BAJA (nuevo) — El hash de la caché se encareció 3×
- **Evidencia (`r3-c.ts`):** con 30.000 movimientos, `inputHash` pasa de 7,6 ms (r4) a **21,8 ms** por
  llamada, y un `performanceSummary` ya en caché por el API tarda **37 ms**, frente a 0,9 ms con
  `createEngine`. Un tablero de 20 llamadas suma unos 0,75 s solo en hashing.
- **Arreglo:** hashear los campos descriptivos (`note`, `source`, `importHash`) solo si cambia el
  conjunto de filas, o usar un contador de versión del conjunto de datos. Documentar que la web debe usar
  `createEngine`.

---

## Comparación con los competidores

La metodología no cambió: frente a Portfolio Performance, Sharesight, Kubera y Gorila/Kinvo, el motor
sigue liderando en renta fija (devengo, cupones, calendarios, valor líquido), % del CDI, retorno real,
multi-divisa local/divisa y cascada que cuadra. Sharesight y Gorila siguen por delante en acciones
corporativas automáticas y conciliación con extractos. El descenso del puntaje se debe solo a C48:
un rastreador cuyo valor puede quedar ×100 sin aviso por un error de importación no puede puntuar por
encima de PP. Con C48 corregido, el puntaje vuelve a 8,3 y la aprobación también.
