# Revisión R5 (confirmación): datos de mercado y servidor API

Revisor: agente revisor independiente, en modo solo lectura sobre el código. Fecha: 2026-10-12.

## Veredicto

**No aprobado: la ronda de pulido introdujo una regresión alta.** Ahora un símbolo sin bolsa se busca primero en el catálogo, y eso desvía tickers de EE.UU. hacia listados europeos o colombianos. El problema es que la web y los importadores **sí envían símbolos de EE.UU. sin bolsa**: el símbolo de Yahoo de un listado estadounidense es el ticker desnudo. Por eso una posición en DTE Energy recibe precios de Deutsche Telekom, y un ADR de BP recibe el precio en GBP de la acción ordinaria de Londres, aunque 1 ADR equivale a 6 acciones. Todo sin ningún aviso.

También hay una regresión menor: la "semilla" `carried` aparece en series líquidas, y la propia suite en vivo del constructor queda en rojo (1/19).

El resto de lo que el constructor reporta sí está verificado: M32, M33 para la BVC, M34 y M35. Si se corrige M36, la parte vuelve a quedar aprobable con 8.

| | Puntaje |
|---|---|
| **Nuestra parte (market-data + server)** | **7 / 10** (R4: 8) |
| **Mejor competidor para este trabajo: Portfolio Performance** | **7 / 10** |

## Qué se verificó

- `npx vitest run packages/market-data apps/server`: **286 OK**. `tsc --noEmit` limpio en ambos paquetes.
- `LIVE=1 … live.test.ts`: **18/19**. Falla "renamed tickers…" en `live.test.ts:222`: espera 3 puntos y recibe 4 (ver M37). Se reprodujo de forma aislada.
- Scripts nuevos en `scratchpad/review-md/`:
  - `bare.mts`: 31 símbolos sin bolsa, en minúsculas y en mayúsculas mixtas.
  - `seed.mts`: semillas `carried` en series líquidas e ilíquidas.
- Se repitieron los scripts de R4: `thin.mts`, `window.mts` y `snapshot.mts`.
- Se rastreó cómo usan las respuestas la web (`apps/web/src/services/marketData.ts`, `db/repo.ts`) y los importadores (`packages/importers/src/instruments.ts`), para medir el impacto real.

## Respuestas a las dos preguntas del coordinador

**1. ¿Es correcto que `SAP` o `VOD` sin bolsa resuelvan a Xetra o Londres en vez del ADR de EE.UU.? ¿Es ambiguo para alguien?**

No es correcto, y sí es ambiguo. En Yahoo, y en todo nuestro propio flujo de datos, un símbolo sin sufijo **es** el listado de EE.UU.:
- Los importadores generan `providerSymbols.yahoo = yahooSymbol('DTE','XNYS')`, que da `'DTE'`.
- La web pide historia con `providerSymbols.yahoo ?? id` (`marketData.ts:29`).
- Luego guarda la respuesta bajo **su** id (`mergePriceSeries({ ...r.data.series, instrumentId: id })`, `marketData.ts:180`) y añade las acciones corporativas del otro emisor.

Para un usuario colombiano con ADR en un bróker de EE.UU. (IBKR, Trii) es justo el caso que más se rompe. Solo es razonable resolver por catálogo los símbolos BVC/B3 que **no** existen en Yahoo como listado de EE.UU. (ECOPETROL, PFAVAL, GEB). M33 quedó corregido para ellos.

**2. ¿Puede core contar dos veces los puntos `carried` anteriores a `from`, o fechar mal un fin de mes?**

No, por diseño:
- La semilla lleva su fecha real de negociación.
- `mergePriceSeries` no sobrescribe un cierre ya guardado en esa fecha.
- Core rellena hacia adelante: el valor es el correcto. AAPL `from=2026-08-01` → semilla 2026-07-31 = 308,91, el cierre real de julio.

El problema es otro: la semilla también aparece en series **líquidas** cada vez que `from` cae en un día sin negociación. Con `1mo` eso añade un mes **fuera del rango pedido**, y de forma inconsistente (ver M37).

## Gaps de R4, verificación uno por uno

