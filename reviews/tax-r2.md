# Revisión `packages/tax` — Ronda 2

**Revisor:** agente revisor (solo lectura; no construí este paquete)
**Fecha:** 2026-10-06
**Alcance:** las correcciones a los 21 gaps de la ronda 1 (`README.md`, sección "Respuesta a la revisión ronda 1"), el código nuevo y una nueva comparación con los competidores.

## Veredicto

**NO APROBADO (por poco).** El salto desde la ronda 1 es grande y real:

- Verifiqué de forma independiente que **18 de los 21 gaps quedaron corregidos**.
- Mis 15 escenarios de la ronda 1 dan ahora los valores esperados.
- El paquete ya cubre renta fija, cripto local, opciones básicas, venta en corto, DARF con datos para el Sicalc, multa e intereses, paquetes por país (Formulario 210 y 160, 7 CSV para Brasil), simulación de ventas y el riesgo de impuesto de sucesiones de EE.UU.

Por cobertura, hoy supera a cualquier competidor individual en el trabajo de este paquete. Las pruebas adversariales nuevas, sin embargo, encontraron **1 error de severidad alta**: la **cripto custodiada en el exterior** se calcula con el régimen equivocado. Por defecto genera un DARF 4600 mensual que no corresponde, y la Lei 14.754 no la calcula nunca. También aparecieron varios errores de severidad media, algunos introducidos por el código nuevo (ver T22–T37).

| | Puntaje |
|---|---|
| **Nuestro paquete (`@pm/tax`)** | **7,5 / 10** (6 en la ronda 1) |
| **Mejor competidor para este trabajo: Gorila (Brasil)** | **7 / 10** |
| Referencia: ReVar (Receita Federal y B3, gratuita, oficial) | 6/10: solo mercado à vista, pero importa de la B3 y alimenta la declaración pré-preenchida |

`approved = false`: aunque nuestro puntaje supera al del competidor, queda un gap de severidad **alta** (T22).

### Pruebas ejecutadas

- `npx vitest run packages/tax` → **100/100 pruebas pasan** en 5 archivos, incluido `review-r1.test.ts` con 46.
- `npx tsc -p packages/tax --noEmit` → **0 errores en `packages/tax`**. Hay 3 errores en `packages/core` (`api.ts:102`, `index.ts:6`, exports de `./performance`) porque el agente de core está a mitad de un cambio; no son de este paquete.
- Repetí mis escenarios de la ronda 1 (`s1-colombia.ts`, `s2-brazil.ts`) y escribí escenarios nuevos (`r2-adversarial.ts`, `r2-colombia.ts`, `r2-us.ts`, `r2-bens.ts`, `r2-short20k.ts`), todos en `scratchpad/review-tax/`.

### Sobre las fuentes

WebSearch funcionó; WebFetch sigue bloqueado por el proxy. Confirmé:

- La cripto en exchanges del exterior sin CNPJ en Brasil tributa 15% anual por la Lei 14.754, "no DARF mensual" (Nomad, InfoMoney, Transfero, DIRPF 2026).
- La ReVar solo cubre el mercado à vista, sin opciones ni futuros.
- La declaración pré-preenchida 2026 ya incluye los DARF pagados y el IRRF de renta variable.
- El IRRF sobre el JCP es 17,5% en 2026 y 2027 (LC 224/2025); una fuente sugiere 20% desde 2028, y el paquete lo deja marcado `needs-verification`.

---

## Verificación de los gaps de la ronda 1

