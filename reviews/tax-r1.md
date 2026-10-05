# Revisión `packages/tax` — Ronda 1

**Revisor:** agente revisor (solo lectura; no construí este paquete)
**Fecha:** 2026-10-05
**Alcance:** `packages/tax/README.md` y todo `packages/tax/src/` (≈3.900 líneas), con pruebas y typecheck.

## Veredicto

**NO APROBADO.** Ninguna herramienta existente cubre Colombia, Brasil (B3 y exterior) y la retención de EE.UU. en un mismo motor, y aquí sí están los tres. Además, cada parámetro trae año, fuente y estado de verificación, algo que no he visto en ningún competidor. El problema es que hay **3 errores de cálculo de severidad alta** que producen cifras tributarias equivocadas en casos comunes:

- Colombia descuenta pérdidas en venta de acciones, cosa que prohíbe el Art. 153 ET.
- La remesa BRL→USD desaparece del cálculo del exterior y de Bens e Direitos.
- La venta en corto o la sobreventa genera una ganancia ficticia y deja una posición fantasma.

Para Brasil, además, faltan piezas que los líderes locales ya ofrecen: emitir el DARF (con multa e intereses si va atrasado), opciones, renda fixa y simular una venta antes de hacerla. Para el inversionista brasileño que solo opera en la B3, el paquete todavía no supera a Gorila ni a la calculadora oficial ReVar (Receita Federal y B3).

| | Puntaje |
|---|---|
| **Nuestro paquete (`@pm/tax`)** | **6 / 10** |
| **Mejor competidor para este trabajo: Gorila (Brasil)** | **7 / 10** |
| Referencia de experiencia de uso: Sharesight (AU/NZ/UK/CA) | 8/10 en su mercado, 2/10 para CO y BR |

`approved = false`: nuestro puntaje no supera al del competidor y hay gaps de severidad alta.

### Pruebas ejecutadas

- `npx vitest run packages/tax` → **54/54 pruebas pasan**, en 4 archivos.
- `npx tsc -p packages/tax --noEmit` → **sin errores** (salida 0).
- Escribí y corrí con `npx tsx` 15 escenarios propios. Están en el scratchpad, en `review-tax/s1-colombia.ts` y `review-tax/s2-brazil.ts`. Los resultados aparecen abajo.

### Sobre las fuentes

WebSearch funcionó. **WebFetch quedó bloqueado por el proxy de salida** para planalto.gov.br, gov.br, camara.leg.br, legisweb y normaslegais. Por eso las reglas se verificaron con los resúmenes de búsqueda y con mi conocimiento, no con el texto oficial completo. Lo que quedó verificado:

- La UVT 2026 es $52.374 (Res. DIAN 000238 de 2025).
- El IRRF del JCP es 17,5% desde el 01/01/2026 (LC 224/2025). Una fuente dice que sube al 20% desde 2028; hay que confirmarlo.
- Lei 15.270/2025: IRRF del 10% sobre lo que supere R$ 50 mil al mes pagado por la misma persona jurídica, con una regla de transición para utilidades de 2025 aprobadas hasta el 31/12/2025.
- IN 2.180/2024: el costo se convierte a PTAX de compra y el valor recibido a PTAX de venda. La divisa comprada en el mercado de cambios tiene como costo "o valor efetivamente pago".
- PGFN y FEBRABAN: el **31/12 no tiene expediente bancario**; las guías se pagan hasta el 30/12.
- **Art. 153 ET**: la pérdida en la venta de acciones no es deducible.
- Ya existe un proyecto de reforma radicado el 20-jul-2026 que propone 4 años de tenencia para ganancia ocasional. El paquete lo marca correctamente como `needs-verification`.

---

## Lo que es mejor que en los competidores

