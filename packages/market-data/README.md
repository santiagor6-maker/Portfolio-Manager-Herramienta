# @pm/market-data

Precios, dividendos/splits, tasas de cambio y búsqueda de instrumentos para **Portafolio Pro**
(BVC, B3, Europa, EE.UU.). Lo usa `apps/server` (lado servidor) y la web a través del cliente
tipado `@pm/market-data/client` (sin dependencias de Node, apto para navegador).

## Arquitectura

```
MarketDataService ── resolve(id | símbolo | ISIN | benchmark) ── InstrumentCatalog (catalog/instruments.json)
   │
   ├── YahooProvider        chart v8 (historia diaria + eventos div/splits, cotización vía meta), search v1
   ├── FxRouter ─┬─ BanrepTrmProvider  (datos.gov.co 32sa-8pi3)      fuente: banrep-trm
   │             ├─ BcbPtaxProvider    (Olinda OData PTAX)          fuente: bcb-ptax
   │             ├─ BcbSgsProvider     (SGS 1 = USD, 21619 = EUR)   fuente: bcb-sgs
   │             ├─ EcbProvider        (SDMX CSV, tasas de referencia) fuente: ecb
   │             └─ YahooFxProvider    (COP=X, BRL=X, EURUSD=X...)  fuente: yahoo (respaldo universal)
   ├── TieredCache          LRU en memoria + PersistentStore enchufable (FileStore en el servidor)
   └── HttpClient           User-Agent de navegador, límite de concurrencia y ritmo por host,
                            reintentos con backoff ante 429/5xx (respeta Retry-After), timeouts,
                            de-duplicación de peticiones idénticas en vuelo
```

Archivos principales: `src/service.ts`, `src/providers/*.ts`, `src/fx-router.ts`, `src/cache.ts`,
`src/http.ts`, `src/symbols.ts`, `src/series.ts`, `src/catalog.ts`, `src/client.ts`, `src/types.ts`.

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
| USD/COP, COP/USD | `banrep-trm` | `yahoo` |
| X/BRL (USD, EUR, GBP, CHF, JPY, CAD, AUD, DKK, NOK, SEK) | `bcb-ptax` (venda, boletim de fechamento) → `bcb-sgs` (USD, EUR) → `ecb` (cruce) | `yahoo` |
| EUR/X y cruces entre monedas del BCE (USD/GBP, USD/MXN, CHF/USD...) | `ecb` | `yahoo` |
| Sin fuente directa pero con ambas patas oficiales vs USD (EUR/COP, BRL/COP, MXN/COP...) | triangulación `ecb*banrep-trm`, `bcb-ptax*banrep-trm` | `yahoo` |
| CLP, PEN y otros | — (`official` → error 422) | `yahoo` |

Se prioriza el banco central local de la moneda emergente (EUR/BRL → PTAX antes que BCE).
Cada fallo queda en `fallbacks: [{source, error}]` y la fuente que respondió en `series.source`.
Yahoo: pares sin USD (p. ej. `BRLCOP=X`, casi sin historia) se triangulan con `BRL=X` y `COP=X`.
Un resultado obtenido tras un fallo de la fuente preferida se cachea solo 1 hora.

## Caché y TTL

| Dato | TTL |
|---|---|
| Historia cuyo `to` es anterior al mes actual | inmutable (se persiste en disco) |
| Historia que termina antes de hoy en el mes actual | 12 h |
| Historia que llega a hoy | 10 min |
| Cotización | 10 min (configurable, `quoteTtlMs`) |
| Búsqueda en Yahoo, historia de splits | 1 día |

Solo se persisten entradas con TTL ≥ 1 h. Si el proveedor falla y hay una entrada vencida, se
sirve la vencida (*stale-if-error*). Cargas concurrentes de la misma clave se comparten.
`PersistentStore` es una interfaz (`get/set/delete`); el servidor usa `FileStore`, la web podría
usar IndexedDB.

## Catálogo curado (`src/catalog/instruments.json`)

200 instrumentos validados uno a uno contra Yahoo el 2026-10-05 (el test en vivo cotiza los 200):
30 BVC, 75 B3 (líderes del Ibovespa, 9 FII, 7 ETF), 44 EE.UU. (acciones, ETF, ADR latinoamericanos),
39 Europa/LatAm (Madrid, Xetra, París, Ámsterdam, Milán, Suiza, Londres, México, Santiago) y
9 índices. ISIN solo donde hay certeza (88, todos con dígito de control válido). Benchmarks:
`COLCAP` (proxy ICOLCAP.CL), `IBOV` (^BVSP), `SPX` (^GSPC), `MSCI_WORLD` (proxy URTH), `SX5E`
(^STOXX50E), `NASDAQ`, `IPC`, `MSCI_ACWI`, `MSCI_EM`.

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
LIVE=1 npx vitest run packages/market-data/test/live.test.ts   # opcional, contra Yahoo y datos.gov.co
```

Fixtures (`test/fixtures/`): las respuestas de Yahoo y datos.gov.co son **reales**, grabadas con
curl el 2026-10-05. BCB (PTAX OData, SGS) y BCE (SDMX CSV) no son accesibles desde el contenedor
de desarrollo: sus fixtures siguen exactamente los formatos documentados, con valores plausibles
pero **sintéticos**. Conviene regrabarlos en una máquina con acceso
(`curl "https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/CotacaoDolarPeriodo(dataInicial=@dataInicial,dataFinalCotacao=@dataFinalCotacao)?@dataInicial='01-02-2025'&@dataFinalCotacao='02-03-2025'&\$format=json"`).

## Pendiente

- Validar PTAX/SGS/BCE contra los servicios reales (el código sigue la documentación; en este
  contenedor responden 403 y el router cae a Yahoo correctamente).
- Otras fuentes de precios (brapi para B3, stooq) detrás de la interfaz `PriceProvider`.
- Fondos colombianos (FIC) y renta fija (CDT, Tesouro Direto) no tienen precio en Yahoo: van
  como `pricing: 'manual'`.
- La moneda de resultados de búsqueda de Yahoo en LSE se infiere (GBP); la real llega en
  `/api/quote` o `/api/history` (los ETF del catálogo ya tienen la moneda correcta).