| Gap | Estado | Evidencia (resultado real) |
|---|---|---|
| T1 Art. 153 | **Corregido** | S-CO1: ganancia ocasional gravable 86.000.000 e impuesto 12.900.000; S-CO1b: renta 44.000.000. Pero se aplica de más (ver T27) |
| T2 Remesa BRL→USD | **Corregido** | S-BR6: efectivo de US$ 5.400 con costo de R$ 28.080; ítem 06-01 con país US |
| T3 DARF el 31/12 | **Corregido** | 2025, 2026 y 2027 vencen el 30/12 |
| T4 Venta en corto | **Corregido** | S-BR4: +R$ 5.000, impuesto R$ 750, sin posición fantasma. El corto que cruza el año se reconoce en el mes de la recompra. Pero la venta en corto no cuenta para el límite de R$ 20 mil (ver T23) |
| T5 Lei 15.270 por empresa | **Corregido** | S-BR2: PETR3 + PETR4 dan R$ 6.000 esperados en total |
| T6 Transición Lei 15.270 | **Corregido** | S-BR3: esperado 0, solo aviso `info:LEI_15270_TRANSITION` |
| T7 ETF de renta fija | **Corregido** | S-BR5: sin DARF; categoría `ETF_RF` y Bens e Direitos 07-08 |
| T8 Dividendos CO, Arts. 254-1 y 241 | **Corregido** | S-CO2: retención esperada 36.857.863,5 y aviso; descuento 254-1 de 46.686.627. C1: el incremental del Art. 241 (46.651.205) coincide con mi cálculo manual |
| T9 Costo en traslados | **Corregido** | C5: la nota `[costo: 2019-03-15 @ 50]` da fecha 2019-03-15, costo 1.550.000 y ganancia ocasional. Pero el parser de texto libre falla (ver T29) |
| T10 `fxRateToBase` | **Corregido** | S-BR7: R$ 52.000 |
| T11 DARF pagable | **Corregido** | Datos para el Sicalc, estados `paga`/`vencida`. R6: 42 días de atraso dan multa de 13,86% y juros de 2,10% (Selic de marzo 1,10% + 1%), correcto. Pero la conciliación mezcla códigos (ver T26) |
| T12 Instrumentos | **Persiste (parcial)** | Renta fija, cripto local y opciones/derechos funcionan. Siguen faltando futuros, aluguel, ejercicio y **vencimiento** de opciones (T24), come-cotas e IRPFM |
| T13 Bens e Direitos | **Corregido** | Campos por activo del exterior, país del efectivo, CNPJ de 5 emisores verificado (PETR, VALE, ITUB, BBDC, BBAS) y códigos nuevos (07-08, 04-02, 08-01, 08-03) |
| T14 Exportaciones y Formulario 210 | **Persiste (parcial)** | Ya hay `colombiaTaxPack` y `brazilTaxPack` (7 CSV) y el Formulario 160 por país o por activo. Faltan los números de casilla verificados del 210, PDF/XLSX, y la asignación del Art. 36-1 es inconsistente (T28) |
| T15 Simulación | **Corregido** | C7: milestone 2026-07-01, 182 días; simular la venta da +1.750.000 de renta y +490.000 de impuesto (28%), correcto |
| T16 Consignaciones | **Corregido** | S-CO5: `byConsignaciones = true` |
| T17 Art. 36-1 por emisor | **Corregido** | `issuerKey` agrupa BCOLOMBIA y PFBCOLOM |
| T18 Fracción del grupamento | **Corregido** | S-BR10: 100 acciones y aviso de la fracción. Pero falla con un ratio redondeado (ver T30) |
| T19 Fuente EE.UU. y sucesiones | **Corregido** | CSPX (ISIN IE) no es fuente EE.UU.; 200 AAPL + 50 VOO = US$ 75.000, supera el umbral |
| T20 Realización y componente inflacionario | **Persiste (baja)** | La realización en la fecha de liquidación funciona (C4), pero ignora feriados: el 30-dic-2025 liquida "2026-01-01", que es feriado. No viene el % del componente inflacionario de ningún año |
| T21 JCP 2028 y dedo-duro | **Corregido** | Años 2027 y 2028 marcados `needs-verification`; el IRRF estimado ya no se acredita (`IRRF_ESTIMATE_NOT_CREDITED`) |

**Corregidos y verificados: 18 de 21** (T1–T11, T13, T15–T19, T21). **Persisten: T12, T14 y T20.**

---

## Lo que ya es mejor que los competidores

1. **Es el único motor con Colombia, Brasil (B3, renta fija, cripto, exterior) y EE.UU. (retención y sucesiones).**
   - Ningún competidor tiene Colombia. Este paquete calcula patrimonio, Formulario 160 por país o activo, Art. 36-1 por emisor, Art. 153, ganancia ocasional, el Art. 241 incremental, los descuentos de los Arts. 254 y 254-1, la retención esperada y las consignaciones.
   - Con eso, ya es la mejor herramienta para colombianos que existe en el mercado.
2. **Estado completo del DARF** (pendente, vencida, paga, paga em atraso) con multa e intereses calculados. Gorila emite el DARF, pero no he podido verificar que concilie pagos atrasados.
3. **Simulación con las reglas de cada país**: el margen que queda de los R$ 20 mil, la cosecha de pérdidas en Brasil, la regla de "no hay cosecha de pérdidas" en Colombia por el Art. 153, y el día en que cada lote cumple 2 años. Sharesight solo ofrece el *Unrealised CGT*.
4. **Aviso de impuesto de sucesiones de EE.UU.** con detección de UCITS. Ningún competidor brasileño ni colombiano lo tiene, y es muy relevante para este público.
5. **Procedencia legal de cada parámetro** (`meta`), ahora también para la tabla de CNPJ, las casillas del 210 y la lista de ETF de renta fija.

