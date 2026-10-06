# @pm/market-data

Precios, dividendos/splits, tasas de cambio y búsqueda de instrumentos para **Portafolio Pro**
(BVC, B3, Europa, EE.UU.). Lo usa `apps/server` (lado servidor) y la web a través del cliente
tipado `@pm/market-data/client` (sin dependencias de Node, apto para navegador).

## Arquitectura

```
MarketDataService ── resolve(id | símbolo | ISIN | benchmark | ticker antiguo) ── catálogo + alias de renombres
   │
   ├── Precios (cadena con failover):
   │     Yahoo (caché por símbolo y año, as-traded) → Twelve Data / FMP / EODHD / Alpha Vantage (si hay clave)
   │     → brapi (B3) → stooq → CoinGecko (cripto);  feeds definidos por el usuario (JSON/CSV) tienen prioridad
   ├── Tesouro Direto (CSV Tesouro Transparente) · FIC y fondos de pensiones (Superfinanciera, datos.gov.co)
   ├── IndexService (/api/index): BCB SGS (CDI, Selic, IPCA...), BanRep SDMX (UVR, IBR, DTF, TPM, COLCAP),
   │     IPC Colombia derivado de la UVR, FRED (CPI EE.UU.), BCE (HICP)
   ├── FxRouter: TRM (datos.gov.co → BanRep SDMX) · PTAX (compra/venta) → SGS · BCE · Yahoo · CoinGecko
   ├── TieredCache: LRU en memoria + PersistentStore (FileStore acotado en el servidor), stale-if-error
   └── HttpClient: User-Agent de navegador, concurrencia y ritmo por host, reintentos 429/5xx, timeouts, dedupe
```

Archivos: `src/service.ts`, `src/providers/*.ts` (yahoo, brapi, stooq, keyed, custom, coingecko, tesouro,
superfin, banrep, banrep-sdmx, bcb, ecb), `src/indices.ts`, `src/fx-router.ts`, `src/corporate.ts`,
`src/aliases.ts`, `src/templates.ts`, `src/cache.ts`, `src/http.ts`, `src/symbols.ts`, `src/series.ts`,
`src/catalog.ts`, `src/client.ts`, `src/types.ts`.


## Decisiones importantes (verificadas con datos reales)

- **Cierres "tal como se negociaron".** Yahoo ajusta retroactivamente `close` por splits (NVDA
  cotizaba ~1.150 USD antes del split 10:1 del 10-jun-2024; Yahoo muestra ~115), incluso si el
  rango pedido termina antes del split. También ajusta los dividendos. Deshacemos el ajuste con
  la historia completa de splits del símbolo (`interval=3mo&events=splits`, caché de 1 día).
  Así el precio cuadra con las cantidades de las transacciones (los splits son transacciones
  `SPLIT`) y los meses cerrados son **inmutables**, lo que permite cachearlos para siempre.
  `adjust=splits` devuelve la serie ajustada (útil para gráficos largos).
- **Cierres de fin de mes desde datos diarios**, no desde las barras `1mo` de Yahoo. Comprobado
  en vivo (PETR4.SA, ECOPETROL.CL, AAPL, 2 años): en meses cerrados el valor coincide (23/23),
  pero Yahoo **fecha cada barra el día 1** del mes y la última barra ignora `period2` (trae el
  precio en vivo). Nosotros devolvemos el último día hábil real de cada mes con su fecha; el mes
  en curso trae el último cierre disponible.
- **Londres en peniques.** `meta.currency = "GBp"` → dividimos precios **y dividendos** entre 100
  y devolvemos `GBP`. Ojo: muchos ETF de LSE cotizan en USD (CSPX.L, IWDA.L, VWRA.L) o en GBP
  (VWRL.L); siempre se usa la moneda de `meta`. Se reparan valores sueltos con error de 100x.
  También se normalizan `ZAc` y `ILA`.
- **BVC**: Yahoo reporta la zona horaria `America/New_York` para `.CL`; las barras siguen cayendo
  en la fecha local correcta. Los festivos colombianos llegan como barras `null` y se descartan.
- **Cotización**: `v7/finance/quote` responde 401 sin cookie+crumb, así que usamos el `meta` del
  chart (`regularMarketPrice`, `chartPreviousClose`). `stale: true` si el último precio tiene más
  de 7 días.
