# @pm/tax — Reportes tributarios (Colombia, Brasil, EE.UU.)

> **Aviso.** Este paquete produce información **informativa y educativa; no es asesoría tributaria,
> contable ni legal**. Las tarifas, la UVT, los umbrales y los códigos cambian cada año. Antes de
> declarar o pagar, verifique siempre con un contador. Cada reporte incluye `disclaimer` en es/pt/en
> (`TAX_DISCLAIMER`).

Los cálculos parten directamente de `Transaction[]` + `Instrument[]` + `MarketData` (contrato de
`@pm/core`). No dependen del motor de `@pm/core`: los impuestos necesitan su propia contabilidad de
lotes, según las reglas de cada país. Brasil usa preço médio sin importar el método de costo del
portafolio, y Colombia usa costo fiscal PEPS en COP.

Todos los parámetros anuales están en tablas fechadas, por año gravable
(`colombia/config.ts`, `brazil/config.ts`, `us/withholding.ts`). Cada valor tiene un `meta` con
`status: 'verified' | 'needs-verification'`, la fuente legal y la fecha de revisión. Si un año no
está en la tabla, se copian los valores del año más cercano y todos quedan marcados
`needs-verification`. Los reportes agregan además el aviso `PARAMS_NEED_VERIFICATION`.

## Cómo se prueba

```bash
npx vitest run packages/tax      # 152 pruebas con escenarios calculados a mano (regresión: 46 ronda 1, 35 ronda 2, 17 ronda 3)
npx tsc -p packages/tax --noEmit
```

Para pruebas o para quien solo tenga algunas tasas oficiales (TRM, PTAX) existe
`createSimpleMarketData({ prices, fx })`, con relleno hacia adelante, pares inversos y triangulación
vía USD.

---

## Colombia — persona natural residente fiscal

`buildColombiaTaxReport(input, { year, ... })` → `ColombiaTaxReport`
`colombiaAccountantCsv(report)` → CSV "para tu contador" (separador `;`, decimal `,`, BOM UTF-8 para Excel)

| Tema | Regla implementada | Referencia |
|---|---|---|
| Costo fiscal de acciones | Lotes PEPS/FIFO con comisiones incluidas, en COP. Las acciones extranjeras van a la TRM de la fecha de compra. No se aplican los reajustes opcionales de los Arts. 70 y 73 | Arts. 69, 72 ET |
| Patrimonio bruto al 31-dic | Acciones por su costo fiscal; efectivo en COP y en divisas | Arts. 261, 267, 272 ET |
| Activos y efectivo en moneda extranjera | **Por defecto, TRM del reconocimiento inicial** (Ley 1819/2016); la diferencia en cambio solo cuenta al realizarse. Opción `foreignValuation: 'year-end'` para valorar a la TRM del 31-dic (criterio anterior a 2017). Siempre se muestra además el valor de mercado a precio y TRM del 31-dic, como dato informativo | Arts. 269, 288 ET |
| Formulario 160 (activos en el exterior) | Obligación si los activos en el exterior superan **2.000 UVT** al 1-ene del año de presentación (se usa la UVT de ese año). Por encima de **3.580 UVT** se discriminan activo por activo | Art. 607 ET |
| Obligación de declarar | Señales con patrimonio > 4.500 UVT e ingresos ≥ 1.400 UVT, contando solo este portafolio | Arts. 592-594-3 ET |
| Venta de acciones de la BVC | No es renta ni ganancia ocasional si en el año se vende ≤ **3%** de las acciones en circulación (10% hasta 2022). Si no se informa `outstandingShares`, se asume que la venta está por debajo del límite y se avisa con `ART_36_1_ASSUMED`. Las acciones extranjeras listadas en el MGC solo entran con `art361IncludeMgc` | Art. 36-1 ET (Ley 2277/2022) |
| Ganancia ocasional | Tenencia **≥ 2 años** (fecha de venta ≥ fecha de compra + 2 años). Tarifa del **15%** desde 2023 (10% en 2022). Se reportan ingresos, costos y ganancia gravable; las pérdidas se netean dentro del año | Arts. 300, 314 ET |
| Renta ordinaria | Tenencia < 2 años: ingresos y costos que van a la cédula general | Arts. 26, 330, 241 ET |
| Dividendos nacionales | Valor bruto, retención en la fuente (0% hasta 1.090 UVT y 15% sobre el exceso) y descuento del 19% del Art. 254-1 en la configuración. La parte gravada o no gravada (Art. 49) la certifica la sociedad | Arts. 49, 242, 254-1 ET |
| Dividendos del exterior | Valor bruto a la TRM del pago; la retención del exterior es un **descuento tributario**. Con `marginalRate`, el tope es min(impuesto pagado, renta × tarifa marginal). No se estima el descuento indirecto (impuesto de la sociedad extranjera) | Art. 254 ET |
| Intereses | Nacionales o del exterior, con su retención. El componente inflacionario no se calcula | Arts. 38-41 ET |
| Diferencia en cambio realizada | Hay una bolsa de divisas con costo promedio en COP. Se realiza al convertir divisas, al comprar activos con divisas y al pagar comisiones o impuestos en divisas. Los retiros se tratan como traslado a otra cuenta propia, salvo `withdrawalsRealizeFx` | Arts. 269, 288 ET |
| GMF 4x1000 | Estimación informativa de 0,4% sobre los retiros, con nota sobre la exención de 350 UVT/mes y la deducción del 50% | Arts. 871-881, 879, 115 ET |