## Por qué un inversionista todavía preferiría Gorila, Investidor10, la ReVar o un contador

1. **Datos de origen.** La ReVar y Gorila leen las operaciones directamente de la B3 (Área do Investidor). La ReVar además alimenta la declaración pré-preenchida, que ya trae DARF e IRRF. Aquí todo depende de que las transacciones se hayan importado bien, y no hay conciliación contra el informe de rendimentos, la pré-preenchida, la exógena de la DIAN ni los certificados de Deceval (T36).
2. **Cripto en el exterior con el régimen equivocado** (T22) y opciones sin vencimiento (T24). Un *trader* de opciones o de cripto obtendría cifras incorrectas.
3. **El contador colombiano necesita casillas.** Las líneas del Formulario 210 vienen sin número de casilla verificado y la línea del Art. 36-1 no cuadra con la exógena (T28). Un contador lo detecta, pero no puede copiar y pegar.
4. **Solo hay CSV**, sin PDF ni XLSX. Sharesight y Gorila entregan un informe presentable.

---

## Gaps abiertos

### Persisten de la ronda 1

- **T12 — MEDIA (persiste, parcial).** Faltan futuros y BM&F, aluguel (la remuneración al prestador), ejercicio de opciones (la prima se ajusta al costo del activo), come-cotas de fondos abiertos, el régimen del exterior anterior a 2024 y el **IRPFM** de la Lei 15.270, que es relevante desde el ajuste de 2027 (ver también T32).
- **T14 — MEDIA (persiste, parcial).** `FORMULARIO_210_META` está en `needs-verification` y **no trae casillas**: `casillas210` lo debe llenar el usuario. No hay PDF ni XLSX. Los dividendos del Formulario 210 no se separan en primera y segunda subcédula (Art. 49, parágrafo 2).
- **T20 — BAJA (persiste).** El componente inflacionario no trae el porcentaje del decreto anual, porque `config.componenteInflacionario` está vacío para todos los años. `settlementDate` ignora los feriados de Colombia y de EE.UU.

### Nuevos

#### T22 — ALTA — Cripto en el exterior: régimen equivocado

- **Evidencia:** `brazil/classify.ts:145` asigna `CRYPTO` a toda la cripto antes de mirar el exchange. `brazil/crypto.ts:80-83` usa una opción global `custody`, cuyo valor por defecto es `'brasil'`. `brazil/exterior.ts` solo procesa `FOREIGN`, y `brazilTaxPack` no deja indicar la custodia.
- **Escenario R10:** ETH en `BINANCE` en USD; compra de 20 a US$ 3.000 en 2025 y venta a US$ 4.000 el 10-mar-2026.
  - Obtenido: un **DARF 4600 de R$ 15.000 con vencimiento 30/04/2026, sin ningún aviso**, y la ganancia no aparece en la Lei 14.754 (`sales: 0`).
  - Con `custody: 'exterior'` solo aparece el aviso `CRYPTO_ABROAD`: la ganancia no se calcula en ninguna parte.
  - Esperado: 15% anual en la DAA (Lei 14.754), sin exención de R$ 35 mil y sin DARF mensual.
- **Fix:** definir la custodia por activo o por cuenta: exchange extranjero o moneda distinta de BRL implica `FOREIGN_CRYPTO`. Incluir esos activos en `brazilForeignAnnualReport` (con PTAX compra/venta y pérdidas) y en Bens e Direitos 08-xx con el país. Nunca generar el DARF 4600 sin confirmar que la custodia está en Brasil.

#### T23 — MEDIA — La venta en corto no cuenta para el límite de R$ 20 mil

- **Evidencia:** `brazil/apuracao.ts:215-219`. `salesAcoesSwing` excluye `shortCover`, y la venta en corto se incluye recién en el mes de la recompra, nunca en el mes en que se vende. La Lei 11.033, art. 3º I mide "valor das alienações realizadas em cada mês".
- **Escenario `r2-short20k.ts`:** en marzo, venta en corto de VALE3 por R$ 60.000 y venta normal de PETR4 por R$ 15.000 con ganancia de R$ 3.000.
  - Obtenido: `salesAcoesSwing` = 15.000, mes **exento**, `exemptGain` = 3.000, impuesto 0.
  - Esperado: ventas por R$ 75.000, no exento, impuesto de R$ 450.