- **TRM**: cada registro de datos.gov.co tiene `vigenciadesde`/`vigenciahasta`; la TRM aplica a
  todos los días calendario (sábado, domingo, festivos). Expandimos a un punto por día, de modo
  que la TRM del 31-dic (patrimonio) o de cualquier fin de mes es exactamente la vigente.

## Enrutamiento de FX (`source`)

| Par | `auto` / `official` | Respaldo (`auto`) |
|---|---|---|
| USD/COP, COP/USD | `banrep-trm` (datos.gov.co) → `banrep-sdmx` (BanRep) | `yahoo` |
| X/BRL (USD, EUR, GBP, CHF, JPY, CAD, AUD, DKK, NOK, SEK) | `bcb-ptax` (venda, boletim de fechamento) → `bcb-sgs` (USD, EUR) → `ecb` (cruce) | `yahoo` |
| EUR/X y cruces entre monedas del BCE (USD/GBP, USD/MXN, CHF/USD...) | `ecb` | `yahoo` |
| Sin fuente directa pero con ambas patas oficiales vs USD (EUR/COP, BRL/COP, MXN/COP...) | triangulación `ecb*banrep-trm`, `bcb-ptax*banrep-trm` | `yahoo` |
| CLP, PEN y otros | — (`official` → error 422) | `yahoo` |

Se prioriza el banco central local de la moneda emergente (EUR/BRL → PTAX antes que BCE).
`side=buy|sell` (en el servidor también `compra|venda`) elige la PTAX de compra o de venta (venta por defecto).
La compra solo la publica el BCB (PTAX → SGS 10813 para USD): nunca se responde con un tipo medio de otra fuente.
Los pares cripto (BTC/USD, ETH/BRL...) usan Yahoo (`BTC-USD`) con CoinGecko como respaldo.
Cada fallo queda en `fallbacks: [{source, error}]` y la fuente que respondió en `series.source`.
Yahoo: pares sin USD (p. ej. `BRLCOP=X`, casi sin historia) se triangulan con `BRL=X` y `COP=X`.
Un resultado obtenido tras un fallo de la fuente preferida se cachea solo 1 hora.

## Caché y TTL

Los precios de Yahoo se guardan en **fragmentos canónicos por símbolo y año** (`hist:v2:yahoo:SÍMBOLO:AÑO`)
con cierres tal como se negociaron. Un rango cualquiera se arma con esos fragmentos y solo se descargan los
años que faltan (en una sola petición). Así la caché está acotada por símbolos × años, no por rangos pedidos.

| Dato | TTL |
|---|---|
| Año cerrado (Yahoo, as-traded, completo) | inmutable (se persiste en disco) |
| Año en curso | 10 min |
| Resultado degradado (sin historia de splits) | 5 min, nunca se persiste |
| Respuesta de un proveedor de respaldo | ≤ 1 h, no se persiste |
| Cotización | 10 min (`quoteTtlMs`) |
| Búsqueda en Yahoo, historia de splits, detalle de dividendos brapi | 1 día (fallos de brapi: 1 h) |
| Índices: rango que termina hace más de 2 meses | inmutable; si no, 30 min (diarios) / 6 h (mensuales) |
| Tesouro Direto (archivo completo) | 12 h en memoria, no se persiste |

Si el proveedor falla y hay una entrada vencida, se sirve la vencida (*stale-if-error*). `FileStore` poda
los archivos menos usados por encima de `CACHE_MAX_FILES`, y `DELETE /api/cache?symbol=` (o
`service.invalidate()`) borra un símbolo para recoger una corrección del proveedor.


## Catálogo curado (`src/catalog/instruments.json`)

201 instrumentos validados uno a uno contra Yahoo (el test en vivo cotiza los 201; última corrida 2026-10-06: 201/201):
30 BVC, 75 B3 (líderes del Ibovespa, 9 FII, 7 ETF), 44 EE.UU. (acciones, ETF, ADR latinoamericanos),
39 Europa/LatAm (Madrid, Xetra, París, Ámsterdam, Milán, Suiza, Londres, México, Santiago) y
9 índices, más VUSA.L (dividendos en USD). Solo hay ISIN donde hay certeza: 89, todos con dígito de control
válido. Benchmarks: `COLCAP` (ICOLCAP con `adjust=total`), `IBOV` (^BVSP), `SPX` (^GSPC), `MSCI_WORLD` (URTH con
`adjust=total`), `SX5E` (^STOXX50E), `NASDAQ`, `IPC`, `MSCI_ACWI`, `MSCI_EM`. El COLCAP real (promedio mensual)
está en `/api/index?id=COLCAP_AVG`.

