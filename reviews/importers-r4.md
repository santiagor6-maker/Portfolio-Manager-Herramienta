# Revisión de importadores (`packages/importers`), ronda 4

**Revisor:** independiente y de solo lectura. No edité `packages/importers`.

**Cómo verifiqué:**
- Volví a ejecutar todos mis lotes anteriores: `t1`, `t2`, `t5`, `t6`, `t8`, `t9`, `t10` y `t11` en `scratchpad/review-imp/`, y comparé cada salida con la de la ronda 3 (`out3/` frente a `out4/`).
- Escribí 3 lotes nuevos con fixtures propios, distintos del corpus del builder:
  - **`t12.ts`:**
    - un PDF con 4 notas: XP, una nota **BM&F** de mini índice, BTG y una nota de Nu con **ruido de OCR** (`1OO`, `66O,00`, `W E G`);
    - cambios de código en B3 Negociação (ELET3, ELET6, MRFG3, BRFS3, EMBR3, TRPL4, CPLE6);
    - NATURA ON en 2019 y a ambos lados del 02/07/2025;
    - AXIA3 con ELET3 ya en el portafolio;
    - PFBCOLOM y BCOLOMBIA;
    - un **Activity consolidado** de IBKR con dos cuentas y un **Flex XML con dos FlexStatement**;
    - correos (un boletín HTML con tabla, y un mensaje reenviado como `message/rfc822` con un CSV de nombre RFC 2231 y una factura PDF);
    - un extracto Davivienda con layout propio (descripciones en dos líneas, `($ …)`, `$ -500`, SALDO sin fecha, pie de página).
  - **`t13.ts`:** una línea dañada por OCR con y sin "Líquido para", una especificação partida en dos líneas, y la página 2 sin cabecera.
  - **`t14.ts`:** spin-off con `acceptCorporateActions` y `referencePrice`, respuestas aprendidas, y la tabla segura frente a una respuesta aprendida contradictoria.
- Revisé la integración con `@pm/market-data` (`aliases.ts`, `TICKER_ALIASES`) y con `apps/web` y `apps/server`.

**Línea base:**
- `npx vitest run packages/importers` pasa: 8 archivos y 240 pruebas.
- `npx tsc -p packages/importers --noEmit` termina sin errores.

## Veredicto

**Puntaje: 8/10 (r1: 5, r2: 6,5, r3: 7,5). Competidor: Sharesight, 8/10. NO APROBADO.**
- No hay brechas **altas**.
- Se queda en empate: para aprobar el puntaje debe ser estrictamente mayor.

**Regresiones: ninguna.** Las únicas diferencias con la ronda 3 son las esperadas: PFBCOLOM → PFCIBEST con `TICKER_RENAMED`, y las respuestas de I20, I30 e I32 en `t11`.

**Lo que mejoró de verdad:**
- **Cambios de código:**
  - coinciden con market-data en ELET3→AXIA3, EMBR3→EMBJ3, CCRO3→MOTV3, MRFG3→MBRF3, PFBCOLOM→PFCIBEST y BCOLOMBIA→CIBEST;
  - BRFS3 se mantiene como fusión y CPLE6 como conversión, también coherente con market-data;
  - con ELET3 ya en el portafolio, una compra de AXIA3 en 2026 se registra en ELET3: un solo activo;
  - "NATURA ON": 01/07/2025 → NTCO3 y 02/07/2025 → NATU3, igual que market-data (`effective 2025-07-02`).
- **SINACOR:**
  - el PDF con varias notas separa bien las corretoras (XP y BTG);
  - la nota BM&F no se mezcla (`NOTE_WITHOUT_TRADES`);
  - la página 2 sin cabecera continúa bien;
  - "ISA ENERGIA PN N1" → ISAE4;
  - "ALPHABET DRN C" → `BDR_CLASS_UNCERTAIN`;
  - las respuestas aprendidas desde las notas existentes funcionan, y la tabla segura gana sobre una respuesta aprendida errónea (GOAU4).
- **IBKR:**
  - el Flex con dos cuentas asigna el U-número correcto a cada movimiento;
  - un extracto de U2222222 con historial de U1111111 ya no da diferencias;
  - el spin-off MMM→SOLV se propone como SPLIT/SPINOFF con ratio 0,25 y `costFraction` 0,156 (17 / (92 + 17), correcto). `acceptCorporateActions: 'all'` lo aplica, y al reimportar queda duplicado u omitido.
- **Correo:**
  - un boletín HTML de XP con una tabla (fechas y "R$ 1.000,00") **no** inventa movimientos;
  - el CSV reenviado como adjunto anidado (RFC 2231) se importa;
  - la factura PDF se rechaza con `FILE_PDF_UNSUPPORTED`.
- **Extracto Davivienda propio:** compra, dividendo y GMF bien. El SALDO ANTERIOR sin fecha y el pie de página se omiten.
- **La web ya tiene la pantalla de sincronización IBKR** (`IbkrSync.tsx` en Import).

**Por qué no supera a Sharesight:**
1. Un extracto consolidado de IBKR con varias cuentas pierde la cuenta y da diferencias falsas de conciliación (I34).
2. Una línea de nota que no se puede leer se descarta en silencio (I35).
3. El correo es solo una librería, sin receptor, y B3 sigue sin sincronización (I2).
4. Las tablas de cambios de código están duplicadas y no coinciden con market-data (I36).
5. Aún no hay ni un solo documento real.

Sharesight y Gorila procesan documentos reales a escala, y en eso todavía no se los puede superar.

## Corregidas (verificadas)

