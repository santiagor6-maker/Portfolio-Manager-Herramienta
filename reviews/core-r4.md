# Revisión del motor de cálculo (`packages/core`), ronda 4

Revisor externo. Solo lectura sobre el código. Fecha: 2026-10-08.
Base: `reviews/core-r3.md` y la sección "Respuesta a la revisión ronda 3" de `packages/core/README.md`.

## Veredicto

**Aprobado.** El motor supera ahora a la mejor herramienta para este caso y no queda ningún hallazgo
de severidad alta.

- **C36 (cupones contados dos veces):** resuelto en lo esencial. Un CDT de interés trimestral da TWR
  11,1 %, el bono con cupón vale 1.097,58 y la caja al vencimiento es 11,155 millones.
  Un bono amortizable no se cuenta dos veces, registre el usuario la amortización como
  `RETURN_OF_CAPITAL` o como venta parcial. En una NTN-B (IPCA+6 %), el valor después del cupón
  queda a 0,1 % del VNA.
- **C37, C39, C40 y C41:** resueltos.
- **C38:** resuelto para el cambio de ticker simple, pero sigue fallando en la cadena fusión →
  cambio de ticker.

Las pruebas adversariales nuevas encontraron cuatro bordes, todos medios o bajos:

- un cupón sobre unidades vendidas entre la fecha de registro y la de pago;
- un cupón mayor que el interés devengado;
- un interés registrado neto sin el campo `taxes`;
- precios de operación sin confirmar que se aceptan sin un tope y sin avisar en las filas.

Ninguno invalida el motor, pero conviene cerrarlos.

| | Puntaje (0–10) |
|---|---|
| **Nuestro motor (`@pm/core`)** | **8,3** (5,5 → 7,0 → 7,8 → 8,3) |
| **Mejor competidor para este caso: Portfolio Performance** | **8,0** |

`approved = true`: el puntaje supera al del competidor y no hay hallazgos altos.

Comprobaciones hechas:
- `npx vitest run packages/core`: 203/203 pruebas pasan. `npx tsc -p packages/core --noEmit` no da
  errores.
- Volví a ejecutar los 16 scripts de las rondas 1–3 con `TZ=America/Bogota`. Todo pasa, salvo los
  esperados ya aceptados como cambios de diseño (S2a, S2b, F1, F4).
- Escribí `r4-a.ts` (renta fija) y `r4-b.ts` (atípicos, posiciones y caché), y ejecuté `r4-b.ts` con
  `TZ=Pacific/Kiritimati`. Todos los scripts están en
  `/tmp/claude-0/-home-user-Portfolio-Manager-Herramienta/8b757dea-bb3a-58bd-aa07-26758394d338/scratchpad/review-core/`.

---

## Arreglos verificados (5)

| ID | Verificación independiente |
|---|---|
| C36 | **H1:** CDT trimestral, total 11.110.902 y TWR 11,1 %. **H2:** bono con cupón, 1.048,77 + 48,81 = 1.097,58. **G3c:** interés registrado al vencimiento, caja 11.155.478 con `INTEREST_ALREADY_RECORDED`. Pruebas nuevas: **J1a/J1b** bono amortizable (50 % amortizado como `RETURN_OF_CAPITAL` o como venta parcial a la par) deja 500 exacto y un total de 1.048,67; **J3** cupón sobre una posición ya vendida, sin efecto sobre una recompra posterior (1.008) y con `INCOME_WITHOUT_POSITION`; **J5** NTN-B IPCA+6 % con cupón semestral del 2,956 % sobre el VNA: valor ex-cupón 4.100,58 frente a un VNA de 4.096,97 (0,09 %), y TWR a 1 año 10,48 % neto del IR del cupón. *Ver C42 y C43.* |
| C37 | **G4:** fondo +40 % real, valor 15.400 y TWR 40 %. **G4b:** BTC +45 %, 45 %. **R2:** el error de digitación con cierre posterior sigue rechazado. **T5:** un error ×3 en cripto con cierre posterior se rechaza, aun con la tolerancia doble. *Ver C44.* |
| C39 | **G3a:** pago registrado 8 días hábiles tarde. Caja 11.152.000, con `LATE_REDEMPTION` y sin `OVERSELL`. |
| C40 | **H3:** una LCI exenta tiene neto = bruto, impuesto 0 y `totalNetMarketValueBase` presente. Con CDB y LCI mezclados, el total líquido también es correcto. |
| C41 | **H5:** un `MarketData` propio sin `revision` ve la cotización nueva (1.500). El hash de 30.000 movimientos baja a 7,6 ms (antes 24,5). Siguen detectándose las ediciones en sitio: la tasa del devengo de un instrumento (K1) y `options.filter.accounts` modificado con `push` (K2). El tablero de 11 resúmenes con 30.000 movimientos tarda 0,83 s. |

