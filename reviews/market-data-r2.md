# Revisión R2 — Datos de mercado + servidor API (`packages/market-data`, `apps/server`)

Revisor: agente revisor independiente, en modo solo lectura sobre el código. Fecha: 2026-10-06.

## Veredicto

**No aprobado, pero el salto desde R1 es grande.** Verifiqué de forma independiente que 13 de los 19 gaps están cerrados. Los otros 6 están parcialmente resueltos y siguen abiertos. Con esta ronda la parte ya tiene lo que ningún competidor global trae listo para Colombia:
- FIC y fondos de pensiones/cesantías en vivo (Superfinanciera).
- IPC Colombia derivado de la UVR: coincide con el DANE en 20 de 20 meses.
- IBR, DTF, UVR y TPM.
- TRM con respaldo oficial (SDMX de BanRep).
- Alias de tickers renombrados.
- Eventos corporativos tipados.

Hay un fallo nuevo de severidad **alta**. El alias de una **fusión** (BRFS3→MBRF3) sirve los precios y dividendos de **otra compañía** (Marfrig) como si fueran de BRF, y usa razón 1 cuando la de canje es 0,8521. Además aparecen varios gaps medios nuevos en el código añadido.

| | Puntaje |
|---|---|
| **Nuestra parte (market-data + server)** | **7 / 10** (R1: 5) |
| **Mejor competidor para este trabajo: Portfolio Performance** | **7 / 10** |

Ya cubrimos en el producto, sin configuración, más fuentes colombianas y brasileñas que Portfolio Performance (que exige montar a mano proveedores JSON o HTML). No lo superamos porque:
- Sin claves de API, una caída de Yahoo deja sin precio a la BVC, a Londres y a casi todo B3.
- Varios proveedores (BCB, BCE, FRED, Tesouro, brapi, stooq) solo están probados con fixtures sintéticos.
- Hay un error alto de integridad de datos (M23).

Para ser estrictamente mejor falta cerrar M23, M20 a M22 y M25, y dar respaldo real a la BVC.

## Qué se verificó

- `npx vitest run packages/market-data apps/server`: **200 OK**, con 15 pruebas en vivo omitidas por diseño.
- `tsc --noEmit` limpio en `packages/market-data` y en `apps/server`, ignorando como se pidió los errores de `apps/web` e importers.
- `LIVE=1 … live.test.ts`: **15/15 OK**. Desde este contenedor BCB, BCE, FRED, Tesouro, brapi y stooq responden **403**: las pruebas lo reportan y pasan.
- Servidor levantado con la configuración por defecto en `127.0.0.1:18788`, probado con curl y luego detenido. Comprobé que no quedó ningún proceso escuchando.
- Scripts nuevos en `scratchpad/review-md/`:
  - `today.mts`: última barra del historial frente a la cotización.
  - `delete-auth.mts`: autorización de `DELETE /api/cache`.
  - `custom-feed.mts`: alineación de los feeds JSON e intento de inyección de URL.
  - `failover.mts`: Yahoo caído, sobre fixtures.
