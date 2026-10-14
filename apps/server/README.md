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
| `MD_DIVIDENDS_FILE` | — | JSON con dividendos decretados (`instrumentId`, `exDate`, `payDate`, `amount`, `note`), por ejemplo las cuotas de la BVC. Agrega la fecha de pago a los dividendos de Yahoo y añade las cuotas que Yahoo no reporte (ver README de market-data) |
| `MD_FROZEN_DIR` | — | carpeta con historias congeladas (`*.json`) de valores que ya no cotizan, grabadas con `packages/market-data/scripts/record-frozen.ts`. Un archivo inválido se omite con un aviso |
| `SNAPSHOT_EXCHANGES` | `XBOG,XLON` | bolsas cuyos instrumentos del catálogo se graban en el snapshot local (último recurso si fallan todos los proveedores). `none` lo desactiva |
| `SNAPSHOT_HOURS` | 12 | intervalo del snapshot; la primera ejecución es 30 s después del arranque |
| `SNAPSHOT_YEARS` | 5 | años cerrados que la primera ejecución del snapshot graba (son inmutables: se graban una vez y después solo se refresca el año en curso). `0` graba solo el año en curso |
| `SYNC_SECRET` | — | activa la sincronización con IBKR (`/api/sync/ibkr-flex`). Clave para cifrar los tokens Flex (AES-256-GCM): mínimo 16 caracteres, mejor 32 aleatorios. Si cambia, hay que volver a guardar los tokens |
| `SYNC_DIR` | `.data/sync` | almacén de tokens cifrados y bandejas de la sincronización diaria. Va aparte de la caché: no se poda ni se borra con `DELETE /api/cache`. Archivos con permisos 0600 |
| `IBKR_FLEX_DAILY` | — | sincronización diaria opcional: `portfolioId[:credentialId]` separados por comas (por ejemplo `p1,p2:ira`). Requiere `SYNC_SECRET` |
| `IBKR_FLEX_HOUR` | 6 | hora UTC de la sincronización diaria (0–23). IBKR genera los extractos durante la noche |
| `INBOX_SECRET` | — | activa el buzón de correo (`POST /api/inbox/email`). Secreto compartido con el proveedor de correo entrante (cabecera `x-inbox-secret` o `?secret=`), de 16 caracteres como mínimo |
| `INBOX_RECIPIENTS` | — (obligatorio con `INBOX_SECRET`) | `token:portfolioId` separados por comas. El correo reenviado a `importar+<token>@su-dominio` va a esa cartera. Token de 8 a 64 caracteres (letras, dígitos, `_`, `-`), difícil de adivinar |
| `INBOX_ALLOWED_SENDERS` | — (obligatorio) | remitentes aceptados, separados por comas: `confirm@broker.com` (dirección exacta) o `@xpi.com.br` (ese dominio y sus subdominios). `*` acepta cualquiera (no recomendado) |
| `INBOX_MAX_BYTES` | 10485760 (10 MiB) | tamaño máximo del mensaje, contado sobre el stream |
| `INBOX_PER_HOUR` | 60 | mensajes por hora aceptados por el webhook, sumando todos los remitentes. `0` lo desactiva |
| `INBOX_REQUIRE_AUTH` | 1 | exige `spf=pass` o `dkim=pass` en `Authentication-Results` / `ARC-Authentication-Results`. `0` lo desactiva (con aviso) |
| `INBOX_PDF_PASSWORDS` | — | contraseñas candidatas para notas PDF cifradas (por ejemplo, los primeros dígitos del CPF), separadas por comas |
| `BRAPI_TOKEN`, `TWELVEDATA_API_KEY`, `FMP_API_KEY`, `EODHD_API_TOKEN`, `ALPHAVANTAGE_API_KEY` (+`ALPHAVANTAGE_PREMIUM=1`), `STOOQ_API_KEY`, `COINGECKO_API_KEY`, `SOCRATA_APP_TOKEN` | — | activan o mejoran los proveedores de respaldo |

