# Revisión de importadores (`packages/importers`), ronda 2

**Revisor:** independiente y de solo lectura. No edité `packages/importers`.

**Cómo verifiqué:**
- Volví a ejecutar mis archivos adversariales de la ronda 1 (`scratchpad/review-imp/t1.ts` a `t4.ts`) contra el código nuevo.
- Escribí 6 lotes nuevos (`t5.ts` a `t10.ts`):
  - PDF SINACOR propios: nota de 2 páginas, ETF, BDR, "GERDAU MET", day trade, cabecera apilada, costos con "C", opción en la misma nota;
  - CDT con trampas;
  - extracto tipo Trii con sección de portafolio;
  - Flex XML con `CorporateAction`, `SUMMARY` y `SalesTax`;
  - conciliación con varios corredores;
  - lotes parciales y dividendos de B3 en dos instituciones;
  - fechas no cronológicas, archivos con varias monedas, convención de signos, AutoFX de DEGIRO, Fidelity y B3 Posição.
- No verifiqué nada leyendo el README.

**Línea base:**
- `npx vitest run packages/importers` pasa: 6 archivos y 146 pruebas.
- `npx tsc -p packages/importers --noEmit` termina sin errores.

**Limitación:** el LibreOffice del contenedor solo trae el núcleo (sin Writer ni Calc). Por eso no pude generar PDF ni `.xls` con un motor independiente. Los PDF los armé con el escritor de pruebas del paquete pero con contenido y layout propios. El `.xls` solo lo probé con el fixture del builder: el lector BIFF8 **no está validado con un archivo de Excel real**.

## Veredicto

**Puntaje: 6,5/10 (antes 5). Competidor: Sharesight, 8/10. NO APROBADO** (5 brechas altas: I21, I22, I23, I4 e I2).

**El salto es real.** Se corrigieron 15 de las 20 brechas y las verifiqué una por una con mis entradas:
- I5: el doble conteo de B3 desapareció, incluso en jueves→lunes y en 29/12→03/01 con feriados.
- I6: IBKR ya importa Transfers y Transaction Fees.
- I10: la comisión de FX va como FEE aparte.
- I11: fracción + leilão quedan como venta de 0,7 a 9,5, el JCP como bruto 3,01 con IR 0,45, y la bonificación da exactamente 0,1.
- I14: 10.000 contra 10.000 movimientos baja de 35 s a 0,45 s, y 50.000 contra 50.000 de más de 10 min a 4,9 s.
- I8: 'US:ENB' se refina a NYSE con `instrumentUpdates`.
- I9: los signos funcionan, incluida la convención estilo flujo de caja.
- I15: DEGIRO AutoFX queda emparejado.
- I16: HTML anidado.
- I17: `2:1`, `45292` y `DR`.
- I18: reverse split de Schwab.
- I19: sin ruido de fechas en B3.
- I1 en lo esencial: ya existen PDF SINACOR, CDT y extractos.

**Lo que impide aprobar:**
1. La nueva deduplicación se pasó al otro extremo. **Bloquea por defecto operaciones y dividendos reales**: lotes parciales de B3, el mismo dividendo en XP y en Nu, dos cobros de GMF iguales, depósitos a dos corredores. Ignora por completo la cuenta y la institución.
2. La sincronización Flex, que es la respuesta a I2, **pierde los splits en silencio** y suma dos veces los dividendos de resumen.
3. El lector SINACOR **asigna mal el ticker en silencio** ("GERDAU MET" → GGBR4) y no reconoce ETF ni BDR.
4. La heurística de monotonía para fechas **decide mal en silencio** cuando el extracto está agrupado por especie.

A esto se suma que la sincronización sigue siendo solo una librería que nadie llama.

Sharesight (IBKR sincronizado, más de 200 corredores, correo) y Gorila/Kinvo (B3 conectado) siguen siendo más confiables para meter datos. Portfolio Performance tiene más de 100 importadores PDF probados con documentos reales por su comunidad; los nuestros son sintéticos.

## Corregidas (verificadas con entradas adversariales)