## Comparación con los competidores

**Por qué ahora supera a Portfolio Performance (8,0) para un inversionista de Colombia o Brasil:**
1. **Renta fija completa.**
   - Devengo (CDT E.A., CDB % CDI, IPCA+, prefixado) con calendarios ANBIMA y de festivos colombianos.
   - Cupones y amortizaciones.
   - Vencimiento al día hábil siguiente.
   - Valor bruto y líquido (IR regresivo, IOF, retención del 4 %).

   PP no tiene nada de esto. Gorila y Kinvo sí, pero solo en BRL.
2. **Multi-divisa real**, con TWR mensual separado en local y divisa, y divisa en dinero en ventas
   realizadas, no realizadas y caja. Sharesight separa la divisa en dinero, pero no en el TWR mensual.
3. **Cascada en dinero que cuadra al peso**, con residuos nombrados.
4. **% del CDI, retorno real con IPC/IPCA estimado y marcado**, y benchmarks de precio, retorno total
   y tasa.
5. **TWR con el día partido en la operación**, correcto con precios de fin de mes, splits,
   reestructuraciones y flujos el mismo día.
6. **Calidad de datos:** diagnósticos con severidad, FX faltante, precios viejos, atípicos, rutas FX
   por frescura y caché segura.

**Dónde sigue por debajo:**
- **Sharesight y Gorila aplican las acciones corporativas automáticamente**; nosotros solo las
  sugerimos y el usuario las confirma.
- **Gorila y Kinvo concilian la renta fija con los extractos de B3/CETIP.**
- **PP y Sharesight son más maduros por posición en reestructuraciones** (C38).

---

## Hallazgos abiertos

### C38 (persiste) — MEDIA — TWR por posición incoherente en la cadena fusión → cambio de ticker
- **Dónde:** `positions.ts`, tramo de entrega al inicio del día. Cuando el valor entregado (el cierre
  propio de la empresa de origen **el día del cambio**) difiere del cierre anterior, el denominador
  `prev + startIn − startOut` queda degenerado y el tramo vale 0.
- **Evidencia (P1, escenario K5):** B recibe 980 en la fusión (último cierre 196) y el día del cambio
  de ticker su propio precio es 200, así que entrega 1.000. Resultado: **B gana +20 en dinero con TWR
  0 %**. Lo correcto es +2,04 %. La suma por posición sí cuadra con el portafolio (70 = 70). El caso
  simple G2 ya funciona.
- **Arreglo:** en una entrega al inicio del día, el tramo de la empresa de origen es
  `r = startOut / V(f−1) − 1` (el valor entregado es su valor final), y el de la resultante
  `r = V(f) / startIn − 1`. Agregar P1 como prueba de consistencia: si no hay flujos externos, el signo
  del TWR debe coincidir con el del retorno en dinero.

### C42 — MEDIA (nuevo) — La reducción por cupón no tiene límite: puede comerse el principal sin aviso
- **Dónde:** `ledger.ts:1033-1047` (`payCoupon`). Reparte el cupón bruto entre las unidades **que se
  tienen el día del pago**. Solo avisa si el cupón supera el **valor total** del lote, no el interés
  devengado.
