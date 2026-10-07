# Revisión `packages/tax` — Ronda 3

**Revisor:** agente revisor (solo lectura; no construí este paquete)
**Fecha:** 2026-10-07
**Alcance:** las correcciones a los gaps abiertos de la ronda 2 (T12, T14, T20, T22–T37), el código nuevo y una nueva comparación con Gorila, Investidor10, la ReVar y un contador.

## Veredicto

**NO APROBADO, por un solo gap alto.** Verifiqué **18 de los 19 gaps de la ronda 2 como corregidos**, ejecutando código y no leyendo el README. Lo que se agregó es de buena calidad:

- futuros con valor del punto;
- vencimiento y ejercicio de opciones;
- aluguel, come-cotas, IRPFM y régimen del exterior anterior a 2024;
- conciliación con informe de rendimentos, pré-preenchida, exógena y 1042-S;
- XLSX válido;
- casillas del Formulario 210 y componente inflacionario con valores de decreto verificados;
- liquidación que respeta los feriados de Colombia y de la NYSE.

Sin embargo, la corrección de T22 introdujo el error contrario: **el régimen de la cripto se decide por la moneda de cotización del instrumento y no por dónde está custodiada** (T38). Un BTC cotizado en USD (como lo entrega Yahoo `BTC-USD`, la fuente de precios de este producto) pero custodiado en Mercado Bitcoin se manda a la Lei 14.754. Se omite así un DARF 4600 mensual obligatorio (R$ 30.000 en el escenario A7), y el único aviso es de nivel `info`.

| | Puntaje |
|---|---|
| **Nuestro paquete (`@pm/tax`)** | **8 / 10** (6 en la ronda 1, 7,5 en la ronda 2) |
| **Mejor competidor para este trabajo: Gorila (Brasil)** | **7 / 10** |

`approved = false`: nuestro puntaje supera al del competidor, pero queda un gap de severidad **alta** (T38).

### Pruebas ejecutadas

- `npx vitest run packages/tax` → **135/135 pruebas pasan** en 6 archivos.
- `npx tsc -p packages/tax --noEmit` → **0 errores**, también en core.
- Volví a correr **todos** mis scripts de la ronda 1 y la ronda 2 (`s1-colombia`, `s2-brazil`, `r2-adversarial`, `r2-colombia`, `r2-us`, `r2-bens`, `r2-short20k`): todos dan los valores esperados.
- Escribí escenarios nuevos (`r3-adversarial.ts`, `r3-recon.ts`, `r3-misc.ts`, `r3-xlsx2.ts`) y un validador de XLSX en Python (`check_xlsx.py`, que usa zipfile y minidom). openpyxl no está instalado.

### Fuentes

WebSearch funcionó y WebFetch sigue bloqueado. Confirmé:

- **Formulario 210, AG 2025:** casillas 112 (ingresos), 113 (costos), 114 (no gravadas y exentas), 115 (gravables) y 127 (impuesto) de ganancias ocasionales.
- **Componente inflacionario:** AG 2024 **50,88%** (Decreto 771/2025) y AG 2025 **55,43%** (Decreto 898/2026).

### Sobre el caso R3 que objetó el constructor

**El constructor tiene razón.** En la B3, la letra de la serie indica el mes de vencimiento: A es enero. Una PETRA350 vendida en febrero de 2026 vence el 15-ene-2027, así que mi ventana hasta abril no podía mostrar ese vencimiento. Con la serie correcta (A1: PETRC350, que es marzo) la prima de R$ 1.000 tributa en marzo de 2026 (R$ 150). Retiro la objeción. Los 7 tests de la ronda 1 que se cambiaron son coherentes con las correcciones T23, T24 y T29: el corto ahora cuenta en el mes de la venta, la opción vence en su fecha y el texto libre solo produce una propuesta.

---

## Verificación de los gaps de la ronda 2