| ID | Prueba propia y resultado |
|---|---|
| I1 | El PDF se detecta como `pdf`. La nota SINACOR de 2 páginas se lee (Folha 1 sin resumen, Folha 2 con resumen), se omiten las opciones y se prorratean los costos. Los defectos que encontré van en I23 a I26. |
| I5 | Negociação el jueves 05/01 y liquidación el lunes 09/01, y 29/12/2022 → 03/01/2023: `SETTLEMENT_MATCHED` en ambos. La proporción de bonificación da 0,1. |
| I6 | ACATS In de 50 AAPL → TRANSFER_IN (con `TRANSFER_COST_FROM_MARKET`). Stamp duty de VOD → FEE en GBP. |
| I7 | Activity seguido de Flex, y canónica seguida de Activity: `possible_duplicate`, fuera de `transactions`. Ojo: ahora se excede (ver I21). |
| I8 | ECOPETROL en USD → XBOG con CURRENCY_MISMATCH en cada fila. AAPL en COP → XNAS:AAPL con `MGC_FOREIGN_LISTING`. SAN en EUR → `EXCHANGE_REQUIRED`. ENB: `US:ENB` y luego refinado a XNYS. Hay un problema de integración aparte en I28. |
| I9 | Dividendo -12,5 → reversión. "Devolución retención" → `REFUND`. Compra con cantidad -5 → `QUANTITY_SIGN_CONTRADICTS`. Extracto estilo flujo de caja (comisiones negativas y una positiva) → FEE -5000 y TAX -1200 como reembolsos. |
| I10 | EUR.USD y USD.MXN → FEE 2 USD separado en ambos. |
| I11 | Ver la tabla del veredicto: venta de fracción 0,7 a 9,5 = 6,65; JCP 3,01 bruto con 0,45 de IR. |
| I12 | Planilla: la nota 1 con corretagem repetida y emolumentos distintos queda por fila. La nota 2 idéntica → `FEES_MODE_AMBIGUOUS`. La opción PETR4E250 se omite. |
| I14 | Ver la tabla del veredicto. |
| I15 | FX Debit -2,04 USD / FX Credit 1,87 EUR → FX_CONVERSION. El débito sin pareja → `AUTOFX_UNPAIRED`. |
| I16 | HTML con tabla anidada y colspan → extracto-co, 1 movimiento correcto. El `.xls` solo con el fixture del builder. |
| I17 | `2:1`=2, `1x10`=0,1, `45292`=2024-01-01, `1,234.56 DR`=-1234,56, "Mon Jan 15 2024". |
| I18 | Reverse split de Schwab (-100 / +10) → SPLIT 0,1 con `SPLIT_PAIR_MERGED`. |
| I19 | B3 Negociação y Movimentação ya no emiten AMBIGUOUS_DATE_FORMAT. |

**Parcialmente corregidas (siguen abiertas con el mismo ID):**
- **I3:** los casos del round 1 se resolvieron: `1.000;2.450` → 1000 a 2450, y `"1,500"` bloquea con `needsConfirmation`. Falla en archivos con varias monedas.
- **I4:** un CSV en inglés con todos los días ≤ 12 ahora bloquea y sugiere MM/DD. `settleDate` funciona. Pero la monotonía decide mal.
- **I2:** existe el cliente Flex WS, pero no está conectado a nada.
- **I13:** hay perfiles de corredor, no importadores.
- **I20:** existe la conciliación, pero mezcla cuentas.

## Mejor que la competencia (además de lo de la ronda 1)

- **Emparejamiento de liquidaciones B3 con calendario B3** (Carnaval, Corpus Christi, 24 y 31 de diciembre). Ningún competidor de archivos lo hace.
- **CDT como activo de renta fija con `accrual`**, IPC/IBR + spread incluidos. Ningún competidor global lo tiene.
- **Confirmación explícita de formato** (`needsConfirmation` con lecturas alternativas por muestra), que supera a Sharesight y Ghostfolio.
- **JCP bruto e IR estimado, fracciones de bonificación** y conciliación con IBKR Open Positions y Cash Report y con B3 Posição.
- **Rendimiento:** 50.000 filas en unos 2–3,5 s, y la deduplicación ya es lineal.

## Peor que la competencia

- Sin conexión a B3 ni correo, y una sincronización IBKR que no está conectada y pierde acciones corporativas.
- Lector de notas con un catálogo de emisores de juguete (unos 80 nombres) frente a Gorila y Kinvo, que leen cualquier nota y piden la contraseña del PDF.
- La deduplicación ahora genera falsos positivos y la conciliación mezcla corredores. Las dos cosas perjudican justo al usuario de varios corredores al que apunta el producto.

## Brechas abiertas

### I21 — alta — La deduplicación bloquea por defecto movimientos legítimos idénticos

**Causa:** la clave es `tipo|activo|moneda` (`DupIndex.key`). Ni la cuenta ni la institución entran en la comparación, y dentro del mismo archivo dos filas idénticas sin referencia del corredor se consideran duplicadas.

**Evidencia:**

