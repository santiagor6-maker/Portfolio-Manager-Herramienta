# Revisión R1: Datos de mercado + servidor API (`packages/market-data`, `apps/server`)

Revisor: agente revisor independiente (sin acceso de escritura al código). Fecha: 2026-10-05.

## Veredicto

**No aprobado.** La ingeniería es buena: un único proveedor bien envuelto, con caché, enrutamiento de FX oficial y pruebas serias. Para el caso central de un inversionista emergente (Colombia/Brasil, seguimiento mensual con rentabilidad real) faltan capas enteras de datos: tasas, inflación, renta fija, fondos y un segundo proveedor. Además hay un bug de corrección que **envenena la caché para siempre** con precios 10x incorrectos.

| | Puntaje |
|---|---|
| **Nuestra parte (market-data + server)** | **5 / 10** |
| **Mejor competidor para este trabajo: Portfolio Performance** | **7 / 10** |

¿Por qué Portfolio Performance? Tiene múltiples proveedores intercambiables: Yahoo, Alpha Vantage, EODHD, Finnhub, Twelve Data, CoinGecko, Binance, Kraken, BCE (ECB SDW), Eurostat HICP, proveedores **JSON y tabla HTML genéricos**, CSV y carga manual. Con eso un usuario colombiano o brasileño puede traer TRM, SGS del BCB, valor de unidad de FIC o PU de Tesouro desde cualquier URL. Sus debilidades son que todo exige configuración manual, que no tiene TRM ni PTAX nativos y que no tiene índices BR/CO listos. Gorila sería superior solo para Brasil (renta fija, CDI/IPCA, B3 oficial), pero no cubre Colombia. Sharesight cubre B3 (BVMF, EOD, confirmado en su web), pero no encontré evidencia de soporte para la BVC.

## Qué se verificó (evidencia)