`src/app.ts` exporta `createApp({ service, corsOrigin, apiToken, rateLimit, trustProxy, maxBodyBytes, ibkrFlexSync, syncMaxBodyBytes, log })`
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
| `POST /api/sync/ibkr-flex` | cuerpo JSON con `action` (ver abajo; ≤ 5 MiB) | `save` → `{ credentialId }`; `sync` → `ImportResult` de `@pm/importers`; `delete` → `{ ok: true }` |
| `GET /api/sync/ibkr-flex/inbox` | `portfolioId` | `{ portfolioId, pending: Transaction[], instruments: Instrument[], lastRun? }`: lo que trajo la sincronización diaria y la web aún no recogió |
| `DELETE /api/sync/ibkr-flex/inbox` | `portfolioId`; cuerpo opcional `{ "ids": [...] }` | `{ cleared }`: la web confirma lo que importó. Con `ids` solo salen esas transacciones (lo que llegó después se conserva); sin cuerpo se vacía la bandeja |
| `POST /api/inbox/email` | mensaje MIME crudo (`message/rfc822`), JSON de Postmark (`RawEmail`) o formulario de Mailgun (`body-mime`) | webhook del proveedor de correo: `{ portfolioId, attachments, needsPassword, transactions }`. Lo importado queda como borrador |
| `GET /api/inbox/email/drafts` | `portfolioId` | `{ portfolioId, drafts: [{ id, receivedAt, from, subject, transactions, instruments, attachments, needsPassword, ignored }] }` |
| `DELETE /api/inbox/email/drafts` | `portfolioId`; cuerpo opcional `{ "ids": [id del borrador...] }` | `{ cleared }`: la web confirma los borradores que importó; sin cuerpo se vacían todos |

### Sincronización con Interactive Brokers (Flex Web Service)

El servidor monta `createIbkrFlexSyncHandler` de `@pm/importers` (`src/ibkrSync.ts`). IBKR no envía
cabeceras CORS, y así el token nunca llega al navegador: se guarda cifrado con `SYNC_SECRET` y ninguna
respuesta lo devuelve.

- Endurecimiento (revisión R4, M35):
  - El token Flex solo se envía por HTTPS a `*.interactivebrokers.com`, también cuando `SendRequest`
    devuelve otra `<Url>` (502 con "Refused to send the Flex token").
  - `API_TOKEN` se compara en tiempo constante (SHA-256 de ambos lados y XOR).
  - Las escrituras de la bandeja van en cola por cartera: una sincronización diaria y una confirmación de la
    web no se pisan, y dos ejecuciones simultáneas no duplican transacciones.
- Protección: la misma que `DELETE /api/cache`. Hace falta `API_TOKEN`, o `ALLOW_LOCAL_ADMIN=1` desde un
  socket loopback directo. También pasa por la allowlist de `Origin`, de `Host` y por el límite por
  cliente. Sin `SYNC_SECRET`, las tres rutas responden 503 `NOT_CONFIGURED`.
- Acciones del `POST` (cuerpo JSON):
  - `{ "action": "save", "token", "queryId", "credentialId?" }` guarda el token Flex y el id de la
    consulta Flex (Activity).
  - `{ "action": "sync", "portfolioId", "credentialId?", "existingTransactions?", "existingInstruments?", "account?", "catalog?" }`
    descarga el extracto (SendRequest, luego GetStatement con reintentos mientras se genera) y lo
    convierte en transacciones. Las que ya están en `existingTransactions` se descartan.
  - `{ "action": "delete", "credentialId?" }` borra la credencial.
- Errores de IBKR: 502 (o 503 si se puede reintentar) con `{ error: { code: "FLEX_1012", message } }` en
  español. Sin credencial guardada: 404 `NO_CREDENTIAL`.
- Sincronización diaria (`IBKR_FLEX_DAILY`):
  - A la hora `IBKR_FLEX_HOUR` (UTC), el servidor ejecuta `runIbkrFlexSyncJobs` para cada cartera.
  - El servidor no guarda las carteras (viven en la web). Lleva por cartera la lista de transacciones
    que ya sincronizó, así que cada ejecución solo trae las nuevas, y las deja en una bandeja.
  - La web lee la bandeja con `GET /api/sync/ibkr-flex/inbox`, las importa con su propia
    deduplicación y confirma con `DELETE`.
  - El resultado de la última ejecución, incluido el error, queda en `lastRun`. Si una cartera falla,
    las demás siguen.

### Buzón de correo (reenviar notas y extractos)

