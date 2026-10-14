# Revisión del motor de cálculo (`packages/core`), ronda 7

Revisor externo. Solo lectura sobre el código. Fecha: 2026-10-14.
Base: `reviews/core-r6.md`, la sección "Respuesta a la revisión ronda 6" de `packages/core/README.md` y
`src/review-r6.test.ts`.

## Veredicto

**No aprobado, todavía.**

Lo que funciona:
- 244/244 pruebas pasan y `tsc` no da errores.
- Los 19 scripts de las rondas 1–6 pasan, salvo los esperados ya aceptados (S2a, S2b, F1, F4).
- **C48, C49, C50 y C51 quedan resueltos.**
- La caché resistió todas las mutaciones que probé (ver la tabla).

Pero al atacar los cambios apareció un problema **alto que no es nuevo de esta ronda**, aunque ningún
escenario anterior lo había tocado:

- **C52 (alta): un split registrado sin cierre en la fecha ex deja el último cierre pre-split sin
  ajustar.** Las cantidades ya están multiplicadas, de modo que la valoración queda multiplicada por la
  razón del split hasta el siguiente cierre. Si hay un flujo en ese intervalo, el TWR del mes se
  distorsiona.
  - Pasa en el **portafolio de ejemplo**: WEGE3 vale 15,4 millones en vez de 7,7 millones del 15 al
    30 de abril de 2024.
  - Pasa con cualquier serie de fin de mes, que es el modo "mensual" del producto.
  - La misma causa produce un falso positivo de `TRADE_PRICE_UNIT_SUSPECT` tras un grupamento
    **registrado**.

También encontré cuatro hallazgos medios o bajos:
- el orden en que market-data emite el desarme de units (CPLE11) borra componentes en core;
- core ignora la tabla compartida de renombres;
- el detector de splits da falsos positivos en caídas reales;
- la convención del VNA de la NTN-B difiere de la de ANBIMA.

| | Puntaje (0–10) |
|---|---|
| **Nuestro motor (`@pm/core`)** | **7,9** |
| **Mejor competidor para este caso: Portfolio Performance** | **8,0** |

`approved = false` por C52. Con C52 corregido (es acotado: ajustar por split la última observación
anterior), el motor vuelve a ≥ 8,3.

Todos los scripts, incluidos los nuevos `r7-a.ts`, `r7-b.ts` y `r7-c.ts`, están en
`/tmp/claude-0/-home-user-Portfolio-Manager-Herramienta/8b757dea-bb3a-58bd-aa07-26758394d338/scratchpad/review-core/`.

---

## Arreglos verificados (4)

| ID | Verificación independiente |
|---|---|
| C48 | R1 (dos ejecuciones ×10 el mismo día): MTD −8,2 %, valor 101.000, `TRADE_PRICE_UNIT_SUSPECT:X` en el resumen. R2 ("4.200" → 4,2): valor 492.000 con aviso (antes 510). R3 (peniques por libras): con aviso. El −99 % del MTD viene del efectivo, también importado ×100; es correcto, y el aviso apunta a la fila. R4 (cripto ×6 con dos precios en días distintos): aceptada con `TRADE_PRICE_CONFIRMED_BY_RUN` como advertencia. |
| C49 | I1 (NTN-B, IPCA 0,12 % mensual): ex-cupón 4.028,80 frente al VNA 4.028,89, y un año después 4.173,12 frente a ≈ 4.177,95. El resto de la diferencia es la convención del VNA (C57). J5 e I2 siguen correctos. |
| C50 | R5 (split 10:1 de NVDA no registrado): `POSSIBLE_UNRECORDED_SPLIT:NV` en la fila y el resumen. *Ver C54.* |
| C51 | Caché atacada sin fallos (`r7-a.ts`, C0–C8): intercambiar dos compras del mismo día cambia el FIFO realizado (300 → 100); `Array.sort` en sitio; `push`; `splice` + `push` con la misma longitud; un arreglo nuevo con una fila cambiada; mutación anidada de `instrument.accrual.annualRate`; `portfolio.costMethod`; `options.filter` reemplazado. `performanceSummary` en caché por el API: 5,0 ms (antes 37). |

---

## Hallazgos abiertos

### C52 — ALTA (nuevo; existía, no se había ejercitado) — Un split registrado sin cierre en la fecha ex valora con el cierre pre-split sin ajustar
- **Dónde:** `pricing.ts` (`priceInfo` / `marketInfo`) devuelve el último cierre en o antes del día sin
  aplicar los `SPLIT` o `STOCK_DIVIDEND` registrados entre esa observación y la fecha de valoración.
  Las cantidades de los lotes sí se escalan en la fecha ex. El detector de atípicos reescala las
  observaciones de operaciones, pero no los cierres de mercado.
