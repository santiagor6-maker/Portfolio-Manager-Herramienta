# Revisión R6: datos de mercado y servidor API (incluye la ronda 6b)

Revisor: agente revisor independiente, en modo solo lectura sobre el código. Fecha: 2026-10-14.

## Veredicto

**Aprobado.** Las dos regresiones de R5 quedaron corregidas y verificadas en vivo:
- M36: los símbolos sin bolsa vuelven a resolver a EE.UU.
- M37: la semilla viaja en `series.seed`, no en `points`.

La integración con la tabla común de renombres funciona, incluido el código NATU3 reutilizado. El buzón de correo montado en el servidor tiene una capa de rutas sólida: token, Origin, límite por hora, tamaño medido sobre el flujo y candados correctos.

No queda ningún gap alto. Sí aparecen dos medios nuevos:
- **M38:** las claves de los proveedores de pago se filtran en el cuerpo de los errores 502.
- **M39:** las preferenciales de Eletrobras/AXIA no tienen la conversión 1,1 → AXIA3.

| | Puntaje |
|---|---|
| **Nuestra parte (market-data + server)** | **8 / 10** (R5: 7) |
| **Mejor competidor para este trabajo: Portfolio Performance** | **7 / 10** |

## Qué se verificó

- `npx vitest run packages/market-data apps/server`: **318 OK**. `tsc --noEmit` limpio en ambos paquetes.
- `LIVE=1 … live.test.ts`: **19/19**, con la prueba de `live.test.ts:222` de nuevo en verde.
- Scripts nuevos en `scratchpad/review-md/`:
  - `bare.mts`: 30 símbolos, incluidos los 15 del caso M36, en mayúsculas y minúsculas.
  - `renames6.mts`: NATU3/NTCO3, TRPL4→ISAE4 y ELET6/AXIA6.
  - `keyleak.mts`: claves de proveedores en errores y en el log.
  - `mask.mts`: `?api_key` y enmascarado del log.
- Código revisado:
  - `apps/server/src/emailInbox.ts`, `keyedLock.ts`, `ibkrSync.ts` y las rutas de `app.ts`.
  - `apps/web/src/db/repo.ts` (`mergePriceSeries`, que lee `series.seed`).
  - `packages/core/src/tickerRenames.ts` y `packages/market-data/src/aliases.ts`.