**Fuente de la renta:** se toma de `instrument.country`. Un activo está "en el exterior" si no cotiza en
la BVC (`XBOG`) y no es un activo colombiano en COP. El efectivo en divisas se considera en el
exterior, salvo con `foreignCashIsAbroad: false`.

---

## Brasil — pessoa física residente

| Función | Qué hace |
|---|---|
| `runBrazilB3Ledger` | Preço médio por ticker (corretagem y emolumentos incluidos), detección de day trade, bonificación, splits, restitución de capital |
| `brazilMonthlyApuracao` | Apuração mensal, pérdidas acumuladas, IRRF, DARF 6015 |
| `brazilApuracaoCsv` | Resumen mensual para el contador |
| `brazilProventosReport` | Dividendos, JCP y rendimientos de FII |
| `brazilForeignAnnualReport` | Apuración anual de la Lei 14.754/2023 (inversiones en el exterior) |
| `brazilBensDireitos` | Ficha "Bens e Direitos" al 31/12 de los dos años, a costo |

| Tema | Regla | Referencia |
|---|---|---|
| Preço médio | Promedio ponderado con costos incluidos; las ventas no cambian el promedio. La bonificación entra al valor por acción que informa la empresa (`price`); si falta, costo 0 y aviso | IN RFB 1.585/2015 art. 58; Lei 9.249/1995 art. 10 |
| Day trade | Compra y venta del mismo activo, el mismo día y en la misma corretora (`account`). Se cruza primero la cantidad coincidente, sin afectar el preço médio. Tarifa del 20% e IRRF del 1% sobre el resultado positivo | IN RFB 1.585/2015 |
| Exención de R$ 20 mil | Solo para ventas de **acciones** en swing trade en el mes. No aplica a ETF, BDR, FII ni day trade. Una pérdida en un mes exento sí se acumula | Lei 11.033/2004 art. 3º I |
| Swing trade | 15% para acciones, ETF y BDR (bolsa "comum") | Lei 11.033/2004 art. 2º |
| FII | 20%, sin exención y con bolsa de pérdidas separada | Lei 8.668/1993 art. 18 |
| Pérdidas | Bolsas separadas: comum, day trade y FII. Una pérdida comum puede compensar day trade, pero no al revés. Se arrastran sin límite de tiempo; `initialLosses` permite cargar saldos anteriores | IN RFB 1.585/2015 |
| IRRF dedo-duro | 0,005% sobre las ventas swing; no se retiene si es ≤ R$ 1. Se usa `taxes` de las ventas si existe; si no, se estima. Lo no compensado se arrastra dentro del año y el saldo de diciembre queda para la DIRPF | Lei 11.033/2004 art. 2º §1º |
| DARF | Código 6015, vence el último día hábil bancario del mes siguiente (feriados bancarios nacionales, Carnaval, Viernes Santo, Corpus Christi y **31/12 sin expediente bancario**). Un valor < R$ 10 se acumula. Datos para Sicalc, estado (pagada, pagada con atraso, pendiente, vencida), multa de 0,33%/día con tope de 20% e intereses Selic + 1% | Lei 9.430/1996 arts. 61 y 68 |
| JCP | IRRF exclusivo del 15% hasta 2025 y del **17,5% desde el 01/01/2026**. Se detecta por la nota "JCP" o por una retención ≈15/17,5%, y se avisa si el IRRF no coincide con lo esperado | Lei 9.249/1995 art. 9º; LC 224/2025 |
| Dividendos | Exentos (linha 09). **Desde 2026**: IRRF del 10% sobre el total si la misma empresa paga > R$ 50 mil en el mes. El IRPFM (> R$ 600 mil/año) solo se menciona, no se calcula. Los dividendos de BDR no son exentos y generan aviso | Lei 9.249/1995 art. 10; Lei 15.270/2025 |
| Rendimientos de FII | Exentos (linha 26) si el fondo cotiza en bolsa, tiene ≥ 100 cuotistas y el inversor tiene < 10% de las cuotas | Lei 11.033/2004 art. 3º III (texto de la Lei 14.754/2023) |
| Exterior (desde 2024) | 15% anual en la DAA. Costo a **PTAX de compra** de la fecha de compra; venta, dividendos e intereses a **PTAX de venta** de la fecha de cobro; impuesto extranjero a PTAX de compra. Las pérdidas compensan ganancias y rendimientos del año y de años siguientes. Crédito del impuesto extranjero ≤ 15% de cada renta y ≤ impuesto debido. El pago es hasta la entrega de la DIRPF (estimado: último día hábil de mayo). Antes de 2024 solo se avisa del otro régimen (GCAP/carnê-leão) | Lei 14.754/2023; IN RFB 2.180/2024 |
| Bens e Direitos | 03-01 acciones (Brasil y exterior, con país), 07-03 FII, 07-09 ETF, 07-08 ETF RF, 04-04 BDR/opciones/derechos, 04-02/04-03 renta fija, 08-0x cripto, 07-99 fondos del exterior, 06-01 cuenta en el exterior (con país). Valores a costo en BRL, nunca a mercado. Para el exterior: resultado, rendimientos e impuesto pagado por bien. CNPJ desde una tabla interna (a verificar) o `cnpjByIssuer` | Programa DIRPF |