| Caso | Esperado | Resultado |
|---|---|---|
| B3 Negociação, 3 compras de 100 ITSA4 a 10,00 el 04/03/2024 (2 de XP y 1 de NU INVEST) | 300 acciones | 100 acciones; las otras 2 filas `possible_duplicate` |
| B3 Movimentação, Dividendo PETR4 189 en XP y en NU el 20/04/2024 | 378 | 189 |
| GMF -400 dos veces el mismo día | 2 cobros | 1 cobro |
| DEPOSIT de 1.000.000 COP a Davivienda 2 días después de uno igual a Trii | Importado | `possible_duplicate` |

B3 lista un negocio por fila, así que las ejecuciones parciales idénticas son la norma, no la excepción.

**Arreglo:**
- Incluir la cuenta o institución en la clave.
- Dentro del archivo, no marcar como duplicado lo que el formato lista por negocio (B3, IBKR sin ID).
- Entre fuentes, exigir la misma cuenta, o al menos una cuenta compatible.

### I22 — alta — La sincronización Flex XML descarta acciones corporativas en silencio

**Evidencia:**
- `<CorporateAction … "NVDA SPLIT 10 FOR 1" type="FS">` no produce ni fila ni aviso. NVDA queda en 10 acciones en vez de 100 y el valor mensual sale ×0,1.
- `<SalesTax>` se descarta.
- `<CashTransaction levelOfDetail="SUMMARY">` agrega un DIVIDEND de 0,4 USD extra, sin activo.

**Causa:** `SECTIONS = ['Trade','CashTransaction','Transfer','OpenPosition']`.

**Arreglo:**
- Mapear CorporateActions con la misma lógica de splits del Activity y llevar spin-off, fusión o cambio de ticker a `corporateActions`.
- Filtrar `levelOfDetail !== 'DETAIL'` en efectivo.
- Emitir `UNHANDLED_SECTION` para cualquier otro elemento.

### I23 — alta — SINACOR: tickers mal deducidos en silencio y catálogo mínimo

**Evidencia:**
- `GERDAU MET PN N1` → `BVMF:GGBR4`, sin aviso. Lo correcto es GOAU4, Metalúrgica Gerdau. La causa es la coincidencia por prefijo `name.startsWith('gerdau ')`.
- `ISHARES BOVA CI ER` y `APPLE DRN` → `UNKNOWN_SECURITY`, y obligan a un `securityMap` manual.
- La tabla tiene unos 80 emisores. Casi todas las small caps, los ETF y los BDR fallan.

**Arreglo:**
- Usar el cadastro de instrumentos de B3 (nome de pregão + especificação ON/PN/UNT/CI/DRN → ticker), vía @pm/market-data.
- Compararlo por igualdad exacta del nombre de pregão.
- Recordar los `securityMap` del usuario entre importaciones.

### I4 — alta — Fechas: la monotonía decide mal en silencio

**Evidencia:** extracto con `;`, en español, en COP y agrupado por especie. Fechas reales en DMY: 01/05, 02/03, 03/04 y 04/06/2024.
- Resultado: `df=MDY`, solo `DATE_FORMAT_INFERRED`, 4 filas `ok` con fechas 2024-01-05, 02-03, 03-04 y 04-06.
- Esperado: mayo, marzo, abril y junio, o bien una confirmación.

Los extractos "por especie" son comunes en las comisionistas colombianas.

**Arreglo:**
- La monotonía solo debe decidir si la otra lectura no es monótona y hay más de N filas.
- Además, si hay encabezados en español o portugués con COP o BRL, pedir confirmación en lugar de elegir MDY.

### I2 — alta — La sincronización sigue siendo solo una librería

**Lo que funciona:** `syncIbkrFlex` maneja bien los errores. Por ejemplo, 1012 da "El token Flex expiró…".

**Lo que falta:**
- Ningún paquete ni app lo usa: grep en `apps/` y `packages/` fuera de importers no devuelve nada.
- No hay guardado cifrado del token, ni rutina diaria, ni UI.
- No hay conexión con B3 (Gorila, Kinvo), ni buzón de correo (Sharesight), ni Pluggy, Belvo o Salt Edge.

### I24 — media — SINACOR: layouts frágiles, sin contraseña ni OCR

**Evidencia:**
- Cabecera apilada ("Nr. nota 11223344" / "Data pregão 07/03/2024" en líneas distintas, sin la fila de valores) da preset `nota-sinacor-pdf`, **0 filas, 0 errores y 0 avisos**.
- No hay `pdfPassword`. Las notas de XP, Clear y Rico se descargan protegidas con dígitos del CPF, así que el usuario recibe `PDF_READ_ERROR`.
- No hay OCR.