| ID | Evidencia |
|---|---|
| I20 | Extracto de U2222222 con historial de U1111111: conciliación vacía. Las transacciones llevan `U2222222`. Sin cuenta en el historial se usa por defecto, como documenta el builder. |
| I30 | Ver los cambios de código del veredicto. En `t1` y `t9`, PFBCOLOM → PFCIBEST con `TICKER_RENAMED`. ISA ENERGIA → ISAE4. Las respuestas se aprenden de las notas existentes. |
| I32 | "ALPHABET DRN C" → `BDR_CLASS_UNCERTAIN` con candidatos, en lugar de GOGL34 silencioso. |
| I33 | Spin-off con propuesta lista y `costFraction` correcto. `acceptCorporateActions` lo aplica. Al reimportar no se duplica. |

**Siguen bien desde rondas anteriores:** I3, I4, I5–I19, I21–I29 (sin regresiones en los 8 lotes).

## Brechas abiertas

### I34 — media — Activity Statement consolidado de IBKR (varias cuentas)

**Evidencia:** extracto con `Account` = U1111111 y U2222222 en Trades, Deposits y Open Positions, que es lo que IBKR genera cuando vinculas cuentas.
- Las 4 transacciones quedan **sin cuenta**.
- La conciliación compara 10 AAPL reportadas por cuenta contra 20 calculadas: dos `RECONCILIATION_DIFF` falsos de -10.
- Las compras idénticas de ambas cuentas no se pueden distinguir para deduplicar contra importaciones futuras por cuenta.

Con el Flex XML de dos cuentas sí funciona.

**Arreglo:** leer la columna `Account` en todas las secciones del Activity, y conciliar por cuenta.

### I35 — media — SINACOR: las líneas de operación que no se pueden leer se descartan en silencio

**Evidencia:**

| Nota | Resultado |
|---|---|
| PETR4 (bien) + ITAUSA con cantidad `1OO` (letra O), con "Líquido para" | Solo PETR4 queda `ok`, con **todos** los costos (1,18 en vez de 0,93). Único rastro: `NOTA_TOTALS_MISMATCH` (esperado -3.701,18, real -4.701,18). |
| La misma nota sin "Líquido para" | Pérdida **totalmente silenciosa**: 1 operación, 0 avisos. |
| Nota del PDF con varias notas | ITAUSA `1OO` y BBSEGURIDADE `66O,00` desaparecen. Solo "W E G" da error. |

**Arreglo:**
- Toda línea del bloque "Negócios realizados" que empiece con `1-BOVESPA` o `B3 RV LISTADO` y C/V y no se pueda leer debe dar el error `UNPARSED_TRADE_LINE` con el texto crudo.
- Con `NOTA_TOTALS_MISMATCH`, dejar las filas de la nota `pending` y no prorratear los costos.

### I2 — media — Automatización incompleta

**Ya existe:**
- la pantalla web para la sincronización IBKR;
- `importTransactionBatch` con deduplicación;
- `importEmail` completo, verificado con MIME anidado, RFC 2231 y la tabla HTML que no inventa movimientos.

**Falta:**
- un receptor de correo (endpoint SMTP o IMAP, o webhook de un proveedor de correo entrante) y la verificación SPF/DKIM en `apps/server`;
- conexión con la Área do Investidor de B3 (Gorila, Kinvo);
- agregadores (Pluggy, Belvo).

### I36 — media — Tablas de cambios de código duplicadas y distintas de @pm/market-data

**Evidencia:**
- `TICKER_RENAMES` (importers) tiene TRPL3/TRPL4 → ISAE3/ISAE4, que **no** existen en `TICKER_ALIASES` (market-data).
- Con BVMF:TRPL4 en el portafolio, el importador lo mantiene a propósito, pero market-data no tiene alias para cotizarlo con ISAE4.
- ELET6 → AXIA6 no está en ninguno de los dos.

El resto coincide.

**Arreglo:** una sola fuente, exportando los alias de market-data (o moviéndolos a core) y derivando de ahí `TICKER_RENAMES`.

### I31 — baja — Sin documentos reales

El corpus real-like es serio y mis layouts propios pasan, pero I35 muestra que el ruido real todavía rompe cosas. Sigue faltando al menos un documento de usuario anonimizado por corredora.

### I37 — baja — NATURA ON anterior a diciembre de 2019 → NTCO3

**Evidencia:** una nota del 10/06/2019 da `BVMF:NTCO3`.
- En esa fecha la especificação correspondía a NATU3 de Natura Cosméticos, canjeada 1:1 por NTCO3 en diciembre de 2019.
- Market-data dice que Yahoo no tiene historia de NTCO3.

Resultado: la posición queda sin precio desde la compra.

### I38 — baja — Retención en la segunda línea de un extracto PDF colombiano

**Evidencia:** "ABONO DIVIDENDOS ISA $ 125.400" seguido de la línea "Retención 7% $ 9.437" da DIVIDEND 125.400 sin `taxes`. La segunda línea queda como NOT_A_MOVEMENT.

**Arreglo:** unir las líneas de continuación a la fila anterior y extraer retención, comisión e IVA.

### I39 — baja — Conflicto entre una respuesta aprendida y la tabla segura, sin aviso

**Evidencia:** con movimientos existentes "GERDAU MET PN N1" → GGBR4 (respuesta antigua del usuario), la nota nueva va a GOAU4, lo cual es correcto, pero no se avisa que la misma especificação quedó repartida en dos activos.

**Arreglo:** aviso `SECURITY_ANSWER_CONFLICT`.

## Prioridad para la ronda 5

1. I35 e I34: pérdida silenciosa y conciliación falsa. Son baratas.
2. I36: alias únicos con market-data.
3. I2: receptor de correo en el servidor.
4. I37, I38 e I39.
5. Primer documento real por corredora (I31).