`PtaxProvider` acepta la PTAX oficial de compra y de venta. Si no se pasa, se usa
`market.fx(ccy,'BRL')` para ambas y se avisa con `PTAX_FALLBACK`.

---

## EE.UU. — retención a no residentes sobre dividendos

`checkUsDividendWithholding(input, residencia)` compara la retención registrada en dividendos de
emisores de EE.UU. con la esperada: 30% por defecto y la tarifa del tratado cuando existe. La tabla
incluye BR, CO, AR, PE y UY sin tratado (30%), ES, PT, FR, DE, IT, NL, GB, CA, CH, CL… al 15%, y
MX, JP y CN al 10%. Marca `over_withheld` (por ejemplo, falta el W-8BEN), `under_withheld` y
`missing_withholding` (el archivo trae el dividendo neto).

---

## Parámetros que requieren verificación anual

| Parámetro | Estado al 2026-10-05 |
|---|---|
| UVT 2022-2026 (38.004 / 42.412 / 47.065 / 49.799 / **52.374**) | Verificada. 2026: Res. DIAN 000238 del 15-dic-2025. **Agregar la UVT 2027** cuando la DIAN la publique (afecta el Formulario 160 del año gravable 2026) |
| CO ganancia ocasional 15% y regla de 2 años (2026) | **needs-verification**: proyecto de reforma radicado el 20-jul-2026 que propone 4 años de tenencia. La ley de financiamiento 2025 se hundió y el Decreto 1474/2025 quedó sin efectos (C-075/2026) |
| CO Art. 36-1 (3%), Formulario 160 (2.000 / 3.580 UVT), retención de dividendos (1.090 UVT, 15%), GMF | Verificados |
| BR alícuotas 15/20%, exención R$ 20 mil (2026) | **needs-verification** (la MP 1.303/2025 caducó; confirmar que no haya ley nueva) |
| BR JCP 17,5% (2026), IRRF de dividendos 10% > R$ 50 mil | Verificados (LC 224/2025, Lei 15.270/2025) |
| BR compensación de pérdida comum contra day trade | needs-verification (interpretación de la IN 1.585) |
| BR artículo exacto del IRRF day trade del 1% | needs-verification (tarifa correcta, cita pendiente) |
| BR códigos DIRPF: ETF 07-09, BDR 04-04, fondos del exterior 07-99, cuenta en el exterior 06-01, linha 26 de FII, linha 20 de exención | needs-verification en el programa de cada año |
| BR plazo de la DIRPF (pago Lei 14.754) | Estimado como último día hábil de mayo; lo fija la IN anual |
| EE.UU. tabla de tratados | needs-verification (IRS Pub. 515, Tabla 1); entrada en vigor del tratado con Chile |

