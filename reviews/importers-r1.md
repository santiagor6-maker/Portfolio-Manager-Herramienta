# Revisión de importadores (`packages/importers`), ronda 1

**Revisor:** independiente; no construyó esta parte. Solo leí el código.

**Alcance:**
- Leí `README.md`, todo `src/` (pipeline, read/decode, numbers/dates, txtypes, mapping, instruments/markets, 12 presets y backup) y todo `test/`.
- Probé con archivos adversariales propios en `scratchpad/review-imp/t1.ts` a `t4.ts`, ejecutados con `npx tsx`.

**Línea base:**
- `npx vitest run packages/importers` pasa: 4 archivos y 86 pruebas.
- `npx tsc -p packages/importers --noEmit` termina sin errores.

**Fuentes de la comparación:**
- Con WebSearch confirmé estos puntos:
  - Sharesight: más de 200 corredores, sincronización con IBKR dos veces al día y reenvío de confirmaciones por correo.
  - Portfolio Performance: importadores PDF para más de 90 a 100 entidades.
  - Gorila y Kinvo: conexión directa con B3 (el CEI fue reemplazado por la Área do Investidor).
- El resto sale de mi conocimiento del producto: los detalles de Snowball, Kubera, Delta, Wealthfolio y Ghostfolio, y el formato SINACOR.

## Veredicto

**Puntaje: 5/10. Competidor de referencia: Sharesight, 8/10. NO APROBADO** (hay 6 brechas de severidad alta).

**Lo bueno:** la base técnica es sólida y en partes mejor que la de muchos competidores:
- lectura robusta de Latin-1, UTF-16, BOM, CRLF y campos multilínea, conservando bien el número de línea;
- vista previa por fila con mensajes en es/pt/en;
- hash estable para reimportar;
- presets propios de B3 y defaults colombianos, que nadie más trae.

**El problema:** para el caso central (seguimiento mensual de un inversionista de Colombia o Brasil), los datos entran con errores silenciosos que mueven meses y multiplican cantidades:
1. Fechas ambiguas asumidas como DD/MM.
2. `1.000` interpretado como 1.
3. Doble conteo en el flujo B3 que el propio README recomienda.
4. Transferencias de IBKR que desaparecen.

Además, el mundo real de estos usuarios es **PDF** (notas SINACOR, extractos de Trii, tyba, Davivienda, Acciones & Valores y CDT) y **sincronización automática** (B3 en Gorila y Kinvo, IBKR en Sharesight y Snowball). Aquí no hay ninguna de las dos.

Sharesight gana el trabajo de meter datos con:
- más de 200 corredores;
- sincronización IBKR por Flex Web Service;
- confirmaciones por correo;
- acciones corporativas automáticas.

Gorila sería 8/10 solo para Brasil, porque le falta Colombia e IBKR.

## Mejor que la competencia

1. **B3 Negociação y Movimentação (XLSX):**
   - normaliza el fraccionario (`ITSA4F`→`ITSA4` y `BOVA11F`→`BOVA11`, verificado);
   - clasifica FII, ETF, units y BDR;
   - omite opciones, BTC y derechos.

   PP, Ghostfolio y Sharesight no traen nada de esto.
2. **Defaults colombianos:** XBOG y COP, y el vocabulario GMF/4x1000, retención, abono, consignación, monetización y TRM como `fx_rate_to_base`.
3. **Lectura de bajo nivel muy robusta.** Verifiqué con BOM + CRLF + comillas con salto de línea + líneas vacías al final:
   - el error se reporta en la línea física correcta (L4);
   - UTF-16LE con tabuladores funciona;
   - `sep=;` funciona;
   - el HTML disfrazado de `.xls` plano funciona.
4. **IBKR:** fusiona la retención con el dividendo (incluye reembolsos como TAX negativo), neta las reversiones de dividendos y convierte los símbolos con espacio (`BRK B`→`BRK.B`). Las bolsas IBIS y NYSE se mapean a MIC.
5. **Proporciones de splits y bonificaciones** inferidas a partir de la posición acumulada, incluidos los movimientos existentes. El split 10:1 de NVDA en Schwab salió correcto.
6. **Reimportación exacta:** 50.000 duplicados se detectan en 1,9 s. Cambiar los segundos de la hora en un reexport de IBKR no rompe la detección.
7. **Rendimiento lineal en el caso normal:**

   | Caso | Tiempo |
   |---|---|
   | 50.000 filas en plantilla canónica | 1,6 s |
   | 50.000 filas de IBKR | 2,3 s |
   | 50.000 filas de extracto-co con inferencia de split | 1,6 s |

