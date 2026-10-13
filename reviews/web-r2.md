# Revisión web — ronda 2 (`apps/web`)

- Revisor: agente revisor (solo lectura).
- Fechas: 9–12 de octubre de 2026.
- Scripts, capturas y PDFs: `RW = /tmp/claude-0/-home-user-Portfolio-Manager-Herramienta/8b757dea-bb3a-58bd-aa07-26758394d338/scratchpad/review-web/`. Los scripts son `r2-1…r2-9.mjs` y las capturas están en `RW/shots2/`.

## Veredicto

**No aprobado, aunque el avance es grande.** De las 20 brechas de la ronda 1 hay **17 cerradas** (15 verificadas a mano en la app real, W13 con defectos nuevos y W17 cubierta solo por la prueba e2e) y 3 parciales (W10, W12, W20).

- La página **Informe/PDF** ya es de nivel profesional.
- La tabla mensual cabe a 1440 px y en el teléfono usa tarjetas.
- Hay rentabilidad real (IPC) y % del IBR.
- El CDT se valora por causación y muestra el valor neto de retención.
- Hay precio sugerido con aviso de desviación y comparación con la TRM.
- Hay alertas, metas, lista de seguimiento, rebalanceo y bandeja de eventos corporativos.

Pero al usar el flujo de **primer uso**, como lo haría un inversionista nuevo, aparecieron **dos errores graves de integridad de datos**:

- **W21**: la primera compra del asistente cae en un **segundo portafolio** creado sin aviso.
- **W22**: el aporte inicial siempre queda con fecha de hoy. Si el usuario registra compras anteriores, los **aportes se inflan un 60 %**, aparece **efectivo fantasma de 100 millones** y el valor total sale **55 % más alto que el real**, sin ningún diagnóstico.

Con brechas altas abiertas no se puede aprobar.

| | Puntaje |
|---|---|
| **Portafolio Pro web (nuestro)** | **7,3 / 10** (ronda 1: 6,0) |
| **Mejor competidor: Sharesight** | **8,0 / 10** |

- Kubera (7,5) gana en sincronización y en la vista de patrimonio total.
- Gorila y Kinvo (≈7,5) ganan en conexión automática con B3 y en apps nativas.
- Snowball (≈7) gana en dividendos y calendario.
- Ghostfolio (≈7) es más simple y tiene X-Ray.

Si se corrigen W21 y W22 y se pulen W23–W26, el puntaje sube a ≈8 y la app compite de igual a igual.

## Cómo se probó

- **Typecheck, pruebas y build**: `npm run typecheck -w @pm/web` sin errores (9-oct) y `npm test -w @pm/web` con **54/54** pasando. No volví a correr los 23 e2e del constructor; usé mis propios scripts.
- **Typecheck roto por otro paquete**: más tarde, `tsc` falló dentro de `packages/tax/src/brazil/classify.ts:362`, que otro agente estaba editando en ese momento. No es de la web, pero ese día `npm run build -w @pm/web` falla.
- **`npm run dev:web` + `npm run dev:server`**: los arranqué como se pidió, pero otros agentes editaban `packages/*` en paralelo.
  - Hubo 6 recargas completas por HMR y 7 reinicios del servidor en minutos.
  - Esas recargas cerraban los diálogos a mitad de un flujo: falso positivo, ya descartado.
- **Montaje estable**: para medir sin ese ruido hice un build con `vite build --outDir RW/dist2`, servido con `vite preview` en :4187. El servidor de datos corrió sin `watch` en :8797 con `CORS_ORIGIN=http://localhost:4187`. Los datos eran reales de Yahoo, TRM e IPC/IBR, con Chromium de `/opt/pw-browsers`.
- **Flujo real** (perfil `r2a`):
  - asistente de inicio en COP (residencia CO, Trii, aporte de 100 M);
  - ECOPETROL (BVC), cambio COP→USD, AAPL, cambio COP→BRL, PETR4 (B3), cambio COP→EUR, ASML (Euronext) y un CDT al 11,2 % E.A. a 360 días;
  - importación de `extracto-trii.csv`;
  - cierre de mes con un FIC manual;
  - tabla mensual en COP, BRL y USD;
  - Informe, PDF e instantánea HTML;
  - modo oscuro, pt y en;
  - teléfono a 390 px, incluido un segundo asistente en BRL (perfil `r2b`).
- **Servidores detenidos** al terminar.

### Consistencia de cifras (verificada)