## Pendientes / limitaciones

- Colombia: el impuesto del Art. 241 es una estimación incremental (requiere `otherCedulaGeneralIncomeCop`)
  que no aplica los límites de los Arts. 336 y 259. Tampoco se calcula el descuento indirecto del Art. 254
  ni los reajustes de los Arts. 70 y 73. De las casillas del Formulario 210 solo se incluyen las
  verificadas (29, 112–115, 127, 132).
- Brasil:
  - No se modelan los ajustes diarios de futuros con posición abierta de un día para otro.
  - En opciones, el ejercicio requiere registrar la operación del activo el mismo día.
  - El IRPFM no aplica el redutor (lucros ya tributados en la empresa).
  - En el régimen anterior a 2024, el carnê-leão de dividendos del exterior solo se informa, no se calcula.
- No se genera el código de barras del DARF: lo emite el Sicalc con los datos exportados.
- No hay PDF en el paquete: la app lo renderiza a partir de `document` (`TaxDocument`). Sí hay XLSX y CSV.
- Los feriados locales (estatales o municipales en Brasil) no se consideran.

---

## Resumo em português

O pacote `@pm/tax` gera relatórios **informativos (não é consultoria tributária)** para:

- **Brasil:**
  - apuração mensal de renda variável na B3: isenção de vendas de ações até R$ 20 mil/mês;
    15% em swing trade (ações, ETF e BDR); 20% em day trade (mesmo dia e mesma corretora) e em FII;
    prejuízos compensados em grupos separados (comum, day trade e FII);
  - IRRF dedo-duro de 0,005% e de 1% no day trade, compensado com o imposto devido; DARF 6015 com
    vencimento no último dia útil do mês seguinte e mínimo de R$ 10 acumulado;
  - preço médio com custos, inclusive na bonificação;
  - proventos: dividendos isentos (IRRF de 10% acima de R$ 50 mil/mês por empresa a partir de 2026,
    Lei 15.270/2025); JCP a 15% até 2025 e 17,5% a partir de 2026 (LC 224/2025); rendimentos de
    FII isentos sob condições;
  - **Lei 14.754/2023**: 15% ao ano sobre ganhos e rendimentos no exterior, com PTAX de compra no
    custo e PTAX de venda na realização, compensação de perdas e crédito do imposto pago no exterior;
  - ficha **Bens e Direitos** a custo de aquisição, com o CNPJ em branco para o usuário.