| ID | Estado | Evidencia |
|---|---|---|
| M33 | **Corregido para la BVC** (con la regresión M36) | `ECOPETROL`, `PFAVAL`, `GEB`, `ISA`, `NUTRESA`, `ICOLCAP`, `CEMARGOS`, `PFCIBEST`, `ELCONDOR` y `MINEROS` resuelven a XBOG/COP. Las variantes en minúsculas o mezcladas (`ecopetrol`, `Ecopetrol`, `PfAval`, `petr4`, `aapl`, `brk-b`, `xbog:ecopetrol`, `bvmf:petr4`) funcionan. Un símbolo inexistente (`XYZQWERTY`, `QWERT`) da `NOT_FOUND`. EC, CIB, NU, VALE, PBR y ASML siguen en EE.UU. |
| M32 | **Corregido** (con el efecto secundario M37) | En vivo: ELCONDOR abr-may 2023 da `2023-03-03: 1020` con `carried`, y BAUH4 ago-2026 da `2026-07-17: 93,9` con `carried`. |
| M34 | **Corregido** | `partial`, `coverageFrom` y `coverageTo` en la serie, más la nota "PARTIAL". La primera grabación incluye además los años cerrados (`SNAPSHOT_YEARS`). |
| M35 | **Corregido** | Token comparado mediante resúmenes SHA-256 (`tokenMatches`). Allowlist `https://*.interactivebrokers.com` en `ibkrSync.ts:88`, que rechaza enviar el token a cualquier otro host. `KeyedLock` por cartera, con ejecución diaria en serie y deduplicación bajo el candado. |
| M2 | **Persiste (parcial, mejorado)** | La instantánea ya cubre instrumentos pedidos fuera del catálogo. Sigue sin haber una segunda fuente pública para la BVC. |
| M29 | **Persiste (parcial, mejorado)** | Existe el modo `cotahist`, que lee los archivos oficiales COTAHIST de B3. No hay datos versionados: BRFS3, NTCO3, CPLE5, CPLE6 y CPLE11 siguen sin puntos. |
| M8 | **Persiste (parcial, mejorado)** | Hay un archivo de calendario de dividendos decretados (`MD_DIVIDENDS_FILE`), pero se mantiene a mano y no tiene fuente automática. |
| M15, M13, M18 | **Persisten** | Sin cambios. |

## Gaps abiertos

### M36 (alta, nuevo, regresión). Resolver primero por catálogo desvía tickers de EE.UU. a otra empresa, otra moneda u otra proporción de acciones, sin aviso
- **Evidencia, en vivo** (`quote <símbolo>`):

| Símbolo | Se resuelve a | Debería ser |
|---|---|---|
| `DTE` | XETR:DTE, Deutsche Telekom, 24,98 EUR | DTE Energy, NYSE, ~USD 130 |
| `ALV` | XETR:ALV, Allianz | Autoliv |
| `AIR` | XPAR:AIR, Airbus | AAR Corp |
| `MC` | XPAR:MC, LVMH | Moelis |
| `OR` | XPAR:OR, L'Oréal | Osisko |
| `ETB` | XBOG:ETB | fondo Eaton Vance ETB |
| `BP` | XLON:BP, 5,88 GBP por acción ordinaria | ADR NYSE = 6 acciones ordinarias |
| `VOD` | XLON | ADR = 10 acciones |
| `SHEL` | XLON | ADR = 2 acciones |
| `AZN` | XLON | ADR = 0,5 acciones |
| `SAP`, `SAN`, `BBVA`, `TEF`, `TTE` | EUR en Europa | ADR en USD |

- **Por qué llega a producción**:
  - Los importadores dan `providerSymbols.yahoo = 'DTE'` a `XNYS:DTE`.
  - La web pide `symbol=DTE` y guarda la serie EUR de Deutsche Telekom, más sus dividendos, bajo `XNYS:DTE`.
  - El engine convierte "EUR" a USD y valora DTE Energy en unos USD 27 en lugar de unos USD 130. En un ADR de BP el error ronda el 80 %.
  - Antes de R5 todos estos símbolos resolvían correctamente a EE.UU.
- **Arreglo**:
  - Que un símbolo sin bolsa que exista en Yahoo como listado de EE.UU. siga siendo de EE.UU. (es la semántica de Yahoo).
  - Usar el catálogo primero solo para símbolos de la BVC o B3 sin listado en EE.UU., o cuando la petición no trae un símbolo de proveedor.
  - Además, en la web: pedir por `id` (`XNYS:DTE`) y rechazar o marcar una respuesta cuyo `instrument.id` o moneda no coincida con el instrumento pedido.
  - Añadir una prueba con los símbolos de la tabla.

### M37 (media, nuevo). La semilla `carried` aparece en series líquidas y saca meses fuera del rango; la suite en vivo queda en rojo
- **Evidencia**:
  - `BCOLOMBIA.CL 2025-01-01..2025-03-31 1mo` → `2024-12-31: 37600 (carried)` + ene/feb/mar, es decir, 4 puntos. `PFBCOLOM.CL`, con el mismo rango, da 3 puntos: comportamiento inconsistente.
  - `AAPL 2026-08-01..09-30 1mo` → incluye `2026-07-31 (carried)`.
  - La prueba en vivo del propio constructor falla (`live.test.ts:222`, esperado 3, recibido 4). El "286 tests OK" no incluye la suite en vivo.
  - Para el valor no es un problema (ver la respuesta 2), pero rompe el contrato "puntos dentro de [from, to]" para cualquier cliente que cuente o tabule meses.
- **Arreglo**: sembrar solo si no hay ninguna operación en los primeros N días hábiles de la ventana, o mejor, devolver la semilla en un campo aparte (`seed` o `previous`) y no en `points`. Mantener la suite en vivo en verde antes de reportar.

### M29 (media, persiste parcial). Sin historia de los títulos deslistados
- Ya existe el modo `cotahist`; falta generar y versionar los archivos.

### M2 (media, persiste parcial). Sin segunda fuente pública para la BVC ni Londres

### M15 (media, persiste). Fuentes oficiales de Brasil, BCE y FRED sin validar en vivo

### M8 (baja, persiste parcial). Calendario de dividendos de la BVC mantenido a mano

### M13 (baja, persiste). COLCAP real solo como promedio mensual

### M18 (baja, persiste). ISIN de la BVC fuera del catálogo sin resolver