- **Evidencia (`r4-a.ts`):**
  - **J2.** Se tienen 2 unidades de un TES, se vende 1 entre la fecha de registro y la de pago (ex-cupón),
    y el cupón de las 2 unidades se paga al titular registrado. A la unidad que queda se le restan
    **los dos cupones**: vale **951,33 en vez de 1.000**, sin diagnóstico.
  - **J4.** Un interés de 5 antes del inicio del devengo (`issueDate`) se descuenta del principal:
    995, y un año después **1.094,50 en vez de 1.100**, sin diagnóstico.
- **Arreglo:**
  - Limitar la reducción por unidad al interés devengado desde el último ancla (más el devengado que se
    compró, si la compra fue a precio sucio).
  - Asignar el cupón a las unidades que había en la fecha ex/registro (con
    `CorporateAction.exDate` o una ventana de días hábiles).
  - El exceso sobre el interés devengado es ingreso, no reducción del principal, y debe avisar
    `COUPON_EXCEEDS_ACCRUED_INTEREST`.

### C43 — BAJA (nuevo) — Un interés registrado neto, sin el campo `taxes`, deja interés devengado fantasma
- **Evidencia (J6):** CDT de 10 millones al 12 %. Si el usuario registra el interés mensual neto
  (96 %) sin `taxes`, después del pago la posición vale **10.003.869**. El 4 % retenido queda como
  interés devengado que nunca se paga; se acumula en unos 46.000 por año y en la redención
  automática se paga otra vez. Es frecuente: muchos usuarios anotan "lo que me llegó".
- **Arreglo:** para instrumentos con `CO_RETENCION`/`BR_IR_REGRESSIVE`, si falta `taxes`, inferir
  el bruto como `neto / (1 − tasa)` y avisar `INTEREST_NET_ASSUMED`, o restar el devengado completo
  del periodo y registrar la diferencia como retención estimada.

### C44 — MEDIA (nuevo) — Los precios de operación "sin confirmar" se aceptan sin tope y el aviso no llega a las filas ni al resumen
- **Dónde:** `ledger.ts`, detector de atípicos. Sin un cierre posterior en 62 días, la observación se
  acepta con cualquier desviación; con una referencia anterior de más de 400 días no se valida nada.
- **Evidencia (`r4-b.ts`):**
  - **T1.** Error ×10 en el mes en curso: **TWR MTD +900 %**, valor 1.010.000 en vez de 101.000. El
    aviso `TRADE_PRICE_UNCONFIRMED` solo aparece en `ledgerDiagnostics`; **`PerformanceSummary.warnings`
    queda vacío**.
  - **T2.** Error ÷10 en una venta con el siguiente cierre a 71 días: **febrero −90 %**.
  - **T3.** Fondo con precio anual y un error ×10 tras 14 meses: valor ×10 **sin ningún
    diagnóstico**.
  - **T4.** Al revés, una caída real del −52 % con precios diarios sale marcada como
    `TRADE_PRICE_UNCONFIRMED` aunque el cierre siguiente la confirma: un falso positivo inofensivo.
- **Arreglo:**
  - Banda dura (p. ej. ×3 o ÷3 frente a la referencia): no se usa hasta que el usuario la confirme,
    aunque no haya cierre posterior.
  - Propagar `TRADE_PRICE_UNCONFIRMED` y `TRADE_PRICE_OUTLIER` a `MonthlyRow.warnings` y
    `PerformanceSummary.warnings`.
  - Con referencias de más de 400 días, aplicar la banda dura en lugar de omitir la validación.
  - No marcar cuando el cierre siguiente confirma el precio.

---

## Recomendaciones para la ronda 5 (no bloquean)

1. C44 y C42: proteger la valoración contra errores de captura y contra cupones mal asignados.
2. C38: tramo de entrega al inicio del día.
3. C43: interés neto sin retención.
4. Fuera del motor, para superar a Sharesight y Gorila: aplicar automáticamente (con deshacer) las
   acciones corporativas de alta confianza y conciliar con los extractos de B3/CETIP y deceval.