- **Fix:** sumar el bruto de la venta en corto a las alienaciones del mes en que se vende.

#### T24 — MEDIA — Opciones: el vencimiento no se modela

- **Escenario R3:** lanzamiento cubierto de 1.000 PETRA350 a R$ 1,00 que vence sin ejercicio.
  - Obtenido: resultado 0 en todos los meses, `openShorts` para siempre y el error `SHORT_OR_MISSING_HISTORY`. **La prima de R$ 1.000 nunca tributa.**
  - Lo mismo ocurre con el titular: la prima pagada nunca se reconoce como pérdida.
- **Fix:** derivar el vencimiento de la serie (letra y mes; tercer viernes, o la fecha que traiga la nota) y cerrar la posición a 0 en esa fecha. Agregar `EXERCISE` cuando el contrato lo permita.

#### T25 — MEDIA — Opciones tipadas como `equity` se tratan como acciones exentas

- **Evidencia:** `brazil/classify.ts:155`. `OPTION_RE` solo se aplica si `assetClass` es `other` o `commodity`.
- **Escenario R4:** PETRB420 importado como `equity`, ganancia de R$ 10.000 con R$ 15.000 de ventas.
  - Obtenido: clasificado como `ACAO`, **exento**, impuesto 0.
  - Esperado: 15%, R$ 1.500.
- **Fix:** aplicar `OPTION_RE` antes de la regla de `equity`; una acción nunca tiene una letra en la quinta posición.

#### T26 — MEDIA — La conciliación de DARF ignora el código de receita

- **Evidencia:** `brazil/darf.ts:119-131`. `DARF_NOTE` acepta 6015, 4600 o "darf", pero `DarfPayment` no guarda el código, y `matchDarfPayments` empareja por mes.
- **Escenario R7:** DARF 6015 de marzo por R$ 1.500 y un pago anotado "DARF 4600 cripto 2026-03".
  - Obtenido: el DARF 6015 queda en estado **`paga`**.
- **Fix:** guardar el `code` en `DarfPayment` y exigir que coincida.

#### T27 — MEDIA — El Art. 153 se aplica a activos que no son acciones

- **Evidencia:** `colombia/report.ts:702-720` agrupa todas las ventas, sin filtrar por clase de activo.
- **Escenario C3:** pérdida de 22M COP en un bono del Tesoro de EE.UU. y ganancia de 44M en AAPL, ambos con tenencia menor a 2 años.
  - Obtenido: la pérdida del bono queda como no deducible y la renta líquida en 44.000.000.
  - El Art. 153 solo habla de "acciones o cuotas de interés social". La renta esperada es 22M, así que se sobrestima el impuesto. Lo mismo pasa con cripto y fondos.
- **Fix:** limitar el Art. 153 a `equity` (y ETF solo si se decide de forma explícita y documentada). Para bonos y cripto, aplicar las reglas de pérdidas que correspondan.

#### T28 — MEDIA — Formulario 210: la venta del Art. 36-1 queda fuera de ingresos brutos y costos

- **Evidencia:** `colombia/taxPack.ts:36-43`.
- **Escenario C2:** venta de ECOPETROL por 250M COP con costo de 200M.
  - Obtenido: "Ingresos brutos por enajenación" = **0**, "Costos" = **0**, "INCRNGO Art. 36-1" = 50M.
  - Esperado: en el Formulario 210 se declara el ingreso bruto (250M), el INCRNGO (50M) y el costo (200M). Así la renta queda en 0 y cuadra con la exógena que reporta el comisionista. Como está, el INCRNGO reduciría otras rentas.
- **Fix:** incluir los ingresos y costos del Art. 36-1 en las líneas de rentas no laborales, o en ganancia ocasional cuando la tenencia sea de 2 años o más.

#### T29 — MEDIA — El parser de costo de traslados acepta texto libre peligroso

- **Evidencia:** `common/basis.ts:30-50`. La función `num` interpreta "1,000.50" como **1,0005**.
- **Escenario R5:**
  - `"bought in 2019 at 1,000.50"` → `unitCost` 1,0005: un costo **1.000 veces menor**, es decir, una ganancia ficticia.
  - `"[cost: 2019-03-15 @ 1,000.50]"` → 1,0005.
  - `"Compra en 2024 a 30 por ciento"` → `unitCost` 30 con fecha 2024-12-31, aplicado sin pedir confirmación.
- **Fix:** aceptar solo la nota estructurada, o con texto libre devolver una propuesta y pedir confirmación (`level: warning`). Distinguir los separadores por posición: un grupo de 3 dígitos detrás de una coma es separador de miles.

