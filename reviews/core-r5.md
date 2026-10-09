# Revisión del motor de cálculo (`packages/core`), ronda 5 (confirmación)

Revisor externo. Solo lectura sobre el código. Fecha: 2026-10-09.
Base: `reviews/core-r4.md` y la sección "Respuesta a la revisión ronda 4" de `packages/core/README.md`.

## Veredicto

**Se mantiene aprobado.** No apareció ningún problema de severidad alta.

- Los 17 scripts de las rondas 1–4 pasan. Solo fallan los esperados que ya acepté como cambios de
  diseño (S2a, S2b, F1, F4).
- Se confirman resueltos **C38, C42 y C44**. C43 se resuelve en su caso original, pero sigue abierto
  en un caso nuevo (W3).

La búsqueda específica de regresiones encontró **tres problemas de severidad media** causados por el
pulido:

- **C45:** confirmar un precio con `priceConfirmed` no tiene efecto a través del API, porque ese campo
  no entra en el hash de la caché.
- **C46:** la banda dura de C44 bloquea para siempre un activo que solo tiene precios de operación
  cuando sube de verdad más de ×3.
- **C47:** la inferencia de C43 se dispara con montos **brutos** cuando el banco usa otra base de
  días, e inventa retenciones que llegan al reporte tributario.

| | Puntaje (0–10) |
|---|---|
| **Nuestro motor (`@pm/core`)** | **8,3** (sin cambio: los arreglos se compensan con las regresiones medias) |
| **Mejor competidor para este caso: Portfolio Performance** | **8,0** |

`approved = true`: el puntaje supera al del competidor y no hay hallazgos altos.

Comprobaciones hechas:
- `npx vitest run packages/core`: 218/218 pruebas pasan. `npx tsc -p packages/core --noEmit` no da
  errores.
- Volví a ejecutar los 17 scripts de las rondas 1–4 con `TZ=America/Bogota`, y escribí `r5-a.ts`
  para la búsqueda de regresiones. Todo está en
  `/tmp/claude-0/-home-user-Portfolio-Manager-Herramienta/8b757dea-bb3a-58bd-aa07-26758394d338/scratchpad/review-core/`.

---

## Arreglos verificados (3)

| ID | Verificación independiente |
|---|---|
| C38 | P1 (fusión y luego cambio de ticker): B +20 con TWR +2,04 %, C +50 con 5 %, A 0 con 0 %. La suma por posición es igual a la ganancia del portafolio (70). G2 y R1c siguen correctos. |
| C42 | J2: la unidad restante vale 1.000 (antes 951,33). J4: 1.000 y un año después 1.100, con `COUPON_EXCEEDS_ACCRUED_INTEREST`. **Regresiones buscadas con compras cerca del pago:** W1, compra 10 días antes del registro a precio sucio: 5 unidades ex-cupón = 5.000,06. W2, compra 3 días antes del pago, después del registro, a precio limpio: 5.000,78. En los dos casos el reparto es correcto. |
| C44 | T1 (error ×10 en el mes en curso): MTD −8,2 %, valor 101.000 y `TRADE_PRICE_OUTLIER:X` en `PerformanceSummary.warnings`. T2: −0,1 % (antes −90 %). T3 (más de 400 días): rechazado. T4 (caída real del −52 % confirmada por el cierre): sin falso positivo. T5 (cripto ×3 con cierre): rechazado. V4 (compra de la empresa ×3,5 confirmada por el cierre del mismo día): aceptada, MTD +250 %. *Ver C45 y C46.* |

## Comparación con los competidores (sin cambios de fondo)

Para el inversionista de Colombia o Brasil, el motor sigue por encima de Portfolio Performance:

- renta fija por devengo con cupones, amortización, calendarios y valor líquido;
- % del CDI y retorno real estimado y marcado;
- multi-divisa con TWR local/divisa mensual;
- cascada en dinero que cuadra.

Sigue por debajo de Sharesight y Gorila en acciones corporativas automáticas y en conciliación con
extractos. Las regresiones nuevas afectan la calidad de datos en casos frontera, no la metodología.

---

## Hallazgos abiertos

