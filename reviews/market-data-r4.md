# Revisión R4: datos de mercado y servidor API (`packages/market-data`, `apps/server`)

Revisor: agente revisor independiente, solo lectura sobre el código. Fecha: 2026-10-09.

## Veredicto

**Aprobado.** Cumple las dos condiciones: el puntaje es estrictamente mayor que el del mejor competidor y no queda ningún gap alto.

El único gap alto de R3 (M28, barras fantasma en NTCO3→NATU3) está corregido de forma general. El filtro que lo resuelve no borra precios legítimos: lo comprobé en 29 acciones ilíquidas de la BVC y de B3, y ningún valor cambia. También quedan corregidos:
- M31: calendario de cupones con feriados de B3/ANBIMA.
- M30: tickers de B3 sin sufijo.
- La parte de M29 sobre la cadena de Copel.

Siguen abiertos seis gaps medios y cuatro bajos. Tres de ellos son nuevos: M32 a M34 y M35, este último de endurecimiento.

| | Puntaje |
|---|---|
| **Nuestra parte (market-data + server)** | **8 / 10** (R1: 5 · R2: 7 · R3: 7,5) |
| **Mejor competidor para este trabajo: Portfolio Performance** | **7 / 10** |

Para el inversionista colombo-brasileño que sigue su portafolio mes a mes, el producto trae listo, sin configurar nada:
- TRM oficial con respaldo.
- FIC y fondos de pensiones/cesantías.
- IPC derivado de la UVR (exacto respecto al DANE), IBR, DTF y UVR.
- CDI, IPCA (con SIDRA de respaldo), Tesouro con cupones y feriados.
- Fusiones, conversiones y escisiones modeladas.
- Un servidor autoalojado seguro por defecto.

Portfolio Performance puede llegar a algo parecido con proveedores JSON configurados a mano, pero no trae nada de eso listo.

No le doy más de 8 por tres motivos: no hay segunda fuente gratuita para la BVC (M2), las fuentes oficiales de Brasil no se han validado en vivo (M15) y los títulos deslistados no tienen historia (M29).

## Qué se verificó

- `npx vitest run packages/market-data apps/server`: **252 OK** (18 en vivo omitidas por diseño). `tsc --noEmit` limpio en ambos paquetes.
- `LIVE=1 … live.test.ts`: **18/18 OK**. La prueba nueva de R4 exige continuidad mensual desde 2019 para cada alias `rename`.
- El servidor se levantó en `127.0.0.1:18790` con la configuración por defecto, se probó con curl y se detuvo. Comprobé que no quedó ningún proceso escuchando.
- Scripts nuevos en `scratchpad/review-md/`:
  - `thin.mts`: compara los cierres de fin de mes de Yahoo en crudo con los del servicio, desde 2019.
  - `window.mts`: ventanas de fechas sin ninguna negociación.
  - `m31.mts`: fechas de cupón.
  - `snapshot.mts`: grabación de la instantánea y respaldo con todos los proveedores caídos.
- Revisé el código nuevo: `dropStaleZeroVolume`, `frozen.ts`, `recordSnapshot` y la sincronización IBKR Flex montada en el servidor (`ibkrSync.ts` y sus rutas en `app.ts`).

## El filtro de barras fantasma frente a acciones ilíquidas legítimas

Probé 29 acciones ilíquidas desde 2019. Algunas tienen más de 1 000 barras con volumen 0.

| Mercado | Acciones |
|---|---|
| BVC | PFAVAL, ETB, MINEROS, PFDAVVNDA, BOGOTA, GRUPOAVAL, NUTRESA, ELCONDOR, CONCONCRET, PFCORFICOL, CORFICOLCF, BBVACOL, PROMIGAS, ENKA, CNEC |
| B3 | BAUH4, CEDO4, MNPR3, HAGA4, BMEB3, CRPG5, EALT4, WLMM4, FESA4, BRSR6, RPAD5, MTSA4, PEAB3 |

