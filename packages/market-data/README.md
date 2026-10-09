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
- Renombres en B3 (misma acción): ELET3 → **AXIA3**, EMBR3 → **EMBJ3**, CCRO3 → **MOTV3**, NTCO3 → **NATU3**,
  MRFG3 → **MBRF3**.
- Fusiones y conversiones (otra acción, ver M23): BRFS3 → 0,8521 **MBRF3**; CPLE6/CPLE5 → 1 **CPLE3** + R$0,7749.
- Yahoo reporta los FII y ETF de B3 como `EQUITY`: la clase
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

El cliente divide de forma transparente las peticiones grandes para respetar los topes del servidor:
- `quotes` en bloques de 50 ids únicos;
- `batch` y `monthEndData()` en bloques de 100 ítems.

Envía como máximo 3 bloques a la vez, une los resultados en el orden original y, si un bloque falla entero,
solo se marcan como fallidos sus ítems.

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
- Renombres sin fecha efectiva verificada (PFBCOLOM, BCOLOMBIA, ELET3, EMBR3, CCRO3). No afecta los precios:
  son la misma serie con canje 1:1.
- BVC: no hay fuente gratuita de respaldo de precios, ni calendario de dividendos con cuotas y fechas de pago,
  ni COLCAP diario. La API pública de la BVC (`rest.bvc.com.co`) no es accesible desde el contenedor y sus
  parámetros no están documentados.
- Cupones NTN-C (IGP-M): se emite la fecha y se marcan `reviewRequired`, sin valor.
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

## Respuesta a la revisión ronda 2

| Gap | Severidad | Corrección | Prueba |
|---|---|---|---|
| M23 | alta | La tabla de alias distingue `rename` (misma acción: se cose la historia, 1:1) de `merger` y `conversion` (otra acción). Para un ticker fusionado se devuelve **solo su propia historia** hasta su último día de negociación (vacía si ningún proveedor la conserva), con `delisted`, `SPLIT/MERGER` y la componente en efectivo. Su cotización responde **410 DELISTED** con `suggest`. Datos verificados: BRFS3 → **0,8521** MBRF3 (desde 2025-09-23; último día 2025-09-22); MRFG3 → MBRF3 1:1 como renombre (Marfrig es la sobreviviente); NTCO3 → NATU3 1:1 (desde 2025-07-02); CPLE6 y CPLE5 → 1 CPLE3 + **R$0,7749** (2025-12-22; pago 2025-12-30). | `round3` M23, server, vivo |
| M20 | media | Si la barra del último día con operación (`regularMarketTime`) viene con `close: null`, se completa con `regularMarketPrice` y se deja nota; los demás nulos quedan en `missingCloseDates`. Un año cerrado solo se congela cuando está asentado: desde el 4 de enero, o desde el 15 de enero si termina con barras sin cierre. En vivo, SAP.DE da 188.6 tanto en el historial como en la cotización. | `round3` M20, vivo |
| M21 | media | `DELETE /api/cache` exige `API_TOKEN`. Sin token solo funciona con `ALLOW_LOCAL_ADMIN=1` desde un socket loopback **real**, sin proxy: nunca en serverless (sin socket), nunca con `X-Forwarded-For` falsificado y nunca con `trustProxy`. Los clientes sin dirección comparten un bucket `anonymous`, con aviso (en serverless hay que usar `TRUST_PROXY=1`). | server round 3 |
| M22 | media | Feeds JSON en modo filas (`rowsPath` + `dateField` + `closeField`). El modo de rutas paralelas conserva los huecos (`keepMissing`) y rechaza longitudes distintas, así que una fila sin valor ya no desplaza las siguientes. | `round3` M22 |
| M25 | media | Los errores de los índices pasan por `mapHttpError` y responden 502/404/503, nunca 500. El IPCA tiene una segunda fuente (IBGE SIDRA, tabla 1737 v63). Se guarda la última serie buena por índice y se sirve con `stale: true`, `fallbacks` y nota si todo falla. | `round3` M25, server |
| M26 | media | Eventos `DIVIDEND/COUPON` para los títulos "com Juros Semestrais". NTN-F paga R$48,80885 por título (10 % a.a. semestral sobre R$1000). NTN-B paga VNA × 2,956301 %, con el VNA calculado desde el IPCA (R$1000 el 2000-07-15, actualizado cada día 15). Las fechas siguen el mes de vencimiento y el mes a seis meses de distancia, movidas al siguiente día hábil: NTN-B 2035/2045 en mayo y noviembre, NTN-B 2030/2040 en febrero y agosto, NTN-F en enero y julio. Corrijo la sugerencia de la revisión (ene/jul para NTN-B): eso solo vale para NTN-F y NTN-C. Si falta el IPCA o el título es NTN-C, el cupón sale con fecha y `reviewRequired`, sin valor. Pedí a core que registre `COUPON` como INTEREST. | `round3` M26 |
| M2 | media (parcial) | Sin claves: si `query2` falla, Yahoo reintenta en `query1` (verificado como host independiente). Los respaldos ajustados por splits (stooq, FMP) se convierten a cierres tal como se negociaron con la historia de splits cacheada. **Sigue abierto**: no hay una segunda fuente gratuita para BVC ni Londres; la API de la BVC no es accesible desde aquí y no está documentada. | `round3` M2 |
| M8 | media (persiste) | Sin cambios de fuente: la BVC no publica su calendario de dividendos en una API accesible. Lo que existe: `payDate` y JCP vía brapi (con token) y la moneda del dividendo (VUSA/VWRL). | — |
| M15 | media (persiste) | Pruebas de contrato en `live.test.ts`: en una máquina con acceso verifican PTAX compra/venta, SGS, SIDRA, BCE, FRED, Tesouro, brapi y stooq contra los servicios reales (`RECORD=1` recuerda regrabar los fixtures). Desde el contenedor informan "UNREACHABLE". | vivo (contrato) |
| M24 | baja | `stale` solo se calcula con la fecha de última operación global de Yahoo o cuando el rango llega a los últimos 7 días. Un rango histórico cerrado de un FIC, Tesouro o feed ya no aparece como "suspendido". | `round3` M24 |
| M27 | baja | `/api/health` no consume del límite. Un batch cuesta un token por ítem. Hay allowlist de `Host` (`ALLOWED_HOSTS`; por defecto localhost, 127.0.0.1 y [::1] cuando `HOST` es loopback) contra DNS rebinding. | server round 3 |
| M13 | baja (persiste) | Sin cambios: el COLCAP diario requiere la API de la BVC, inaccesible. Sigue el promedio mensual de BanRep (`COLCAP_AVG`) más ICOLCAP con retorno total. | — |
| M18 | baja (parcial) | Los ISIN de valores renombrados resuelven vía alias: `COB07PA00078` → XBOG:PFCIBEST. No encontré una fuente accesible de ISIN de la BVC: el formato 351 de la Superfinanciera solo trae nemotécnicos para acciones. | `round3` M18 |