- `npx vitest run packages/market-data apps/server`: **118 pruebas OK** (10 en vivo omitidas). `tsc --noEmit` limpio en ambos paquetes.
- `LIVE=1 npx vitest run packages/market-data/test/live.test.ts`: **10/10 OK**, 200/200 cotizaciones del catálogo, 23/23 cierres mensuales iguales a las barras `1mo` de Yahoo en PETR4/ECOPETROL/AAPL.
- Servidor levantado en `127.0.0.1:18787`, probado con curl y luego detenido.
- Scripts adversariales en `scratchpad/review-md/`: `splits.mts`, `split-fail-cache.mts`, `gbp.mts`, `renames.mts`, `illiquid.mts`, `divs.mts`.
- Fuentes web consultadas: [Sharesight, bolsas soportadas](https://www.sharesight.com/supported-stock-exchanges-managed-funds-mutual-funds/) y [blog LatAm](https://www.sharesight.com/blog/track-latin-american-stocks-with-sharesight/) (B3/BVMF EOD confirmado; Colombia no confirmado); [Ghostfolio, fuentes de datos](https://deepwiki.com/ghostfolio/ghostfolio/5.2-market-data-sources) (Yahoo, CoinGecko, Alpha Vantage, EOD, FMP, Google Sheets, Manual, Rapid-API); [Portfolio Performance, manual de precios](https://help.portfolio-performance.info/en/how-to/downloading-historical-prices/) y [proveedor JSON](https://help.portfolio-performance.info/en/how-to/downloading-historical-prices/json/); [Kinvo, conexión B3](https://suporte.kinvo.com.br/articles/93dc3576-86a1-4f73-9011-3e34d2186a7e) (Tesouro, FII, BDR; agenda de proventos/JCP). Lo dicho sobre Kubera, Snowball, Delta, Stock Events, Gorila y Status Invest viene **de conocimiento previo, no verificado hoy**.

## Mejor que la competencia

1. **Cierres "tal como se negociaron" con des-ajuste de splits correcto en datos reales.** NVDA 10:1 (1208.88 → 121.79), AAPL 4:1, TSLA 3:1, PETR4 2:1 (2008), WEGE3 (4 eventos), ITUB4 (3), BBAS3 2:1, GE 1:8 inverso y CNEC 1:5 inverso. En todos, el salto bruto coincide con la razón. Ghostfolio y Kubera trabajan con precios ajustados.
2. **TRM con semántica de vigencia correcta.** Comprobado contra datos.gov.co en vivo: 4409.15 vigente del 31-dic-2024 al 2-ene-2025 y 4355.51 del 4 al 7-ene-2025. Se expande a días calendario, así que el 31-dic (patrimonio) usa la TRM correcta. Ningún competidor global trae TRM oficial.
3. **Enrutamiento de FX oficial con trazabilidad.** `source` y `fallbacks` (TRM → PTAX → SGS → BCE → Yahoo) y triangulación oficial (`ecb*banrep-trm`).
4. **Fin de mes real.** Se usa el último día hábil con su fecha, no la barra `1mo` de Yahoo fechada el día 01.
5. **GBp bien resuelto, incluidos dividendos declarados en USD.** HSBA 0.0758 GBP ≈ 0.10 USD, RIO 2.0377 ≈ 2.58 USD, AZN 1.56 ≈ 1.97 USD, ISF 4.75p → 0.0475.
6. **Catálogo curado con renombres de 2025 ya resueltos.** CIBEST/PFCIBEST, AXIA3, EMBJ3, MOTV3. Buscar "bancolombia" devuelve Cibest. El historial de Yahoo bajo el nuevo ticker llega hasta 2019.
7. **Caché de dos niveles** con dedupe en vuelo, stale-if-error, ritmo por host y reintentos con Retry-After. Buenas pruebas con fixtures reales.

## Peor que la competencia

1. **Un solo proveedor de precios (Yahoo, no oficial).** Ghostfolio, Portfolio Performance, Sharesight, Kubera y Gorila tienen varios o licenciados.
2. **Cero tasas e inflación.** No hay CDI, Selic, IPCA, IPC, IBR ni DTF. Gorila, Kinvo y Status Invest las traen de serie.
3. **Cero renta fija y fondos.** No hay Tesouro Direto, CDB, CDT ni FIC, que son el grueso del patrimonio de un inversionista colombiano o brasileño típico. Gorila y Kinvo los traen automáticamente.
4. **Eventos corporativos pobres.** Todo sale como `SPLIT` o `DIVIDEND`: no distingue bonificação, spin-off ni JCP, y no da fecha de pago. Gorila, Kinvo y Sharesight lo distinguen.
5. **Sin historial de tickers.** Los símbolos viejos dan 404 y no hay alias. Sharesight maneja los cambios de código.
6. **COLCAP solo por proxy ETF.**
7. **Seguridad del servidor** pensada para localhost, pero con valores por defecto de servidor público (detalle en los gaps).

## Gaps numerados

### M1 (alta). Un fallo transitorio del historial de splits envenena la caché con precios 10x incorrectos para siempre
- **Evidencia** (`split-fail-cache.mts`): NVDA 2024-01-02..09 con el endpoint `interval=3mo&events=splits` respondiendo 503.
  - Esperado: 481.68, 475.69, 479.98 (tal como se negoció).
  - Real: **48.17, 47.57, 48** (ajustado), sin ninguna nota.
  - Se guardó con `expiresAt: null` en el store persistente. Una segunda instancia con el endpoint ya sano sigue devolviendo 48.17, y un rango distinto devuelve 481.68: dos respuestas incompatibles para el mismo día.
- **Causa**: `yahoo.ts:508` `this.splits(symbol).catch(() => [])` + `historyTtlMs` inmutable.
- **Arreglo**: si falla la historia de splits, propagar el error o devolver el dato con TTL corto (≤1 h) y una nota `splits-unavailable`. Nunca persistir como inmutable un resultado degradado. Añadir prueba.

### M2 (alta). Sin segundo proveedor de precios
- **Evidencia**: `PriceProvider` tiene una sola implementación (Yahoo, vía endpoints no documentados con User-Agent falso). Si Yahoo cambia `v8/chart` o bloquea, solo queda la caché vencida.
- **Arreglo**: cadena de proveedores de precios como la de FX: brapi o B3 para Brasil, BVC/Investing o EODHD para Colombia, stooq o Twelve Data para EE.UU./Europa. Detectar divergencias entre proveedores y dar opción manual por instrumento.

### M3 (alta). Sin series de tasas ni inflación: no hay rentabilidad real ni devengo de CDT/CDB
- **Evidencia**: no existe ningún endpoint ni proveedor para:
  - BCB SGS 12 (CDI diario), 11 (Selic diaria), 4389 (CDI anualizado), 433 (IPCA mensual).
  - IPC Colombia (DANE / Banrep), IBR o DTF.
- **Arreglo**: crear un `RateProvider` con `/api/rates?series=CDI|SELIC|IPCA|IPC_CO|IBR&from=`, con índice acumulado mensual y fecha de publicación. El IPCA y el IPC se publican con rezago, así que hace falta un flag `provisional`.

### M4 (alta). Sin precios de renta fija ni fondos colombianos y brasileños
- **Evidencia**: búsquedas `tesouro direto` → `[]` y `fondo renta fija` → `[]`. El README los remite a `pricing: 'manual'`.
- **Arreglo**:
  - Tesouro Direto: PU diario desde el CSV de Tesouro Transparente.
  - FIC: valor de unidad publicado por la Superfinanciera (datos abiertos).
  - CDT/CDB: motor de devengo con % del CDI/IBR o tasa fija sobre las series de M3.

### M5 (alta). Tickers renombrados sin alias: el historial importado se rompe
- **Evidencia** (`renames.mts`): `PFBCOLOM.CL`, `BCOLOMBIA.CL`, `XBOG:PFBCOLOM`, `ELET3.SA`, `EMBR3.SA` y `CCRO3.SA` dan **NOT_FOUND**, sin pista de "renombrado a…". Un extracto de comisionista de 2023 con PFBCOLOM no se puede valorar.
- **Arreglo**: añadir `formerSymbols: [{symbol, until}]` al catálogo, resolver alias en `resolve()` con una nota `renamed`, y devolver un 404 con sugerencia (`details.suggest: 'XBOG:PFCIBEST'`).

### M6 (media). Precios fantasma en acciones suspendidas: el historial contradice la cotización
- **Evidencia** (`illiquid.mts`):
  - `CNEC.CL` historial diario: **213 cierres idénticos de 6240** desde 2025-12-03 hasta 2026-10-02.
  - `/quote` del mismo símbolo: price **5000**, `date: 2025-11-14`, `stale: true`.
  - El fin de mes de sept-2026 sale 6240: un 25 % de diferencia con la cotización y sin ningún aviso.
- **Arreglo**: detectar rachas planas o barras sin volumen después del último `regularMarketTime`, truncarlas o marcarlas, añadir `stale`/`lastTradeDate` a `PriceSeries` y alinear historial con cotización.

### M7 (media). Bonificações y spin-offs salen como `SPLIT`
- **Evidencia** (`splits.mts`):
  - ITUB4 2025-03-18 con razón 1.1 y WEGE3 con 1.3 son bonificações (en Brasil tienen costo atribuído a efectos de IR). Core ya tiene `STOCK_DIVIDEND`.
  - GE 2024-04-02 con "ratio 1.253" es la **escisión de GE Vernova**, no un split. Aplicarla como split infla la cantidad de GE en un 25,3 % y omite las acciones GEV.
- **Arreglo**:
  - Razones no enteras de B3 → `STOCK_DIVIDEND`.
  - Lista de spin-offs conocidos, o heurística (razón no "redonda" en EE.UU. → `review_required`).
  - Nunca auto-aplicar sin confirmación.

### M8 (media). Dividendos incompletos
- **Evidencia**:
  - `CorporateAction` de dividendo solo trae `date` (fecha ex). No trae fecha de pago, tipo (JCP o dividendo, que tributan distinto) ni moneda del dividendo.
  - VUSA.L y VWRL.L: 0.237 y 0.618 en "GBP" coinciden con distribuciones declaradas en **USD**. Probable error de moneda del 20-25 %; verificar.
  - Para Colombia (pago en cuotas, p. ej. ECOPETROL 156 + 156) no hay fecha de pago real.
- **Arreglo**: añadir `exDate`/`payDate`/`kind`/`currency`, con fuentes B3 (proventos) y BVC (calendario de dividendos) y un override manual.

### M9 (media). IDs de instrumento no reversibles para bolsas no mapeadas
- **Evidencia**:
  - `GET /api/history?symbol=0254.HK` → `instrument.id = "XNYS:0254.HK"`, `country: "US"`. Lo mismo con `7203.T`, `RELIANCE.NS`, `5614.KL` y `ISAT.JK`.
  - Al usar ese mismo id: `symbol=XNYS:0254.HK` → **NOT_FOUND "0254-HK"** (convierte el `.` en `-`).
  - La búsqueda ofrece estos resultados con id roto.
- **Arreglo**: para sufijos desconocidos usar un MIC genérico `YAHOO:` o no reescribir `.`. Ampliar `MARKETS` (HK, T, NS, AX, KS, TW, JK, KL). Prueba de ida y vuelta id↔símbolo para todo resultado de búsqueda.

### M10 (media). Servidor como proxy abierto: CORS `*` + bind `0.0.0.0` + sin auth ni límite por cliente
- **Evidencia**:
  - `Origin: https://evil.example` → `access-control-allow-origin: *` en GET y en el preflight de POST `/api/batch`.
  - Cualquier web que visite el usuario puede usar su servidor para martillar Yahoo desde su IP (riesgo de baneo).
  - Amplificación: un `batch` admite 200 ítems; un historial diario de 56 años pesa ~530 KB, así que una petición genera ~100 MB de respuesta y 400 llamadas a Yahoo (historial + splits).
- **Arreglo**:
  - Por defecto `HOST=127.0.0.1` y CORS restringido al origen de la web.
  - Token opcional y límite por IP (token bucket).
  - Tope de puntos totales por respuesta en `batch` (o forzar `1mo` en batch).

### M11 (media). El límite de cuerpo de 256 KB se evade con `Transfer-Encoding: chunked`
- **Evidencia**: el mismo JSON de 5,2 MB devuelve 400 con `Content-Length` y **200 OK** con chunked. Se debe a que `app.ts:522` solo mira la cabecera.
- **Arreglo**: usar `hono/body-limit` (cuenta los bytes leídos) o leer el stream con contador.

### M12 (baja). Se salta la validación de símbolo con la forma `MIC:SYM`: escape de ruta hacia otro endpoint de Yahoo
- **Evidencia**:
  - `symbol=CRYPTO:..` → el servidor pide `https://query2.finance.yahoo.com/v8/finance/` (log: `upstream .../v8/finance/ -> 404`), porque el `..` se normaliza en la URL.
  - `XNYS:..` → `-.`.
  - En `batch` la longitud no tiene límite.
  - No es SSRF a otros hosts (el host está fijo), pero la regex `^[\w.^=\-&]{1,32}$` solo se aplica a símbolos sin `:`.
- **Arreglo**: validar la parte del símbolo de todo id con la misma regex y longitud máxima, y rechazar `.`/`..`.

### M13 (media). COLCAP solo como proxy (ICOLCAP)
- **Evidencia**: benchmark `COLCAP` → `XBOG:ICOLCAP`, que incluye costos y distribuye dividendos, así que no es el índice de precios. Comparar un portafolio con el COLCAP real da un sesgo sistemático.
- **Arreglo**: obtener la serie diaria del índice desde la BVC o Investing como segundo proveedor, o calcular un "ICOLCAP total return" con sus dividendos y etiquetarlo así. Hacer lo mismo con MSCI World (URTH).

### M14 (media). El último punto del mes en curso es un precio intradía sin marca
- **Evidencia**: `history?symbol=PETR4.SA&interval=1mo` en plena sesión → `{date: 2026-10-05, close: 54.45}`, sin `notes` ni `provisional`. La cotización simultánea marcaba 54.05 → 54.45.
- **Arreglo**: añadir `asOf`, `provisional: true` y `marketState` al último punto si es la sesión en curso. Hoy el usuario no sabe si el "cierre" de octubre es final.

### M15 (media). PTAX, SGS y BCE sin validar contra los servicios reales
- **Evidencia**: el README admite que los fixtures son **sintéticos**. En el contenedor todo cae a Yahoo (`BRL/COP source=yahoo, fallbacks cross:USD`). Solo se expone PTAX **venta**. Según mi conocimiento (no verificado hoy), la Receita usa la **compra** para ciertos saldos en moneda extranjera de la DIRPF.
- **Arreglo**: regrabar los fixtures en una máquina con acceso, añadir prueba en vivo condicionada, y ofrecer `side=compra|venta` en PTAX.

### M16 (baja). Caché de disco sin límite ni invalidación
- **Evidencia**:
  - Cada combinación distinta (símbolo, from, to) genera un archivo inmutable. Tras unas pocas pruebas ya había 26 archivos, y un cliente que varíe `from` crea miles.
  - No hay evicción ni forma de purgar una corrección de Yahoo: lo inmutable lo es para siempre.
- **Arreglo**: cachear por símbolo y año (fragmentos canónicos) y recortar en memoria, añadir LRU o tamaño máximo en `FileStore` y un endpoint o CLI de invalidación.

### M17 (baja). El `batch` sin validación de esquema filtra errores internos
- **Evidencia**: `{"histories":[null], "quotes":[123]}` devuelve `INTERNAL "Cannot read properties of null (reading 'from')"` e `INTERNAL "(input ?? \"\").trim is not a function"`.
- **Arreglo**: validar con zod o similar y responder `BAD_REQUEST` por ítem.

### M18 (baja). ISIN y búsqueda limitados
- **Evidencia**:
  - ISIN solo para 88 instrumentos del catálogo: `COB04PA00026` → `[]`.
  - "itaú" devuelve ITA (aeroespacial EE.UU.) y Poste Italiane.
  - "isa" devuelve Visa (por coincidencia de subcadena).
- **Arreglo**: buscar el ISIN en Yahoo/OpenFIGI, penalizar coincidencias de subcadena dentro de palabras y filtrar ruido por país preferido del usuario.

### M19 (baja). Cripto solo vía Yahoo (`BTC-USD`)
- **Evidencia**: no hay CoinGecko ni pares cripto en `/api/fx`.
- **Arreglo**: añadir un proveedor CoinGecko detrás de `PriceProvider`.

## Resumen de corrección (lo que SÍ está bien)

- Des-ajuste de splits: correcto en 10 casos reales. El límite `s.date > date` es correcto porque el día ex ya cotiza post-split.
- TRM: la vigencia es correcta, con relleno de fines de semana y festivos.
- GBp: correcto en precios y dividendos de acciones (HSBA, BP, SHEL, RIO, AZN, ISF). CSPX.L se deja en USD.
- Fin de mes: alineado con el último día hábil (23/23 en vivo).
- Errores HTTP: códigos coherentes (400/404/422/502/503/504). Los 429 se reintentan y se mapean a 503.
- Timezone: BVC con `America/New_York` cae en la fecha correcta y FX de Yahoo se fecha bien con Europe/London. "Hoy" se calcula en UTC; no encontré un caso que rompa cierres, pero `stale` y los TTL no usan la zona de la bolsa (menor).