Resultados:
- **Ningún cierre cambió de valor.** El filtro solo quita barras que repiten el último precio negociado; el engine de core rellena hacia adelante con ese mismo precio.
- Se pierden meses enteros solo cuando no hubo **ninguna** negociación en el mes: ELCONDOR (2023-04, 2023-05 y 2026-04), BBVACOL 2026-04 y BAUH4 2026-08. Core los valora con el último precio, que también es el precio de referencia de la BVC. Es correcto.
- El fin de mes queda fechado el día de la última operación real. Ejemplo: BBVACOL, septiembre de 2026, sale el 24-sep a 251 y no el 30-sep, porque Yahoo **copia también el volumen** de la última operación en los días siguientes (153 333 diarios). Es más fiel, no un error.
- Efecto secundario negativo: cuando la ventana pedida **entera** cae en un periodo sin negociación, la respuesta queda vacía (ver M32).

## Gaps de R3, verificación uno por uno

| ID | Estado | Evidencia |
|---|---|---|
| M28 | **Corregido** | NATU3 ya no trae las 4 barras a 36,86 (nota "dropped 4 zero-volume bar(s)…") y julio de 2025 sale en 9,03. NTCO3 ahora es una conversión 1:1: `delisted`, `MERGER` → NATU3 el 2025-07-02 y sin precios prestados. |
| M30 | **Corregido para B3** | CPLE3, TAEE11, SAPR11, KLBN11 y BPAC11 resuelven a BVMF/BRL. AAPL y BRK-B no cambian, y ABCD3 da `NOT_FOUND`. Los tickers de la BVC sin sufijo siguen fallando: ver M33. |
| M31 | **Corregido** | NTN-B 2035: 2023-11-16, 2024-11-18, 2025-11-17, 2026-11-16, 2027-05-17 y 2027-11-16, todas corridas correctamente por el feriado del 15-nov y por fines de semana. NTN-B 2040: 2026-02-18 (Carnaval). NTN-F: 2025-01-02 y 2027-01-04. |
| M29 | **Persiste (parcial)** | La cadena de Copel ya es correcta. CPLE6 pasa a CPLE5 (último día 2025-11-07, efectiva el 10-nov). CPLE5 pasa a CPLE3 + R$0,7749 (último día 2025-12-19, efectiva el 22-dic, pago el 30-dic). CPLE11 se disuelve el 2023-12-26 en 1 CPLE3 + 4 CPLE6, con `reviewRequired`. El mecanismo de historia congelada existe y valida bien sus archivos, pero **no trae datos**: BRFS3, NTCO3, CPLE5, CPLE6 y CPLE11 siguen con `points: 0`. |
| M2 | **Persiste (parcial, mejorado)** | La instantánea local funciona. Una grabación en vivo de XBOG registró 30/30 en 4 s, y con todos los proveedores caídos se sirve `source: "snapshot"`. Solo cubre instrumentos del catálogo (ELCONDOR → `UPSTREAM_ERROR`) y solo el año en curso (ver M34). |
| M15 | **Persiste** | Ahora existe `CONTRACT_STRICT=1`, pero PTAX, SGS, SIDRA, BCE, FRED, Tesouro, brapi y stooq siguen sin validarse contra los servicios reales. |
| M8, M13, M18 | **Persisten** | Sin cambios: la API de la BVC no es accesible. |

## Gaps abiertos

### M32 (media, nuevo). Una ventana sin negociaciones devuelve una serie vacía, sin precio de arranque
- **Evidencia, en vivo**:
  - `history ELCONDOR.CL 2023-04-01..2023-05-31 interval=1mo` → `[]`. Antes de R4 esa ventana traía las barras arrastradas a 1020.
  - `ELCONDOR 2026-04` → `[]`.
  - `BBVACOL 2026-04` → `[]`.
- **Impacto**: si el portafolio arranca, o se consulta, en un mes sin operaciones, el engine no tiene precio previo. Valora a costo y lo marca en `missingPrices` en lugar de usar el precio de referencia vigente.
- **Arreglo**: cuando el filtro deja la ventana sin puntos, o el primer punto queda después de `from`, añadir al inicio la última operación real anterior como punto `carried: true` (o en un campo `previous`).