El servidor monta `createEmailInboxHandler` de `@pm/importers` (`src/emailInbox.ts`). El usuario reenvía a
`importar+<token>@su-dominio` las notas de corretaje, los extractos o las confirmaciones que le llegan del
bróker. Los adjuntos (PDF, incluso con contraseña; CSV; Excel; HTML) se importan y quedan como
**borrador**: nada se registra hasta que la web lo revisa y lo confirma.

Controles del webhook, en este orden:
1. `Host`, `Origin` (los proveedores no envían `Origin`) y `API_TOKEN`. Con `API_TOKEN` se acepta
   `Authorization: Bearer`, `x-api-key` o, **solo en esta ruta**, `?api_key=`, para los proveedores que no
   permiten cabeceras.
2. Tope por hora (`INBOX_PER_HOUR`) y tamaño máximo (`INBOX_MAX_BYTES`), contado sobre el stream.
3. `INBOX_SECRET`, comparado en tiempo constante.
4. Remitente en `INBOX_ALLOWED_SENDERS`.
5. `spf=pass` o `dkim=pass` en `Authentication-Results`.
6. Token del destinatario en `INBOX_RECIPIENTS`. Si no existe: 404.

`?api_key=` y `?secret=` nunca aparecen en el log (se registran como `***`). Los borradores se guardan en
`SYNC_DIR`, en el mismo almacén que los tokens de IBKR, por cartera y con candado. Un mismo correo reenviado
dos veces no duplica transacciones. Se guardan como máximo 200 borradores por cartera.

Para recibir correo, el servidor tiene que ser alcanzable por HTTPS desde internet:
- `HOST=0.0.0.0` detrás de un proxy con TLS, o un túnel (Cloudflare Tunnel);
- `ALLOWED_HOSTS` con el nombre público;
- `API_TOKEN` definido. Sin él, el webhook solo responde a un socket loopback con `ALLOW_LOCAL_ADMIN=1`,
  y eso no sirve para un proveedor externo.

Cómo conectar un proveedor de correo entrante (`https://portafolio.ejemplo.com` es su servidor):

- **Cloudflare Email Routing + Email Worker.** En Email Routing, cree una regla para `importar@su-dominio`
  y active el subaddressing (o use una regla catch-all) con acción "Send to a Worker". El Worker reenvía el
  mensaje crudo:
  ```js
  export default {
    async email(message, env) {
      const res = await fetch('https://portafolio.ejemplo.com/api/inbox/email', {
        method: 'POST',
        headers: { 'content-type': 'message/rfc822', authorization: `Bearer ${env.API_TOKEN}`, 'x-inbox-secret': env.INBOX_SECRET },
        body: message.raw,
      });
      if (!res.ok) message.setReject(`Portafolio Pro: ${res.status}`);
    },
  };
  ```
  Guarde `API_TOKEN` e `INBOX_SECRET` como secretos del Worker.
- **Mailgun (Receiving → Routes).** Expresión `match_recipient("importar\+.*@su-dominio")` con la acción
  `forward("https://portafolio.ejemplo.com/api/inbox/email?api_key=<API_TOKEN>&secret=<INBOX_SECRET>&format=mime")`.
  Mailgun envía el MIME completo (campo `body-mime`) solo cuando la URL de destino termina en `mime`; por eso
  `format=mime` va al final. Compruébelo con un correo de prueba: si el webhook responde 400 "Se esperaba el
  mensaje MIME completo", Mailgun no envió `body-mime`.
- **Postmark (Inbound).** Webhook `https://portafolio.ejemplo.com/api/inbox/email?api_key=…&secret=…`, con
  la opción de incluir el contenido crudo (`RawEmail`) activada.
- **Amazon SES (Email Receiving).** Una regla de recepción guarda el mensaje en S3 y dispara una Lambda.
  La Lambda lee el objeto y lo envía con `POST` a la misma URL, con las cabeceras `authorization` y
  `x-inbox-secret`, igual que el Worker de arriba.

Compruebe el resultado con un correo de prueba. Si el proveedor no añade `Authentication-Results`, el
webhook responde 403 `NOT_AUTHENTICATED`; en ese caso, revise la configuración antes de pensar en
`INBOX_REQUIRE_AUTH=0`.

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

Las pruebas usan los fixtures de `packages/market-data/test/fixtures` y no necesitan red. `src/ibkrSync.test.ts` simula IBKR con un `fetch` falso que responde con las respuestas grabadas de `packages/importers/test/fixtures/ibkr-flex-ws`.