Hallazgos al validar:
- **Bancolombia** ya no existe en BVC como `PFBCOLOM`/`BCOLOMBIA` (404): tras la reorganización
  de 2025 es **Grupo Cibest**: `CIBEST.CL` y `PFCIBEST.CL` (ADR `CIB`). Buscar "bancolombia"
  devuelve estos dos.
- **Nutresa** (`NUTRESA.CL`) sigue cotizando (318.340 COP, muy ilíquida tras las OPA).
- **Canacol** (`CNEC.CL`) sin precio desde 2025-11-14: excluida.
- Renombres en B3: ELET3 → **AXIA3**, EMBR3 → **EMBJ3**, CCRO3 → **MOTV3**, NTCO3 → **NATU3**,
  BRFS3 → **MBRF3**, CPLE6 → **CPLE3**. Yahoo reporta los FII y ETF de B3 como `EQUITY`: la clase
  de activo sale del catálogo o de una heurística por nombre (FII/Imobiliário → `reit`,
  "Índice" → `etf`).
- **COLCAP**: `^COLCAP` no existe en Yahoo y el índice MSCI COLCAP (`^737809-COP-STRD`) solo trae
  el último valor, sin historia. Se usa el ETF ICOLCAP como proxy.
- **Lima (`.LM`)**: Yahoo dejó de publicar datos en 2019 (sin moneda). Para Perú usar las acciones
  listadas en NYSE (BAP, SCCO, BVN).
- Roche es `RO.SW` (`ROG.SW` da 404). GXG/ICOL (ETF de Colombia en EE.UU.) ya no existen.

## Uso

```ts
import { MarketDataService } from '@pm/market-data';
const md = new MarketDataService();            // opcional: { store, now, fetch, quoteTtlMs }
await md.history({ symbol: 'BVMF:PETR4', from: '2024-01-01', interval: '1mo' });
await md.fxSeries({ base: 'USD', quote: 'COP', from: '2024-01-01', interval: '1mo' });
await md.quote('ECOPETROL.CL');
await md.search('iberdrola');
```

Navegador:

```ts
import { MarketDataClient } from '@pm/market-data/client';
const api = new MarketDataClient({ baseUrl: 'http://localhost:8787' });
const r = await api.monthEndData(['XBOG:ECOPETROL', 'BVMF:PETR4'], ['COP', 'BRL'], 'USD', '2024-01-01');
```

`symbol` acepta: id de instrumento (`MIC:SÍMBOLO`, p. ej. `XBOG:ECOPETROL`, `XNAS:AAPL`,
`INDEX:^GSPC`), símbolo de Yahoo (`PETR4.SA`), ISIN del catálogo o id de benchmark (`COLCAP`).
Mapeo de sufijos: `.CL` XBOG/COP, `.SA` BVMF/BRL, `.MC` XMAD, `.DE` XETR, `.PA` XPAR, `.AS` XAMS,
`.MI` XMIL (EUR), `.L` XLON (GBP/GBp), `.SW` XSWX/CHF, `.MX` XMEX/MXN, `.SN` XSGO/CLP,
`.LM` XLIM/PEN; EE.UU. sin sufijo (NMS/NGM→XNAS, NYQ→XNYS, PCX→ARCX, PNK→OTC).

## Pruebas

```bash
npx vitest run packages/market-data apps/server      # sin red: fixtures grabados
npx tsc -p packages/market-data --noEmit
LIVE=1 npx vitest run packages/market-data/test/live.test.ts   # opcional, contra los servicios reales
```

`test/round2.test.ts` tiene una prueba de regresión por cada gap de la revisión R1, y reproduce sin red los
scripts del revisor (`split-fail-cache`, `splits`, `gbp`/`divs`, `renames`, `illiquid`).

Fixtures (`test/fixtures/`):
- **Reales**, grabados el 2026-10-05 con curl: Yahoo, datos.gov.co (TRM, FIC, AFP), BanRep SDMX y CoinGecko.
- **Sintéticos**, con el formato documentado, porque estos servicios no son accesibles desde el contenedor:
  BCB (PTAX, SGS 1/10813/21619/12/11/4389/433), BCE (EXR, ICP), FRED, Tesouro Transparente, brapi, stooq,
  FMP, EODHD, Alpha Vantage y Twelve Data. Conviene regrabarlos en una máquina con acceso.


