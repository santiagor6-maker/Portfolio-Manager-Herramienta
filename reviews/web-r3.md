# Revisión web — ronda 3 (`apps/web`)

- **Revisor:** agente revisor, solo lectura.
- **Fecha:** 13 de octubre de 2026.
- **Material de soporte:** scripts, capturas y PDFs en `RW = /tmp/claude-0/-home-user-Portfolio-Manager-Herramienta/8b757dea-bb3a-58bd-aa07-26758394d338/scratchpad/review-web/`. Scripts: `r3-*.mjs` e `imp.mjs`. Capturas: `RW/shots3/`. Archivos de prueba: `RW/fx3/`.

## Veredicto

**No aprobado.**

Las brechas de la ronda 2 están casi todas cerradas y verificadas a mano: el asistente ya no crea un segundo portafolio, se marcan los aportes implícitos y los diagnósticos están traducidos. Pero el recorrido completo de punta a punta destapó dos fallas altas nuevas:

1. **La importación de PDF y de correos `.eml` no funciona en la app compilada.** Fallan los cinco PDF probados: SINACOR, XP, Nu (dentro de un `.eml`), extracto Trii y CDT Bancolombia. Es una de las funciones anunciadas de esta ronda.
2. **Tras el asistente y la importación, el portafolio real se valora con los precios sintéticos del ejemplo.** Pasa con los activos que también estaban en el ejemplo (ISA, PFCIBEST) y con el índice COLCAP. El problema dura hasta una actualización manual o hasta que pasan los 5 minutos del límite de actualización. En ese lapso la app dice «Todos los activos tienen precio» y el **Informe PDF sale con cifras falsas**.

| | Puntaje |
|---|---|
| **Portafolio Pro web (nuestro)** | **7,5 / 10** (ronda 1: 6,0 · ronda 2: 7,3) |
| **Mejor competidor: Sharesight** | **8,0 / 10** |

Con W30 y W31 corregidas y W32–W34 pulidas, el puntaje llega a ≈8,3. Ahí superaría a Sharesight en el caso Colombia–Brasil.

Comparación con el resto (sin verificación en vivo en esta ronda):
- **Kubera (≈7,5):** gana en sincronización y en patrimonio total.
- **Gorila y Kinvo (≈7,5):** leen B3 y las notas de corretaje sin fallar.
- **Snowball (≈7):** gana en dividendos.

## Cómo se probó

- **Comprobaciones previas:** `tsc --noEmit -p apps/web` sin errores. `npm test -w @pm/web`: **63/63** pruebas aprobadas.
- **Build y servidores:** build propio en `RW/dist3` (`vite build --outDir`), servido con `vite preview` en :4187. Servidor de datos sin modo watch en :8797, con `CORS_ORIGIN=http://localhost:4187` y `RATE_LIMIT_PER_MIN=600`. Datos reales de Yahoo, TRM, IPC e IBR. Chromium de `/opt/pw-browsers`. Los servidores se detuvieron al terminar.
- **Inversionista colombiano** (perfil `r3co`, interfaz es):
  - asistente en COP con aporte de 20 M y fecha por defecto (hoy);
  - «Registrar una compra»: AAPL del 1-feb-2024 (precio sugerido 186,86);
  - enlace directo en frío;
  - diagnóstico y botón «Crear aporte en esa fecha»;
  - importación de `extracto-trii.pdf`, `cdt-bancolombia.pdf` y `extracto-trii.csv`;
  - tabla mensual en COP, BRL y USD;
  - Informe PDF;
  - Impuestos Colombia;
  - Rendimiento (Sharpe sobre el IBR).
- **Inversionista brasileño** (perfil `r3br`, navegador pt-BR, interfaz pt):
  - asistente en BRL con aporte de R$ 100.000 el 2-ene-2023 y corretora «XP»;
  - importación de `b3-negociacao.xlsx`, `nota-sinacor.pdf`, `nota-xp-2024-03-08.pdf` y `nota-nu.eml` (correo con la nota Nu en PDF adjunta);
  - compra de 2.000 PETR4 (5-ene-2026) y venta de 2.000 PETR4 (10-mar-2026) para generar un DARF;
  - tabla mensual en BRL, COP y USD;
  - Informe PDF;
  - Impostos Brasil y «Registrar pagamento».
