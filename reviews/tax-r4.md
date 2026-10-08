# Revisión `packages/tax` — Ronda 4

**Revisor:** agente revisor (solo lectura; no construí este paquete)
**Fecha:** 2026-10-07
**Alcance:** las correcciones a los gaps de la ronda 3 (T35, T38–T46), el código nuevo y escenarios adversariales de custodia de cripto: cuenta sin nombre, venues mezclados y traslados entre custodios.

## Veredicto

**NO APROBADO. Los 10 gaps de la ronda 3 están corregidos y lo verifiqué ejecutando código.** Pero el nuevo enrutamiento de la cripto por cuenta (`routeCryptoByCustody`) **divide un mismo activo en instrumentos virtuales según la etiqueta de cada transacción**. Basta que una venta no tenga cuenta, o que la cuenta esté escrita distinto ("MercadoBitcoin S.A." en lugar de "Mercado Bitcoin"), para que la venta quede en una porción virtual sin saldo. Resultado:

- **la ganancia de R$ 250.000 no tributa en ningún reporte**;
- **Bens e Direitos sigue mostrando el BTC ya vendido** al 31/12.

Lo único que aparece es un error `OVERSELL` en el reporte de cripto (T47, alta). Con el mismo diseño, **un traslado entre custodios pierde el costo** (T48): Mercado Bitcoin → Binance da una ganancia de R$ 450.000 en vez de R$ 250.000, es decir, R$ 30.000 de impuesto de más.

| | Puntaje |
|---|---|
| **Nuestro paquete (`@pm/tax`)** | **8 / 10** (6 → 7,5 → 8 → 8) |
| **Mejor competidor para este trabajo: Gorila (Brasil)** | **7 / 10** |

`approved = false`: nuestro puntaje supera al del competidor, pero queda un gap de severidad **alta** (T47).

### Pruebas ejecutadas

- `npx vitest run packages/tax` → **152/152 pruebas pasan** en 7 archivos.
- `npx tsc -p packages/tax --noEmit` → **0 errores**.
- Volví a correr los 11 scripts de las rondas 1 a 3 (`s1-colombia`, `s2-brazil`, `r2-*`, `r3-adversarial`, `r3-recon`, `r3-misc`, `r3-xlsx2`): todos terminan bien y dan los valores esperados.
- Escribí escenarios nuevos: `r4-adversarial.ts` (K1–K9), `r4-k1b.ts` y `r4-misc.ts`.
- Generé con Python (zipfile, `ZIP_DEFLATED`) dos XLSX con la estructura del export "Movimentação" de la B3, con sharedStrings: uno con fechas en texto y otro con fechas como número de serie de Excel. Están en `scratchpad/review-tax/gen/`.

---

## Verificación de los gaps de la ronda 3