## Pendiente

- Validar contra los servicios reales lo que el contenedor no alcanza (todo devuelve 403): PTAX/SGS (incluidos
  CDI, Selic e IPCA), BCE, FRED, Tesouro Transparente, brapi, stooq y los proveedores con clave. El código sigue
  la documentación, el router y la cadena de precios caen al siguiente proveedor y lo registran.
- No hay serie diaria del COLCAP: Yahoo no la tiene y BanRep publica solo el promedio mensual.
- En Colombia (BVC) no hay fecha de pago de dividendos. Solo B3 la trae, vía brapi y con `BRAPI_TOKEN`.
- Las fechas efectivas de los renombres no están verificadas, así que la tabla de alias las deja vacías. Las
  relaciones de canje de NTCO3→NATU3, BRFS3/MRFG3→MBRF3 y CPLE6→CPLE3 se asumen 1:1 y hay que verificarlas.
- Los spin-offs fuera de la lista conocida (GE/GEV, GE/GEHC, MMM/SOLV) se marcan `reviewRequired` sin
  instrumento destino.


## Proveedores de precios y failover

| Proveedor | Cobertura | Clave | Cierres | Estado desde el contenedor |
|---|---|---|---|---|
| Yahoo (primario) | todo el mundo, índices, FX, cripto | no | as-traded (des-ajustados) | OK |
| Twelve Data | MIC (`mic_code`), incluye LSE con GBp | `TWELVEDATA_API_KEY` | as-traded (`adjust=none`) | bloqueado (fixture) |
| FMP | EE.UU. + sufijos estilo Yahoo (sin LSE ni BVC) | `FMP_API_KEY` | ajustados por splits | bloqueado (fixture) |
| EODHD | EE.UU., Europa, B3, MX, CL, CA... (sin LSE) | `EODHD_API_TOKEN` | as-traded | bloqueado (fixture) |
| Alpha Vantage | EE.UU., B3, Xetra, TSX | `ALPHAVANTAGE_API_KEY` | as-traded (100 días sin premium) | bloqueado (fixture) |
| brapi | B3 (sin token: PETR4, VALE3, ITUB4, MGLU3) | `BRAPI_TOKEN` opcional | as-traded; dividendos con JCP y fecha de pago | bloqueado (fixture) |
| stooq | EE.UU., Xetra, Tokio, HK, índices | `STOOQ_API_KEY` opcional | ajustados por splits | bloqueado (fixture) |
| CoinGecko | cripto (365 días sin clave; sin COP) | `COINGECKO_API_KEY` opcional | precio diario | OK |
| Feeds del usuario | cualquier URL JSON (JSONPath) o CSV | — | según la fuente | — |

El servicio intenta Yahoo y, si falla, el siguiente proveedor que cubra el instrumento. La respuesta indica
`series.source` y `fallbacks` (proveedor y error de cada intento). Las respuestas de respaldo se cachean como
máximo 1 h y no se persisten. Los cierres de fuentes ajustadas por splits llevan una nota.

Feeds definidos por el usuario (como los proveedores JSON y tabla de Portfolio Performance): `MD_CUSTOM_FEEDS_FILE` apunta
a un JSON con `[{ id, name, currency, feed: { type: 'json'|'csv', url, datePath, closePath | dateColumn, closeColumn,
delimiter, decimal, dateFormat } }]`. La URL acepta `{SYMBOL} {FROM} {TO} {FROM_DMY} {TO_DMY} {FROM_EPOCH} {TO_EPOCH}`.
Los feeds solo se configuran en el servidor, nunca desde una petición, para que no sirvan de proxy abierto.

## Índices de tasas e inflación (`/api/index`)

La salida usa exactamente el `IndexSeries` de `@pm/core` (`kind`, `period`, `unit`, `dayCount`, `currency`,
`points`, `source`) y añade `info` y `notes`.