| Comprobación | Cálculo | Resultado |
|---|---|---|
| Valor total en las tres monedas | COP 168.005.529 / USD 52.195,89 = 3.218,75; efectivo USD 31.067,96 por 100 M COP = 3.218,75 | ✓ |
| CDT por causación | 20 M × 1,112^(250/365) = 21.508.425 | ✓ |
| Valor neto del CDT | retención del 4 % sobre 1.508.425 = 60.337 → 21.448.088 | ✓ |
| Redención del CDT | 22.150.400 netos de 89.600 | ✓ |
| Rentabilidad real (Informe) | 1,0877 / 1,0570 − 1 = **+2,90 %** | ✓ |
| % del IBR | 8,77 / 8,36 = **105 %** | ✓ |
| Total de la tabla mensual | (1 + 14,97 %)(1 − 5,42 %) − 1 = +8,74 %, frente a una TWR de 8,77 % | ✓ (multiplicativo) |
| Efectivo COP tras corregir el aporte | 100 M − 2,08 M − 20 M − 10 M − 8 M − 20 M − 0,1423 M (conversión implícita de EUR) = 39.777.700 | ✓ |

## Brechas de la ronda 1: estado

| ID | Estado | Evidencia |
|---|---|---|
| W1 | **Cerrada** | Enter rápido con «ECOPETROL» espera los resultados y elige BVC; no se abrió el editor manual (`r2-2`). |
| W2 | **Cerrada** | `/informe`: portada, KPIs, gráfico con «aportado + IPC», mapa de calor, tabla completa de 13 columnas, distribución, posiciones, dividendos, precio/divisa y metodología. PDF A4 horizontal limpio (`shots2/e02-informe.pdf`, `e03-mensual.pdf`) e instantánea HTML descargable. Queda W23 (barras vacías). |
| W3 | **Cerrada** | Vista «Esencial» a 1440 px con `scrollWidth` 1130 = `clientWidth` (`c05-monthly-COP.png`), selector de columnas y modo compacto; en el teléfono, tarjetas por mes sin scroll horizontal (`f-phone-light-mensual.png`). |
| W4 | **Cerrada** | Rentabilidad real frente al IPC, % del IBR y aportado + inflación (Resumen, Rendimiento, Informe). CDT con causación. |
| W5 | **Cerrada** | Un FIC manual comprado el 1-jul aparece como «3 meses con cierre pendiente (jul, ago, sept)». Empieza por julio y el Resumen avisa (`j01-cierre-fic.png`). |
| W6 | **Cerrada** | ECOPETROL: precio sugerido 2.065 y aviso «difiere −9,0 % del cierre del 13 de ene». Cambio COP→USD: «difiere −6,1 % de la TRM del día 3.757,59». Atajo N, «Agregar y nuevo» y duplicar. Ver W25 (mensaje erróneo). |
| W7 | **Cerrada** | Cajón móvil: 25 de 25 tabulaciones dentro del diálogo; Escape lo cierra y el foco vuelve a «Abrir menú». |
| W8 | **Cerrada** | Se compara año corrido con año corrido (verificado en el código y en la página). |
| W9 | **Cerrada** | «Anualizada: —» para menos de un año; la TIR muestra «en el periodo». |
| W10 | **Parcial → baja** | Hay respaldo cifrado e instantánea HTML de solo lectura, pero no hay sincronización ni enlace vivo como en Kubera o Sharesight. |
| W11 | **Cerrada** | Alertas (con Notification API), lista de seguimiento, objetivos y rebalanceo en Posiciones, y metas con proyección. |
| W12 | **Parcial → baja** | El calendario existe y la bandeja muestra 8 dividendos del proveedor (PETR4, AAPL con 30 % sugerido, ASML). Pero «Próximos» del Resumen dice «Sin pagos estimados en 75 días» con AAPL y PETR4 en cartera, y el único próximo es ISA estimado para jul-2027. |
| W13 | **Cerrada con defectos** | Hay asistente de 3 pasos, «Primeros pasos x/5» y datos de ejemplo congelados, pero el flujo introduce W21 y W22. |
| W14 | **Cerrada** | KPIs en dinero, «TWR = precio × divisa (1 + 14,97 %) × (1 − 5,42 %) − 1» y cascada. |
| W15 | **Cerrada** | La importación muestra comisiones (14.280) y retención (8.400) y completa los nombres («Interconexión Eléctrica S.A.»). |
| W16 | **Cerrada** | El buscador muestra BVC, B3, NASDAQ y Euronext Ámsterdam. |
| W17 | **Cerrada (sin reprobar a mano)** | Cubierta por `regression-r1.spec.ts`. |
| W18 | **Cerrada** | Cabecera compacta en el teléfono (el nombre del portafolio se trunca a «Inversiones», aceptable). |
| W19 | **Cerrada** | Cada gráfico tiene resumen textual y «Ver datos». |
| W20 | **Parcial → baja** | Ver W20 abajo. |