1. **Tres países en un solo motor**: Colombia, Brasil (B3 y exterior) y la retención de EE.UU. Gorila, Kinvo, Investidor10 y Status Invest solo cubren Brasil. Sharesight solo cubre AU/NZ/UK/CA de verdad. Portfolio Performance y Ghostfolio no tienen reglas fiscales.
2. **Colombia, donde casi no existe software.** Hoy los contadores colombianos trabajan con Excel, los extractos del bróker y los certificados de Deceval. No hay un "Sharesight colombiano". Este paquete ya calcula:
   - el patrimonio a costo fiscal según el Art. 269 (con la opción de TRM al 31-dic);
   - el Formulario 160 con la UVT del año en que se presenta;
   - el Art. 36-1 con el 3%;
   - la ganancia ocasional con la regla de 2 años (incluido el 29-feb);
   - la diferencia en cambio realizada, con una bolsa de divisas a costo promedio;
   - un CSV para el contador con separador `;`, coma decimal y BOM.
3. **Parámetros por año con procedencia** (`meta.status`, `source`, `checkedOn`), con aviso `PARAMS_NEED_VERIFICATION`. Ningún competidor muestra en qué ley o resolución se basa cada tarifa.
4. **Brasil, B3: el núcleo está bien.** Preço médio con costos; day trade por corretora; tres bolsas de pérdidas separadas; una pérdida en mes exento sí se acumula; dedo-duro con la dispensa de R$ 1 calculada por mes; DARF por debajo de R$ 10 que se acumula; feriados móviles y el 20-nov desde 2024. También están JCP al 17,5% y dividendos por encima de R$ 50 mil desde 2026.
5. **Lei 14.754 con PTAX compra/venta diferenciada**, pérdidas que se arrastran entre años y crédito por impuesto pagado afuera con tope por renta. Verifiqué un año con pérdida mayor que el dividendo (S-BR8): base 0 y crédito 0. Es correcto.
6. **El chequeo de la retención de EE.UU. contra la tabla de tratados** (falta de W-8BEN, archivos que traen el dividendo neto) no existe en Gorila ni en Kinvo.

## Lo que es peor que en los competidores

1. **Errores de cálculo en casos comunes** (ver T1, T2 y T4). Una herramienta tributaria con errores silenciosos vale menos que una con menos funciones.
2. **El DARF no se emite.** Solo se entregan el valor y la fecha: no hay código de barras ni Sicalc, no hay multa ni intereses por atraso, y la fecha del 31/12 está mal. Gorila PRO, Investidor10 y la ReVar oficial generan el DARF.
3. **Cobertura de instrumentos menor** que en Gorila o Bússola. Faltan opciones, futuros, aluguel, venta en corto, derechos de suscripción, ETF de renta fija, renda fixa/Tesouro (tabla regresiva y come-cotas), cripto (en Brasil, la exención de R$ 35 mil y el GCAP) y Fiagro.
4. **No hay simulación ni "impuesto si vendo hoy".** Sharesight tiene el *Unrealised CGT report*. Aquí no se ven el margen que queda de los R$ 20 mil del mes, el día en que un lote colombiano cumple 2 años ni la cosecha de pérdidas (*tax-loss harvesting*).
5. **Exportaciones incompletas.** Solo hay CSV para Colombia y para la apuração de Brasil. Faltan proventos, exterior y Bens e Direitos, no hay PDF o *tax pack*, y tampoco la correspondencia con los renglones del Formulario 210 o el formato del 160. Sharesight exporta PDF, XLSX y Google Sheets y permite compartir con el contador.
6. **No concilia con documentos oficiales.** No cruza contra el informe de rendimentos de la corretora, los certificados de retención o Deceval, ni el 1042-S.

---

## Gaps (numerados)

### T1 — ALTA — Colombia: se descuentan pérdidas en venta de acciones (Art. 153 ET)

- **Evidencia:** `colombia/report.ts:681` (`goGravable = max(0, ingresos − costos)` sobre todas las ventas de ganancia ocasional) y `colombia/report.ts:729` (`rentaLiquidaCop = ingresos − costos` en renta ordinaria). Las pérdidas de una acción compensan la ganancia de otra. El Art. 153 ET dice que "no es deducible la pérdida en la enajenación de acciones o cuotas de interés social" (doctrina DIAN, Concepto 978 de 2023).
- **Escenario S-CO1:** AAPL y VOO, cada una 100 acciones compradas el 2021-01-10 (TRM 4.000). Se venden el 2025-06-02 (TRM 4.200): AAPL a US$ 300 y VOO a US$ 150.
  - Esperado: ganancia ocasional gravable **86.000.000 COP** e impuesto **12.900.000**.
  - Obtenido: **29.000.000** e impuesto **4.350.000**, es decir, se subestima el impuesto en un 66%.
