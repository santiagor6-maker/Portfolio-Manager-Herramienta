# @pm/server — API de datos de mercado

API HTTP (Hono) sobre `@pm/market-data`. Expone:
- precios y cierres de fin de mes, dividendos y eventos corporativos tipificados;
- FX oficial (TRM, PTAX compra/venta, BCE) con respaldo en Yahoo;
- índices de tasas e inflación (CDI, Selic, IPCA, IPC Colombia, IBR, UVR, DTF...);
- Tesouro Direto, FIC y fondos de pensiones colombianos;
- búsqueda y catálogo.

Evita CORS en el navegador y cachea en memoria y en disco.

## Arrancar

```bash
npm run dev -w @pm/server        # tsx watch
npm run start -w @pm/server      # o: npx tsx apps/server/src/main.ts
```

| Variable | Por defecto | Uso |
|---|---|---|
| `PORT` | 8787 | puerto |
| `HOST` | **127.0.0.1** | use `0.0.0.0` solo detrás de un firewall o proxy, y con `API_TOKEN` |
| `CORS_ORIGIN` | `http://localhost:5173`, `http://127.0.0.1:5173`, `:4173` | allowlist separada por comas (`*` = cualquiera, no recomendado) |
| `API_TOKEN` | — | si se define, todo `/api/*` salvo `/api/health` exige `Authorization: Bearer <token>` o `x-api-key` |
| `RATE_LIMIT_PER_MIN` | 120 | límite por cliente (token bucket; un batch cuesta un token por ítem; `/api/health` no consume). `0` lo desactiva |
| `ALLOWED_HOSTS` | `localhost,127.0.0.1,[::1]` si `HOST` es loopback | allowlist de la cabecera `Host` (protección contra DNS rebinding) |
| `ALLOW_LOCAL_ADMIN` | — | `1`: permite `DELETE /api/cache` sin token desde un socket loopback real (nunca con `TRUST_PROXY`) |
| `TRUST_PROXY` | — | `1`: identifica al cliente por `X-Forwarded-For` / `X-Real-IP` / `CF-Connecting-IP`. Úselo solo detrás de un proxy de confianza; en serverless es necesario para tener un límite por cliente |
| `CACHE_DIR` | `.cache/market-data` | caché persistente |
| `CACHE_MAX_FILES` | 20000 | poda LRU de la caché en disco |
| `MD_CUSTOM_FEEDS_FILE` | — | JSON con feeds de precios definidos por el usuario (ver README de market-data) |
| `MD_FROZEN_DIR` | — | carpeta con historias congeladas (`*.json`) de valores que ya no cotizan, grabadas con `packages/market-data/scripts/record-frozen.ts`. Un archivo inválido se omite con un aviso |
| `SNAPSHOT_EXCHANGES` | `XBOG,XLON` | bolsas cuyos instrumentos del catálogo se graban en el snapshot local (último recurso si fallan todos los proveedores). `none` lo desactiva |
| `SNAPSHOT_HOURS` | 12 | intervalo del snapshot; la primera ejecución es 30 s después del arranque |
| `BRAPI_TOKEN`, `TWELVEDATA_API_KEY`, `FMP_API_KEY`, `EODHD_API_TOKEN`, `ALPHAVANTAGE_API_KEY` (+`ALPHAVANTAGE_PREMIUM=1`), `STOOQ_API_KEY`, `COINGECKO_API_KEY`, `SOCRATA_APP_TOKEN` | — | activan o mejoran los proveedores de respaldo |

`src/app.ts` exporta `createApp({ service, corsOrigin, apiToken, rateLimit, trustProxy, maxBodyBytes, log })`
sin efectos secundarios: sirve para `app.request()` en pruebas o para desplegar como función serverless
(`app.fetch`). `src/main.ts` solo lo monta en `@hono/node-server` con un `FileStore` persistente.

## Endpoints (JSON)