### C45 — MEDIA (nuevo, regresión de C44) — `priceConfirmed` no forma parte del hash de la caché: confirmar un precio no tiene efecto a través del API
- **Dónde:** `engine.ts:537-539` (`rowValues`) no incluye `priceConfirmed`.
- **Evidencia (V1):** una small cap sube ×4 de verdad (1 → 4) sin cierre que lo confirme y se rechaza
  (valor 1.100). El usuario marca `priceConfirmed = true` sobre la misma fila: `valuePortfolio` sigue
  dando **1.100**. Con una **copia nueva** de la fila y un arreglo nuevo, también **1.100**: el hash es
  idéntico y la caché devuelve el motor viejo. Un `createEngine` nuevo da 4.400 (correcto).
  `apps/web/src/services/engineDirect.ts` usa el API sin estado.
- **Arreglo:** agregar `priceConfirmed`, y en general **todos** los campos de `Transaction` que lee el
  motor, a `rowValues`, con una prueba que recorra las claves de `Transaction` para que un campo nuevo
  no vuelva a quedar fuera del hash.

### C46 — MEDIA (nuevo, regresión de C44) — La banda dura queda anclada a la última referencia aceptada: tras una revalorización real, todos los precios siguientes se rechazan
- **Dónde:** `ledger.ts` (detector de atípicos). La referencia de la banda es el último precio
  **aceptado**, y los precios rechazados nunca se confirman entre sí.
- **Evidencia (V2):** una acción sin serie de mercado (OTC, Colombia poco líquida, privada) con
  precios de operación 1 → 3,5 → 4 → 4,2 en 4 meses. Las tres últimas se rechazan (`TRADE_PRICE_OUTLIER`
  ×3) y el valor queda en **1.030 en vez de 4.326 (−76 %) para siempre**. En V3, una cripto ×6,25 en un
  mes queda con MTD −4,9 %. Las dos salidas son confirmar cada precio a mano, y eso hoy no funciona por
  C45, o esperar un cierre que nunca llega.
- **Arreglo:**
  - Dos o más precios consecutivos que concuerdan entre sí (dentro de la tolerancia normal) confirman
    el nuevo nivel y re-aceptan el primero.
  - Banda por volatilidad histórica o por clase de activo (small caps y cripto más anchas).
  - Confirmar un precio debe re-anclar la referencia de los siguientes.

### C47 — MEDIA (nuevo, regresión de C43) — La inferencia de "interés neto" se dispara con montos brutos e inventa retenciones
- **Dónde:** `ledger.ts` (`INTEREST_NET_ASSUMED`). Basta que el monto coincida ±2 % con el causado
  neto de la retención esperada y no con el bruto.
- **Evidencia (X1, X2):**
  - **X1.** El banco paga el interés mensual **bruto** sobre 30 días y el motor causó 31 (ACT/365). El
    pago es el 96,8 % del causado. El motor lo toma como neto: **bruto 97.481 en vez de 93.582 y una
    retención inventada de 3.899**.
  - **X2.** Un monto bruto igual al 96,2 % del causado (base 360 del banco, tasa efectiva distinta)
    produce una **retención inventada de 11.359**.

  Las diferencias de 2 % a 4 % entre la base de días del banco (30/360, base 360) y ACT/365 son
  rutinarias en los CDT colombianos. Esa `IncomeEvent.taxes` inventada la lee
  `packages/tax/src/colombia/report.ts`, de modo que termina como una retención certificada que no
  existe. Además, el ingreso bruto queda sobrestimado.
- **Arreglo:**
  - Inferir neto solo con coincidencia estricta (±0,5 %) que no se explique con otras bases de días
    (30/360, ACT/360), o con una marca explícita `amountIsNet`.
  - Marcar las retenciones inferidas (`IncomeEvent.taxesEstimated`) para que el paquete tributario no
    las trate como certificadas.

### C43 (persiste, baja) — Un cupón neto sin `taxes` en un bono brasileño con lotes de distinto plazo deja interés fantasma
- **Evidencia (W3):** NTN-F con 4 unidades antiguas y 1 comprada hace 10 días. El cupón se registra neto
  del IR del 20 % sin `taxes`. La inferencia no se dispara, porque el IR esperado mezcla 20 % y
  22,5 % y queda fuera del ±2 %. Resultado: valor **5.048,73 en vez de 5.000**, un IR de 48,67 que se
  queda como interés causado. El caso original de J6 sí funciona (10.000.000 exacto).
- **Arreglo:** calcular la retención esperada por lote con su propio plazo, o pedir `amountIsNet`
  explícito (ver C47).

---

## Recomendación

Mantener la aprobación. En la próxima iteración, cerrar C45 (una línea más una prueba de cobertura del
hash), C47 (para no contaminar el reporte tributario) y C46. Los tres afectan los mecanismos nuevos de
calidad de datos, no la metodología de rentabilidad.