- **Teléfono:** 390 px en modo oscuro (Resumen, Mensual, Impuestos), sin scroll horizontal.
- **IBKR:** se probó la conexión de Interactive Brokers contra el servidor local sin `API_TOKEN` ni `SYNC_SECRET`.

## Brechas de rondas anteriores

| ID | Estado | Evidencia |
|---|---|---|
| W21 | **Cerrada** | Después del asistente, «Registrar una compra» propone «Portafolio Colombia». El enlace directo en frío a `/movimientos?nuevo=1` también. Queda un solo portafolio (`r3-co.mjs`). |
| W22 | **Cerrada** | El asistente pide «¿Desde cuándo inviertes?». Si se deja hoy, Diagnóstico muestra «Compra sin aporte previo… aporte implícito de USD 1.868,60». La tabla mensual marca «Aporte implícito» en feb-2024 (también en el teléfono). «Crear aporte en esa fecha» crea el aporte y la advertencia desaparece (`co02`, `co05`, `m10-phone-dark-mensual.png`). Ver W33 y W39. |
| W23 | **Cerrada** | Las barras de Clase, País y Divisa del PDF tienen relleno (`co12-informe.pdf`, p. 5). |
| W24 | **Cerrada** | Plantillas en es y pt con el símbolo del activo y montos con formato local («Compra sem aporte prévio… R$ 2.345,00»). |
| W25 | **Cerrada** | Formulario vacío: «Elige un activo.», «Campo obligatorio.» ×2. |
| W26 | **Cerrada** | Cambio del día «+$ 256.236 (+1,20 %) hoy». «Mayores movimientos» muestra la fecha de cada fila. |
| W27 | **Cerrada** | «Índice IPCA — falhou — Sem esta série não se calculam a rentabilidade real nem o «% do índice»». |
| W28 | **Cerrada** (no reprobada a mano con CORS) | La conexión de IBKR muestra un mensaje específico para el 403. |
| W29 | **Cerrada** | Sharpe 0,59 con «Libre de riesgo: IBR 9,52 %». |
| W12 | **Cerrada** | Próximos proventos: HGLG11 (3-nov y 1-dic), ITSA4 y PETR4 (23-dic). |
| W10 | **Abierta, baja** | Sin cambios. |
| W20 | **Abierta, baja** | El paquete de gráficos (~690 kB) se sigue cargando en el Resumen. Ya hay íconos PNG 192/512 y `apple-touch-icon` en `dist3`. |

## Mejor que la competencia

1. **Seguimiento mensual**, en escritorio y teléfono:
   - mapa de calor nominal o real;
   - efecto precio y efecto divisa;
   - insignias «Aporte implícito» y «Precio atípico» por mes, con acción para corregir.

   Ninguno de los competidores explica así la calidad del dato mes a mes.
2. **Diagnósticos accionables y traducidos** («Crear aporte en esa fecha», «Confirmar precio», «Marcar como neto»). Sharesight y Kubera no lo tienen.
3. **B3 Negociação XLSX** con confianza alta. La línea de opciones se ignora y se explica por qué.
4. **Cambio de código PFBCOLOM→PFCIBEST** aplicado solo al importar.
5. **Impostos Brasil:** DARF con estado «Vencida — 166 dias de atraso: multa R$ 773,68 + Selic R$ 254,54» y botón para registrar el pago.
6. **Informe PDF** completo: real vs IPC, aportado + IPC, efecto precio × efecto divisa, distribución y metodología.
7. **Local-first, PWA, tres idiomas e impuestos de Colombia y Brasil en una sola app.**

## Peor que la competencia

1. **Notas de corretaje y extractos en PDF:** Gorila y Kinvo los leen sin fallar. Aquí no funcionan en el build (W30).
2. **Integridad del dato justo después del asistente** (W31). Sharesight y Kubera nunca mezclan datos de ejemplo con los reales.
3. **Referencia brasileña:** para un portafolio en BRL compara con COLCAP y con el IBR (W32). Kinvo y Gorila muestran el CDI y el Ibovespa por defecto.
4. **Sin sincronización entre dispositivos** (W10). La conexión con IBKR requiere configurar el servidor y no se pudo probar de punta a punta (W38).