8. **Privacidad:** todo corre en el navegador.
9. **Respaldo JSON** validado y migrable, y plantilla CSV de ida y vuelta.

## Peor que la competencia

- Sin PDF: Portfolio Performance lee más de 100 entidades en PDF, y Gorila, Kinvo y Status Invest leen notas de corretagem.
- Sin sincronización: B3 (Gorila, Kinvo), IBKR (Sharesight, Snowball), Plaid, Salt Edge y Yodlee (Kubera), y conexiones de Delta.
- Sin reenvío de correo (Sharesight).
- Ambigüedad de números y fechas resuelta en silencio. Portfolio Performance obliga a elegir el formato en el asistente.
- Deduplicación entre fuentes débil: solo avisa y la fila igual se importa.
- Cobertura de corredores de mercados emergentes muy corta. Faltan XP/BTG/Rico/Clear/Nu/Inter, Avenue, Hapi, Fidelity, Tesouro Direto y Trii/tyba.
- No hay conciliación con la posición ni la caja que reporta el corredor.

## Brechas numeradas

### I1 — alta — No hay importación de PDF

**Evidencia:**
- Un PDF (`%PDF-1.4 ... Nota de Corretagem`) se detecta como `csv` y devuelve `NEEDS_MAPPING: No se reconoció el formato... (faltan: date, quantity)`.
- El preset `nota-corretagem` solo acepta una planilla resumida hecha a mano. La confianza "baja" la declaran ellos mismos.
- Los extractos de Trii, tyba, Davivienda y Acciones & Valores, y los certificados de CDT, son PDF. El README pide "copiar la tabla a Excel".

**Arreglo:**
1. Integrar `pdfjs-dist` (corre en el navegador) para extraer texto por coordenadas.
2. Escribir un parser SINACOR: cabecera con Nr. nota y Data pregão; "Negócios realizados" con C/V, Tipo mercado, Especificação, Quantidade, Preço, Valor y D/C; "Resumo financeiro" con taxa de liquidação, registro, emolumentos, corretagem, ISS e IRRF, prorrateados por valor.
3. Luego agregar plantillas para los extractos de Trii, tyba y Davivienda Corredores, y para los certificados de CDT (emisor, tasa E.A., plazo y valor).
4. Detectar `%PDF` en `sniffKind` y responder `FILE_PDF` con un mensaje claro.

### I2 — alta — No hay sincronización automática

**Evidencia:** solo hay importación de archivos. Gorila y Kinvo se conectan a B3 (Área do Investidor). Sharesight sincroniza IBKR dos veces al día (Flex Web Service). Kubera usa Plaid, Salt Edge y Yodlee.

**Arreglo:**
1. Conector IBKR Flex Web Service (token + query id, el XML ya es casi el formato Flex) desde el servidor Hono.
2. Conector a la API de la Área do Investidor de B3, que requiere certificación como parceiro. Mientras tanto, guiar la descarga mensual.
3. Buzón de correo para confirmaciones (trade confirmations de IBKR, notas de XP y BTG).
4. Belvo o Salt Edge para Colombia y Brasil.

### I3 — alta — Los números ambiguos se interpretan mal en silencio

**Evidencia, caso 1 (genérico, `;`, encabezados en español, moneda COP):**

`15/01/2024;Compra;ECOPETROL;1.000;2.450;COP`
- Resultado: `BUY XBOG:ECOPETROL 1 2.45 2.45 COP`, estado `ok`.
- Esperado: 1000 acciones a 2450 COP.

**Evidencia, caso 2 (`extracto-co`):** `"1,500","2,450"` da 1,5 acciones a 2,45 COP, estado `ok`. En Colombia se usan los dos estilos: Bancolombia muestra `$1,234,567.89`.

En ambos casos solo hay un aviso de archivo, `AMBIGUOUS_NUMBER_FORMAT`.