- **Evidencia:**
  - **F (`r7-b.ts`).** 100 acciones a 100 con cierres solo de fin de mes. Se registra un split 2:1 el
    12-feb, con precio plano en términos post-split (cierre del 29-feb = 50). El 15-feb la posición
    vale **20.000 en vez de 10.000**. Con un depósito el 20-feb, **el TWR de febrero sale +20 % en un
    mes plano**.
  - **Portafolio de ejemplo (`r7-c.ts`).** WEGE3 tiene un split 2:1 registrado el 2024-04-15 y series
    de fin de mes. El 2024-04-20 WEGE3 vale **15.427.442 COP en vez de 7.713.721** (precio 39,26
    pre-split frente a 19,63). La serie diaria del gráfico muestra un salto falso ×2 durante media
    quincena. El TWR de abril del demo no se afecta solo porque ese mes no tiene flujos.
  - **A2 (`r7-a.ts`).** Grupamento 10:1 **registrado** y compra posterior a 10,2 sin cierre post-split.
    El motor la marca `TRADE_PRICE_UNIT_SUSPECT` porque la referencia es el cierre sin ajustar de 1,0.
    Valor **1.100 en vez de 11.220 (−90 %)**, MTD −94,5 %. Los grupamentos 10:1 y 100:1 son frecuentes
    en B3 por la regla de cotización mínima.
- **Arreglo:** al resolver un precio (valoración, `P(f)`, referencia de atípicos, detector de splits),
  dividir la observación por el factor acumulado de los SPLIT y STOCK_DIVIDEND registrados entre la
  fecha de la observación y la fecha pedida. Es la misma lógica que `splitFactor` de los benchmarks. Las
  reestructuraciones (spin-off) deben ajustar la observación de la empresa de origen por
  `1 − costFraction`, o marcarla como vieja. Agregar F, A2 y el demo a mediados de abril como pruebas.

### C53 — BAJA (nuevo) — La regla de potencia de diez bloquea movimientos reales de 8× a 12× aunque haya varios precios consistentes
- **Evidencia (A1, A3):**
  - Una acción de centavos sin serie de mercado que se multiplica por 10 de verdad (0,10 → 1,05 → 1,10
    → 1,20, en tres días distintos) queda valorada en **1.030 en vez de 12.360** con tres
    `TRADE_PRICE_UNIT_SUSPECT`.
  - Una cripto que se multiplica por 9 en un mes, con dos precios: MTD −1,6 %.

  Es una decisión defendible, porque así se atrapan los errores de unidad (R2, R3), y hay aviso.