| Gap | Estado | Evidencia (resultado real) |
|---|---|---|
| T12 Instrumentos | **Corregido** | A6: un swing de WDO en octubre da +2.000 (impuesto 300) y un day trade de WIN en noviembre da +500 (impuesto 100), con el valor del punto bien aplicado. A8: come-cotas de mayo sobre un rendimiento de 6.000 da 900 de impuesto; el de noviembre da 594,9 sobre la base actualizada; el FIA queda excluido. El aluguel tiene línea 06 y la tabla regresiva. El régimen anterior a 2024 da GCAP con R$ 42.500 en ventas, no exento, impuesto de 750 y DARF del 30-jun-2023 |
| T14 Formulario 210 | **Corregido** | Casillas 29, 112, 113, 114, 115, 127 y 132, más subcédulas de dividendos (`nationalDividendsGravadosCop`) |
| T20 Componente inflacionario y feriados | **Corregido** | Porcentajes del decreto 2023/2024/2025 verificados. A11: una venta en la BVC el viernes 20-mar-2026 (con el lunes 23 de San José festivo) liquida el 25-mar; en la NYSE, el 25-nov se liquida el 27-nov (Thanksgiving) y el 2-abr se liquida el 6-abr (Viernes Santo) |
| T22 Cripto en el exterior | **Corregido** | R10: ETH en Binance ya no genera DARF mensual y tributa R$ 15.000 por la Lei 14.754; Bens e Direitos 08-02 con país KY. Una billetera fría da custodia desconocida y el DARF bloqueado con advertencia. **Pero ver T38** |
| T23 Corto y límite de R$ 20 mil | **Corregido** | r2-short20k: ventas R$ 75.000, no exento, impuesto R$ 450 |
| T24 Vencimiento y ejercicio de opciones | **Corregido** | A1: el lanzamiento vencido da +1.000 en marzo. A2: el titular de una put vencida registra −800 y arrastra la pérdida. A5: en el ejercicio de una call lanzada, la prima se suma a la venta del activo: acciones +6.000, impuesto 900. **Pero ver T39 y T40** |
| T25 Opción tipada como acción | **Corregido** | R4: PETRB420 como `equity` queda en `OPCAO`, impuesto R$ 1.500 |
| T26 Código del DARF | **Corregido** | R7: el pago 4600 ya no salda el DARF 6015, que queda `vencida` |
| T27 Art. 153 solo en acciones | **Corregido** | C3: renta 22.000.000 |
| T28 Art. 36-1 en el Formulario 210 | **Corregido** | C2: 250M / 50M / 200M |
| T29 Parser de texto libre | **Corregido** | R5: "1,000.50" y "1.000,50" dan 1000,5; el texto libre queda como propuesta; los porcentajes se rechazan |
| T30 Ratio redondeado | **Corregido** | R1: con ratio 0,3333 quedan 100 acciones y no se separa fracción |
| T31 JCP de 2025 pagado en 2026 | **Corregido** | R8: esperado 15%, sin aviso |
| T32 IRPFM | **Corregido** | A9: dividendos de R$ 1,08 millones dan tarifa de 8% y R$ 86.400, con la tarifa lineal correcta. **Pero ver T43** |
| T33 Opciones del paquete | **Corregido** | `brazilTaxPack` reenvía issuers, preLei15270Dividends, jcpCreditDates, initialLossCarry, portfolioBaseCurrency, cryptoCustody y fundTerms |
| T34 CNPJ | **Corregido** | 8 CNPJ verificados por mí: PETR, VALE, ITUB, BBDC, BBAS, ABEV, ITSA, WEGE. `reconcileBrazil(...).cnpjByIssuer` los aprende del informe |
| T35 Selic | **Persiste (baja)** | La tabla 2024-01 a 2026-09 coincide con la Receita en los meses que revisé, **pero falta 2026-01**. Un DARF que venció el 30-dic-2025 y se paga en marzo de 2026 da `total: undefined`, porque falta la Selic de enero |
| T36 Conciliación | **Corregido** | r3-recon: proventos por empresa (VALE en `falta_no_portfolio`, JCP `diferente`), posiciones, DARF pagados y exógena de dividendos (`diferente`). **Pero ver T44** |
| T37 XLSX | **Corregido** | Los dos XLSX tienen ZIP íntegro (`testzip` sin errores), todo el XML bien formado, content types y relaciones correctos, 9 y 7 hojas, números como `<v>` y textos inline. **Pero ver T42** |

**Corregidos y verificados: 18 de 19** (T12, T14, T20, T22–T34, T36, T37). **Persiste: T35 (baja).**

---

## Comparación con fresca mirada: ¿por qué alguien seguiría prefiriendo Gorila, Investidor10, la ReVar o su contador?

