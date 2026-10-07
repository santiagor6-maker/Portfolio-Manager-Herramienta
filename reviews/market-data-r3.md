# Revisión R3: datos de mercado y servidor API (`packages/market-data`, `apps/server`)

Revisor: agente revisor independiente (solo lectura sobre el código). Fecha: 2026-10-07.

## Veredicto

**No aprobado, por un único gap alto nuevo.** La ronda 3 cierra correctamente el problema grave de R2 (M23, la fusión BRF/Marfrig) y otros 7 gaps medios y bajos, y los verifiqué todos en vivo. Pero al probar la otra fila de la tabla de alias apareció el mismo tipo de fallo por otra vía. NTCO3→NATU3 está marcado como `rename` ("Yahoo movió la historia"), y no es así. La historia que se sirve:
- Tiene un **hueco total de 2020-01 a 2025-05**.
- Valora el cierre de **junio de 2025 en 36,86**, cuando el valor real rondaba R$10 (≈3,6× de más). Ese 36,86 sale de barras fantasma de Yahoo con volumen 0.

Es un error silencioso de valoración en el fin de mes, que es justo el caso central del producto.

| | Puntaje |
|---|---|
| **Nuestra parte (market-data + server)** | **7,5 / 10** (R1: 5 · R2: 7) |
| **Mejor competidor para este trabajo: Portfolio Performance** | **7 / 10** |

Por amplitud para un inversionista colombo-brasileño ya superamos a Portfolio Performance sin configuración:
- TRM oficial con respaldo.
- FIC y AFP en vivo.
- IPC Colombia exacto desde la UVR, más IBR, DTF y UVR.
- CDI, IPCA (con SIDRA de respaldo) y Tesouro con cupones.
- Eventos corporativos tipados y fusiones modeladas.
- Servidor endurecido.

La regla de aprobación exige además que no haya ningún gap alto, y M28 lo es. Cerrando M28 (con un filtro genérico de barras sin volumen más la corrección del alias) la parte quedaría aprobable tal como está.

## Qué se verificó