- **Escenario S-CO1b:** las mismas acciones, con tenencia menor a 2 años (compra 2024-06-03).
  - Esperado: renta por venta de acciones **+44.000.000**.
  - Obtenido: `rentaLiquidaCop` **−13.000.000**.
- **Fix:** por cada venta (o por lote), limitar el costo deducible a `min(costo, ingreso)` en ganancia ocasional y en renta ordinaria. Reportar aparte "pérdida no deducible (Art. 153 ET)". Agregar pruebas.

### T2 — ALTA — Brasil exterior: la remesa BRL→USD (`FX_CONVERSION` desde BRL) se ignora

- **Evidencia:** `brazil/exterior.ts:199`. `if (!foreignCash || …) continue;` sale del ciclo cuando `currency === 'BRL'`, así que la línea 211 (`pool.add(toCurrency…)`) nunca corre en una remesa. Las compras con USD (`:226`) se descuentan de una bolsa vacía sin ningún aviso.
- **Escenario S-BR6:** conversión de R$ 52.000 a US$ 10.000; luego compra de 20 AAPL a US$ 230.
  - Esperado: efectivo al 31/12 de US$ 5.400 con costo de R$ 28.080, e ítem 06-01 en Bens e Direitos.
  - Obtenido: `cash: []`, y Bens e Direitos solo muestra la acción. **Falta un bien en la declaración.** Es el flujo típico de Avenue, Nomad o Inter.
- **Fix:** procesar `FX_CONVERSION` con origen BRL. El costo en BRL es `amount + fees`, es decir, el valor efectivamente pagado según la IN 2.180. Emitir `FOREIGN_CASH_NOT_RECORDED`, como en Colombia, cuando `pool.remove` quede sin cubrir.

### T3 — MEDIA — DARF con vencimiento el 31/12, día sin expediente bancario

- **Evidencia:** `common/dates.ts:88-104`. `brazilBankHolidays` no incluye el 31/12, y `apuracao.ts:205` usa ese cálculo.
- **Escenario S-BR1:** ganancia en noviembre de 2026.
  - Esperado: `dueDate` **2026-12-30**.
  - Obtenido: **2026-12-31**. Lo mismo pasa en 2025 y 2027. PGFN y FEBRABAN: "no dia 31 de dezembro não haverá expediente bancário".
- **Fix:** tratar el 31-dic como día no hábil bancario y agregar una prueba.

### T4 — ALTA — Venta en corto o sobreventa: ganancia ficticia y posición fantasma

- **Evidencia:** `brazil/ledger.ts:202-210`. Si la venta supera la posición, el costo es 0. Después, la recompra (`:196`) abre una posición larga.
- **Escenario S-BR4:** venta en corto de 1.000 VALE3 a R$ 60 el 02/03 y recompra a R$ 55 el 20/03.
  - Esperado: resultado **+R$ 5.000** e impuesto **R$ 750**.
  - Obtenido: resultado **R$ 60.000**, impuesto **R$ 9.000**, y queda una posición de 1.000 VALE3 a R$ 55 que contamina meses futuros y Bens e Direitos.
  - Se emite `OVERSELL`, pero el DARF sale igual.
- **Fix:** manejar el corto. La venta abre una posición corta y la ganancia se reconoce al recomprar (IN 1.585, art. 56 y siguientes). Cuando el problema sea historial incompleto, no generar DARF y exigir el costo de entrada.

### T5 — MEDIA — Lei 15.270: el umbral de R$ 50 mil se agrupa por ticker y no por empresa pagadora

