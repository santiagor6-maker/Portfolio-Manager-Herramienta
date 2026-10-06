# Revisión web — ronda 1 (`apps/web`)

Revisor: agente revisor (solo lectura). Fecha: 5–6 de octubre de 2026.
Capturas y scripts: `/tmp/claude-0/-home-user-Portfolio-Manager-Herramienta/8b757dea-bb3a-58bd-aa07-26758394d338/scratchpad/review-web/` (en adelante `RW/`). Capturas en `RW/shots/`.

## Veredicto

**No aprobado.** La app está muy por encima de un prototipo. Es rápida, consistente entre monedas y honesta con la frescura de los datos. El seguimiento mensual (mapa de calor + tabla con efecto precio y efecto divisa) ya supera a Sharesight y a Ghostfolio en esa vista concreta. Pero todavía no puede competir con las mejores herramientas por cuatro razones:

1. **No hay reporte imprimible ni PDF**: la impresión de la página mensual sale rota.
2. **La vista estrella no se ve completa**: a 1440 px las columnas de precio/divisa quedan escondidas, y en el teléfono solo se ven 2 columnas.
3. **Hay un bug de captura de datos**: Enter rápido en el buscador crea un activo manual falso.
4. **Faltan funciones** que Kinvo y Gorila dan por hechas al público de Colombia y Brasil: rentabilidad real (IPC/IPCA), CDI, alertas, metas, rebalanceo, enlace compartible y sincronización.

| | Puntaje |
|---|---|
| **Portafolio Pro web (nuestro)** | **6,0 / 10** |
| **Mejor competidor: Sharesight** | **8,0 / 10** |

Gorila y Kinvo se acercan (≈7,5) en el caso Brasil: CDI/IPCA, conexión con B3 y PDF. Portfolio Performance (≈7,5) gana en profundidad analítica, pero pierde en UX y en móvil.

## Qué se hizo (pruebas reales)

- `npm run typecheck -w @pm/web` → OK. `npm test -w @pm/web` → 40/40 OK (6 archivos). `npm run build -w @pm/web` → OK. El bundle principal pesa 993 kB (328 kB gzip).
- Se sirvió el build con `vite preview` (:4187, proxy a :8797) y el servidor de datos real `apps/server` (:8797, Yahoo/TRM en vivo).
- Scripts de Playwright (`RW/s1…s8`) con Chromium de `/opt/pw-browsers`, a 1440 px y 390 px, en claro y oscuro.
- **Inversionista real** (`RW/s4-real.mjs`), en un portafolio vacío:
  - aporte de COP 50.000.000;
  - compra de ECOPETROL (BVC) 1.000 a 1.880 + 15.000 de comisión;
  - cambio de COP 20.000.000 a USD 5.000;
  - compra de AAPL 10 a USD 230,50;
  - cambio de COP 10.000.000 a BRL 14.000;
  - compra de PETR4 200 a R$ 36,20;
  - dividendo de AAPL: USD 2,60 bruto con 0,78 de retención.

  Tiempo total de captura: ≈10 s con el script (unos 700 ms por guardado).
- Cambio de moneda COP→USD→BRL→EUR→COP, verificado número a número (ver "Consistencia").
- Otras tareas:
  - fondo manual (FIC) y **cierre de mes**;
  - **modo privado**;
  - **pt** y **en**;
  - **importación CSV** de un extracto colombiano (`RW/extracto-trii.csv`) con reimportación para probar duplicados;
  - **respaldo → borrar todo → restaurar**;
  - **teclado** y auditoría de etiquetas;
  - **servidor caído** (`route.abort`);
  - **portafolio grande** de 3.000 movimientos y 12 activos desde 2016 (`RW/big.csv`);
  - **impresión a PDF** (`RW/monthly-print.pdf`).
- Los servidores se detuvieron al terminar.

### Consistencia multi-moneda (verificada)

Valor total del portafolio real:

| Moneda | Valor mostrado | Tasa implícita | Tasa del día en la app | ¿Cuadra? |
|---|---|---|---|---|
| COP | 52.316.499 | — | — | — |
| USD | 15.981,87 | 3.273,5 COP/USD | 3.273,49 | ✓ |
| BRL | 79.636,07 | 656,9 COP/BRL | 656,94 | ✓ |
| EUR | 14.243,04 | 3.673,1 COP/EUR | 3.673,13 | ✓ |

- Posiciones + efectivo = total. Efectivo COP 18.105.000, USD 2.695,82 y BRL 6.760: los tres cuadran a mano.
- El efecto precio mensual es idéntico en las 4 monedas (+1,68 % en octubre) y el efecto divisa cambia, como debe ser.
- "Este mes" del Resumen = "Ganancia" de la fila del mes en curso en Seguimiento.
- Respaldo y restauración: el valor total quedó idéntico antes y después ($ 55.527.559).

### Rendimiento (3.000 movimientos)

| Operación | Tiempo |
|---|---|
| Lectura y vista previa del CSV | 473 ms |
| Confirmación | 611 ms |
| Resumen listo | 591 ms |
| Cambio de moneda | ≈300 ms |
| Cambio de página | 450–740 ms |

Movimientos se pagina a 100 filas. **Excelente.**

## Mejor que la competencia

1. **Seguimiento mensual**: mapa de calor año × mes con total anual e índice, más una tabla con valor inicial, aportes, dividendos, comisiones, ganancia, valor final, TWR, acumulada, **efecto precio y efecto divisa por mes**, índice y diferencia. Exporta CSV y XLSX. Ni Sharesight ni Ghostfolio tienen esta tabla. Kinvo y Gorila tienen la rentabilidad mensual, pero sin descomposición por divisa.
2. **Moneda de reporte global e instantánea** (9 monedas) y consistente al centavo. Gorila y Kinvo solo reportan en BRL.
3. **Local-first y modo sin conexión**:
   - Con el servidor caído aparece un aviso claro y se usan los precios guardados.
   - El buscador cae al catálogo local («Servidor no disponible: buscando en el catálogo local»).
   - Evidencia: `RW/shots/t8-server-down.png`.
4. **Modo privado completo**: oculta KPIs, ejes y tooltips del gráfico, y deja los porcentajes visibles (`t5-privacy-dash.png`). Con un regex sobre el texto de 5 páginas no se filtró ningún monto.
5. **Frescura y avisos**: tarjeta "Frescura de datos" por fuente (Yahoo, TRM) con antigüedad, tiempo del motor, avisos de precio manual viejo y enlace a "Cerrar mes".
6. **Importador**:
   - detecta el extracto colombiano;
   - marca los 4 duplicados al reimportar ("Ya importado anteriormente");
   - trae la retención del dividendo (ISA neto 75.600) y la comisión + IVA (14.280).
7. **Tres idiomas completos**: pt y en sin cadenas en español, salvo el nombre del portafolio, que es dato del usuario.
8. **Rendimiento con carteras grandes**, mejor que Ghostfolio y que Sharesight en el navegador.
9. **Impuestos Colombia y Brasil** en la misma app: nadie más los tiene juntos.

## Peor que la competencia

1. Sin **reporte PDF ni impresión**. Sharesight, Gorila y Kinvo tienen reportes PDF por periodo.
2. Sin **enlace de solo lectura** (Sharesight, Kubera, Ghostfolio) y sin **sincronización** entre dispositivos: los datos viven en un solo navegador.
3. Sin **rentabilidad real vs inflación** (IPC/IPCA) ni **CDI/IBR** como referencia. Kinvo y Gorila los ponen en primera plana.
4. Sin **alertas**, **watchlist**, **metas**, **rebalanceo con objetivos** ni **what-if**. Ghostfolio tiene FIRE y X-Ray; Portfolio Performance tiene rebalanceo.
5. **Captura de datos**:
   - no propone el precio de cierre de la fecha;
   - no compara la tasa del cambio con la TRM;
   - no tiene "guardar y agregar otro".

   Sharesight, Ghostfolio y Gorila sí proponen el precio.