## Mejor que la competencia (ahora)

1. **Seguimiento mensual**: mapa de calor Nominal/Real, tabla con efecto precio y efecto divisa, índice y diferencia, columnas configurables y tarjetas en el teléfono. Ninguno de los seis competidores lo tiene completo.
2. **Informe PDF / HTML**: incluye «aportado + IPC», rentabilidad real, % del IBR y metodología. Está al nivel del reporte de rendimiento de Sharesight y por encima en el contexto de Colombia y Brasil.
3. **Renta fija colombiana**: CDT por causación con valor neto estimado de retención en la fuente y redención automática estimada.
4. **Captura de datos**: precio de cierre sugerido, aviso de desviación del precio y de la tasa frente a TRM/PTAX, y bandeja de eventos corporativos del proveedor que solo se aplican si el usuario confirma. Es mejor que Kubera y Ghostfolio, y comparable a Sharesight.
5. **Local-first + PWA + modo privado + tres idiomas + impuestos de Colombia y Brasil**: nadie más reúne todo.

## Peor que la competencia (ahora)

1. **Primer uso con errores de integridad** (W21, W22). Sharesight y Kubera no dejan el portafolio en un estado incoherente desde el primer día.
2. **Sin sincronización ni enlace vivo**. Kubera, Sharesight, Gorila y Kinvo sincronizan entre dispositivos.
3. **Sin conexión automática con corredores ni con B3**. Gorila y Kinvo leen B3; Sharesight lee más de 200 corredores.
4. **Dividendos próximos casi vacíos** para acciones de EE. UU. y Brasil. Snowball y Kinvo tienen un calendario completo, con fechas ex y de pago.
5. **Pulido**: diagnósticos en inglés crudo, barras vacías en el Informe, «—» en el cambio del día y fuentes con estado «falló» sin explicación.

## Brechas abiertas

### W21 — alta — La primera compra del asistente se guarda en un portafolio nuevo creado sin aviso

**Pasos** (perfil `r2b`, 390 px; también ocurre en escritorio):
1. Empezar mi portafolio.
2. Nombre «Carteira BR» en BRL.
3. Aporte de 50.000.
4. «Registrar una compra».
5. Comprar ITUB4 sin tocar el selector de portafolio.

**Resultado**: el selector viene en «**+ Nuevo portafolio «Mi portafolio»**» (`shots2/i03-phone-onb-buy.png`). Al guardar quedan dos portafolios: «Mi portafolio» con la compra y «Carteira BR» con el aporte (`r2-8.mjs`: `portfolios ['Todos (2)', 'Mi portafolio', 'Carteira BR', …]`). El mismo error aparece con cualquier enlace directo a `/movimientos?nuevo=1` en una carga en frío (`r2-7.mjs`: «deeplink portfolio default = + Nuevo portafolio»).

**Causa**:
- `src/components/TransactionForm.tsx:63-68`: cuando el formulario se abre, la consulta viva de portafolios todavía está vacía, así que el valor por defecto es `NEW_PORTFOLIO`. Como `NEW_PORTFOLIO` siempre es «válido», nunca se corrige.
- `src/components/Onboarding.tsx:172` navega directo a `?nuevo=1`.

**Corrección**:
- Inicializar el portafolio cuando `portfolios` cargue, si el usuario no lo ha tocado.
- Nunca preseleccionar «Nuevo portafolio» si existe uno real.
- Agregar una prueba e2e del flujo asistente → compra.

### W22 — alta — El aporte inicial siempre lleva la fecha de hoy y las compras anteriores generan aportes y efectivo fantasma sin aviso

**Pasos** (`r2-1`…`r2-3`):
1. En el asistente, aporte de 100 M sin campo de fecha (`Onboarding.tsx:56` usa `todayIso()`).
2. Registrar compras y cambios de divisa de enero a abril de 2026.

**Resultado** (`c05-monthly-COP.png`, `c04-pos-COP.png`):

| Cifra | Con el aporte con fecha de hoy | Real (aporte corregido a 5-ene) |
|---|---|---|
| Aportes | ene +2,08 M, feb +40 M, mar +10 M, abr +8,14 M, oct +100 M = **160,2 M** | 100 M |
| Efectivo COP | **100.000.000** | 39.777.700 |
| Valor total | **168,0 M** | 108,8 M |

El panel «Diagnóstico del motor» solo muestra «1 nota» (la redención del CDT). Las compras sin efectivo se registran como `IMPLICIT_DEPOSIT` sin ninguna advertencia, porque `packages/core/src/ledger.ts` solo emite diagnóstico para retiros. El EUR negativo (−33,40) también se cubrió en silencio con una conversión implícita.