## Brechas nuevas

### W30 — alta — La importación de PDF y de `.eml` falla en la app compilada

Mensaje (los cinco archivos, en es y pt): «No se pudo leer el PDF (No "GlobalWorkerOptions.workerSrc" specified.). Si tiene contraseña, quítala y vuelve a intentarlo.» Por eso queda «Por importar 0» y el botón de importar está desactivado.

Archivos probados:
- `nota-sinacor.pdf`
- `nota-xp-2024-03-08.pdf`
- `nota-nu.eml`: el adjunto se extrae bien, pero su PDF falla.
- `extracto-trii.pdf`
- `cdt-bancolombia.pdf`

Capturas: `shots3/co-trii-pdf-preview.png`, `br-sinacor-preview.png`, `br-eml-preview.png`.

**Causa:**
- `apps/web/src/services/importers.ts:64-80` no pasa `options.pdfjs` ni configura `GlobalWorkerOptions.workerSrc`.
- `packages/importers/src/pdf/extract.ts:4-5,50` documenta que en el navegador hay que hacerlo.
- Las pruebas pasan porque corren en Node, que usa el *fake worker*.
- El mensaje además sugiere una contraseña, lo que despista al usuario.

**Corrección:**
- En la web, importar `pdfjs-dist/legacy/build/pdf.worker.min.mjs?url` y asignar `GlobalWorkerOptions.workerSrc`, o pasar el módulo configurado en `options.pdfjs`.
- Agregar un e2e de Playwright sobre el build que importe `nota-sinacor.pdf` y un `.eml`.
- Distinguir «error interno del lector» de «PDF protegido».

### W31 — alta — Los precios sintéticos del ejemplo valoran el portafolio real y el índice hasta la siguiente actualización

**Qué pasa:** después de «Empezar mi portafolio», las series `isDemo` del ejemplo se quedan en IndexedDB. Cuando el usuario importa o compra un activo que también estaba en el ejemplo (ISA, PFCIBEST, ECOPETROL, PETR4, AAPL, VOO…), la valoración y el índice usan esos cierres falsos (`r3-dbg.mjs`).

| Serie | Cierre del ejemplo (30-sep) | Cierre real |
|---|---|---|
| `XBOG:ISA` | 19.349 | 28.500 |
| `XBOG:PFCIBEST` | 47.740 | 76.620 |
| `XBOG:ICOLCAP` | 17.312 | 25.387,5 |

**Efecto visible:**

| Cifra | Con precios del ejemplo | Con precios reales |
|---|---|---|
| Valor total | 41,5 M | 43,0 M |
| TWR de septiembre | +3,52 % | +5,19 % |
| COLCAP de septiembre | −2,58 % | +3,95 % |

**Otros síntomas:**
- El Resumen dice «Todos los activos tienen precio y tasa de cambio» y la cabecera «Sin actualizar».
- «Frescura de datos» dice «Aún no se han descargado precios».
- El **Informe PDF generado en ese momento** (`co12-informe.pdf`: ISA a $ 3.869.800 = 200 × 19.349) no lleva ninguna marca.
- Solo un clic en «Actualizar» lo corrige (`r3-dbg2.mjs`).

**Causa:**
- No se dispara ninguna actualización después de importar ni después de crear el primer movimiento.
- `refreshMarketData` limita la actualización automática a 5 min y 2 min (`services/marketData.ts:119-131`).
- Las series `isDemo` no se borran ni se excluyen de la valoración de los portafolios reales.

**Corrección:**
- borrar o aislar las series `isDemo` al quitar el ejemplo;
- forzar `refreshMarketData({ force: true })` tras importar o tras el primer movimiento de un activo nuevo;
- marcar «precio de ejemplo / sin verificar» en Posiciones, Informe y Avisos si alguna valoración usa una serie `isDemo`.

### W32 — media — Un portafolio brasileño se compara con COLCAP y con el IBR