**Arreglo:**
- Aviso `NOTE_WITHOUT_TRADES`.
- Varios patrones de cabecera.
- `options.pdfPassword` pasado a `getDocument`.

### I25 — media — SINACOR: IRRF y costos mal asignados

**Evidencia:**
- La línea "IRRF Day Trade: Base R$ 50,00 Projeção R$ 0,50 → 0,50" reemplaza el I.R.R.F. s/ operações de 0,16. El total queda en 0,50 en vez de 0,66 y se reparte también sobre la venta swing de ITUB4 (0,234).
- Las operaciones con Obs `D` (day trade) no se marcan.
- "Taxa Operacional 4,90 C" (crédito) se suma como costo: 10,22 en vez de 0,42. El `NOTA_TOTALS_MISMATCH` lo detecta, pero la fila queda `ok`.
- Opción y PETR4 en la misma nota: la opción se omite y todos los costos, incluida la Taxa de termo/opções de 3,70, van a PETR4: 5,38 frente a ≈1,32.

### I26 — media — CDT: vencimiento y tasa mal leídos en silencio

**Evidencia:**
- Con "Modalidad de pago de intereses: al vencimiento" antes de las fechas, el vencimiento queda en 2024-01-15, igual a la apertura (debía ser 15/07/2024). La causación es de 0 días y la fila queda `ok`.
- "Tasa nominal: 10,80% N.M.V." se guarda como `annualRate 0.108` E.A. Lo correcto es 11,35 % E.A.
- La retención en la fuente se ignora.

**Arreglo:**
- Validar que el vencimiento sea posterior a la apertura.
- Convertir las tasas NMV, NATV y NASV a E.A.
- Leer la retención.

### I20 — media — La conciliación mezcla corredores

**Evidencia:** existentes de Schwab (KO 30 y depósito 5000 USD) y un extracto de IBKR. La conciliación reporta:
- `KO: reportado 0, calculado 30`;
- `USD: reportado 149, calculado 3.349`.

Para el usuario objetivo, con varios corredores, `RECONCILIATION_DIFF` es ruido permanente.

**Arreglo:** filtrar por `account` del extracto (ClientAccountID) antes de `computeBalances`.

### I28 — media — Ids incompatibles con @pm/market-data

**Evidencia:**
- `yahooSymbolFromId('US:ENB')` → `undefined`, y `MarketDataService.resolve('US:ENB')` lanza `BAD_REQUEST Unknown exchange`. Solo funciona si se pasa la instancia con `providerSymbols.yahoo`.
- El Tesouro Direto que llega de B3 queda como `MANUAL:<slug>` con precio manual, aunque market-data cotiza los ids `TD:` (Tesouro) y `FIC:` (fondos colombianos).

**Arreglo:** acordar el pseudo-MIC `US` con market-data y emitir `TD:` y `FIC:`.

### I3 — media — Números: varias monedas en un mismo archivo

**Evidencia:** extracto con `;` y filas COP y USD. `SIRI 1.000 a 1.725 USD` se lee como 1000 acciones a 1725 USD, es decir, 1.725.000 USD. Solo hay un aviso de archivo, `NUMBER_FORMAT_INFERRED`.

**Arreglo:** plausibilidad por fila, con decimales según la moneda y `referencePrice` cuando la moneda difiere de la dominante.

### I13 — media — Cobertura: perfiles, no importadores

**Evidencia:**
- XP, BTG, Nu, Inter, Avenue y Hapi solo tienen perfil: guían al usuario a B3 o a la plantilla.
- En Fidelity, `REINVESTMENT … (SPAXX)` da `MISSING_INSTRUMENT`. SPAXX es el core position de toda cuenta Fidelity.

### I29 — baja — La sección de portafolio de los extractos PDF se lee como movimientos

**Evidencia:** en un PDF tipo Trii, la tabla "Portafolio al cierre" genera 3 errores (`INVALID_DATE`, `UNKNOWN_TYPE "ECOPETROL"`). Debería omitirse o alimentar la conciliación.

## Prioridad para la ronda 3

1. I21 (clave con cuenta, sin bloquear lotes parciales) e I22 (CorporateAction y SUMMARY en Flex): son baratas y evitan pérdidas de datos.
2. I23 (cadastro B3 y coincidencia exacta) e I4 (monotonía).
3. I2: conectar `syncIbkrFlex` al servidor con token cifrado y rutina diaria.
4. I24 a I26, I20 e I28.