- **Evidencia:** `brazil/proventos.ts:104` (clave `instrumentId|mes`).
- **Escenario S-BR2:** R$ 30.000 de PETR4 y R$ 30.000 de PETR3 en marzo de 2026, ambos pagados por Petrobras.
  - Esperado: IRRF esperado de R$ 6.000 y aviso.
  - Obtenido: `expectedIrrf = 0`, sin aviso.
- **Fix:** agrupar por emisor (CNPJ raíz o `issuerId`). Mientras tanto, agrupar las clases ON, PN y UNIT de un mismo ticker raíz.

### T6 — MEDIA — Lei 15.270: falta la transición para utilidades de 2025 aprobadas hasta el 31/12/2025

- **Evidencia:** `brazil/proventos.ts:100-119` aplica el 10% a todo dividendo de 2026 que supere el umbral.
- **Escenario S-BR3:** VALE3 paga R$ 80.000 el 15/02/2026, correspondientes a 2025 y aprobados en diciembre de 2025. Legalmente no hay retención.
  - Obtenido: `expectedIrrf = 8.000` y la advertencia **`IRRF_MISMATCH`**, que es una falsa alarma.
- **Fix:** agregar un campo o heurística para "lucros até 2025 aprovados até 31/12/2025". Bajar el aviso a nivel `info` cuando no se pueda determinar.

### T7 — MEDIA — Un ETF de renta fija se trata como ETF de acciones (15% vía DARF)

- **Evidencia:** `brazil/classify.ts:22` clasifica cualquier `etf` de la B3 como `ETF` swing.
- **Escenario S-BR5:** compra de 1.000 IMAB11 a R$ 100 y venta a R$ 110.
  - Obtenido: un DARF de **R$ 1.494,50**.
  - En un ETF de renta fija (Lei 13.043/2014), el IR se retiene en la fuente con una tarifa que depende del plazo de la cartera. Este DARF lleva a pagar dos veces el mismo impuesto.
- **Fix:** crear la categoría `ETF_RF`: excluirla de la apuração mensual, mostrarla como tributación en la fuente y declararla en el código 07-08.

### T8 — MEDIA — Colombia: la retención sobre dividendos nacionales y el Art. 254-1 están en la configuración pero no se calculan

- **Evidencia:** `colombia/config.ts:30-32,63`. Ni `dividendWithholding` ni `dividendDiscount` aparecen en `colombia/report.ts`, lo que confirmé con grep. Tampoco se calcula el impuesto del Art. 241 de la cédula general.
- **Escenario S-CO2:** dividendo de ECOPETROL de 300.000.000 COP en 2025, sin retención registrada.
  - Esperado: una retención aproximada de **36.857.864 COP** (15% sobre lo que exceda 1.090 UVT), un aviso y un descuento estimado por el Art. 254-1.
  - Obtenido: sin aviso y sin descuento.
- **Fix:** calcular la retención esperada y avisar si no coincide, como ya se hace en Brasil. Estimar el descuento del Art. 254-1 y ofrecer un impuesto estimado con la tabla del Art. 241, usando `marginalRate` o los ingresos que informe el usuario.

### T9 — MEDIA — `TRANSFER_IN` reinicia la fecha de compra y el costo (Colombia y Brasil)

- **Evidencia:** en `colombia/report.ts:348-353`, el lote abre en la fecha de la transferencia con el costo `grossAmount`. Pasa lo mismo en `brazil/ledger.ts:118`.
- **Escenario S-CO3:** AAPL comprado en 2019, transferido de bróker el 2024-09-01 y vendido el 2025-06-02.
  - Obtenido: **renta_ordinaria** con costo de mercado de 8.800.000 COP.
  - Esperado: ganancia ocasional (más de 2 años) con el costo original.
- **Fix:** aceptar fecha y costo originales en el traslado. Por ejemplo, un `meta` propio del paquete, o leer `fxRateToBase`, `price` y la fecha original desde `note` mientras no exista contrato. Avisar con `TRANSFER_COST_UNKNOWN`.

### T10 — MEDIA — Se ignora `fxRateToBase` (el tipo de cambio realmente pagado)