- **Arreglo:** que el aviso sea accionable con una sola acción de la UI ("confirmar el nuevo nivel de
  este instrumento"). Un `priceConfirmed` en el primer precio ya re-ancla los siguientes; documentarlo
  en el aviso.

### C54 — BAJA (nuevo) — Falsos positivos del detector de splits en movimientos reales, y redenominación no soportada
- **Evidencia (`r7-a.ts`, B1–B5, A4):**
  - `POSSIBLE_UNRECORDED_SPLIT` aparece con una caída diaria real de −50 % (100 → 50,5), una de −66 %
    (100 → 33,5), una acción biotecnológica que se duplica (10 → 20,1) y **una cripto con −75 % en el
    mes** (las criptos no hacen splits).
  - Una caída de −50 % en un mes con serie de fin de mes no se marca.
  - Una redenominación hipotética del COP (÷1.000) da TWR −40 % sin ningún aviso: ÷1.000 no está entre
    las razones vigiladas, y la caja no se redenomina.
- **Arreglo:**
  - Exigir que la razón sea casi exacta (±1 %) y que el nivel persista varios días.
  - Excluir `crypto`.
  - Consultar el historial de splits del proveedor.
  - Agregar ÷100 y ÷1.000 con un aviso distinto (`POSSIBLE_REDENOMINATION`).

### C55 — MEDIA (nuevo, integración market-data ↔ core) — El desarme de units en el orden emitido (MERGER y luego SPINOFF) pierde componentes en silencio
- **Dónde:** `packages/market-data/src/service.ts:959-972` emite el primer componente como `MERGER` y
  los demás como `SPINOFF`, en ese orden y la misma fecha. En core, `restructure` procesa el `MERGER`
  primero (`extractAll`) y el `SPINOFF` después encuentra el libro de la unit vacío.
- **Evidencia (E2, `r7-b.ts`):** 100 CPLE11 = 1 CPLE3 + 4 CPLE6, aplicadas en el orden emitido. Quedan
  **solo 100 CPLE3, con todo el costo, y 0 CPLE6**. El TWR de diciembre de 2023 da **−80 %** en lugar
  de ≈ 0 %. No hay diagnóstico; solo aparece `INVALID_COST_FRACTION` como advertencia de validación.
  Las acciones vienen con `reviewRequired` (E3: 0 sugeridas, 2 en revisión), pero si el usuario las
  acepta tal como aparecen, se pierde el 80 % del valor.
- **Arreglo:**
  - En core, dentro de la misma fecha, procesar los `SPINOFF` antes del `MERGER` o `TICKER_CHANGE` del
    mismo origen, y avisar `SPINOFF_WITHOUT_POSITION` si el origen ya está vacío.
  - En market-data, emitir primero los `SPINOFF` con su `costFraction`, que es el reparto de B3.

### C56 — MEDIA (nuevo) — Core no usa la tabla compartida de renombres (`tickerRenames.ts`)
- **Consistencia revisada:**
  - La tabla vive en core, pero solo la consumen `@pm/importers` (canonicaliza los ids con
    `tickerRenameMap`) y `@pm/market-data` (une historias y emite `MERGER`).
  - Los `kind: 'merger' | 'conversion'` se traducen bien a las acciones `SPLIT/MERGER` que core
    entiende: `ratio` = acciones nuevas por acción vieja, y `cashPerShare` va como `DIVIDEND/EXTRAORDINARY`.
    Core lo combina en `MERGER.amount` en la fecha efectiva, no en `cashPayDate`: el efectivo de
    CPLE5 → CPLE3 se acredita 8 días antes del pago real.
  - Los `components` (units) chocan con el orden de core (C55).
  - Los códigos reutilizados (NATU3) dependen de `tickerIdOn`, que core no usa.
- **Evidencia (E1):** historia manual con el id viejo (`XBOG:PFBCOLOM`, compra de 100) y una venta
  importada con el id nuevo (`XBOG:PFCIBEST`, el importador canonicaliza). El resultado son dos
  instrumentos: `OVERSELL` en PFCIBEST y una posición fantasma de 100 PFBCOLOM valorada al precio de
  operación de 2024 (fuente `trade`). Ni el libro ni el validador sugieren el renombre.
- **Arreglo:** en `createContext`, canonicalizar los ids con `renamedTickerId` (solo `rename`, con la
  misma serie de precios) y emitir `INSTRUMENT_RENAMED` (info). En el validador, avisar cuando aparecen
  juntos un id viejo y su sucesor. Acreditar el efectivo de una fusión en `cashPayDate` cuando exista.

### C57 — BAJA (nuevo) — El devengo IPCA no sigue la convención del VNA de ANBIMA
- **Evidencia (D, `r7-a.ts`):** comparé, con el IPCA mensual 2022-12 a 2025-01 (valores de IBGE que
  ingresé de memoria, solo para comparar convenciones), el devengo del motor con el VNA de ANBIMA. Ese
  VNA se actualiza el día 15 con el IPCA del mes anterior. El motor queda **entre −0,05 % y −0,31 %**
  (máximo el 2023-06-15; en las fechas de cupón, 15-may y 15-nov, entre −0,05 % y −0,16 %), sin deriva
  acumulada. Frente al extracto de Tesouro Direto o de la corredora, aparecen diferencias de cientos de
  reales en posiciones de R$ 100.000.
- **Arreglo:** una convención `'VNA'` para `index: 'IPCA'` (escalón el día 15 más pro rata por días
  hábiles con el IPCA proyectado), o documentar que market-data entregue el VNA diario de ANBIMA como
  índice `level`, que el motor ya soporta.

---

## Comparación con los competidores

Con C52 corregido, el motor vuelve a estar por encima de Portfolio Performance para el inversionista de
Colombia o Brasil:

- renta fija completa: devengo, cupones, calendarios, valor líquido, VNA dentro del 0,3 %;
- % del CDI y retorno real;
- multi-divisa con TWR local/divisa;
- cascada que cuadra;
- calidad de datos con avisos accionables.

PP no tiene el problema de C52: exige un precio en la fecha del split o ajusta los históricos al
registrarlo. Sharesight y Gorila siguen por delante en acciones corporativas automáticas y en
conciliación con extractos (C55 y C56 son justamente bordes de esa integración).