### M33 (media, nuevo). Los tickers de la BVC sin sufijo, tal como aparecen en los extractos colombianos, no resuelven
- **Evidencia**: `quote ECOPETROL`, `PFAVAL`, `GEB`, `ISA`, `NUTRESA`, `ICOLCAP`, `CEMARGOS` y `PFCIBEST` dan `UPSTREAM_ERROR` (502). El código lo trata como `XNYS:ECOPETROL`. Todos están en el catálogo, y `details.suggest` sí trae `XBOG:…`. M30 se corrigió para B3, pero no para el mercado principal del producto.
- **Arreglo**: en `resolve`, comprobar primero si el símbolo coincide exactamente con uno del catálogo (único) y, si no, probar `.CL` antes que EE.UU. Además, un 404 de todos los proveedores debería responder `NOT_FOUND`, no 502.

### M29 (media, persiste parcial). Títulos deslistados sin historia
- **Arreglo**: grabar y versionar los históricos congelados de BRFS3, NTCO3, CPLE5, CPLE6 y CPLE11, con `scripts/record-frozen.ts` y brapi con token, o a partir de un export de B3.

### M2 (media, persiste parcial). No hay segunda fuente gratuita para la BVC ni Londres
- La instantánea solo cubre el catálogo y el año en curso.

### M8 (media, persiste). Dividendos de la BVC sin fecha de pago ni cuotas

### M15 (media, persiste). Fuentes oficiales de Brasil, BCE y FRED sin validar en vivo

### M34 (baja, nuevo). El respaldo por instantánea devuelve rangos parciales sin decirlo
- **Evidencia**: con todos los proveedores caídos, `history XBOG:ECOPETROL from=2025-06-01` → `source: snapshot`, con el primer punto el **2026-01-30**. De junio a diciembre de 2025 desaparecen sin un indicador de cobertura parcial; solo hay una nota genérica.
- **Arreglo**: incluir `coverageFrom` o `partial: true` en la respuesta, y grabar una sola vez los años cerrados de los instrumentos de la instantánea, que son inmutables.

### M35 (baja, nuevo). Endurecimiento de la sincronización IBKR montada en el servidor
- **Evidencia**:
  - El token de Flex se envía a la URL que trae la respuesta de `SendRequest` (`<Url>`) sin verificar que el host sea `*.interactivebrokers.com` (código en `@pm/importers/sync/ibkr-flex.ts:117`, ejecutado por este servidor).
  - La comparación de `API_TOKEN` no es de tiempo constante.
  - El inbox se actualiza con leer-modificar-escribir sin bloqueo, así que una ejecución diaria y otra desde la web pueden pisarse.
  - El acceso a las rutas sí está bien protegido: `API_TOKEN` o `ALLOW_LOCAL_ADMIN` sobre un socket loopback real, como en M21.
- **Arreglo**: allowlist del host de IBKR, `timingSafeEqual` y una cola o mutex por portafolio.

### M13 (baja, persiste). COLCAP real solo como promedio mensual

### M18 (baja, persiste). ISIN de la BVC fuera del catálogo sin resolver

## Matriz resumida frente a la competencia

Sobre Portfolio Performance y Sharesight usé lo consultado en R1. Sobre Kinvo/Gorila y Status Invest, conocimiento previo, no verificado hoy.

- **Ganamos** en:
  - Datos oficiales de Colombia: TRM, IPC/UVR, IBR, DTF, FIC y AFP.
  - Eventos corporativos tipados, con fusiones y conversiones en efectivo.
  - Cierres tal como se negociaron, fin de mes real e indicadores de frescura.
  - Seguridad del servidor autoalojado.
- **Perdemos** en:
  - Respaldo de precios para la BVC (Sharesight tiene datos licenciados; Portfolio Performance admite cualquier URL).
  - Historia de títulos deslistados (Sharesight, Kinvo/Gorila y Status Invest la conservan).
  - Dividendos con fecha de pago en la BVC.