- **Evidencia:** `brazil/exterior.ts:200`. El costo de un depósito en USD es `amount × PTAX venda`, aunque la IN 2.180 dice que la divisa comprada tiene como costo "o valor efetivamente pago".
- **Escenario S-BR7:** depósito de US$ 10.000 con `fxRateToBase` de 5,20.
  - Esperado: costo de **R$ 52.000**.
  - Obtenido: **R$ 50.100**.
- En Colombia, usar la TRM es defendible por el Art. 269, así que no lo marco ahí.
- **Fix:** en Brasil, cuando exista `fxRateToBase` y la base sea BRL, usarlo como costo del efectivo.

### T11 — MEDIA — El DARF no se puede pagar desde el producto

No se genera la guía (código de barras o datos para Sicalc). Tampoco se calculan multa por atraso (0,33% diario, con tope de 20%) ni intereses Selic para meses vencidos, y no hay un estado de "pagado / pendiente". Gorila PRO, Investidor10 y la ReVar (Receita y B3, gratuita) sí generan el DARF. **Fix:** agregar `darf.lateFees` usando la fecha de pago, exportar los datos para Sicalc y registrar los DARF pagados como `TAX` para conciliar.

### T12 — MEDIA — Faltan clases de instrumentos

Faltan: opciones y ejercicio, futuros/BM&F, aluguel (tanto el pago al prestador como el corto del tomador), derechos de suscripción, renda fixa/Tesouro/CDB (IR regresivo, tabla que Gorila sí muestra), come-cotas de fondos, Fiagro y cripto (Brasil: exención de R$ 35 mil/mes y GCAP de 15–22,5%; Colombia: activo y ganancia ocasional). Están documentadas como pendientes, pero un usuario real de la B3 las tiene. **Fix:** priorizar en este orden: renda fixa (lectura de la retención en la fuente), opciones y suscripción, cripto.

### T13 — MEDIA — Bens e Direitos incompleta para el exterior

- **Evidencia:** `brazil/bensDireitos.ts:127`. El efectivo en el exterior queda con `localizacao: ''`. No se entregan los campos por activo que pide la DIRPF desde 2025 en el exterior: lucro o prejuízo del año, rendimientos e imposto pago no exterior por bien. Tampoco hay CNPJ: Gorila completa automáticamente el CNPJ de las empresas de la B3.
- **Fix:** asignar ventas e ingresos de `brazilForeignAnnualReport` a cada ítem, agregar el país del custodio para el efectivo y usar una tabla de CNPJ por ticker.

### T14 — MEDIA — Exportaciones y formato para el contador incompletos

Solo existen `colombiaAccountantCsv` y `brazilApuracaoCsv`. Faltan CSV o PDF de proventos, exterior (Lei 14.754) y Bens e Direitos. En Colombia no se indican los **renglones del Formulario 210** ni el formato del Formulario 160 (por país o por activo cuando se superan 3.580 UVT). **Fix:** un `taxPack(year)` por país que devuelva todas las tablas, con un renglón o código DIRPF por línea.

### T15 — MEDIA — No hay simulación ni impuesto sobre lo no realizado

Faltan "¿cuánto pago si vendo hoy?", el margen restante de los R$ 20 mil del mes, la fecha en que cada lote colombiano cumple 2 años y pasa a ganancia ocasional, y la cosecha de pérdidas. El caso central del producto es el seguimiento mensual, y Sharesight ya tiene el *Unrealised CGT report*. **Fix:** agregar `simulateSale(...)` reutilizando los ledgers.

### T16 — BAJA — Colombia: no se evalúan las consignaciones mayores de 1.400 UVT

- **Escenario S-CO5:** depósitos por 80.000.000 COP en 2025, frente a un umbral de 69.718.600.
  - Obtenido: `byIngresosPortafolio = false`, sin una señal propia; solo aparece la nota genérica.
- **Fix:** agregar `byConsignaciones` sumando los `DEPOSIT` del año (Art. 594-3, literal c).

### T17 — BAJA — Art. 36-1: el 3% se calcula por instrumento y no por emisor