**Arreglo:**
- Usar pistas: el delimitador `;` sugiere coma decimal, la moneda COP/BRL y el idioma de los encabezados.
- Validar la consistencia `cantidad × precio ≈ valor` entre columnas para escoger la interpretación.
- Verificar la plausibilidad de los precios contra la historia de mercado, con `@pm/market-data` en la UI.
- Si sigue ambiguo, `needsConfirmation: 'numberFormat'` debe bloquear la importación hasta que el usuario elija. Las filas afectadas deben quedar marcadas.

### I4 — alta — Las fechas ambiguas se asumen DD/MM

**Evidencia:** CSV en inglés (`Date,Action,...,USD`) con 03/04/2024, 05/06/2024 y 11/12/2024. Se importa como 2024-04-03, 2024-06-05 y 2024-12-11, las 3 filas `ok`. En un tracker mensual esto mueve flujos de mes y cambia el TWR mensual.

**Arreglo:**
- Pistas: encabezados en inglés, verbos Buy/Sell, moneda USD, hora con AM/PM.
- Monotonía: los extractos suelen venir ordenados; probar las dos lecturas y escoger la secuencia ordenada.
- Si sigue ambiguo, bloquear con confirmación explícita.

### I5 — alta — Doble conteo en el flujo B3 que recomienda el README

**Evidencia 1:** con la Negociação ya importada, la Movimentação importa `Transferência - Liquidação` como `BUY BVMF:ITSA4 100` (`POSSIBLE_DUPLICATE` solo como warning, estado `ok`, incluido en `transactions`).

**Evidencia 2:** la ventana es de ±3 días naturales:
- PETR4, Negociação el jueves 05/01/2023 y liquidación el lunes 09/01: no hay ningún aviso.
- VALE3, 29/12/2022 y 03/01/2023: no hay ningún aviso.

**Evidencia 3:** la bonificación de 13,7 ITSA4 sobre 137 acciones reales infiere `ratio=0.0578` en vez de 0,1, porque el duplicado entra en la posición.

**Arreglo:**
- En Movimentação, si ya hay movimientos de `import:b3-negociacao` o de nota para ese activo, omitir por defecto las liquidaciones (`skipped` con su motivo) o emparejarlas en D+2 hábiles con calendario B3.
- Excluir los posibles duplicados de `inferRatios`.
- Que POSSIBLE_DUPLICATE deje la fila fuera de `transactions` hasta que el usuario la confirme.

### I6 — alta — IBKR descarta secciones en silencio

**Evidencia:**
- Una sección `Transfers` con 50 AAPL vía ACATS In no genera ninguna fila: `totalRows` = 10, sin aviso. La posición nunca existe.
- `Transaction Fees` (stamp duty de VOD) también desaparece.
- `handled` es una lista blanca y el resto hace `return` sin dejar rastro.

**Arreglo:**
- Importar `Transfers` como TRANSFER_IN/OUT, con el precio y el valor de mercado como base de costo sugerida.
- Importar `Transaction Fees` como FEE asociado a la operación.
- Emitir un aviso de archivo por cada sección con filas `Data` no manejadas (nombre + conteo). Esto incluye `Open Positions` para la conciliación (ver I20).

### I7 — media — Duplicados entre fuentes: solo avisos

**Evidencia:**
- La misma compra de AAPL en el Activity Statement y luego en Flex: el Flex sale `ok` con aviso.
- La misma operación en la plantilla canónica tras el Activity: `ok` con aviso.
- Solo se compara contra los movimientos existentes y solo BUY, SELL y DIVIDEND. FX, depósitos e intereses repetidos no se detectan.

**Arreglo:**
- Clave semántica entre fuentes: activo + tipo + cantidad + fecha en días hábiles + precio con tolerancia. La fila queda en estado `duplicate?`, excluida por defecto.
- Ampliar a DEPOSIT, WITHDRAWAL, FX_CONVERSION e INTEREST.

### I8 — media — La bolsa adivinada fragmenta posiciones

**Evidencia:**

| Caso | Resultado |
|---|---|
| Schwab `ENB` y luego IBKR con NYSE | `XNAS:ENB` (adivinado) y `XNYS:ENB` (nuevo): dos activos |
| `ECOPETROL` en USD primero | `XNAS:ECOPETROL`; la fila en COP posterior crea `XBOG:ECOPETROL` |
| `ECOPETROL` en COP primero y luego una fila en USD | No se avisa del desajuste de moneda (la nota solo se emite al crear el activo) |
| `AAPL` en COP (MGC) | `XBOG:AAPL`, con Yahoo `AAPL.CL` inexistente |
| `SAN` en EUR | `XETR:SAN` (Madrid es lo correcto) |