**Corrección**:
- campo de fecha en el aporte inicial, con «¿desde cuándo inviertes?»;
- en la web, aviso visible de «aportes implícitos» por mes (columna o insignia en la tabla mensual y entrada en Diagnóstico), con un botón «crear aporte en esa fecha»;
- pedirle a core un diagnóstico `IMPLICIT_DEPOSIT` de tipo `warning` también para compras.

### W23 — media — Las barras de distribución del Informe salen vacías (pantalla, PDF y HTML)

`src/pages/Report.tsx:253` pinta el relleno con un `<span class="f" style="width:…">`. La regla CSS de `:57-58` no le da `display:block`, así que un `span` en línea ignora `width` y `height`. En el PDF (`shots2/e02-informe.pdf`, página 3) las barras de Clase, País y Divisa son grises y vacías. Además, el último rótulo del eje del gráfico se corta («09/10/2»).

**Corrección**: `display:block` en `.f` y margen derecho en el eje.

### W24 — media — Los diagnósticos del motor salen en inglés crudo y sin formato en la interfaz en español

Ejemplo (`c02-movimientos-diag.png`):

> «Redención al vencimiento MANUAL:CDT-BANCOLOMBIA-360-DIAS redeemed automatically (estimated) for 22150400.00 COP net of an estimated 89600.00 withholding; record the real payment to replace it».

Muestra el id interno, números sin separador de miles y texto en inglés.

**Corrección**: traducir por `code` con parámetros estructurados y formatear con `formatMoney`.

### W25 — baja — Precio vacío muestra «No puede ser negativo»

Al guardar una compra sin precio, el error dice «No puede ser negativo.» (`r2-3`, `txValidation.ts:51-59` → `validation.positive`).

**Corrección**: mensajes distintos para «obligatorio» y «mayor que cero».

### W26 — media — «Hoy» y «Mayores movimientos» con fechas incoherentes

- Con precios frescos (Actualizado hace 3 minutos; precios del 08 y 09/10), la KPI «Valor total» muestra «—» en lugar del cambio del día (`e30-dark-.png`).
- «Mayores movimientos» dice «Último cierre disponible (30 de sept de 2026) vs. el anterior», pero mezcla activos con cierres de distintas fechas. El subtítulo toma `movers[0].date` (`Dashboard.tsx:191`; `analysis.ts:450-475`) y los activos manuales o importados con último punto a fin de mes arrastran esa fecha.

**Corrección**:
- una fecha por fila;
- excluir los activos manuales;
- calcular el cambio del día con la última fecha común.

### W27 — baja — «Frescura de datos» muestra una fuente «indices — falló» sin explicación

Aparece en minúscula y sin traducir, sin decir qué índice falló ni qué impacto tiene (`e30-dark-.png`).

### W28 — baja — Errores del servidor mal explicados

- Un **403 de CORS** se muestra como «Servidor de precios no disponible… inicia el servidor» (`r2-2`, puerto no permitido).
- Un **429 (rate limit)** se alcanzó con unas 15 recargas en un minuto (`r2-6`).
- En los dos casos el usuario recibe un consejo equivocado.

**Corrección**: mostrar el código y el mensaje del servidor (FORBIDDEN_ORIGIN, RATE_LIMITED) y espaciar la actualización automática al abrir.

### W29 — baja — Sharpe y Sortino usan una tasa libre de riesgo fija del 4 % para cualquier moneda

Con COP (IBR ≈ 8–9 %) el Sharpe de 0,87 se infla (`db/repo.ts:67`).

**Corrección**: tomar por defecto la tasa de referencia de la moneda (IBR/CDI/SOFR/€STR), que ya está en el servidor.

### W10 — baja (antes media) — Sin sincronización ni enlace vivo de solo lectura

El respaldo cifrado y la instantánea HTML mitigan, pero no igualan a Kubera o Sharesight.

### W12 — baja (antes media) — «Próximos dividendos» vacío para AAPL, PETR4 y ASML

El calendario del Resumen y de Dividendos no proyecta los pagos recurrentes conocidos de AAPL y PETR4 a partir de los eventos del proveedor, que ya aparecen en la bandeja.

### W20 — baja (antes baja) — El primer render del Resumen sigue descargando ~1,4 MB de JS

El `index` pesa 193 kB, pero el Resumen carga 1.388 kB de JS sin comprimir (charts 674 kB, app 115, useData 116, marketData 164, worker 96; `r2-9.mjs`). Los iconos del manifiesto son solo SVG, sin PNG 192/512 ni `apple-touch-icon` para iOS.

## Matriz

Ver `web-r2.json`. Competidores según la documentación pública citada en la ronda 1 y conocimiento previo, sin verificación en vivo en esta ronda.