`soldInYear` agrupa por instrumento. Debería agrupar por sociedad (por ejemplo, BCOLOMBIA y PFBCOLOM). **Fix:** usar un `issuer` para agrupar.

### T18 — BAJA — Grupamento con fracciones

- **Escenario S-BR10:** grupamento 1:10 sobre 1.005 acciones. Obtenido: **100,5 acciones**, sin aviso del remate de fracciones (*leilão de frações*), que es una venta tributable.
- **Fix:** truncar la cantidad, avisar y aceptar la venta de la fracción.

### T19 — BAJA — Retención de EE.UU.: detección por `instrument.country`

Los ADR y los ETF domiciliados en Irlanda pueden clasificarse mal. Tampoco hay un aviso de **impuesto de sucesiones de EE.UU.** para no residentes con más de US$ 60 mil en activos de EE.UU., que es muy relevante para inversionistas latinoamericanos. **Fix:** usar el domicilio del emisor o el ISIN (prefijo US) y agregar el aviso de *estate tax*.

### T20 — BAJA — Colombia: momento de realización y otros detalles

- Las ventas se reconocen en la fecha de negociación. Para una persona natural no obligada a llevar contabilidad aplica el Art. 27 (se realiza al recibir), lo que importa con liquidación T+2 a fin de año.
- No se calcula el componente inflacionario (Arts. 38–41).
- El GMF estimado sobre los retiros del bróker puede inducir a error.

### T21 — BAJA — JCP 2028 y dedo-duro estimado

- Una fuente indica que LC 224/2025 sube el JCP al 20% desde 2028. La configuración copia el 17,5% marcado `needs-verification`; hay que confirmar y agregar los años 2027 y 2028.
- `apuracao.ts:181-193` **acredita como pagado** el IRRF dedo-duro *estimado* cuando el bróker no lo informa. Eso puede bajar el DARF si nunca se retuvo. Conviene mostrarlo como estimado sin acreditarlo, o pedir confirmación.

---

## Matriz frente a competidores (resumen; el detalle está en el JSON)

| Función | Nosotros | Sharesight | Gorila | Kinvo | Portfolio Performance | Ghostfolio |
|---|---|---|---|---|---|---|
| Apuração mensual B3 (exención de R$ 20 mil, swing/day trade, FII) | sí | no | sí | parcial | no | no |
| Bolsas de pérdidas por categoría | sí | no | sí | parcial | no | no |
| Emisión de DARF (guía pagable, atraso) | parcial | no | sí | parcial | no | no |
| Opciones, futuros, aluguel, corto | no | no | parcial | no | no | no |
| Lei 14.754 (exterior, PTAX, pérdidas, crédito) | parcial | no | parcial | no | no | no |
| Bens e Direitos | parcial | no | sí | sí | no | no |
| Reporte Colombia (patrimonio, F160, 36-1, ganancia ocasional) | parcial | no | no | no | no | no |
| Chequeo de retención de EE.UU. por tratado | sí | parcial | no | no | parcial | no |
| Simulación o impuesto no realizado | no | sí | parcial | no | parcial | no |
| Exportaciones para el contador | parcial | sí | sí | sí | parcial | parcial |

Las celdas de competidores salen de búsquedas web y de conocimiento previo. No pude abrir sus páginas (WebFetch bloqueado), así que las celdas "parcial" de Gorila y Kinvo deben confirmarse.

## Qué haría falta para un 9–10

1. Corregir T1, T2 y T4, con pruebas de regresión que usen exactamente los escenarios de arriba.
2. DARF pagable (con atraso), renda fixa, opciones y simulación de venta (T11, T12, T15).
3. Un "tax pack" por país con renglón del Formulario 210, códigos DIRPF por línea, PDF y XLSX, y conciliación con el informe de rendimentos y los certificados de retención.
4. Colombia completa: impuesto estimado del Art. 241, Art. 254-1, retención esperada, consignaciones y formato del Formulario 160 por país o activo. Con eso sería la mejor herramienta colombiana que existe, porque hoy no hay ninguna.