6. **Primer uso** mínimo: botón "Empezar mi portafolio" y una tarjeta vacía. No pregunta moneda base, residencia fiscal ni corredor. Kubera y Sharesight tienen un asistente.
7. **Móvil**: la tabla mensual y la de posiciones requieren scroll horizontal y no hay vista en tarjetas. Gorila y Kinvo son apps móviles nativas.
8. **Calendario de dividendos** solo estimado a partir del historial propio. Un usuario nuevo con AAPL ve "Sin pagos estimados en los próximos 75 días".
9. No hay conexión automática con corredores ni B3 (Gorila y Kinvo sincronizan con B3).

## Brechas numeradas

### W1 — alta — Enter rápido en el buscador de activos crea un activo manual falso
- **Pasos**: Nuevo movimiento → escribir `MSFT` → Enter antes de que lleguen los resultados (debounce de 220 ms + red).
- **Resultado**: se abre el formulario de **activo manual "MSFT"** en la moneda de reporte (COP), sin precio automático. Ver `RW/shots/t7-fast-enter.png` y `RW/s7-a11y.mjs`: "fast Enter on picker created manual instrument? YES -> MSFT".
- Lo mismo ocurre al hacer clic en la opción "Crear activo manual «…»", que se muestra mientras carga. Así se crearon por error ECOPETROL, AAPL y PETR4 como activos manuales en COP sin precio en `RW/s3-real.mjs`: AAPL a "$ 231" COP, sin precio y con ganancia 0.
- **Causa**: `src/components/InstrumentPicker.tsx:106-109`. Con `results=[]` y `active=0`, Enter llama a `onCreateManual`. La opción manual se pinta siempre (`:146-159`).
- **Corrección**:
  - No ofrecer ni ejecutar "crear manual" mientras `loading`.
  - Si el texto coincide exactamente con un símbolo del catálogo, elegirlo.
  - Pedir confirmación ("¿Seguro? MSFT existe en NASDAQ") antes de crear un manual con un símbolo cotizado.

### W2 — alta — No hay reporte PDF/imprimible y la impresión sale rota
`page.pdf()` de Seguimiento mensual (`RW/monthly-print.pdf`) muestra:
- la cabecera sticky encima de los KPIs;
- los botones y selects impresos;
- el mapa de calor **sin colores**;
- la tabla **cortada a 6 de 13 columnas**: no salen valor final, rentabilidad, acumulada ni efecto precio/divisa.

No existe ninguna regla `@media print` en `src/` (grep vacío).

**Corrección**: hoja `@media print` (ocultar barra lateral y cabecera, `print-color-adjust: exact`, tabla a ancho completo con fuente compacta) y un botón "Reporte PDF" del mes o del año, con portada, KPIs, mapa de calor, tabla, posiciones y metodología.

### W3 — alta — La vista estrella no se ve completa: columnas de precio y divisa ocultas a 1440 px y tabla inservible en el teléfono
- **Escritorio a 1440 px** (`RW/shots/t1-mensual-desktop-light.png`): la tabla mensual corta en "ACUMULADA". Efecto precio, efecto divisa, índice y diferencia quedan detrás de un scroll horizontal dentro de una caja con `max-h-[640px]` (`src/pages/Monthly.tsx:319`), que además mete un scroll anidado.
- **Teléfono a 390 px** (`t2-mensual-phone-dark.png`): solo se ven "Mes" y "Valor inicial"; el mapa de calor también exige scroll horizontal.
- **Posiciones**: a 1440 px se corta "Ef. divisa" y no se ve "Peso" (`t1-posiciones-desktop-dark.png`).