- **Colômbia:** patrimônio em 31/12 (Art. 269 ET), Formulário 160, Art. 36-1, ganho ocasional
  (≥ 2 anos, 15%), dividendos do exterior com crédito do Art. 254, diferença cambial realizada,
  GMF e CSV para o contador.
- **EUA:** conferência da retenção de 30% ou da alíquota do tratado sobre dividendos.

Os parâmetros ficam em tabelas anuais com fonte e status de verificação. Itens pendentes de
verificação: alíquotas de 2026, códigos da DIRPF de cada ano, compensação de perda comum contra
day trade e a tabela de tratados dos EUA.

---

## Respuesta a la revisión ronda 1

Revisión: `reviews/tax-r1.md`. Cada gap tiene pruebas de regresión en `src/review-r1.test.ts`, la
mayoría con los escenarios exactos del revisor. Sus scripts `s1-colombia.ts` y `s2-brazil.ts` ya
dan los valores esperados.

| Gap | Severidad | Corrección |
|---|---|---|
| T1 | alta | **Art. 153 ET**: cada venta lleva `deductibleCostCop` y `nonDeductibleLossCop`. Solo se netean lotes de una misma venta; una pérdida neta no reduce otras ganancias, ni en ganancia ocasional ni en renta ordinaria. Se reporta "pérdida no deducible" en totales y CSV. S-CO1 → ganancia ocasional gravable 86.000.000 e impuesto 12.900.000; S-CO1b → renta 44.000.000 |
| T2 | alta | `FX_CONVERSION` con origen BRL crea divisa con costo igual a lo efectivamente pagado (`amount + fees`, IN 2.180). Aparece el ítem 06-01 en Bens e Direitos con país. Una salida sin saldo registrado genera aviso `FOREIGN_CASH_NOT_RECORDED`. S-BR6 → US$ 5.400 con costo de R$ 28.080 |
| T3 | media | El 31/12 no tiene expediente bancario: el DARF de noviembre vence el 30/12 (`brazilBankHolidays`) |
| T4 | alta | La venta por encima de la posición abre una **posición corta**; el resultado se reconoce al recomprar. Una venta que nunca se recompra (historial incompleto) **no genera DARF** y produce `openShorts` y el error `SHORT_OR_MISSING_HISTORY`. En Colombia, lo sobrevendido queda `pendiente_costo`, sin impuesto; en el exterior no hay ganancia ficticia. S-BR4 → +R$ 5.000, impuesto R$ 750, sin posición fantasma |
| T5 | media | El umbral de R$ 50 mil de la Lei 15.270 se agrupa por empresa (`issuerKey`: raíz B3 PETR3/PETR4, o `issuers`/CNPJ) |
| T6 | media | Transición de utilidades hasta 2025 aprobadas hasta el 31/12/2025: opción `preLei15270Dividends` o nota ("ref. 2025", "lucros de 2024"). Sin retención esperada; los casos dudosos quedan como `info`, no `warning` |
| T7 | media | Nueva categoría `ETF_RF` (lista de ETF de renta fija y detección por nombre): fuera de la apuração y sin DARF, con aviso de retención en la fuente y Bens e Direitos 07-08 |
| T8 | media | Retención esperada sobre dividendos nacionales (15% sobre lo que exceda 1.090 UVT, acumulada por sociedad) con aviso `CO_DIVIDEND_WITHHOLDING_MISMATCH`. Descuento del Art. 254-1 (19%). Tabla del Art. 241 (`art241TaxCop`) e `impuestoEstimado` incremental con descuentos de los Arts. 254 y 254-1 y retenciones. La tarifa marginal también fija el tope del Art. 254 |
| T9 | media | `TRANSFER_IN` conserva la fecha y el costo originales: opción `transferBasis`, nota estructurada `[costo: AAAA-MM-DD @ precio]` o texto libre ("bought 2019 at 50"; con solo el año se usa el 31-dic y se avisa). Sin datos, aviso `TRANSFER_COST_UNKNOWN`. Aplica en Colombia, la B3 y el exterior |
| T10 | media | En Brasil, `fxRateToBase` de los depósitos en divisas es el costo efectivamente pagado (base BRL, `portfolioBaseCurrency`). S-BR7 → R$ 52.000 |
| T11 | media | DARF con datos para el Sicalc (código, período, vencimiento, principal, multa, juros y total) e instrucciones, estado `paga`/`paga_em_atraso`/`pendente`/`vencida` y conciliación con pagos (`TAX` con "DARF/6015" en la nota, u opción `payments`). `darfLateCharges` calcula la multa (0,33%/día, tope 20%) y los intereses Selic + 1% (`selicMonthly`, serie BCB 4390). Exportación en `brazilDarfCsv`. El código de barras lo emite el Sicalc |
| T12 | media | Opciones (`OPCAO`: 15%, sin exención, day trade y lanzamiento cubierto vía posición corta), derechos de suscripción (`DIREITO`), Fiagro como FII. Renta fija: `brazilRendaFixaReport` con tabla regresiva, IOF < 30 días, exentos LCI/LCA/CRI/CRA y chequeo de la retención. Cripto: `brazilCryptoReport` con exención de R$ 35 mil al mes, GCAP 15–22,5% y DARF 4600 |
| T13 | media | Bens e Direitos: por cada bien del exterior, lucro/prejuízo, rendimentos e imposto pago no exterior; país de la cuenta en el exterior (`foreignCashCountry`, USD → US); CNPJ desde una tabla interna (a verificar) o `cnpjByIssuer`; nuevos códigos para renta fija, cripto, ETF RF, opciones y derechos |
| T14 | media | `colombiaTaxPack`: renglones del Formulario 210 por concepto (las casillas son configurables: cambian cada año), Formulario 160 agregado por país o discriminado por activo por encima de 3.580 UVT, y 3 CSV. `brazilTaxPack`: apuração, DARF, proventos, exterior, Bens e Direitos, renta fija y cripto (7 CSV). El CSV de Colombia ahora incluye Art. 153, retención esperada, Art. 254-1, impuesto estimado, consignaciones y Formulario 160 |
| T15 | media | `simulateBrazilSale` (impuesto si vendo hoy, margen restante de los R$ 20 mil, pérdidas), `brazilExemptionHeadroom`, `brazilUnrealizedReport` (no realizado, impuesto si vendo, candidatos a cosecha de pérdidas), `simulateColombiaSale` (aclara que en Colombia vender con pérdida no genera beneficio, Art. 153) y `colombiaLotMilestones` (fecha en que cada lote pasa a ganancia ocasional) |
| T16 | baja | `obligacionDeclarar.byConsignaciones`: depósitos del año > 1.400 UVT (Art. 594-3) |
| T17 | baja | El 3% del Art. 36-1 se mide por sociedad (BCOLOMBIA + PFBCOLOM, Grupo Aval, Sura, Argos, Cibest, Corficolombiana, Davivienda), con `outstandingShares` por emisor |
| T18 | baja | Grupamento con fracción: la cantidad queda entera y la fracción, con su costo, se separa con el aviso `FRACAO_GRUPAMENTO`. La venta de la fracción (leilão) se acepta como venta tributable |
| T19 | baja | `isUsSource`: emisor en EE.UU. y, si existe ISIN, que sea US (los ADR y los ETF UCITS de Irlanda o Luxemburgo no son fuente EE.UU.). `checkUsEstateTaxExposure`: aviso de impuesto de sucesiones por encima de US$ 60.000 en activos US-situs |
| T20 | baja | Colombia: la venta se realiza en la fecha de liquidación (Art. 27; T+2 en BVC y Europa, T+1 en EE.UU. desde el 28-may-2024), opción `realization: 'trade'`. Componente inflacionario configurable. El GMF solo se estima sobre retiros en COP, con nota de exenciones |
| T21 | baja | Configuración 2027–2028 con JCP marcado `needs-verification` (posible 20% desde 2028). El IRRF dedo-duro **estimado** ya no se abona por defecto (`creditEstimatedIrrf`); se muestra y se avisa con `IRRF_ESTIMATE_NOT_CREDITED` |

