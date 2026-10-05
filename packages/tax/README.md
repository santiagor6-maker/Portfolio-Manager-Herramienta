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
npx vitest run packages/tax      # 54 pruebas con escenarios calculados a mano
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
| DARF | Código 6015, vence el último día hábil del mes siguiente (feriados bancarios nacionales, Carnaval, Viernes Santo y Corpus Christi). Un valor < R$ 10 se acumula para los meses siguientes | Lei 9.430/1996 art. 68 |
| JCP | IRRF exclusivo del 15% hasta 2025 y del **17,5% desde el 01/01/2026**. Se detecta por la nota "JCP" o por una retención ≈15/17,5%, y se avisa si el IRRF no coincide con lo esperado | Lei 9.249/1995 art. 9º; LC 224/2025 |
| Dividendos | Exentos (linha 09). **Desde 2026**: IRRF del 10% sobre el total si la misma empresa paga > R$ 50 mil en el mes. El IRPFM (> R$ 600 mil/año) solo se menciona, no se calcula. Los dividendos de BDR no son exentos y generan aviso | Lei 9.249/1995 art. 10; Lei 15.270/2025 |
| Rendimientos de FII | Exentos (linha 26) si el fondo cotiza en bolsa, tiene ≥ 100 cuotistas y el inversor tiene < 10% de las cuotas | Lei 11.033/2004 art. 3º III (texto de la Lei 14.754/2023) |
| Exterior (desde 2024) | 15% anual en la DAA. Costo a **PTAX de compra** de la fecha de compra; venta, dividendos e intereses a **PTAX de venta** de la fecha de cobro; impuesto extranjero a PTAX de compra. Las pérdidas compensan ganancias y rendimientos del año y de años siguientes. Crédito del impuesto extranjero ≤ 15% de cada renta y ≤ impuesto debido. El pago es hasta la entrega de la DIRPF (estimado: último día hábil de mayo). Antes de 2024 solo se avisa del otro régimen (GCAP/carnê-leão) | Lei 14.754/2023; IN RFB 2.180/2024 |
| Bens e Direitos | 03-01 acciones (Brasil y exterior, con país), 07-03 FII, 07-09 ETF, 04-04 BDR, 07-99 fondos/ETF del exterior, 06-01 cuenta en el exterior. Valores a costo en BRL, nunca a mercado. El CNPJ queda vacío para el usuario | Programa DIRPF |

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

- Colombia: no se calculan la tabla del Art. 241 (impuesto total de la cédula general), el componente
  inflacionario, el descuento indirecto del Art. 254 ni los reajustes de los Arts. 70 y 73.
- Brasil: falta el régimen del exterior anterior a 2024 (GCAP con exención de R$ 35 mil y
  carnê-leão), así como opciones, futuros, aluguel, Fiagro, IRPFM y carnê-leão de dividendos de BDR.
- Los feriados locales no se consideran para el vencimiento del DARF.

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
