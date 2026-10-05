# @pm/server — API de datos de mercado

API HTTP (Hono) sobre `@pm/market-data`: precios, cierres de fin de mes, dividendos/splits,
FX oficial (TRM, PTAX, BCE) con respaldo en Yahoo, búsqueda y catálogo. Evita CORS en el navegador
y cachea en memoria + disco.

## Arrancar

```bash
npm run dev -w @pm/server        # tsx watch
npm run start -w @pm/server      # o: npx tsx apps/server/src/main.ts
```

Variables de entorno: `PORT` (8787), `HOST` (0.0.0.0), `CACHE_DIR` (`.cache/market-data`),
`CORS_ORIGIN` (lista separada por comas, por defecto `*`), `SOCRATA_APP_TOKEN` (opcional, datos.gov.co).

`src/app.ts` exporta `createApp({ service, corsOrigin, log })` sin efectos secundarios: sirve para
`app.request()` en pruebas o para desplegar como función serverless (`app.fetch`). `src/main.ts`
solo lo monta en `@hono/node-server` con un `FileStore` persistente.

## Endpoints (JSON, CORS habilitado)

| Método y ruta | Parámetros | Respuesta |
|---|---|---|
| `GET /api/health` | — | `{ ok, service, version, time, cache }` |
| `GET /api/search` | `q`, `limit` (1–50) | `{ results: SearchResult[], warnings? }` — catálogo primero, luego Yahoo |
| `GET /api/quote` | `ids` (coma; ids o símbolos, máx. 100) | `{ quotes: ({ok:true,data:Quote} \| {ok:false,error})[] }` |
| `GET /api/history` | `symbol`, `from`, `to?`, `interval=1d\|1mo`, `adjust=none\|splits` | `{ instrument, series: PriceSeries, actions: CorporateAction[], notes? }` |
| `GET /api/fx` | `base`, `quote` (o `pair=USDCOP`), `from`, `to?`, `interval`, `source=auto\|official\|yahoo` | `{ series: FxSeries, interval, fallbacks? }` |
| `GET /api/catalog` | — | `{ version, updated, instruments, benchmarks }` |
| `POST /api/batch` | `{ histories: HistoryRequest[], fx: FxRequest[], quotes: string[] }` (máx. 200 ítems) | cada ítem resuelto por separado + `tookMs` |

Errores: `{ "error": { "code", "message", "details?" } }` con estado 400 (`BAD_REQUEST`),
404 (`NOT_FOUND`), 422 (`UNSUPPORTED`, p. ej. `source=official` para USD/CLP), 502
(`UPSTREAM_ERROR`), 503 (`RATE_LIMITED`), 504 (`TIMEOUT`). Los mensajes indican el formato
esperado (p. ej. `Invalid or missing "from" date (YYYY-MM-DD)`).

Cabeceras: `Server-Timing` en todas las respuestas; `Cache-Control` inmutable (1 día +
stale-while-revalidate) cuando `to` es anterior al mes en curso, 5 min en otro caso. Cada
petición y cada llamada a proveedores se registra con su duración.

Ejemplos:

```bash
curl "localhost:8787/api/history?symbol=XBOG:ECOPETROL&from=2024-01-01&interval=1mo"
curl "localhost:8787/api/fx?base=USD&quote=COP&from=2025-01-01&interval=1mo"
curl "localhost:8787/api/quote?ids=PETR4.SA,VOD.L,AAPL"
curl -X POST localhost:8787/api/batch -H 'Content-Type: application/json' \
  -d '{"histories":[{"symbol":"BVMF:PETR4","from":"2025-01-01","interval":"1mo"}],"fx":[{"base":"BRL","quote":"COP","from":"2025-01-01","interval":"1mo"}]}'
```

Desde la web usar el cliente tipado `MarketDataClient` de `@pm/market-data/client`
(incluye `monthEndData()` para la tabla mensual en una sola llamada).

## Pruebas

```bash
npx vitest run apps/server       # rutas vía app.request(), cliente tipado contra la app, FileStore
npx tsc -p apps/server --noEmit
```

Las pruebas usan los fixtures de `packages/market-data/test/fixtures` (sin red).