1. **Ingreso de datos.** Gorila y la ReVar leen la B3 directamente, y la ReVar además alimenta la pré-preenchida. Aquí la conciliación existe, pero los documentos oficiales hay que transcribirlos a un CSV: no se lee el PDF del informe, el extracto de la Área do Investidor ni el archivo de la exógena (T44).
2. **Cripto local cotizada en USD** con el régimen equivocado (T38). Es justo el caso más común del público objetivo.
3. **Opciones semanales y tickers que se reutilizan cada año** (T39, T40). Un *trader* de opciones de PETR o VALE lo notaría en el primer mes.
4. **IRPFM sin el redutor** (T43). Quien vive de dividendos de grandes empresas, que tributan cerca de 34%, vería un IRPFM sobrestimado. Un contador sí lo aplica.

Aun así, ningún competidor combina Brasil (B3, renta fija, fondos, cripto, exterior, IRPFM, DARF con atraso, conciliación), Colombia (Formulario 210 con casillas, Formulario 160, Arts. 36-1, 153, 241 y 254-1, exógena) y EE.UU. (retención y sucesiones). Por eso el 8 frente al 7.

---

## Gaps abiertos

### Persiste

- **T35 — BAJA (persiste).** `SELIC_MONTHLY` no tiene **2026-01** (`brazil/darf.ts:50-57`). Cualquier DARF vencido antes de enero de 2026 y pagado después queda sin juros ni total (`r3-misc`: venció el 30-dic-2025, se paga el 10-mar-2026, y `missingSelicMonths` = ["2026-01"]). **Fix:** completar enero de 2026 (BCB SGS 4390) y agregar una prueba que garantice que no hay huecos.

### Nuevos

#### T38 — ALTA — El régimen de la cripto se decide por la moneda del instrumento, no por la custodia

- **Evidencia:** `brazil/classify.ts:70`, `if (inst.currency !== 'BRL') return 'exterior'`. `Transaction.account` (el exchange real) nunca se mira: grep de `account` en `crypto.ts` y `classify.ts` sin resultados.
- **Escenario A7:** `CCC:BTC-USD` (moneda USD, como lo entrega Yahoo) comprado y vendido con `account: 'Mercado Bitcoin'`. Venta de R$ 450.000 con ganancia de R$ 200.000 en marzo de 2026.
  - Esperado: GCAP, **DARF 4600 de R$ 30.000 con vencimiento el 30-abr-2026**.
  - Obtenido: `cryptoMonths: []`, sin DARF, la ganancia mandada a la Lei 14.754 (R$ 30.000 que se pagarían en mayo de 2027) y solo un aviso `info:CRYPTO_ABROAD`. El usuario no paga a tiempo y luego enfrenta multa de hasta 20% más Selic.
  - Además, Binance figura como "exterior" de forma fija, aunque opera en Brasil con entidad local; es un caso discutible que debería quedar `needs-verification`.
- **Fix:** decidir la custodia por cuenta o exchange (`tx.account`, o un mapa `accountCustody`), no por `inst.currency`. Si no hay información, usar `'desconhecida'` con advertencia. Nunca omitir un DARF por una heurística de moneda.

#### T39 — MEDIA — Un ticker de opción reutilizado al año siguiente nunca vence

- **Evidencia:** `brazil/ledger.ts:165-172`. `expiryOf` guarda un solo vencimiento por instrumento: el del primer movimiento. La B3 reutiliza los códigos cada año.
- **Escenario A3:** PETRC350 vendida el 3-feb-2025 (vence el 21-mar-2025) y otra vez el 2-feb-2026.
  - Obtenido: solo aparece +1.000 en 2025-03; la prima de 2026 (R$ 2.000) **nunca tributa** y queda en `openShorts`.
- **Fix:** calcular el vencimiento por lote o apertura, buscando el siguiente vencimiento después de cada venta o compra que abre posición.

#### T40 — MEDIA — Las opciones semanales se clasifican como acciones

- **Evidencia:** `OPTION_RE` (`brazil/classify.ts:43`) no acepta el sufijo semanal `W1`–`W5`.
- **Escenario A4:** PETRC350W4 tipada `equity` queda como **ACAO**, con la exención de R$ 20 mil y en Bens e Direitos como acción.
- **Fix:** aceptar `^[A-Z]{4}[A-X]\d{1,4}(W\d)?$` y derivar el vencimiento semanal (viernes de la semana N).

#### T42 — BAJA — El XLSX de Brasil pierde los ceros a la izquierda