#### T30 — BAJA — Grupamento con ratio redondeado

- **Escenario R1:** grupamento 3:1 de 300 acciones con `ratio` 0,3333.
  - Obtenido: **99 acciones**, la fracción de 0,9999 separada con R$ 29,70 de costo y el aviso `FRACAO_GRUPAMENTO`. Con 1/3 exacto funciona bien.
- **Fix:** ajustar a un entero cuando la diferencia sea menor a 0,01 por acción, o aceptar el ratio como `from`/`to`.

#### T31 — BAJA — JCP acreditado en 2025 y pagado en 2026 al 15%

- **Escenario R8:** un JCP con nota "declarado em 12/2025" pagado en 2026 da `IRRF_MISMATCH` (esperado 17,5%). La LC 224 se aplica por fecha de "pagamento ou crédito", y fue un caso masivo en 2026.
- **Fix:** aplicar a la nota la misma detección de fecha que en T6, o agregar una opción `jcpCreditDate`.

#### T32 — MEDIA — Falta el IRPFM de la Lei 15.270

Falta la tributación mínima anual para rentas de más de R$ 600 mil, con tarifa progresiva hasta 10% a partir de R$ 1,2 millones, y el crédito del IRRF del 10% sobre dividendos. Es relevante para el público con patrimonio alto, y entra en el ajuste de 2027 (año 2026). Hoy solo aparece mencionado en las notas.

#### T33 — BAJA — `brazilTaxPack` no pasa todas las opciones

No se reenvían `issuers` ni `preLei15270Dividends` (proventos), `initialLossCarry` ni `portfolioBaseCurrency` (exterior), ni la custodia de la cripto. Con el paquete, el resultado puede diferir del de cada reporte por separado.

#### T34 — BAJA — La tabla de CNPJ solo trae 5 emisores

FII, ETF, BDR y el resto de las acciones quedan en blanco. Gorila completa todos. **Fix:** una tabla más amplia, versionada, o importarla desde el informe de la corretora.

#### T35 — BAJA — La Selic no viene incluida

Sin `selicMonthly`, el total del DARF vencido queda `undefined` (R6b) y solo aparece el aviso `SELIC_MISSING`. **Fix:** incluir la serie 4390 grabada y actualizable, igual que las demás tablas fechadas.

#### T36 — MEDIA — No hay conciliación con documentos oficiales

No se cruza contra el informe de rendimentos de la corretora, la declaración pré-preenchida (que ya trae DARF e IRRF), la exógena de la DIAN, los certificados de retención o Deceval, ni el 1042-S. Es la razón principal por la que un contador seguiría prefiriendo su propio proceso.

#### T37 — BAJA — Solo hay CSV

Sin PDF ni XLSX: Sharesight y Gorila entregan un informe presentable. La UI podría resolverlo, pero el paquete no ofrece un modelo de documento.

---

## Matriz frente a competidores (detalle en el JSON)

| Función | Nosotros | Sharesight | Gorila | Kinvo | Portfolio Performance | Ghostfolio |
|---|---|---|---|---|---|---|
| Apuração mensual B3 | sí | no | sí | parcial | no | no |
| DARF (Sicalc, estado, multa e intereses) | parcial | no | sí | parcial | no | no |
| Opciones, futuros, aluguel, corto | parcial | no | parcial | no | no | no |
| Renta fija (tabla regresiva, IOF, exentos) | parcial | no | sí | parcial | no | no |
| Cripto (Brasil y exterior) | parcial | parcial | parcial | no | no | no |
| Lei 14.754 | parcial | no | parcial | no | no | no |
| Bens e Direitos (CNPJ, campos del exterior) | sí | no | sí | sí | no | no |
| Colombia (210, 160, 36-1, 153, 241) | sí | no | no | no | no | no |
| Simulación e impuesto no realizado | sí | sí | parcial | no | parcial | no |
| Conciliación con documentos oficiales | no | parcial | parcial | parcial | no | no |
| Export PDF/XLSX/CSV | parcial | sí | sí | sí | parcial | parcial |

Las celdas de competidores salen de búsquedas web y de conocimiento previo, porque WebFetch está bloqueado. Las de Gorila y Kinvo deben confirmarse.

## Para aprobar en la ronda 3

1. Corregir **T22** (régimen de la cripto según la custodia) con una prueba basada en R10.
2. Corregir T23, T24, T25, T26, T27 y T28. Son cambios pequeños y los escenarios ya están escritos.
3. Con eso el puntaje subiría a 8 o más y no quedarían gaps altos.