**Corrección**:
- columnas configurables, o agrupar "Flujos" y "Resultado" con "Precio/Divisa" visibles por defecto;
- primera columna fija (sticky);
- en móvil, tarjetas por mes (valor final, ganancia, TWR, precio/divisa) que se expanden;
- quitar el `max-h` o poner el encabezado sticky de página.

### W4 — alta — Sin rentabilidad real ni referencias de tasa (IPC/IPCA, CDI/IBR)
Para el público de Colombia y Brasil, "¿le gané a la inflación y al CDI?" es la primera pregunta. Kinvo y Gorila la responden en la pantalla principal. Aquí solo hay índices de precio (COLCAP, Ibovespa, S&P 500, URTH). Ajustes no ofrece IPC, IPCA, CDI, IBR ni UVR (`t1-ajustes-desktop-light.png`).

**Corrección**:
- serie IPC (DANE) / IPCA (IBGE) y CDI/IBR en el servidor;
- columnas "Rent. real" y "% del CDI" en la tabla mensual y en Rendimiento;
- línea de inflación en "Valor vs. aportado".

### W5 — media — El cierre de mes no detecta meses atrasados sin precio
- **Pasos**: comprar un FIC manual el 1-jul-2026 → Cierre de mes.
- **Resultado** (`t5-cierre-before.png`):
  - Solo propone septiembre.
  - Julio y agosto quedan valorados al costo, así que toda la ganancia del FIC cae en septiembre.
  - El Resumen dice "Todo en orden – Todos los activos tienen precio" (`t5-privacy-dash.png`).

**Corrección**: lista de "meses pendientes por activo manual" desde la compra, un aviso por cada mes sin cierre y un asistente que recorra los meses.

### W6 — media — El formulario no propone el precio ni valida contra el mercado o la TRM
- **Compra de ECOPETROL** el 13-ene-2026 a 1.880: el cierre real fue 2.065 (verificado en `/api/history`), un 9 % de diferencia. No hubo ningún aviso.
- **Cambio de divisa**: COP 20.000.000 → USD 5.000 implica 4.000 COP/USD, frente a una TRM de ≈3.700. El formulario muestra la "tasa implícita" (`t4-form-fx.png`) pero no la compara.
- **Compra de ITUB4 sin servidor** a 30: la app mostró +34,57 % "este mes" sin advertencia.
- No hay "guardar y agregar otro" ni duplicar movimiento.

**Corrección**:
- rellenar el precio de cierre de la fecha (editable);
- aviso si la diferencia es mayor de ±5 %, y lo mismo para la tasa frente a la TRM o PTAX;
- botón "Agregar y nuevo";
- atajo `N` para abrir el formulario: hoy no existe ningún atajo.

### W7 — media — Menú móvil inaccesible por teclado
Con el cajón abierto (`t2-drawer-phone.png`):
- Tab recorre la página de fondo (16 de 16 focos fuera del `aside`).
- **Escape no lo cierra**.
- El foco no entra al cajón.
- Falta `role="dialog"` y `aria-modal`.

Evidencia: `src/components/Layout.tsx:253-268` y `RW/s2-phone.mjs`. Además, al cargar cada ruta se enfoca `#main` (`Layout.tsx:236`), así que la cabecera (portafolio, moneda, privacidad) solo se alcanza después de recorrer todo el contenido.

**Corrección**: reutilizar el `Modal` (con foco atrapado y Escape, `ui.tsx:274`) para el cajón y devolver el foco al botón de menú.

### W8 — media — Dividendos: "vs 2025 −27,25 %" compara el año en curso con el año completo anterior
`src/pages/Dividends.tsx:39-40,120` suma todo 2025 y lo compara con enero–septiembre de 2026 (`t1-dividendos-desktop-light.png`). El mensaje "cobras 27 % menos" es engañoso.

**Corrección**: comparar el mismo periodo (YTD contra YTD) y mostrar aparte el total del año anterior.