- `npx vitest run packages/market-data apps/server`: **232 OK** (17 en vivo omitidas por diseño). `tsc --noEmit` limpio en ambos paquetes.
- `LIVE=1 … live.test.ts`: **17/17 OK**. Ojo: las "pruebas de contrato" de BCB, SIDRA, BCE, FRED, Tesouro, brapi y stooq pasan aunque los servicios respondan "UNREACHABLE" (403 desde aquí). Por eso no prueban nada todavía.
- Servidor levantado con la configuración por defecto en `127.0.0.1:18789`, probado con curl y luego detenido. Comprobé que no quedó ningún proceso escuchando.
- Scripts de R2 vueltos a correr: `today.mts` (M20), `delete-auth.mts` (M21), `custom-feed.mts` (M22). Más pruebas nuevas con curl y Yahoo crudo para NTCO3/NATU3, CPLE6/CPLE5/CPLE11 y BRFS3.
- Fuentes web:
  - [ADVFN](https://br.advfn.com/jornal/2025/11/copel-conclui-unificacao-das-acoes-preferenciais-na-b3), [Visno](https://visnoinvest.com.br/news/11091/copel-cple3-cple5-conclui-migracao-para-o-novo-mercado-da-b3-e-passa-a-negociar-apenas-acoes-ordinarias-sob-cple3) e [Investidor10](https://investidor10.com.br/noticias/copel-cple6-vai-tirar-um-tipo-de-acao-do-mercado-entenda-116538/): CPLE6 negoció por última vez el **2025-11-07** y pasó a CPLE5 el 2025-11-10. CPLE5 se convirtió en CPLE3 + CPLE7 (rescate de R$0,7749) el 2025-12-22.
  - [A Revista](https://arevista.com.br/acoes/fim-de-cple6-e-cple11-como-declarar-o-resgate-e-recalcular-o-preco-medio-da-copel-no-irpf-2026/): el pago es un **rescate** que recalcula el precio medio.
  - Competidores: lo consultado en R1. Gorila, Kinvo, Status Invest y Kubera, por conocimiento previo, no verificados hoy.
- **Corrección a mi R2:** en M26 propuse cupones de NTN-B en ene/jul y estaba equivocado. El constructor tiene razón: la NTN-B paga en el mes de vencimiento y seis meses después (2035/2045 en may/nov; 2030/2040 en feb/ago). Las fórmulas también son correctas: NTN-F R$48,80885 = 1000·(1,10^0,5−1); NTN-B VNA·2,956301 %; VNA de R$1000 el 2000-07-15, multiplicado cada día 15 por el IPCA del mes anterior.

## Gaps de R2, verificación uno por uno

| ID | Estado | Evidencia |
|---|---|---|
| M23 | **Corregido** (pero ver M28) | `quote BRFS3` → `DELISTED`, `details.delisted.ratio 0.8521`, `suggest BVMF:MBRF3`. El historial de BRFS3 ya no trae precios de Marfrig (`points: []`, `SPLIT/MERGER` 0,8521 → MBRF3). MRFG3 se trata como `rename` hacia MBRF3. CPLE6 → `SPLIT/MERGER` 1 → CPLE3 + R$0,7749 con pago el 2025-12-30. En core, ese efectivo se absorbe en la fusión (`ABSORBED_IN_MERGER`), no cuenta como dividendo. |
| M20 | **Corregido** | Hoy SAP.DE da 187.94 tanto en el historial como en la cotización. El código completa con `regularMarketPrice` la barra null del día de última operación y deja `missingCloseDates`. Un año solo se congela desde el 4 de enero, o desde el 15 si terminó con barras sin cierre. Hay un caso residual: si el null del 31-dic persiste más allá del 15 de enero, el año se congela sin ese cierre (riesgo bajo). |
| M21 | **Corregido** | En serverless, con XFF falsificado y detrás de un proxy local, los tres casos dan **403** sin `API_TOKEN`. En serverless el bucket de rate limit sigue siendo compartido (`anonymous`), pero está documentado con un aviso. |
| M22 | **Corregido** | Esperado 09-28=100, 09-30=102, 10-01=103, y eso es lo que sale. El 09-29 queda vacío, sin desplazar las siguientes filas. |
| M24 | **Corregido** | Un FIC con rango cerrado en 2025-06-30 ya no lleva `stale` ni la nota de suspensión. |
| M25 | **Corregido** | CDI con BCB bloqueado → **502** `UPSTREAM_ERROR`. IPCA intenta `ibge-sidra` como segunda fuente (también bloqueada aquí → 502). Ya no se devuelve 500. |
| M26 | **Corregido** (sin validar en vivo, ver M15) | Cupones `DIVIDEND/COUPON`, que core convierte en `INTEREST`. Fórmulas correctas. Las fechas solo saltan fines de semana (ver M31). |
| M27 | **Corregido** | `Host: evil.example` → 403 y `Host: localhost` → 200. `/api/health` no consume del límite y el batch cobra por ítem. |
| M2 | **Persiste (parcial)** | Ahora hay reintento en `query1` y los respaldos ajustados se pasan a cierres tal como se negociaron. Pero `query1` es la misma infraestructura de Yahoo, y sin claves sigue sin haber segunda fuente para la BVC ni Londres. |
| M8 | **Persiste** | Sin cambios: los dividendos de la BVC siguen sin fecha de pago ni cuotas. |
| M13 | **Persiste (baja)** | Sin cambios: el COLCAP real solo existe como promedio mensual. |
| M15 | **Persiste** | Siguen sin validarse contra los servicios reales PTAX, SGS, SIDRA, BCE, FRED, Tesouro (con los importes de cupón NTN-B, que dependen del IPCA), brapi y stooq. Las pruebas de contrato existen, pero pasan cuando no hay acceso. |
| M18 | **Persiste (parcial, baja)** | `COB07PA00078` → XBOG:PFCIBEST vía alias. Los demás ISIN de la BVC fuera del catálogo siguen sin resolverse. |

## Mejor que la competencia

1. **Datos oficiales de Colombia que nadie trae:** TRM con respaldo SDMX, IPC derivado de la UVR (verificado contra el DANE en 20 meses en R2 y de nuevo hoy: 2024-12 = 0,46 … 2026-08 = 0,39), IBR, DTF, TPM, FIC y fondos de pensiones/cesantías.
2. **Reestructuraciones societarias bien modeladas** (renombre, fusión y conversión, con efectivo, `DELISTED` y `suggest`). Es más explícito que Portfolio Performance y Sharesight, que aquí dependen de ajustes manuales.
3. **Tesouro Direto con cupones semestrales** calculados (NTN-F fijo, NTN-B desde el VNA). Gorila y Kinvo lo hacen; los globales no.
4. **Servidor autoalojado con valores seguros:** loopback, Origin, allowlist de `Host`, token, rate limit por ítem, 413 en flujo y validación estricta.

## Peor que la competencia

1. **Historia de títulos que dejaron de cotizar:** BRF 2019–2025, Copel PNB y Natura &Co 2020–2025 no tienen precios (ver M28 y M29). Sharesight, Gorila, Kinvo y Status Invest conservan la historia deslistada. En Portfolio Performance los precios quedan guardados en el archivo del usuario.
2. **Sin segunda fuente gratuita** para la BVC y Londres (M2).
3. **Brasil oficial sin validar en vivo** (M15): PTAX, CDI, IPCA y Tesouro solo están probados con fixtures.

## Gaps abiertos

### M28 (alta, nuevo). El "rename" NTCO3→NATU3 sirve barras fantasma y un hueco de 5 años: el fin de mes de junio de 2025 sale 3,6× sobrevalorado
- **Evidencia, en vivo** (`/api/history?symbol=NTCO3&from=2019-06-01&to=2025-12-31&interval=1mo`):
  - El historial resuelve a `BVMF:NATU3` con apenas 14 puntos: 2019-06…2019-12-18 (Natura Cosméticos anterior a la holding), luego directamente **2025-06-30 = 36,86** y 2025-07-31 = 9,03.
  - Entre 2020-01 y 2025-05 no hay ningún dato.
  - En la serie diaria, del 2025-06-26 al 2025-07-01, aparecen cuatro cierres de **36,86 con volumen 0**. Son copias del último cierre de 2019, y Yahoo crudo los trae igual.
  - El primer precio real es NATU3 el 2025-07-02 a 10,19. NTCO3 cotizaba alrededor de R$10, así que un usuario con NTCO3 ve su posición de jun-2025 valorada a 36,86.
  - La nota del alias afirma que Yahoo movió la historia; para esta fila es falso (el símbolo viejo da 404 y el nuevo no la tiene).
  - El filtro de M6 solo descarta barras **posteriores** a la última operación; estas barras fantasma están a mitad de la serie.
- **Arreglo**:
  - Descartar barras con volumen 0 cuyo cierre repite exactamente el último cierre real tras un tramo de nulls (genérico, sirve para cualquier símbolo).
  - Reclasificar NTCO3 como "conversión sin historia en el proveedor" hasta tener una fuente (igual que BRFS3), en vez de coserla a NATU3.
  - Añadir una prueba en vivo que exija continuidad mensual a cada alias `rename` (en R2 la hice con 6 renombres y 0 meses faltantes; NTCO3 no estaba).

### M29 (media, nuevo). Los títulos deslistados o fusionados no tienen historia: los fines de mes pasados no se pueden valorar
- **Evidencia**:
  - `history BRFS3 2024-01..06` → `points: []`, con la nota "no provider still has prices for BRFS3.SA". Lo mismo con CPLE6.
  - Además, las fechas de Copel son inexactas. CPLE6 dejó de negociar el **2025-11-07** y fue CPLE5 del 2025-11-10 al 2025-12-22, pero el alias solo registra el 2025-12-22, sin `lastTradingDay`.
  - CPLE11 (units) no figura en la tabla y cae a `XNYS:CPLE11` con `UPSTREAM_ERROR`.
  - Para la tabla mensual, esto deja meses sin valor en posiciones muy comunes en Brasil.
- **Arreglo**:
  - Incluir en el catálogo, para cada alias de fusión o conversión, una historia congelada (cierres diarios o mensuales grabados una vez; son inmutables).
  - Modelar la cadena CPLE6→CPLE5→CPLE3 con sus fechas reales y añadir CPLE11.

### M2 (media, persiste parcial). Sin segunda fuente gratuita para la BVC ni Londres
- **Evidencia**: `query1` es otro host de la misma API de Yahoo. Los demás respaldos requieren clave o no cubren la BVC.
- **Arreglo**: añadir un feed preconfigurado para la BVC, o grabar periódicamente los cierres del catálogo colombiano en una fuente propia.

### M8 (media, persiste). Dividendos de la BVC sin fecha de pago ni cuotas; JCP solo con token de brapi
- **Arreglo**: sin cambios desde R2.

### M15 (media, persiste). Fuentes brasileñas y otras sin validar contra los servicios reales
- **Evidencia**: PTAX compra/venta, SGS, SIDRA, BCE, FRED, el CSV del Tesouro (y con él los importes de cupón NTN-B), brapi y stooq. Todos dan 403 desde aquí, y las pruebas de contrato **pasan** aunque no haya acceso.
- **Arreglo**: que las pruebas de contrato **fallen** cuando hay acceso y el formato cambia, y que se ejecuten en CI o en la máquina del usuario con `RECORD=1`.

### M30 (baja, nuevo). Los tickers de B3 sin sufijo y fuera del catálogo se tratan como de EE.UU.
- **Evidencia**: `quote CPLE3` → `XNYS:CPLE3` y `quote CPLE11` → `XNYS:CPLE11`, ambos con `UPSTREAM_ERROR`, sin sugerir `.SA`. Un extracto de corretora trae "CPLE3", "TAEE11" y similares sin sufijo.
- **Arreglo**: inferir `BVMF` para el patrón `^[A-Z]{4}(3|4|5|6|11|33|34)$` (o probar `.SA` antes que EE.UU.) y añadir `suggest`.

### M31 (baja, nuevo). El calendario de cupones ignora los feriados brasileños
- **Evidencia**: `couponDates` solo salta fines de semana. Por eso el cupón NTN-B de noviembre (15-nov, feriado nacional) y el de NTN-F en enero (1-ene) quedan con fecha de pago en día feriado. Ejemplo: 2024-11-15 cae en viernes, pero el pago real fue el 18. No cambia el mes, pero sí la fecha de pago y el día ex en la vista diaria.
- **Arreglo**: usar el calendario de feriados de B3/ANBIMA, que también sirve para `nextWeekday` en el día ex de brapi.

### M13 (baja, persiste). COLCAP real solo como promedio mensual

### M18 (baja, persiste parcial). ISIN de la BVC fuera del catálogo sin resolver