Fuentes de los datos de M23:
- BRF→MBRF 0,8521, efectiva el 2025-09-23: [Finance News](https://financenews.com.br/2025/09/novas-acoes-da-mbrf-mbrf3-estreiam-na-b3-em-23-de-setembro/), [Investidor10](https://investidor10.com.br/noticias/mbrf3-cai-6-72-em-estreia-na-bolsa-mas-nao-impede-recorde-ao-ibovespa-115614/).
- NTCO3→NATU3 1:1 desde el 2025-07-02: [Acionista](https://acionista.com.br/natura-comeca-a-operar-com-ticker-natu3-nesta-quarta-feira-3/), [Suno](https://www.suno.com.br/noticias/natura-ntco3-anuncia-reestruturacao-extingue-holding/amp/).
- Copel 1 ON + R$0,7749 (2025-12-22, pago el 2025-12-30): [Investidor10](https://investidor10.com.br/noticias/copel-cple3-agora-so-tem-acoes-ordinarias-em-negociacao-na-b3-117563/), [Seu Dinheiro](https://www.seudinheiro.com/2025/empresas/copel-cple6-rumo-ao-novo-mercado-da-b3-tudo-o-que-os-acionistas-precisam-saber-sobre-os-dividendos-e-o-que-fazer-com-as-acoes-agora-miql/), [Acionista](https://acionista.com.br/copel-cple6-anuncia-mudancas-que-podem-impactar-acoes-e-dividendos/).

## Respuesta a la revisión ronda 3

| Gap | Severidad | Corrección | Prueba |
|---|---|---|---|
| M28 | alta | Filtro general `dropStaleZeroVolume` en `buildHistory`, aplicado a toda la serie y no solo al final. **Regla A**: se descarta una barra con volumen 0 que repite el último cierre negociado cuando ya pasaron más de 30 días desde esa operación. **Regla B**: se descartan las barras con volumen 0 anteriores a la primera operación del rango si difieren de ella más de un 25 %. Los días tranquilos de un papel ilíquido (volumen 0 con el cierre anterior, pocos días después de operar) se conservan. Las series sin volumen (índices, FX) no se tocan. En vivo, NATU3 pierde las 4 barras fantasma a 36,86 (jun-2025); el cierre de junio ya no queda sobrevalorado y julio-2025 = 9,03. **NTCO3 → NATU3 pasa a `conversion`** (1:1, efectiva el 2025-07-02, último día 2025-07-01). Ya no se cose como renombre: NTCO3 tiene su propia historia (Yahoo no la conserva), con `MERGER` → NATU3. | `round4` M28, vivo |
| M29 | media | **Historias congeladas** (`src/frozen.ts`): cierres tal como se negociaron de un valor que ya no cotiza, grabados una sola vez desde una fuente que aún los tenga. El servidor carga los `*.json` de `MD_FROZEN_DIR` y los sirve con `source: 'frozen'`, cortados en `lastTradingDay` y con la acción `MERGER`. Para grabarlas: `scripts/record-frozen.ts brapi BVMF:BRFS3 out/` (con `BRAPI_TOKEN`), o `csv` a partir de un export de corredora o de la B3 (`;`, coma decimal, `DD/MM/YYYY`). Hoy ninguna fuente accesible desde aquí conserva BRFS3, NTCO3, CPLE6, CPLE5 ni CPLE11: Yahoo da 404 en query1 y query2, BRF.F es otra empresa y ELP.HM solo tiene 2 meses. Por eso no se versiona ningún archivo con datos inventados. **Fechas de Copel corregidas**: CPLE6 → CPLE5 1:1 (último día **2025-11-07**, efectiva 2025-11-10); CPLE5 → CPLE3 1:1 + R$0,7749 (último día 2025-12-19, efectiva 2025-12-22, pago 2025-12-30). **CPLE11** (unit = 1 CPLE3 + 4 CPLE6) se disolvió el 2023-12-26 (último día 2023-12-22): se registra un `MERGER` a CPLE3 y un `SPINOFF` de 4 CPLE6, ambos con `reviewRequired`. | `round4` M29, `round3` (cadena Copel) |
| M30 | media | Un ticker sin sufijo con el patrón B3 `[A-Z]{4}\d{1,2}` que no está en el catálogo se busca como `.SA` (BVMF), nunca como acción de EE. UU.; antes pasa por la tabla de alias (CPLE11 → delisted). Verificado en vivo: CPLE3, TAEE11, SAPR11. AAPL y BRK-B no cambian. | `round4` M30, vivo |
| M31 | media | Las fechas de cupón de Tesouro (`couponDates`, `nextBusinessDayBR`) y las fechas ex de brapi (`nextWeekday`) usan `calendars` de `@pm/core` (calendario BR/ANBIMA): Carnaval, Corpus Christi, 20-nov (desde 2024), 1-ene, etc. Ejemplos: el cupón NTN-B de nov-2024 se paga el 2024-11-18; el de NTN-F de ene-2025, el 2025-01-02; un "data com" del 2026-02-13 da fecha ex 2026-02-18. No hay copia local del calendario. | `round4` M31, `round3` |
| M2 | media (mejorada) | **Snapshot local** sin claves: el servidor graba cada `SNAPSHOT_HOURS` (12) los cierres del año en curso de los instrumentos del catálogo en `SNAPSHOT_EXCHANGES` (por defecto `XBOG,XLON`) con persistencia forzada. Si después fallan Yahoo (query2 y query1) y todos los respaldos, se sirven esos cierres con `source: 'snapshot'` y una nota. No sustituye a una segunda fuente pública, pero evita quedarse sin precios de la BVC o de Londres durante una caída. | `round4` M2 |
| M15 | media (mejorada) | Con `CONTRACT_STRICT=1`, las pruebas de contrato fallan si un servicio no es accesible (para CI en una máquina con red); sin la variable siguen informando "UNREACHABLE". El timeout de esa prueba sube a 300 s, porque los hosts bloqueados se reintentan con backoff. | vivo (contrato) |
| M8 | media (persiste) | Sin cambios: la API REST de la BVC (`rest.bvc.com.co`) da 403 desde aquí y no está documentada. Sin ella no hay fechas de pago ni cuotas de dividendos de la BVC. | — |
| M13 / M18 | baja (persiste) | Igual que en la ronda 2: no hay COLCAP diario ni ISIN de la BVC en fuentes accesibles. Se mantienen `COLCAP_AVG` + ICOLCAP y el ISIN por alias (`COB07PA00078`). | — |

Fuentes de las fechas de Copel: CPLE11 negoció por última vez el 2023-12-22 y se disolvió el 2023-12-26 (Investidor10, Finance News); CPLE6 negoció por última vez el 2025-11-07 (ADVFN, Visno), y CPLE5 hasta el 2025-12-19.

## Respuesta a la revisión ronda 4

| Gap | Severidad | Corrección | Prueba |
|---|---|---|---|
| M33 | media | Un símbolo sin bolsa se busca **primero en el catálogo** por su símbolo exacto (`catalog.bySymbol`). Si hay varios listados, gana el que coincide con el símbolo de Yahoo (EE. UU.), luego la BVC, luego B3. Fuera del catálogo, una palabra de 6 a 12 letras se busca en la BVC (`.CL`): en EE. UU. los tickers tienen como máximo 5 letras. Solo si nada coincide se busca en EE. UU. En vivo, ECOPETROL, PFAVAL, GEB, ISA, NUTRESA, ICOLCAP, CEMARGOS y PFCIBEST cotizan en XBOG/COP. Además, si Yahoo dice "no existe" y los respaldos fallan solo por acceso (claves, red, 403), la respuesta es `NOT_FOUND` (404), no `UPSTREAM_ERROR`. Una caída real sigue siendo 502. Cambio de comportamiento: `SAP` o `VOD` sin bolsa resuelven al listado del catálogo (XETR, XLON), no al ADR de EE. UU. | `round5` M33, vivo |
| M32 | media | Si la ventana pedida empieza sin operaciones, el primer punto es la **última operación real anterior a `from`** (hasta un año atrás), marcada `carried: true` y con su fecha real, fuera del rango. No se siembra si la ventana empieza con una operación, ni antes del `firstTradeDate` de Yahoo. Se conserva con `adjust=splits` y en `1mo`. En vivo: ELCONDOR abr-may 2023 da 1020 (2023-03-03); ELCONDOR abr-2026, 520; BBVACOL abr-2026, 240; BAUH4 ago-2026, 93,9. | `round5` M32, vivo |
| M34 | baja | Cuando el respaldo por instantánea cubre solo parte del rango, la serie trae `partial: true`, `coverageFrom` y `coverageTo`, más una nota "PARTIAL". Además, la primera grabación del servidor incluye los años cerrados (`SNAPSHOT_YEARS`, 5 por defecto). Son inmutables, así que se graban una sola vez y luego solo se refresca el año en curso. | `round5` M34 |
| M35 | baja | Servidor (`apps/server`): el token Flex solo viaja por HTTPS a `*.interactivebrokers.com`, aunque `<Url>` apunte a otro host. `API_TOKEN` se compara en tiempo constante. La bandeja usa un candado por cartera, las ejecuciones diarias van en serie y se deduplica bajo el candado. La confirmación acepta `ids`, así que no se pierde lo que llegó después. | server `ibkrSync.test.ts` |
| M2 | media (mejorada) | La instantánea también cubre los instrumentos de la BVC o Londres pedidos fuera del catálogo (ELCONDOR, MINEROS...). El servidor recuerda los que Yahoo sirvió, en una lista persistida de hasta 1000, y los graba en cada ejecución. Sigue sin haber una segunda fuente pública gratuita para la BVC. | `round5` M2 |
| M29 | media (mejorada) | `scripts/record-frozen.ts cotahist BVMF:BRFS3 out/ COTAHIST_A2024.TXT COTAHIST_A2025.TXT` lee los **archivos oficiales COTAHIST de B3**, que conservan todos los tickers que negociaron, incluidos los deslistados. Toma solo el mercado de contado (TPMERC 010) y aplica `FATCOT`. Los archivos se descargan gratis desde b3.com.br (Séries históricas), pero `bvmf.bmfbovespa.com.br` y `arquivos.b3.com.br` están bloqueados desde aquí. Yahoo sigue dando 404 para BRFS3, NTCO3, CPLE5, CPLE6 y CPLE11. Por eso sigue sin versionarse ningún archivo: hay que generarlos en una máquina con acceso. | `round5` M29 |
| M8 | media (mejorada) | Calendario de dividendos decretados (`src/dividend-calendar.ts`, `MD_DIVIDENDS_FILE` en el servidor) con `exDate`, `payDate`, `amount` y `note` por cuota. Yahoo sigue mandando en fechas ex e importes. El calendario agrega la fecha de pago a cada dividendo (±3 días), añade las cuotas que Yahoo no reporta y avisa si el importe difiere. No encontré una fuente pública con API: la BVC está bloqueada y datos.gov.co no tiene un conjunto de dividendos. El archivo hay que mantenerlo a partir de las decisiones de asamblea. | `round5` M8 |
| M15, M13, M18 | persisten | Sin cambios: las fuentes siguen inaccesibles desde aquí. | — |