### W9 — media — Cifras anualizadas inconsistentes y TIR absurda en periodos cortos
- En Rendimiento, la TWR anualizada desde el inicio sale **+13,72 %** en la KPI y en "Por periodo", pero **+13,13 %** en "Comparación con índices". Son dos fórmulas distintas: el motor frente a `annualize()` local (`src/pages/Performance.tsx:23,69,184`).
- "Por periodo → Mes → TIR +148,21 %" anualiza 5 días sin advertencia (`t1-rendimiento-desktop-light.png`).
- Sharpe se muestra "0,9" en una fila y "0,91" en otra.

**Corrección**:
- una sola fuente de anualización;
- no anualizar periodos de menos de un año (mostrar "—" con tooltip);
- decimales uniformes.

### W10 — media — Sin enlace de solo lectura ni sincronización
Todo vive en IndexedDB de un navegador. No hay forma de mostrarle el portafolio al asesor o a la pareja ni de verlo en el teléfono, salvo exportando y restaurando un JSON a mano.

**Corrección**: sincronización cifrada de extremo a extremo (opcional), una instantánea compartible (HTML/PDF firmado) o un enlace con caducidad.

### W11 — media — Faltan alertas, watchlist, metas, rebalanceo con objetivos y what-if
Ninguna de estas existe (ni rutas ni ajustes). Kinvo y Gorila envían alertas, Ghostfolio tiene FIRE/metas y X-Ray, y Portfolio Performance tiene rebalanceo y watchlists.

**Corrección mínima**:
- pesos objetivo por clase, país y divisa, con desviación en Posiciones;
- meta de patrimonio con proyección de aportes;
- alertas locales (Notification API) para el cierre de mes, el precio y el dividendo.

### W12 — media — El calendario de dividendos es solo una estimación propia
"Próximos (estimado)" usa el mismo mes del año anterior del historial del usuario. Con AAPL comprada en 2026 muestra "Sin pagos estimados en los próximos 75 días" (`t4-dash-USD.png`), aunque el servidor ya devuelve las acciones corporativas (`/api/history` → `actions`).

**Corrección**: usar los dividendos del proveedor (fecha ex y de pago) y una vista de calendario mensual con montos netos estimados después de retención.

### W13 — media — Primer uso pobre y datos de ejemplo mezclados con precios en vivo
- **"Empezar mi portafolio"** crea "Mi portafolio" en COP sin preguntar nada. El resumen vacío es una tarjeta con dos botones (`t4-empty-dashboard.png`). No hay checklist (aporte inicial → primera compra → cierre de mes) ni elección de moneda, residencia o corredor.
- **Datos de ejemplo**: al llegar los precios en vivo, el ejemplo muestra "hoy +1,60 %" y "Mayores movimientos: ITUB4 +10,37 %" (`t1-dashboard-desktop-light.png`). Es el salto de los precios sintéticos al 30-sep frente a los precios reales al 5-oct.
- **Etiqueta "hoy"**: compara el último cierre con el anterior aunque haya varios días hábiles de por medio.

**Corrección**:
- asistente de 3 pasos;
- datos de ejemplo congelados (sin actualizar precios);
- etiqueta "desde el cierre del 30-sep" cuando el intervalo sea mayor de un día hábil.

### W14 — baja — Tarjetas de Divisas confusas
- "Precio + divisa (acumulado): **+105,05 % + −22,20 %**" usa un signo "+" aunque la composición es multiplicativa y no suma la TWR de +60,48 %.
- "166 % del total no realizado" y "−66 %" son difíciles de leer (`t1-divisas-desktop-light.png`).

**Corrección**: mostrar "(1+p)(1+d)−1 = total" o un gráfico de cascada (inicio → precio → divisa → final), con montos en lugar de porcentajes de un total.