| Gap | Estado | Evidencia (resultado real) |
|---|---|---|
| T35 Selic de enero de 2026 | **Corregido** | Un DARF que vence el 30-dic-2025 y se paga el 10-mar-2026 da multa del 20%, juros de 3,16% (Selic de enero 1,16% + febrero 1,00% + 1%) y total R$ 1.231,60 |
| T38 Custodia por cuenta | **Corregido (el caso reportado)** | A7: `BTC-USD` con cuenta "Mercado Bitcoin" da un DARF 4600 de R$ 30.000; la moneda ya no decide la custodia. K2 (venues mezclados: una compra en Mercado Bitcoin, otra en Binance y la venta en Binance) separa bien los costos: Lei 14.754 con costo de R$ 300.000, ganancia de R$ 150.000 e impuesto de R$ 22.500. **Pero ver T47 y T48** |
| T39 Ticker de opción reutilizado | **Corregido** | A3: +1.000 en 2025-03 y +2.000 en 2026-03, sin cortos abiertos |
| T40 Opciones semanales | **Corregido** | A4: PETRC350W4 queda en `OPCAO`. K7: W2 de marzo de 2026 vence el 13-mar; W5 (marzo no tiene quinto viernes) el 27-mar; un W1 negociado después del primer viernes pasa a marzo de 2027, igual que la regla mensual |
| T41 Miles en formato EE.UU. | **Corregido** | A12: `"1,234.56"` y `1234.56` dan 1234,56 |
| T42 Ceros a la izquierda en el XLSX | **Corregido** | En Bens e Direitos, grupo "03" y código "01" salen como texto inline; en proventos, la línea "09" también. Los 3 XLSX pasan `testzip` y tienen el XML bien formado |
| T43 Redutor del IRPFM | **Corregido** | K8: sin tasas por empresa da el rango [0; 86.400]. Con VALE al 30% y PETR al 34% da 21.600, que coincide con mi cálculo (redutor de 4% y 8% sobre R$ 540 mil cada una) |
| T44 Conciliación | **Corregido** | K9: el XLSX deflate con sharedStrings se lee bien, `officialDocRowsFromTable` mapea los encabezados de la B3 y `informeFromB3Movimentacao` produce DIVIDENDO PETR4 500, JCP ITSA4 825 (líquido) y RENDIMENTO_FII HGLG11 11. r3-recon: el JCP líquido 825 queda `ok`. **Pero ver T51** |
| T45 Régimen anterior a 2024 | **Corregido** | R$ 5.000 en junio de 2023 dan carnê-leão de 490,04 por la tabla, igual a mi cálculo; con retención de EE.UU. de R$ 1.500 el crédito lo cubre y queda 0; en julio, sin retención, quedan 490,04 a pagar con DARF 0190 |
| T46 Futuros cotizados en USD | **Corregido** | Un day trade de ICF que gana 10 US$/saca por 100 sacas al tipo 5 da R$ 5.000 e impuesto de R$ 1.000 |

**Corregidos y verificados: 10 de 10** (T35, T38, T39, T40, T41, T42, T43, T44, T45, T46).

---

## Gaps nuevos

### T47 — ALTA — Venta sin cuenta o con la cuenta escrita distinto: la cripto desaparece del impuesto y queda una tenencia fantasma

- **Evidencia:** en `brazil/classify.ts` (`routeCryptoByCustody`), cada transacción recibe su propia custodia. Una cuenta vacía o no reconocida da `'desconhecida'`, y cuando un instrumento tiene más de una custodia se divide en `#brasil` y `#desconhecida`. La venta cae en la porción sin saldo.
- **Escenario K1:** compra de 1 BTC (`CCC:BTC-USD`) con cuenta "Mercado Bitcoin" a US$ 40.000 y venta el 10-mar-2026 a US$ 90.000 **sin cuenta**.
- **Escenario r4-k1b:** igual, pero la venta tiene la cuenta "MercadoBitcoin S.A.".
  - Esperado: GCAP con ventas de R$ 450.000, ganancia de R$ 250.000 y **DARF 4600 de R$ 37.500**, o como mínimo atribuir la venta a la custodia donde están las unidades.
  - Obtenido: `cripto.months = []`, **sin impuesto en ningún reporte** (`fTax` 0), solo los avisos `info:CRYPTO_SPLIT_BY_CUSTODY` y `error:OVERSELL`. En **Bens e Direitos 08-02 sigue apareciendo 1 BTC con costo de R$ 200.000 al 31/12/2026**, aunque ya se vendió.
- Las importaciones parciales y la escritura manual producen exactamente estas etiquetas inconsistentes.
- **Fix:** no dividir por etiqueta, sino seguir la ubicación de las unidades. Una salida sin custodia reconocida debe consumir el saldo de la custodia donde existen unidades (si hay una sola, sin ambigüedad). Si hay varias, avisar con `warning` y aplicar la regla más conservadora: tributar como Brasil y retener el DARF hasta que el usuario confirme. Nunca dejar una venta fuera del cálculo.

### T48 — MEDIA — El traslado entre custodios pierde el costo de adquisición