Parámetros nuevos que requieren verificación: tabla interna de CNPJ, casillas del Formulario 210,
JCP 2027/2028, exención de cripto (R$ 35 mil, IN 1.888), lista de ETF de renta fija, códigos 04-02,
04-03, 07-08 y 08-0x de la DIRPF, y el tratamiento conservador de la venta en corto (sin exención de
R$ 20 mil).

---

## Respuesta a la revisión ronda 2

Revisión: `reviews/tax-r2.md`. Las pruebas de regresión están en `src/review-r2.test.ts`
(escenarios R1–R11 y C1–C8 del revisor). Los scripts `r2-*.ts` del revisor dan ahora los valores
esperados.

| Gap | Severidad | Corrección |
|---|---|---|
| T22 | alta | **La custodia de cada criptoactivo define su régimen** (`cryptoCustodyOf`). Un exchange brasileño (Mercado Bitcoin, Foxbit, NovaDAX…) sigue el GCAP mensual con DARF 4600. Un exchange extranjero (Binance, Coinbase, Kraken…) o una moneda distinta de BRL pasa a la categoría `FOREIGN`: Lei 14.754, 15% anual con PTAX y pérdidas, y Bens e Direitos 08-xx con país. Con custodia desconocida se muestra el impuesto pero **no se genera el DARF 4600** (`darfBlockedUnknownCustody` y aviso `CRYPTO_CUSTODY_UNKNOWN`). La opción `cryptoCustody` llega a todos los reportes. R10 → sin DARF mensual; Lei 14.754 da R$ 15.000 |
| T23 | media | La venta en corto genera un registro `shortOpen` en el mes de la venta, cuyo valor bruto cuenta para los R$ 20 mil y para la base del IRRF. La recompra no lo vuelve a contar. r2-short20k → ventas R$ 75.000, no exento, impuesto R$ 450 |
| T24 | media | El vencimiento de opciones sale de la letra de la serie (A–L call, M–X put, tercer viernes) o de `optionExpiries`. Sin ejercicio, la posición se cierra en 0: la prima del lanzador tributa y la prima del titular es pérdida. Ejercicio y asignación (`TRANSFER_OUT`/`TRANSFER_IN` con nota "exercício") ajustan la prima al costo o precio del activo el mismo día. Las opciones lanzadas que todavía no vencen se reportan como `info` |
| T25 | media | El patrón de ticker de opción B3 (letra en la 5.ª posición) se aplica antes que `assetClass`. R4 → `OPCAO`, R$ 1.500 |
| T26 | media | `DarfPayment.code` se lee de la nota (6015, 4600, 0211, 0190) y la conciliación exige que coincida. R7 → el DARF 6015 queda `vencida` |
| T27 | media | El Art. 153 se aplica solo a acciones y, por decisión conservadora y documentada, a ETF (`art153AssetClasses` por defecto `['equity','etf']`). Bonos, cripto y fondos compensan pérdidas. C3 → renta 22.000.000 |
| T28 | media | Formulario 210: las ventas del Art. 36-1 de menos de 2 años van a ingresos brutos, INCRNGO y costos (rentas no laborales). Las de 2 años o más van a las casillas 112, 113 y 114 de ganancias ocasionales. C2 → 250M / 50M / 200M, cuadra con la exógena |
| T29 | media | `parseLocaleNumber` entiende los separadores según su posición (1,000.50 y 1.000,50 dan 1000,5). El texto libre solo genera una **propuesta** (`TRANSFER_BASIS_PROPOSED`) que se aplica con `acceptNoteProposals`; los porcentajes se rechazan |
| T30 | baja | `snapRatio` lleva los ratios redondeados a la fracción simple (0,3333 → 1/3), además de ajustar cantidades a menos de 0,01 de un entero. R1 → 100 acciones sin fracción |
| T31 | baja | El JCP usa la tarifa del año de crédito: `jcpCreditDates` o una nota como "declarado/creditado em 12/2025". R8 → 15%, sin aviso |
| T32 | media | `brazilIrpfmEstimate`: base con dividendos, JCP, renta fija gravable, ganancias en bolsa (incluidas las exentas), exterior y otros ingresos; exclusiones de la ley; tarifa lineal de 0% a 10% entre R$ 600 mil y R$ 1,2 millones; deducción de IRRF, DARF, Lei 14.754 e impuesto sobre otros ingresos. Incluido en `brazilTaxPack` (CSV). Sin redutor; `needs-verification` |
| T33 | baja | `brazilTaxPack` reenvía `issuers`, `preLei15270Dividends`, `jcpCreditDates`, `initialLossCarry`, `portfolioBaseCurrency`, `cryptoCustody`, `acceptNoteProposals`, `fundTerms` y los datos del IRPFM |
| T34 | baja | Tabla de CNPJ versionada (`B3_CNPJ_VERSION`) con 9 emisores (todos `needs-verification`), e importación desde el informe de rendimentos con `reconcileBrazil(...).cnpjByIssuer`, que alimenta `cnpjByIssuer` |
| T35 | baja | `SELIC_MONTHLY` incluida: 2024-01 a 2026-09, sin enero de 2026. Se usa por defecto en multa e intereses y `selicMonthly` la sobrescribe. Marcada `needs-verification` (fuentes secundarias) |
| T36 | media | Conciliación con documentos oficiales: `reconcileBrazil` (informe de rendimentos por empresa y tipo, posiciones al 31/12, renta fija, IRRF de bolsa y la pré-preenchida con DARF pagados y rendimientos), `reconcileColombia` (exógena de la DIAN, certificados de dividendos y retención, Deceval) y `reconcileUs1042S`. Importación genérica por CSV con `parseOfficialDocCsv`, `informeFromRows` y `exogenaFromRows` |
| T37 | baja | Escritor XLSX sin dependencias (`toXlsx`: ZIP stored, una hoja por tabla, validado con ZIP y XML) en `colombiaTaxPack.xlsx` y `brazilTaxPack.xlsx`. Modelo de documento `TaxDocument` (resumen con cifras clave, tablas, supuestos y alertas) para que la app genere el PDF |
| T12 | media (persistía) | **Futuros** (WIN, WDO, IND, DOL…, con valor del punto), **aluguel de ações** (tipo `ALUGUEL`, IRRF por tabla regresiva, línea 06), **come-cotas** (`brazilComeCotasReport`, mayo y noviembre, 15%/20%, fondos de acciones exentos), **ejercicio y vencimiento de opciones** (T24), **IRPFM** (T32) y **régimen del exterior anterior a 2024** (`gcapPre2024`: GCAP mensual con exención de R$ 35 mil) |
| T14 | media (persistía) | Casillas verificadas del Formulario 210 (`FORMULARIO_210_CASILLAS` para AG 2024 y 2025: 29, 112–115, 127, 132; las demás se pueden configurar), dividendos separados en primera y segunda subcédula (`dividendosGravados`, Art. 49 par. 2), XLSX y `TaxDocument` |
| T20 | baja (persistía) | Componente inflacionario por año: AG 2023 66,71%, AG 2024 50,88% (Decreto 771/2025), AG 2025 55,43% (Decreto 898/2026). `settlementDate` usa los feriados de Colombia (Ley Emiliani) y de la NYSE |

Parámetros nuevos que requieren verificación:
- tabla Selic mensual;
- casillas no confirmadas del Formulario 210;
- IRPFM (redutor y reglamentación);
- lista de exchanges de cripto brasileños y extranjeros;
- valor del punto de futuros;
- CNPJ;
- componente inflacionario de 2025 (verificado en fuentes secundarias).