**Arreglo:**
- Si la bolsa fue adivinada, no ponerla en el id (`US:ENB`) o migrar el id cuando llegue una bolsa real.
- Emitir CURRENCY_MISMATCH en cada fila.
- Para MGC, mapear al activo de EE. UU. y registrar la operación en COP con `fxRateToBase`.
- Para EUR sin ISIN, preguntar en lugar de adivinar.

### I9 — media — El genérico pierde el signo

**Evidencia:**

| Entrada | Resultado | Esperado |
|---|---|---|
| `Dividendo,-12.5` (reversión) | `DIVIDEND 12.5` | Reversión |
| `Devolución retención,15` | `TAX 15` | `TAX -15` |
| `Compra` con cantidad -5 | `BUY 5` | Señalar la contradicción |

**Arreglo:**
- Conservar el signo en DIVIDEND, TAX y FEE: un negativo es reversión o reembolso.
- Agregar al vocabulario devolución, reintegro, reversión y estorno.
- Avisar cuando el signo de la cantidad contradice el tipo.

### I10 — media — IBKR pierde la comisión de las operaciones de divisas

**Evidencia:** `EUR.USD` con -5000 y `Comm in USD` de -2 da `FX_CONVERSION 5000 EUR→5450 USD`, con la comisión solo en la nota. Lo mismo pasa con `USD.MXN`. IBKR siempre cobra en la moneda base, así que pasa en casi toda conversión que no es desde USD.

**Arreglo:** emitir un FEE aparte en la moneda de la comisión, o descontarla de `toAmount` cuando coincide con la moneda recibida.

### I11 — media — B3 Movimentação: fracciones, JCP y eventos corporativos

**Evidencia:**
- Bonificação de 13,7 + `Fração em Ativos` 0,7 + `Leilão de Fração` R$ 6,65: las dos últimas filas se omiten. Quedan 0,7 acciones fantasma y faltan R$ 6,65 de caja.
- JCP de R$ 2,56 se registra como bruto 2,56 sin impuesto. Debería ser bruto ≈ 3,01 e IR 0,45.
- Las incorporações y cisões solo dan un warning.

**Arreglo:**
- Fração en Ativos como venta o ajuste de cantidad.
- Leilão como venta con su valor.
- JCP: bruto = neto/0,85 y `taxes`, marcado como estimado.
- Incorporação y cisão: asistente de evento corporativo.

### I12 — media — Heurística de la nota de corretagem

**Evidencia:**
- Nota 2 con ITSA4 y BBAS3, cada una con corretagem 4,90 + emolumentos 0,27: se toman como totales de la nota. Cada fila queda con 2,585 en lugar de 5,17 (comisiones a la mitad).
- `PETR4E250` (opción) se importa como `BUY BVMF:PETR4E250` de acciones.

**Arreglo:**
- Un modo explícito "costos por fila" o "totales de la nota", o una columna `Total nota`.
- Leer `Tipo mercado` y `D/C`.
- Omitir opciones y termo como hace el preset de B3.

### I13 — media — Cobertura y vocabulario para mercados emergentes

**Evidencia:**
- No hay presets para XP/Rico/Clear (extrato), BTG, Nu Invest, Inter, Avenue, Hapi, Fidelity, Tesouro Direto (extrato), ni Trii o tyba.
- `classifyType` devuelve `undefined` para "Redención CDT", "Constitución CDT", "Cancelación CDT", "Liquidación", "Traslado", "Cash in Lieu" y "Leilão de fração".
- `classifyType` devuelve TAX para "Dividendo neto de retención".

**Arreglo:**
- Presets para los cinco corredores más usados de cada país.
- Ampliar el vocabulario de CDT (constitución = BUY de renta fija, redención = SELL más INTEREST).
- Que la regla TAX no gane cuando la frase empieza con "dividendo".

### I14 — media — La búsqueda de posibles duplicados es cuadrática

**Evidencia:** IBKR contra existentes del mismo activo:

| Importados | Existentes | Tiempo |
|---|---|---|
| 2.000 | 2.000 | 1,5 s |
| 5.000 | 5.000 | 8,7 s |
| 10.000 | 10.000 | 34,8 s |
| 50.000 | 50.000 | Más de 10 min (lo maté) |

La causa está en `pipeline.ts`: `byInst` se reconstruye con spread por cada elemento, y hay un `find` con `Date.parse` para cada fila.

**Arreglo:** construir el índice con `push`, indexar por activo + fecha (buckets por día, ±N) y parsear las fechas una sola vez.

### I15 — media — DEGIRO descarta AutoFX

**Evidencia (lectura del código):** `degiroDescription` → `SKIP_FX` para Valuta Creditering/Debitering. Por eso el dividendo en USD queda como caja USD aunque DEGIRO lo convirtió a EUR, y lo mismo pasa con las compras en USD pagadas desde EUR.

**Arreglo:** emparejar los débitos y créditos FX del mismo día y convertirlos en FX_CONVERSION.

### I16 — baja — .xls antiguo y HTML complejo

**Evidencia:**
- `.xls` BIFF devuelve `FILE_XLS_LEGACY`.
- Un HTML con una tabla anidada (encabezado del banco) devuelve `NEEDS_MAPPING`, por el regex no codicioso `<table…</table>`. El mismo HTML sin anidar sí se importa.
- `colspan` se ignora.

**Arreglo:** usar un lector BIFF (SheetJS) y DOMParser o un parser HTML real con expansión de colspan.

### I17 — baja — Formatos que dan error

**Evidencia:**
- Proporción `2:1` o `1x10` → `INVALID_NUMBER`.
- Serial `45292` como texto → `INVALID_DATE`.
- `1,234.56 DR` y `1.234,56 D` → NaN.

No son silenciosos, pero obligan a editar.

**Arreglo:** parsear `a:b` y `axb`, los seriales numéricos en texto con rango plausible, y los sufijos DR/CR/D/C.

### I18 — baja — Reverse split de Schwab en dos filas

**Evidencia:** -100 y +10 del mismo símbolo dan `MISSING_FIELD` y `SPLIT_RATIO_UNKNOWN`.

**Arreglo:** agrupar las filas del mismo día y símbolo y calcular la proporción como nuevo/antiguo (incluso con cambio de CUSIP o símbolo).

### I19 — baja — Avisos de fecha innecesarios

**Evidencia:** B3 Negociação y la nota emiten `AMBIGUOUS_DATE_FORMAT` aunque esos formatos siempre son DD/MM.

**Arreglo:** que los presets con formato fijo fuercen el orden y no avisen.

### I20 — baja — Sin conciliación ni foto inicial

**Evidencia:** se ignoran `Open Positions` y `Cash Report` de IBKR. No hay importación de "Posição" de B3 ni de un saldo inicial.

**Arreglo:**
- Comparar la posición y la caja calculadas contra lo que reporta el corredor tras importar, y mostrar las diferencias.
- Permitir importar posiciones iniciales a una fecha para arrancar el seguimiento mensual.

## Cosas verificadas que están bien

- Negativos: `(1.234,56)`, `1.234,56-`, `−1,234.56`, `- 1,234.56`, `USD -1,234.56`, `-$1,234.56`, `R$ -1.234,56` y `-R$ 1.234,56`.
- Montos: `1 234,56` y `1'234.50`.
- Fechas: `15-ene-2024`, `15/01/24`, `2024/1/5`, ISO con zona horaria, `20240115`; `31/02/2024` se rechaza.
- XLSX: serial numérico, celda de fecha y número en texto `2.500,50`.
- IBKR: fracciones B3, ADR EC y CIB en USD a XNYS, ECOPETROL en COP a XBOG, BRK B a BRK.B, SAP a XETR, y reembolso de retención como TAX -3.
- Split 10:1 de Schwab.
- Comisiones negativas en el genérico pasan a positivo.

## Recomendación de prioridad para la ronda 2

1. I3, I4, I5 e I6: correcciones de exactitud, baratas y de alto impacto.
2. I1: PDF SINACOR más Trii, tyba y Davivienda.
3. I7, I8, I9 e I14.
4. I2: sincronización IBKR Flex Web Service.