### W15 — baja — Importación sin enriquecer nombres y retención invisible en Movimientos
- Los activos importados quedan con el ticker como nombre ("ISA ISA", "PFBCOLOM PFBCOLOM" en `t6`/`RW/s6`), aunque el catálogo tiene "Interconexión Eléctrica S.A." y "Bancolombia S.A. Preferencial".
- La tabla de Movimientos no tiene columna de retención/impuestos.
- La vista previa de importación no muestra comisiones ni retenciones (`t5-import-2.png`).

**Corrección**: resolver contra el catálogo al importar y añadir columnas de retención y comisión en la vista previa y en Movimientos.

### W16 — baja — El buscador muestra MIC en lugar de nombres de bolsa
El buscador muestra "XBOG", "BVMF" y "XNAS" en vez de "BVC", "B3" y "NASDAQ", que es lo que reconoce el usuario (`RW/s4-real.mjs`).

### W17 — baja — Borrar todo vuelve a sembrar el ejemplo y el estado del servidor se contradice
- "Borrar todos los datos" vuelve a cargar de inmediato el portafolio de ejemplo (`RW/s6-tasks.mjs`, "after wipe dashboard: Estás viendo datos de ejemplo").
- "Frescura de datos" muestra "Servidor de precios: En espera" con punto gris justo después de una actualización correcta (`t4-dash-USD.png`).

### W18 — baja — Cabecera móvil
En el teléfono, el selector de portafolio se trunca ("Todos (1 por") y el estado de actualización se oculta (`t2-dashboard-phone-light.png`).

En el menú lateral de pt, "Acompanhamento mensal" ocupa 2 líneas (`t5-pt-mensual.png`).

### W19 — baja — Gráficos sin alternativa accesible
Los `canvas` tienen `aria-label` genérico ("Gráfico de distribución"), pero no hay tabla de datos ni resumen textual para lectores de pantalla. El mapa de calor sí tiene botones con etiqueta ("Enero de 2026 +0,81 %"), lo cual está bien.

**Corrección**: `<details>` con "Ver datos" o un `aria-describedby` con el resumen (máximo, mínimo, último valor).

### W20 — baja — Bundle pesado y sin PWA
- El bundle principal pesa 993 kB (ECharts completo).
- La primera carga con el ejemplo tardó ≈4,4 s en local.
- No hay `manifest` ni service worker, aunque la propuesta es local-first y offline.

**Corrección**: importación modular de ECharts y un PWA instalable con caché del shell.

### Bugs visuales revisados

- **Fondo de la barra lateral en páginas largas**: **no se reproduce** en uso real. El `aside` es `fixed inset-y-0` (`Layout.tsx:244`) y al hacer scroll hasta el fondo de Movimientos ocupa toda la altura (`t7-scrolled-bottom.png`). Sí aparece cortado a 900 px en las capturas de página completa (`t1-*`), y en impresión la cabecera y los controles se superponen al contenido (ver W2).
- **Recorte de columnas** a 1440 px en Seguimiento y Posiciones (W3).
- **Etiqueta truncada** en la KPI "Rentabilidad · Septiembre d…" (`t1-mensual-desktop-light.png`).
- **Modo oscuro**: buen contraste y sin fallos visibles (`t1-posiciones-desktop-dark.png`, `t2-mensual-phone-dark.png`).

## Matriz (resumen; competidores según documentación pública y conocimiento propio)

Fuentes consultadas:
- [Sharesight – performance report](https://www.sharesight.com/blog/track-your-investments-with-sharesights-performance-report/)
- [Sharesight – performance](https://www.sharesight.com/us/investment-portfolio-performance/)
- [Ghostfolio – changelog](https://ghostfol.io/en/about/changelog)
- [Ghostfolio review 2026](https://www.portfolioglance.com/investing-apps/ghostfolio)
- [Kinvo – planes](https://consolidador.kinvo.com.br/lp/planos/)
- [Gorila – Google Play](https://play.google.com/store/apps/details?id=br.com.gorilainvest.mobileapp&hl=en_US)

El resto se basa en conocimiento previo, sin verificación en vivo. Ver `web-r1.json`.