- **Evidencia:** `brazil/taxPack.ts` arma las hojas con `parseCsv` sobre el CSV. En Bens e Direitos, grupo "03" y código "01" salen como **3 y 1** (`r3-xlsx2`, hoja 5). En proventos, la línea "09" sale como 9.
- **Fix:** construir las hojas desde los objetos tipados, o marcar como texto las columnas de códigos.

#### T43 — MEDIA — IRPFM sin redutor

- **Evidencia:** `brazil/irpfm.ts` (`IRPFM_META.note`: "Redutor... não calculado").
- La Lei 15.270 limita la carga combinada de empresa y persona (34% en general, 40% o 45% en sectores financieros). Para dividendos de empresas que ya tributan cerca de 34%, el redutor elimina o reduce mucho el IRPFM. Sin él, A9 estima R$ 86.400 que en la práctica pueden ser cercanos a 0.
- Tampoco se aclara si los dividendos de la transición (utilidades de 2025) entran en la base.
- **Fix:** aceptar la tasa efectiva por emisor (o un valor por defecto de 34% marcado `needs-verification`), calcular el redutor y mostrar el resultado como rango.

#### T44 — MEDIA — La conciliación depende de transcribir los documentos oficiales

`parseOfficialDocCsv` exige un CSV propio. No hay lector para el PDF del informe de rendimentos, el extracto de la Área do Investidor de la B3 (posición y movimientos) ni los archivos de la exógena o los certificados de la DIAN. Además, el JCP del informe se compara en bruto, mientras que muchos informes y la DIRPF usan el valor líquido (r3-recon: 1.000 frente a 825, `diferente`). **Fix:** importar los formatos de la B3 y la DIAN (o coordinarlo con el paquete importers) y documentar o detectar si el JCP viene bruto o líquido.

#### T41 — BAJA — `parseOfficialDocCsv` interpreta mal los miles en formato EE.UU.

- **Escenario A12:** con separador `,` y decimal `.`, el valor `"1,234.56"` da **1,23456**.
- **Fix:** usar `parseLocaleNumber`, que ya existe en `common/basis.ts`.

#### T45 — BAJA — Régimen del exterior anterior a 2024 incompleto

El carnê-leão de dividendos solo devuelve el total en BRL (`dividendsCarneLeaoBrl`), sin impuesto mensual con la tabla progresiva ni crédito por la retención de EE.UU. La conversión de la ganancia no distingue activos comprados con renta de origen extranjero (IN SRF 118/2000). Afecta solo a declaraciones rectificadoras de 2023 o años anteriores.

#### T46 — BAJA — Futuros de commodities cotizados en USD

`FUTURES_POINT_VALUE` aplica R$ por punto también a ICF (café, cotizado en US$ por saca) sin convertir la moneda. El resultado en reales queda mal para esos contratos; WIN, WDO, IND y DOL están bien.

---

## Matriz frente a competidores (detalle en el JSON)

| Función | Nosotros | Sharesight | Gorila | Kinvo | Portfolio Performance | Ghostfolio |
|---|---|---|---|---|---|---|
| Apuração mensual B3 | sí | no | sí | parcial | no | no |
| DARF (Sicalc, estado, multa e intereses) | sí | no | sí | parcial | no | no |
| Opciones, futuros, aluguel, corto | parcial | no | parcial | no | no | no |
| Renta fija, come-cotas | sí | no | sí | parcial | no | no |
| Cripto (Brasil y exterior) | parcial | parcial | parcial | no | no | no |
| Lei 14.754 y régimen anterior a 2024 | sí | no | parcial | no | no | no |
| IRPFM (Lei 15.270) | parcial | no | no | no | no | no |
| Colombia (210 con casillas, 160, 36-1, 153, 241) | sí | no | no | no | no | no |
| Conciliación con documentos oficiales | parcial | parcial | parcial | parcial | no | no |
| Exportación XLSX/CSV y modelo para PDF | sí | sí | sí | sí | parcial | parcial |
| Ingesta directa B3/DIAN | no | parcial | sí | sí | no | no |

## Para aprobar en la ronda 4

Corregir **T38** con una prueba basada en A7. Con eso no quedan gaps altos, y como 8 es mayor que 7, la revisión se aprobaría. Recomiendo corregir también T39 y T40, que son cambios pequeños sobre el código nuevo, y T35, que es completar una fila de la tabla.