| id | kind | Fuente | Verificado |
|---|---|---|---|
| CDI, SELIC | periodRate/day, BUS/252 | BCB SGS 12, 11 | fixture (bloqueado) |
| CDI_ANUAL, SELIC_META | annualRate BUS/252 | SGS 4389, 432 | fixture |
| IPCA, IGPM, INPC | periodRate/month (fecha = día 1 del mes) | SGS 433, 189, 188 | fixture |
| IPC_CO | periodRate/month | **derivado de la UVR** (BanRep) | **en vivo: idéntico al DANE** |
| UVR | level diario (COP) | BanRep SDMX DF_UVR_DAILY_HIST | en vivo |
| IBR / IBR_1M / IBR_3M / IBR_6M | annualRate nominal ACT/360 | BanRep SDMX DF_IBR_DAILY_HIST | en vivo |
| IBR_EA (y variantes `_EA`) | annualRate E.A. ACT/365 | BanRep SDMX | en vivo |
| DTF | annualRate E.A. ACT/365 | BanRep SDMX DF_DTF_DAILY_HIST | en vivo |
| TPM_CO | annualRate | BanRep SDMX DF_CBR_DAILY_HIST | en vivo |
| COLCAP_AVG | level mensual (**promedio**, fechado fin de mes) | BanRep SDMX | en vivo |
| CPI_US | level mensual (fin de mes) | FRED CPIAUCSL | fixture |
| HICP_EA | level mensual | BCE ICP | fixture |

IPC Colombia: el DANE no es accesible y datos.gov.co no publica el IPC. Por la fórmula legal de la UVR (Ley
546/1999), entre el día 16 del mes m+1 y el 15 del mes m+2 la UVR crece exactamente la variación del IPC del
mes m. Por eso `IPC_m = UVR(15 de m+2) / UVR(15 de m+1) − 1`, redondeado a 2 decimales como lo publica el DANE.
Comprobado en vivo: dic-2024 0,46 %, ene-2025 0,94 %, feb-2025 1,14 %, mar-2025 0,52 %.

Hallazgos en el servicio SDMX de BanRep (`totoro.banrep.gov.co/nsi-jax-ws`):
- la clave debe ser `all/all`;
- `endPeriod` se rechaza, así que el recorte por fecha se hace localmente;
- `startPeriod` se aplica por año completo;
- las respuestas tardan entre 5 y 7 s, por eso se cachean 6 h.

## Renta fija y fondos

- **Tesouro Direto** (`TD:<código>-<vencimiento>`, p. ej. `TD:NTNBP-2035-05-15` = Tesouro IPCA+ 2035):
  precio = PU de venta (resgate antecipado). Viene del CSV de Tesouro Transparente y aparece en la búsqueda
  ("tesouro ipca", "selic", "prefixado"...).
- **FIC colombianos** (`FIC:<tipo_entidad>-<entidad>-<negocio>-<participación>`): valor de unidad diario del
  dataset qhpu-8ixx de la Superfinanciera. Se buscan por nombre ("fiducuenta"). Verificado en vivo.
- **Fondos de pensiones obligatorias y cesantías** (`AFP:<entidad>-<patrimonio>`): dataset uawh-cjvi.
  Verificado en vivo.
- **CDT / CDB / LCI / LCA / debêntures**: plantillas (`TEMPLATE:CDT-IBR`, `TEMPLATE:CDB-CDI`...) con el
  `AccrualSpec` de core, para que el motor las valore por devengo sobre los índices de `/api/index`.

## Respuesta a la revisión ronda 1