| Método y ruta | Parámetros | Respuesta |
|---|---|---|
| `GET /api/health` | — | `{ ok, service, version, time, cache, providers }` |
| `GET /api/search` | `q`, `limit` (1–50), `countries=CO,BR` | `{ results: SearchResult[], warnings? }`. Orden: alias, catálogo, plantillas CDT/CDB, Tesouro, FIC, AFP y luego Yahoo |
| `GET /api/quote` | `ids` (coma; máx. 50) | `{ quotes: ({ok:true,data:Quote} \| {ok:false,error})[] }`. Incluye `stale`, `marketState` y `renamedFrom` |
| `GET /api/history` | `symbol`, `from`, `to?`, `interval=1d\|1mo`, `adjust=none\|splits\|total` | `{ instrument, series (lastTradeDate, stale, puntos con provisional), actions, fallbacks?, degraded?, asOf, marketState, renamedFrom?, notes? }` |
| `GET /api/fx` | `base`, `quote` (o `pair=USDCOP`), `from`, `to?`, `interval`, `source=auto\|official\|yahoo`, `side=buy\|sell\|compra\|venda` | `{ series: FxSeries, interval, side?, fallbacks? }` |
| `GET /api/index` (alias `/api/rates`) | `id` (o `series`), `from`, `to?`; sin `id` lista los índices | `{ series: IndexSeries (core), info, lastObservation, notes? }` |
| `GET /api/catalog` | — | `{ version, updated, instruments, benchmarks }` |
| `POST /api/batch` | `{ histories, fx, quotes, indices }` (máx. 100 ítems, ~100k puntos estimados, cuerpo ≤ 64 KiB) | cada ítem resuelto por separado, más `tookMs` |
| `DELETE /api/cache` | `symbol` | invalida la caché del símbolo (requiere `API_TOKEN`, o `ALLOW_LOCAL_ADMIN=1` con socket loopback directo) |

Errores: `{ "error": { "code", "message", "details?" } }` con los siguientes estados:

| Estado | Código |
|---|---|
| 400 | `BAD_REQUEST` |
| 401 | `UNAUTHORIZED` |
| 403 | `FORBIDDEN_ORIGIN` / `FORBIDDEN` |
| 404 | `NOT_FOUND` (con `details.fallbacks` y `details.suggest`) |
| 410 | `DELISTED`: ticker fusionado o convertido, con `details.delisted` (razón y efectivo) y `details.suggest` |
| 413 | cuerpo demasiado grande |
| 422 | `UNSUPPORTED` |
| 429 | límite por cliente, con `Retry-After` |
| 502 | `UPSTREAM_ERROR` |
| 503 | `RATE_LIMITED` (proveedor) |
| 504 | `TIMEOUT` |

Los errores internos se responden como `INTERNAL` sin el mensaje de JavaScript.

Seguridad (revisión R1, M10–M12 y M17):
- Origen: allowlist de CORS más verificación del `Origin` en el servidor. CORS solo oculta respuestas, así
  que además se rechaza la petición con 403.
- Acceso: token opcional y límite por cliente.
- Cuerpo: el límite cuenta los bytes del stream, también con `Transfer-Encoding: chunked`.
- Batch: topes por número de ítems y por puntos estimados.
- Símbolos: se validan antes de llegar a la URL del proveedor (sin `..`).
- Escucha en `127.0.0.1` por defecto.

Cabeceras: `Server-Timing` en todas las respuestas. `Cache-Control` según el caso:
- inmutable (1 día + stale-while-revalidate) cuando `to` es anterior al mes en curso;
- 5 min en otro caso;
- `no-store` para respuestas degradadas.

Cada petición y cada llamada a proveedores se registra con su duración.

Ejemplos:

```bash
curl "localhost:8787/api/history?symbol=XBOG:ECOPETROL&from=2024-01-01&interval=1mo"
curl "localhost:8787/api/history?symbol=XBOG:ICOLCAP&from=2024-01-01&interval=1mo&adjust=total"
curl "localhost:8787/api/fx?base=USD&quote=BRL&from=2025-01-01&interval=1mo&side=compra"
curl "localhost:8787/api/index?id=IPC_CO&from=2025-01-01"
curl "localhost:8787/api/quote?ids=PFBCOLOM.CL,TD:NTNBP-2035-05-15,FIC:5-31-2852-800"
curl -X POST localhost:8787/api/batch -H 'Content-Type: application/json' \
  -d '{"histories":[{"symbol":"BVMF:PETR4","from":"2025-01-01","interval":"1mo"}],"fx":[{"base":"BRL","quote":"COP","from":"2025-01-01","interval":"1mo"}],"indices":[{"id":"CDI","from":"2025-01-01"}]}'
```

Desde la web se usa el cliente tipado `MarketDataClient` de `@pm/market-data/client`. Incluye `index()`,
`indexList()` y `monthEndData()`, que obtiene en una sola llamada las series para la tabla mensual, con
índices opcionales. Acepta `apiToken`.

## Pruebas

```bash
npx vitest run apps/server       # rutas vía app.request(), cliente tipado contra la app, FileStore, seguridad
npx tsc -p apps/server --noEmit
```

Las pruebas usan los fixtures de `packages/market-data/test/fixtures` y no necesitan red.