- Además volví a correr los scripts de R1 (`split-fail-cache`, `renames`, `illiquid`).
- Fuentes web:
  - Relación de canje BRF→Marfrig de 0,8521, según [Exame](https://exame.com/invest/mercados/fusao-entre-marfrig-e-brf-estreia-hoje-na-bolsa-o-que-muda-para-os-acionistas-de-mbrf3/) y [Suno](https://www.suno.com.br/noticias/fusao-marfrig-brf-acoes-brfs3-mrfg3-go/).
  - En Copel, cada PNB se cambió por 1 ON más 1 PNC rescatada a R$0,7749, según [Investidor10](https://investidor10.com.br/noticias/copel-cple6-unifica-acoes-e-inicia-caminho-ao-novo-mercado-da-b3-114955/) y [XP](https://conteudos.xpi.com.br/esg/copel-cple6-avanca-em-migracao-para-novo-mercado-da-b3-cafe-com-esg-18-11/).
  - Competidores: lo consultado en R1. Las capacidades de Gorila, Kubera y Kinvo vienen de conocimiento previo y no las verifiqué hoy.

## Gaps de R1: verificación uno por uno

| ID | Estado | Evidencia |
|---|---|---|
| M1 | **Corregido** | Con el endpoint de splits caído, la respuesta lleva la nota `split history unavailable … (not cached)` y no se persiste. Un segundo proceso con el mismo store devuelve **481.68**; en R1 devolvía 48.17 para siempre. |
| M2 | **Persiste (parcial)** | La cadena de respaldo existe y funciona: con Yahoo caído, PETR4 sale de brapi y AAPL de stooq. Pero sin claves ECOPETROL.CL, VOD.L e ITUB4.SA dan `UPSTREAM_ERROR … fallbacks ["yahoo"]`. La BVC solo tiene respaldo con Twelve Data, que requiere clave. |
| M3 | **Corregido** | IPC_CO de 2024-01 a 2025-08 coincide con el DANE: 0,92; 1,09; 0,70; 0,59; 0,43; 0,32; 0,20; 0,00; 0,24; −0,13; 0,27; 0,46; 0,94; 1,14; 0,52; 0,66; 0,32; 0,10; 0,28; 0,19. La matemática se comprobó: en la UVR, del 16 de m+1 al 15 de m+2 se compone el IPC de m, y la UVR del 15 al 16-sep-2025 da un factor diario coherente con 0,19 %. IBR, UVR, DTF y COLCAP_AVG funcionan en vivo. CDI e IPCA (SGS) no se pudieron validar desde aquí. |
| M4 | **Corregido** | FIC (`FIC:5-31-2852-800`, Fiducuenta) y AFP (`AFP:3-1000`, Porvenir Moderado) dan historia mensual en vivo. Las búsquedas "fiducuenta", "porvenir moderado" y "proteccion cesantias" funcionan. Hay plantillas CDT y CDB con `AccrualSpec`. Tesouro solo está validado con fixture y le faltan los cupones (ver M26). |
| M5 | **Corregido**, con regresión en M23 | PFBCOLOM, BCOLOMBIA, ELET3, EMBR3 y CCRO3 resuelven con historia desde 2019 y `renamedFrom`. |
| M6 | **Corregido** | CNEC: el historial termina en 2025-11-14 en 5000, igual que la cotización, con `stale` y `lastTradeDate`. |
| M7 | **Corregido** | ITUB4 2025-03-18 sale como `STOCK_DIVIDEND` 1.1. GE 2024-04-02 sale como `SPLIT/SPINOFF` hacia XNYS:GEV, con razón 0.25, `costFraction` 0.2019 y `reviewRequired`. |
| M8 | **Persiste (parcial)** | VUSA.L ya trae dividendos en `currency: USD`. JCP y fecha de pago solo llegan vía brapi, y sin token eso cubre 4 tickers. La BVC sigue sin fecha de pago ni cuotas. |
| M9 | **Corregido** | 0254.HK→XHKG:0254, 7203.T→XTKS, RELIANCE.NS→XNSE, 5614.KL→XKLS e ISAT.JK→XIDX. El id vuelve a resolverse, con moneda y país correctos. |
| M10 | **Corregido** | El servidor escucha en `127.0.0.1`. Un Origin ajeno o `null` recibe 403. Hay token opcional. El límite por cliente responde 429 con `Retry-After`. El batch tiene tope de puntos (~207k → 400). |
| M11 | **Corregido** | Un cuerpo chunked de 300 KB recibe **413**. |
| M12 | **Corregido** | `CRYPTO:..`, `YAHOO:../x`, `TD:../../etc` e inyecciones SoQL en `FIC:` se rechazan con 400 antes de llamar al proveedor. |
| M13 | **Persiste (parcial, baja)** | El benchmark COLCAP es ICOLCAP con `adjust=total`; verifiqué la fórmula, que da 2024 = 16,26 % frente a 15,04 % de precio. El índice real solo existe como **promedio** mensual, no como cierre. |
| M14 | **Corregido** | En vivo: `provisional: true`, `marketState` y `asOf`. |
| M15 | **Persiste (parcial)** | Se añadió `side` compra/venta. `buy` fuera de PTAX responde 422 explícito, lo cual está bien. Pero PTAX y SGS siguen sin validarse contra los servicios reales. |
| M16 | **Corregido** | Hay chunks por año, `FileStore` con poda LRU e invalidación. La autorización de la invalidación es débil (ver M21). |
| M17 | **Corregido** | Los ítems basura del batch reciben `BAD_REQUEST` por ítem, también con `__proto__` y `constructor`. Excepción: los índices, ver M25. |
| M18 | **Persiste (parcial, baja)** | "isa" ya no devuelve Visa, y el ISIN de EE.UU. y B3 funciona. El ISIN colombiano `COB07PA00078` (Bancolombia preferencial) sigue dando `[]`. |
| M19 | **Corregido** | Hay CoinGecko de respaldo. BTC/COP, ETH/USD y USDT/COP funcionan en `/api/fx`. |

## Mejor que la competencia, nuevo en R2

1. **FIC y fondos de pensiones/cesantías colombianos en vivo**, con búsqueda por nombre. Ningún competidor global ni brasileño lo trae.
2. **IPC Colombia exacto sin el DANE**, derivado de la UVR y verificado mes a mes. Además IBR (4 plazos, nominal y E.A.), DTF, UVR y TPM. Junto con CDI, Selic e IPCA del lado brasileño, ya se puede calcular rentabilidad real en COP y BRL.
3. **Eventos corporativos tipados**: bonificação como `STOCK_DIVIDEND`, spin-off con instrumento destino y `costFraction`, y `reviewRequired`.
4. **Seguridad del servidor por defecto** al nivel de una herramienta autoalojada seria: loopback, verificación de Origin en servidor, 413 en flujo, rate limit y validación estricta.
5. **Feeds JSON/CSV definidos solo en configuración**, sin que ningún parámetro de la petición pueda alterar la URL (verificado). Es el equivalente al proveedor JSON de Portfolio Performance.

## Peor que la competencia

1. Para la BVC y Londres **no hay respaldo sin claves**. Sharesight usa datos licenciados; Portfolio Performance permite cualquier URL por instrumento.
2. **Fusiones mal modeladas** (M23). Gorila y Kinvo aplican la relación de canje oficial de B3.
3. Tesouro sin cupones (M26) y CDI/IPCA sin fuente alternativa (M25). Gorila es más robusto en renta fija brasileña.
4. Varios proveedores nuevos solo están probados con fixtures, porque el contenedor no tiene acceso.

## Gaps abiertos

### M23 (alta, nuevo). Los alias de fusión sirven precios y dividendos de otra compañía y usan razón 1
- **Evidencia, en vivo**:
  - `GET /api/history?symbol=BRFS3&from=2024-01-01&to=2024-06-30&interval=1mo` → `BVMF:MBRF3` con 9.41, 9.90, 10.31, 9.45, 11.28, 12.36. Es **idéntico** a `symbol=MRFG3`, es decir, la historia de **Marfrig**. BRF cotizaba en otro nivel.
  - El dividendo extraordinario de Marfrig del 2024-12-13 (R$2.83) aparece como dividendo de BRF.
  - `quote BRFS3` → MBRF3 a 17.80 con `renamedFrom.ratio: 1`. La relación de canje oficial es **0,8521** MBRF3 por cada BRFS3, así que un tenedor de BRF queda sobrevalorado un **17,4 %**.
  - `CPLE6→CPLE3` con ratio 1 ignora el rescate de la PNC (R$0,7749 en efectivo por acción).
- **Arreglo**:
  - Distinguir **renombre** (misma compañía, se puede coser la historia) de **fusión o incorporación**. En una fusión no se devuelve la historia del absorbente como historia del absorbido. Se corta en la fecha efectiva, se marca `delisted` y se emite `MERGER` con razón y efectivo.
  - Poner las razones verificadas: BRFS3 0,8521 y MRFG3 1. Para CPLE6, 1 acción más un evento de caja de R$0,7749.
  - No publicar alias marcados "verificar relação" hasta que estén verificados.

### M20 (media, nuevo). Se descarta la barra del día con `close: null`: historial y cotización discrepan
- **Evidencia**:
  - SAP.DE el 2026-10-06 a las 22:51 UTC, más de 7 horas después del cierre de Xetra: el historial termina el **10-05 en 185.04**, mientras `lastTradeDate` es 10-06 y la cotización 10-06 es **188.6**.
  - En crudo, Yahoo trae `2026-10-06T07:00 close: None` con `regularMarketPrice: 188.6`.
  - Riesgo: el chunk anual pasa a **inmutable** en cuanto termina el año. Si en el último día hábil del año Yahoo deja el null, el cierre del 31-dic (patrimonio) queda mal para siempre.
- **Arreglo**: si la última barra tiene `close` null y su fecha es la de `regularMarketTime`, completarla con `regularMarketPrice`. No congelar un chunk anual cuya última barra no coincida con el último día hábil o con `regularMarketTime`.

### M21 (media, nuevo). La autorización de `DELETE /api/cache` por loopback se puede saltar
- **Evidencia** (`delete-auth.mts`, sin `API_TOKEN`):
  - En modo serverless (`app.fetch`, sin socket), el `clientId` vale `'local'` → **200**.
  - Con `trustProxy` y `X-Forwarded-For: 127.0.0.1` falsificado desde 203.0.113.9 → **200**.
  - Detrás de un proxy inverso en la misma máquina, cualquier cliente remoto aparece como 127.0.0.1 → **200**.
  - Además, en serverless todos los clientes comparten un único bucket: 4 clientes distintos con capacidad 3 dan `200,200,200,429`.
- **Arreglo**: exigir `API_TOKEN` para `DELETE` siempre, salvo una opción explícita `allowLocalAdmin` que solo valga sin proxy. No tratar `'local'` como loopback.

### M22 (media, nuevo). Los feeds JSON personalizados desalinean fechas y precios si falta un campo
- **Evidencia** (`custom-feed.mts`): filas al estilo datos.gov.co, que **omite los campos nulos**, con la del 09-29 sin `valor_unidad_operaciones`.
  - Esperado: 09-28=100, 09-29 ausente, 09-30=102, 10-01=103.
  - **Real**: 09-28=100, **09-29=102, 09-30=103**, y el 10-01 se pierde.
  - La causa es que `jsonPath` filtra `undefined` por separado en las fechas y en los cierres. El propio ejemplo del docstring es un dataset de datos.gov.co.
- **Arreglo**: extraer pares por fila (`rowsPath` + campos relativos) o conservar los huecos sin filtrar y emparejar por índice.

### M25 (media, nuevo). Los índices devuelven 500 INTERNAL ante fallos del proveedor y no tienen fuente alternativa
- **Evidencia**: `GET /api/index?id=CDI&from=2026-09-01` → **HTTP 500** `{"code":"INTERNAL","message":"Internal error"}`, cuando debería ser 502 `UPSTREAM_ERROR`. El log muestra `HTTP 403 … api.bcb.gov.br`.
  - `fetchSgs`, FRED y BCE no pasan por `mapHttpError`.
  - El SGS devuelve 404 para ventanas sin datos y cae con frecuencia, y no hay segunda fuente para CDI ni IPCA (como B3/CETIP o IBGE SIDRA).
- **Arreglo**: mapear los errores HTTP en todos los loaders de índices, añadir SIDRA para el IPCA, y servir la última serie cacheada (stale-if-error) con nota.

### M26 (media, nuevo). Tesouro Direto sin cupones
- **Evidencia**: `TesouroProvider` solo emite precios (PU venda). Los títulos "com Juros Semestrais" (NTN-B y NTN-F) pagan cupón cada 6 meses y su PU cae ese día. Sin una acción `INTEREST`, la rentabilidad mensual muestra una pérdida falsa de cerca de 3 % semestral. Además, el CSV solo está validado con un fixture.
- **Arreglo**: generar los eventos de cupón con el calendario oficial (15-ene/15-jul para NTN-B; 1-ene/1-jul para NTN-F) y su valor por título, a partir de la tasa del título o del CSV de cupones del Tesouro.

### M2 (media, persiste parcial). Sin respaldo de precios para la BVC, Londres y la mayor parte de B3 sin claves de API
- **Evidencia** (`failover.mts`, Yahoo 503): ECOPETROL.CL, VOD.L e ITUB4.SA → `UPSTREAM_ERROR`. brapi sin token solo cubre PETR4, MGLU3, VALE3 e ITUB4… pero ITUB4 falló con el fixture. stooq solo cubre EE.UU., Xetra, Tokio y HK.
- **Arreglo**: añadir una fuente gratuita para la BVC (por ejemplo, el endpoint público de cierres de la BVC o un feed JSON preconfigurado), aplicar el ajuste de splits que ya está cacheado a los respaldos que entregan precios ajustados, y documentar qué cubre cada clave.

### M8 (media, persiste parcial). Dividendos de la BVC sin fecha de pago ni cuotas; JCP solo con token de brapi
- **Arreglo**: obtener el calendario de dividendos de la BVC (cuotas y fechas de pago) y fijar `kind` por defecto para B3 a partir de fuentes de proventos.

### M15 (media, persiste parcial). PTAX, SGS, BCE, FRED, Tesouro, brapi y stooq sin validar contra los servicios reales
- **Evidencia**: todos responden 403 en el contenedor y sus fixtures son sintéticos. Es un riesgo de formato, no un error demostrado.
- **Arreglo**: regrabar los fixtures en la máquina del usuario y añadir un "contract test" en CI con acceso.

### M24 (baja, nuevo). `stale` en falso para rangos históricos de proveedores que no son Yahoo
- **Evidencia**: `history FIC:5-31-2852-800 from=2025-01-01 to=2025-06-30` → `stale: true`, con la nota "no trades since 2025-06-30: instrument suspended, delisted or illiquid". Ocurre porque `simpleHistory` toma `lastTradeDate` como la última fecha **del rango** pedido. Lo mismo pasa con stooq, brapi, Tesouro y los feeds personalizados.
- **Arreglo**: calcular `lastTradeDate` sobre los datos completos del proveedor, o no marcar `stale` cuando `to < hoy`.

### M27 (baja, nuevo). Endurecimiento del servidor pendiente
- **Evidencia**:
  - Un batch de hasta 100 ítems cuesta solo 10 tokens, así que el rate limit permite unas 1 200 historias por minuto (unas 2 400 llamadas a Yahoo).
  - `/api/health` también consume tokens: con el bucket agotado devuelve 429.
  - No se valida la cabecera `Host`: con DNS rebinding, un GET same-origin no envía Origin y la respuesta es legible. Son datos públicos, así que el impacto es bajo.
- **Arreglo**: cobrar por ítem en el batch, excluir `health` del límite y aceptar solo `Host` en una allowlist (localhost / 127.0.0.1).

### M13 (baja, persiste parcial). COLCAP real solo como promedio mensual; el benchmark es ICOLCAP con retorno total
- **Arreglo**: obtener los cierres diarios del índice desde la BVC.

### M18 (baja, persiste parcial). ISIN colombianos sin resolver
- **Evidencia**: `COB07PA00078` → `[]`.
- **Arreglo**: añadir los ISIN de la BVC al catálogo, o consultar OpenFIGI.