- **Evidencia:** las porciones `#brasil`, `#exterior` y `#desconhecida` tienen costos medios independientes. El `TRANSFER_OUT` de una porción no se empareja con el `TRANSFER_IN` de la otra.
- **Escenario K3:** compra en Mercado Bitcoin (costo R$ 200.000), traslado a Binance y venta en Binance por R$ 450.000.
  - Esperado: Lei 14.754 con ganancia de R$ 250.000 e impuesto de R$ 37.500.
  - Obtenido: **costo 0, ganancia de R$ 450.000, impuesto de R$ 67.500** (R$ 30.000 de más) y el aviso `TRANSFER_COST_UNKNOWN`.
- **Escenario K4** (Mercado Bitcoin → billetera Ledger y venta desde la Ledger): ganancia de 450.000 e impuesto de 67.500, con el DARF retenido.
- **Fix:** emparejar `TRANSFER_OUT`/`TRANSFER_IN` del mismo activo y cantidad, en fechas cercanas, y trasladar el costo medio en BRL de la porción de origen. Es el movimiento más común en cripto.

### T49 — BAJA — El reconocimiento de venues exige coincidencia exacta

- **Escenario K5:** "MercadoBitcoin S.A.", "Coinbase Pro", "OKX Brasil" y "Bitso" dan `undefined` (custodia desconocida). Solo funciona la forma exacta ("Mercado Bitcoin", "Binance BR", "Binance Brasil", "Binance.com", "Bybit", "Nubank").
- Hoy es "seguro" porque retiene el DARF, pero alimenta T47.
- **Fix:** comparar por prefijo o token (MERCADOBITCOIN*, COINBASE*, OKX + BR), y agregar Bitso y otros venues con presencia en Brasil (`needs-verification`).

### T50 — BAJA — Bens e Direitos de la cripto en el exterior usa el país del instrumento

- **Escenario K6:** un BTC (`CCC:BTC-USD`, `country: 'US'`) custodiado en Binance por cuenta sale en el ítem **08-02 con localización "US"**.
- La localización debe ser la del custodio, no la de la cotización de Yahoo.
- **Fix:** un mapa de venue a país (`needs-verification`), y si no se conoce, dejarlo vacío con aviso, como ya se hace con el efectivo.

### T51 — BAJA — Export de la B3 con fechas como número de serie: filas descartadas sin aviso

- **Escenario K9:** el mismo "Movimentação" con la fecha como número de serie de Excel (46101 = 20-mar-2026, lo que pasa si el archivo se vuelve a guardar en Excel) da `periodo: "46101"` e **`itens: []`**, sin ninguna alerta.
- La conciliación diría después "falta en el documento" para todo.
- **Fix:** convertir los números de serie (base 1899-12-30) en `readXlsx` u `officialDocRowsFromTable`, y avisar cuando una fila con valor no tenga fecha reconocible. El PDF del informe de rendimentos sigue sin leerse (documentado); se acepta.

---

## Competidores, con fresca mirada

Desde la ronda 3 no apareció nada nuevo en Gorila, Investidor10 ni la ReVar (WebSearch sin novedades relevantes y WebFetch bloqueado).

- **Ventaja nuestra:** Colombia completa, Brasil con un alcance mayor que el de Gorila (IRPFM con redutor, régimen anterior a 2024 con carnê-leão, futuros y opciones con vencimiento, come-cotas, conciliación con informe, pré-preenchida y exógena, XLSX) y EE.UU. (retención y sucesiones).
- **Lo que todavía hace preferir a Gorila o la ReVar:** la ingesta automática desde la B3 y la confianza en cifras ya probadas con datos reales. Un inversionista de cripto que mueve fondos entre exchanges y billeteras obtendría hoy cifras incorrectas (T47, T48), y es precisamente el caso de uso que tienen Koinly o CoinTracker, que sí siguen los traslados.

## Para aprobar en la ronda 5

1. Corregir **T47**: la venta debe consumir el saldo donde están las unidades y nunca quedar fuera del cálculo.
2. Corregir **T48**: el costo debe seguir al activo en los traslados.

Hacen falta pruebas con K1, r4-k1b, K3 y K4. Con eso no quedan gaps altos y, como 8 es mayor que 7, la revisión se aprobaría.