- Fuentes web:
  - Exclusión voluntaria de los ADS de Telefónica de la NYSE (anuncio del 2025-12-17, Form 25 del 2026-01-08), según [Reuters/TradingView](https://www.tradingview.com/news/reuters.com,2025:newsml_L8N3XN1SM:0-telefonica-to-delist-adss-from-nyse-over-cost-administrative-burdens/) y el [6-K de la SEC](https://www.sec.gov/Archives/edgar/data/814052/000081405225000116/tefdel.htm).
  - Conversión de AXIA5/AXIA6 a 1,1 AXIA3 desde el 2026-06-08, según [Seu Dinheiro](https://www.seudinheiro.com/2026/bolsa-dolar/fim-de-axia5-e-axia6-na-bolsa-de-valores-veja-o-que-acontece-com-as-acoes-da-ex-eletrobras-hoje-kaes/) y el [Plantão de la B3](https://sistemasweb.b3.com.br/PlantaoNoticias/Noticias/Detail?idNoticia=3380314&agencia=15&dataNoticia=2026-06-01+05%3A39%3A16).

## Respuestas a lo que pidió el coordinador

**Los 15 tickers en vivo.**
- Salen como listado de EE.UU. en USD: DTE (DTE Energy 128,31), ALV (Autoliv), AIR (AAR), MC (Moelis), OR (OR Royalties), ETB (Eaton Vance), BP (48,81), VOD (XNAS), SHEL, AZN, SAP (220,49), SAN, BBVA y TTE.
- TEF va a XMAD (3,224 EUR).
- ECOPETROL, PFAVAL, GEB, ISA, BHI e ICOLCAP van a XBOG.
- EC, CIB y ASML siguen en EE.UU.
- Las minúsculas (`ecopetrol`, `tef`) funcionan.

**¿Es correcta la excepción de TEF?** Sí. Telefónica dejó la NYSE (Form 25 del 2026-01-08) y su ADS equivalía a 1 acción ordinaria, así que Madrid en EUR es el precio económico correcto. Matiz (M41): una posición histórica `XNYS:TEF` importada pasa a recibir precios de Madrid. Falta además un evento "ADS → ADR nivel 1 OTC" en la tabla común.

**¿La web cuenta dos veces la semilla?** No:
- `mergePriceSeries` guarda `series.seed` en su propia fecha real y solo si no hay ya un cierre para esa fecha (`repo.ts:197`).
- `points` queda siempre dentro de [from, to]: BCOLOMBIA y PFBCOLOM en `1mo` dan 3 meses cada uno.
- Si `from` es el día 1, la semilla es el cierre real del mes anterior. Si `from` cae a mitad de mes, el cierre del mes lo da el último punto del mes. En ningún caso queda mal fechado un fin de mes.

**Integración con la tabla de renombres y fechas de NATU3.** Funciona:
- `NATU3 2019-06..2020-03` → la Natura Cosméticos original, con `MERGER → NTCO3` el 2019-12-18 y **sin** marcarla `delisted`.
- `NATU3` desde 2025-05 → solo la NATU3 nueva, con el primer cierre en 2025-07-31.
- `NTCO3` → `conversion`, sin precios prestados, con `MERGER → NATU3` el 2025-07-02.
- `TRPL4` → ISAE4, continua desde 2019 y con el split 4:1 del 2019-04-05.
- Detalle menor: la serie de 2019 incluye una barra el **2019-12-18** (36,86) aunque `lastTradingDay` es el 2019-12-17.

**Seguridad de las rutas de correo en el servidor:**
- **Autenticación:** el webhook pasa por `API_TOKEN` (comparado en tiempo constante). `?api_key=` solo se acepta en `POST /api/inbox/email`: un `GET /api/catalog?api_key=…` da 401. Después pasa por `adminForbidden`, por `INBOX_SECRET` y por el remitente/SPF/DKIM del handler.
- **Límites:** hay un bucket global de mensajes por hora y uno por cliente. El tamaño se mide sobre el flujo (`bodyLimit`, 413), y lo mismo se aplica al `DELETE` de borradores.
- **SYNC_DIR sin path traversal:** `FileStore` usa el sha1 de la clave como nombre de archivo, con modo 0600. `portfolioId` se valida con una regex y el token del destinatario también.
- **Candados:** `KeyedLock` encadena por clave y una promesa rechazada no rompe la cadena. `save` vuelve a deduplicar bajo el candado y `clearDrafts` con `ids` conserva lo que llegó después.
- **Log:** el enmascarado de `?api_key/secret/token` se puede saltar (ver M40).

## Gaps de R5, verificación uno por uno

| ID | Estado | Evidencia |
|---|---|---|
| M36 | **Corregido** | Los 15 tickers resuelven a EE.UU. salvo TEF, que va a Madrid por una excepción justificada. Los símbolos locales largos van a la BVC. |
| M37 | **Corregido** | `series.seed` aparte; la web lo consume sin contarlo dos veces; la suite en vivo vuelve a estar en verde. |
| M29, M2, M15, M8, M13, M18 | **Persisten** | Las fuentes (COTAHIST de B3, BVC, BCB, BCE, FRED) siguen bloqueadas desde aquí; las herramientas existen. |

## Gaps abiertos

### M38 (media, nuevo). Las claves de los proveedores de pago se filtran en el cuerpo de los errores
- **Evidencia** (`keyleak.mts`): Yahoo caído y los proveedores con clave respondiendo 429 o con timeout. `GET /api/history?symbol=AAPL` o `PETR4.SA` → **502**, y en `details.fallbacks` aparecen literalmente `FMP-SECRET-456`, `EOD-SECRET-789`, `AV-SECRET-000`, `STOOQ-SECRET-222` y `BRAPI-SECRET-111`.
- **Causa:** `HttpClient` construye `Upstream rate limit (429) … : ${url}` y `Upstream timeout: ${url}`, con la clave dentro de la query. `mapHttpError` reenvía tal cual los `MarketDataError` que ya traen ese mensaje.
- **Impacto:** el log del servidor no las muestra, pero cualquier cliente de la API (el navegador, sus herramientas de desarrollo, un reporte de errores) ve las claves de pago.
- **Arreglo:** censurar los parámetros `apikey`, `api_token`, `token`, `apiKey` y `key` de toda URL antes de incluirla en un mensaje de error, o no incluir URLs en los errores de los proveedores. Añadir una prueba.

### M39 (media, nuevo, hueco conocido). Eletrobras preferenciales: falta la conversión AXIA5/AXIA6 → 1,1 AXIA3
- **Evidencia:** `history ELET6` y `AXIA6` → `NOT_FOUND`, sin `MERGER`. Según la B3 y la compañía, AXIA5 y AXIA6 (antes ELET5 y ELET6) se convirtieron en **1,1 AXIA3** el 2026-06-08.
- **Impacto:** un tenedor de la PNB de Eletrobras, una posición muy común en Brasil, queda sin precio ni conversión desde junio de 2026.
- **Arreglo:** añadir a `TICKER_EVENTS` de core (tarea compartida con importers): ELET6→AXIA6 y ELET5→AXIA5 como renombres, y AXIA5/AXIA6 → AXIA3 con ratio 1,1 y efectiva el 2026-06-08.

### M29 (media, persiste). Títulos deslistados sin historia
- Faltan los archivos congelados de BRFS3, NTCO3, CPLE5, CPLE6 y CPLE11, y ahora también ELET6 y AXIA5/AXIA6.

### M2 (media, persiste). Sin segunda fuente pública para la BVC ni Londres

### M15 (media, persiste). Fuentes oficiales de Brasil, BCE y FRED sin validar en vivo

### M40 (baja, nuevo). El enmascarado de secretos en el log se puede saltar
- **Evidencia** (`mask.mts`):
  - `POST /api/inbox/email?api%5Fkey=<API_TOKEN>` **autentica**: Hono decodifica el nombre del parámetro.
  - Sin embargo, el log muestra la línea `?api%5Fkey=TOPSECRETTOKEN…` en claro.
  - Variantes mal escritas (`x=1;api_key=…`, `api_key%3D=…`) también dejan el token en el log, aunque den 401.
- **Arreglo:** enmascarar sobre los parámetros ya decodificados (`URLSearchParams`), o registrar solo la ruta sin query en `/api/inbox/*`.

### M41 (baja, nuevo). Bordes de la resolución
- `ETB` y `BVC` sin bolsa dan el fondo Eaton Vance y BitVentures (EE.UU.), cuando un usuario colombiano suele referirse a ETB.CL y BVC.CL. Es coherente con la regla, pero la respuesta no avisa: falta un `ambiguous` con alternativas.
- Falta el evento de los ADS de Telefónica (NYSE → OTC nivel 1).
- La serie de NATU3 de 2019 trae una barra el día efectivo de la conversión (2019-12-18), posterior a `lastTradingDay`.

### M42 (baja, nuevo). La bandeja de borradores descarta en silencio
- Pasados 200 borradores por cartera, se eliminan los más antiguos aunque no se hayan confirmado, sin aviso.
- El `seq` de los ids se reinicia en cada arranque; solo el milisegundo evita colisiones.
- **Arreglo:** avisar con un 429 o un 507, o marcar `dropped`. Usar ids aleatorios.

### M8, M13, M18 (baja, persisten)