| Gap | Severidad | Corrección | Prueba |
|---|---|---|---|
| M1 | alta | Si falla la historia de splits, el resultado se marca `degraded`, con nota y `Cache-Control: no-store`. Se cachea 5 min solo en memoria y nunca se persiste. Si el rango llega al presente, ya no hace falta esa historia. | `round2` M1: reproduce 48.17 → 481.68 con el mismo store |
| M2 | alta | Cadena de proveedores con failover: Twelve Data, FMP, EODHD y Alpha Vantage (por variables de entorno), más brapi, stooq y CoinGecko sin clave, y feeds JSON/CSV del usuario. Se reportan `source` y `fallbacks`. | `round2` M2 (cada proveedor, cuota de Alpha Vantage, feeds) |
| M3 | alta | `/api/index` (+ alias `/api/rates` y `indices` en batch) con forma `IndexSeries` de core: CDI, SELIC, CDI_ANUAL, SELIC_META, IPCA, IGPM, INPC (SGS); UVR, IBR (4 plazos × nominal/E.A.), DTF, TPM_CO y COLCAP_AVG (BanRep SDMX); IPC_CO derivado de la UVR; CPI_US (FRED) y HICP_EA (BCE). | `round2` M3 + vivo (IPC_CO = DANE) |
| M4 | alta | Tesouro Direto (CSV), FIC y fondos de pensiones (Superfinanciera, en vivo) y plantillas CDT/CDB con `AccrualSpec`. Todos aparecen en la búsqueda. | `round2` M4 + vivo (FIC, AFP) |
| M5 | alta | Tabla de alias (PFBCOLOM→PFCIBEST, BCOLOMBIA→CIBEST, ELET3→AXIA3, EMBR3→EMBJ3, CCRO3→MOTV3, NTCO3→NATU3, BRFS3/MRFG3→MBRF3, CPLE6→CPLE3) aplicada en quote, history y search con `renamedFrom`. Si el proveedor aún tiene el símbolo viejo, la historia se cose con una acción `SPLIT/TICKER_CHANGE`. Los 404 incluyen `details.suggest`. | `round2` M5 + vivo |
| M6 | media | Se descartan las barras posteriores a la última operación real (`regularMarketTime`); en CNEC son 225 fantasmas, una de ellas un duplicado con volumen. Se añaden `lastTradeDate` y `stale` en la serie, y el historial y la cotización coinciden (5000). | `round2` M6 + vivo |
| M7 | media | Bonificaciones B3 (razón no entera) → `STOCK_DIVIDEND`. Spin-offs conocidos (GE/GEV, GE/GEHC, MMM/SOLV) → `SPLIT/SPINOFF` con instrumento destino, razón de distribución, `costFraction` y `reviewRequired`. Un factor raro fuera de B3 se marca `SPINOFF reviewRequired`. Los precios siguen des-ajustados correctamente. | `round2` M7 + vivo (ITUB4, GE) |
| M8 | media | Los dividendos usan el `CorporateAction` de core con `exDate`, `payDate`, `subtype` JCP/ORDINARY (vía brapi) y `currency`. VUSA.L y VWRL.L se marcan con dividendos en USD (verificado). | `round2` M8, server (JCP + fecha de pago) |
| M9 | media | 23 bolsas nuevas (HK, Tokio, India, ASX, Corea, Taiwán, Yakarta, KL, Singapur, China, JSE, TASE...). Los sufijos desconocidos dan ids `YAHOO:<símbolo>` reversibles. | `round2` M9: ida y vuelta de todo resultado de búsqueda |
| M10 | media | El servidor escucha en `127.0.0.1` por defecto. CORS y una verificación del Origin en el servidor usan una allowlist. Hay `API_TOKEN` opcional, límite por cliente (token bucket, `Retry-After`) y tope de batch (100 ítems y ~100k puntos estimados). | server round 2 |
| M11 | media | `hono/body-limit` cuenta los bytes leídos, así que un cuerpo chunked de 300 KB recibe 413. | server round 2 + demo en vivo |
| M12 | baja | Se valida la parte del símbolo de todo id: 1 a 32 caracteres permitidos y sin `..`. La petición se rechaza antes de llamar al proveedor. | `round2` M12, server |
| M13 | media | El benchmark COLCAP usa ICOLCAP con `adjust=total` (retorno total), y MSCI World usa URTH con `adjust=total`. El COLCAP real está disponible como promedio mensual (`COLCAP_AVG`, BanRep); se verificó que es promedio y no cierre. | `round2` M13 |
| M14 | media | `provisional: true` en el último punto si es de la sesión en curso, y en el mes en curso para `1mo`. Se añaden `marketState` y `asOf`. | `round2` M14 |
| M15 | media | PTAX de compra y venta (`side`), SGS 10813 para la compra en USD, y la compra nunca se responde con tipo medio. BCB, BCE y FRED siguen inaccesibles desde aquí: prueba en vivo condicionada que informa si hay acceso. | `round2` M15 + vivo (reporta 403) |
| M16 | baja | Caché por símbolo y año, `FileStore` con poda LRU (`CACHE_MAX_FILES`), `deletePrefix` y `DELETE /api/cache?symbol=` (token o loopback). | `round2` M16, server |
| M17 | baja | Validación por ítem en batch (`BAD_REQUEST`); los errores internos se responden como `INTERNAL` sin mensaje. | `round2` M17, server |
| M18 | baja | Búsqueda por ISIN vía Yahoo, filtro de ruido por prefijo de palabra, la subcadena solo cuenta con 5 o más letras ("isa" ya no trae Visa) y `countries=` prioriza países. | `round2` M18 |
| M19 | baja | CoinGecko como proveedor de precios cripto y de pares cripto en `/api/fx` (Yahoo `BTC-USD` primero). | `round2` M19 + vivo |