- **Problema:** con moneda base BRL y residencia BR, la tabla mensual y el Informe usan **COLCAP (ICOLCAP)** como índice y muestran «**53% do IBR**». Como el CDI, el IPCA y la Selic fallan en este contenedor, cae al IBR colombiano.
- **El Informe muestra:** «Real (vs —) —» y «% IBR 53 %» (`br12-informe.pdf`, `br10-monthly-BRL.png`).
- **Corrección:**
  - índice por defecto según residencia y moneda: Ibovespa y CDI para BRL, COLCAP e IBR para COP;
  - si falta la serie propia, mostrar «CDI no disponible» en vez de otra tasa;
  - en el Informe, ocultar la tarjeta real si no hay índice de inflación.

### W33 — media — Cuentas que no coinciden generan avisos falsos de «compra sin aporte»

- **Problema:** el asistente guarda el aporte con cuenta «XP» (el corretor que escribió el usuario). El XLSX de B3 trae «XP INVESTIMENTOS CCTVM S/A» y «NU INVEST CORRETORA DE VALORES S.A.». Como el motor lleva el efectivo por cuenta, marca 4 avisos «Compra sem aporte prévio» (R$ 2.345, 330,04, 1.605 y 337,20) aunque había R$ 100.000 depositados ese mismo día.
- **Consecuencia:** los aportes quedan inflados en R$ 4.617,24 (aportado neto R$ 104.617,24). La acción sugerida («Criar aporte nessa data») duplicaría dinero (`r3-br3.mjs`).
- **Corrección:**
  - asociar alias de cuenta (Ajustes, o la pregunta «¿"XP INVESTIMENTOS CCTVM S/A" es tu cuenta "XP"?» al importar);
  - cuando hay efectivo en otra cuenta del mismo portafolio, sugerir «Trasladar efectivo» en vez de «Crear aporte».

### W34 — media — «Registrar pagamento» del DARF no pide confirmación y la KPI no se actualiza

- **Qué hace:** un clic crea un `TAX` con la **fecha de hoy** y R$ 4.896,61 (principal + multa + Selic calculados a hoy), sin diálogo para la fecha o el monto realmente pagados.
- **Inconsistencia:** después de pagar, la fila dice «Paga em atraso», pero la tarjeta «**DARF a pagar R$ 3.868,39 · 1 DARF**» sigue igual (`r3-br2.mjs`, `r3-br3.mjs`).
- **Corrección:** diálogo con fecha y monto editables (prellenados) y excluir de la KPI las DARF pagadas.

### W35 — baja — No se detecta el idioma del navegador

Con un navegador `pt-BR`, la app arranca en español (`lang=es`). Un usuario brasileño tiene que encontrar «Ajustes → Idioma» en español.

### W36 — baja — Impostos muestra claves internas

Ejemplos: «Alguns parâmetros de 2026 estão marcados para verificação (ver config.meta)» y «…ou ative creditEstimatedIrrf». Ninguna de las dos es accionable para el usuario.

### W37 — baja — El PDF repite la fila «Total» al final de cada página

En `br12-informe.pdf`, p. 3, la tabla parece terminar en feb-2025 porque la fila Total (`tfoot`) se repite antes de que la tabla continúe en la página 4.

**Corrección:** `tfoot { display: table-row-group }` en impresión.

### W38 — baja — Conexión con IBKR: configuración del servidor sin explicar

Con el servidor local por defecto, «Conectar» devuelve 403 y la interfaz solo dice «El servidor pide un token de API». No menciona que también hace falta `SYNC_SECRET` en el servidor ni cómo habilitarlo en local. No se pudo probar de punta a punta (sin cuenta de IBKR).

### W39 — baja — «Crear aporte en esa fecha» usa la moneda de la compra

Crea un aporte en USD (USD 1.868,60) para un inversionista colombiano que en realidad depositó COP y los convirtió. Así, el efecto divisa de ese aporte se mide desde la fecha de compra y no desde la conversión.

**Corrección:** ofrecer «aporte en COP + cambio a USD» con la TRM del día.

### W10 — baja — Sin sincronización ni enlace vivo

Sin cambios.

### W20 — baja — El Resumen aún carga ~690 kB del paquete de gráficos

## Matriz

Ver `web-r3.json`. Para los competidores: documentación pública citada en la ronda 1 y conocimiento previo, sin verificación en vivo en esta ronda.
