# Revisión de importadores (`packages/importers`), ronda 3

**Revisor:** independiente y de solo lectura. No edité `packages/importers`.

**Cómo verifiqué:**
- Volví a ejecutar todos mis lotes adversariales de las rondas 1 y 2: `t1`, `t2`, `t4`, `t5`, `t6`, `t8`, `t9` y `t10` en `scratchpad/review-imp/`. Las salidas quedaron en `out3/`.
- Escribí un lote nuevo, `t11.ts`, con:
  - Flex XML con reverse split en dos filas (cambio de ISIN), spin-off y stock dividend;
  - el handler de sincronización con usuarios, credenciales ajenas y JSON inválido;
  - una nota SINACOR cifrada (sin contraseña, con una incorrecta y con la correcta) con GERDAU PN, "ALPHABET DRN C" e "ISA ENERGIA";
  - conciliación con dos cuentas IBKR;
  - nombres de cuenta manuales ("XP", "Clear", "Banco Inter") contra los nombres largos de B3;
  - 9 fechas agrupadas en inglés y USD.
- También revisé la integración en `apps/server` y `apps/web` y comparé los ids del Tesouro con `@pm/market-data`.

**Línea base:**
- `npx vitest run packages/importers` pasa: 7 archivos y 189 pruebas.
- `npx tsc -p packages/importers --noEmit` termina sin errores.

## Veredicto

**Puntaje: 7,5/10 (r1: 5, r2: 6,5). Competidor: Sharesight, 8/10. NO APROBADO.**
- No quedan brechas de severidad **alta**.
- No se aprueba porque el puntaje no supera al de Sharesight.

**Las 4 altas de la ronda 2 están resueltas** y las verifiqué con mis entradas:

| ID | Resultado |
|---|---|
| I21 | Los 3 lotes de B3 se importan (2 de XP y 1 de Nu). El dividendo en XP y en Nu se importa dos veces. El depósito a Davivienda tras uno a Trii se importa. Los duplicados reales entre fuentes se siguen detectando, incluso con "XP" frente a "XP INVESTIMENTOS CCTVM S/A", "Clear" frente a "CLEAR CORRETORA - GRUPO XP" y "Banco Inter" frente a "INTER DTVM". |
| I22 | Split 10:1 desde Flex. El reverse split en dos filas da una sola proporción de 0,1. La fila SUMMARY se ignora. SalesTax queda como TAX. SD queda como STOCK_DIVIDEND con proporción 0,05. SO va a `corporateActions`. |
| I23 | GERDAU MET → GOAU4, GERDAU PN → GGBR4, ISHARES BOVA → BOVA11 y APPLE DRN → AAPL34. "ISA ENERGIA PN N1" se **pregunta**: `unknownSecurities`. |
| I4 | El extracto agrupado por especie en español y COP ya no se lee como MM/DD: pide confirmación. Con 9 fechas en inglés y USD, ambiguas, también confirma. `settleDate` sigue resolviendo. |

**Lo que separa a este paquete de Sharesight:**
- La sincronización IBKR funciona en el servidor, pero **ninguna pantalla la usa**.
- No hay B3 automático (Gorila y Kinvo sí), ni correo, ni agregadores.
- Los PDF y `.xls` **solo se han probado con documentos sintéticos**.
- El catálogo de nomes de pregão obliga a responder varias preguntas por nota.

Para un inversionista colombiano o brasileño con archivos locales, este importador ya es mejor que Sharesight y que Portfolio Performance:
- B3 Negociação, Movimentação y Posição;
- notas SINACOR con contraseña;
- CDT con causación;
- Tesouro con id cotizable;
- extractos colombianos.

Pierde en automatización y en la confianza que da un uso real probado.

## Corregidas en esta ronda (verificadas)

| ID | Prueba propia y resultado |
|---|---|
| I3 | Extracto en `;` con COP y USD: ECOPETROL 1000 a 2450 se importa. La fila `SIRI 1.000 a 1.725 USD` queda `pending` con `ROW_NUMBER_AMBIGUOUS` y `scope: rows`, en lugar de ×1000. |
| I4 | Ver el veredicto. Además, una sola fila ambigua en español también confirma. |
| I13 | Fidelity: SPAXX se omite como sweep y no da error. Los tipos con dirección por signo funcionan en el pipeline. |
| I21 | Ver el veredicto. La reimportación exacta sigue quedando `duplicate`. |
| I22 | Ver el veredicto. |
| I23 | Ver el veredicto. No encontré coincidencias por prefijo en una revisión de unos 30 nombres y clases: PNB, PNA y UNT de COPEL, ELETROBRAS, USIMINAS, BRASKEM, KLABIN, SANEPAR, BTGP y otros. |
| I24 | La cabecera apilada (Nu) da 1 operación. La nota cifrada sin contraseña da `needsPassword: 'required'`, con una incorrecta da `'incorrect'` y con la correcta se importa. |
| I25 | En la nota de 2 páginas, el IRRF de 0,16 va a ITUB4 (swing) y el de 0,50 a la venta day trade de PETR4. "4,90 C" resta: los costos son 0,42. Con opción + PETR4, a PETR4 le tocan 1,32, no 5,38. Las dos notas distintas con operaciones idénticas se importan las dos. |
| I26 | 10,80 % N.M.V. → 11,35 % E.A. Con "al vencimiento" antes de las fechas, el vencimiento es correcto (2024-07-15). |
| I28 | ENB → `XNYS:ENB` (sin `US:`). El Tesouro usa `TD:<código>-<vencimiento>`. Revisé que la regla de meses coincida con los vencimientos reales: NTN-B y NTN-B Principal, año impar 15/05 y par 15/08; LFT 01/03; LTN, NTN-F y NTN-C 01/01. |
| I29 | La sección "Portafolio al cierre" del PDF tipo Trii ya no produce errores: 3 movimientos y 0 errores. |

**Regresiones:** ninguna. Todo lo que pasaba en las rondas 1 y 2 sigue pasando:
- doble conteo B3;
- comisión FX de IBKR;
- fracciones y JCP;
- signos;
- AutoFX de DEGIRO;
- reverse split de Schwab;
- HTML anidado;
- 10.000 contra 10.000 movimientos en 0,48 s.

## Mejor que la competencia

- **Archivos B3 completos:** Negociação, Movimentação con liquidaciones emparejadas por calendario B3, y Posição para la foto inicial y la conciliación. Sharesight, PP y Ghostfolio no los leen.
- **Notas SINACOR en PDF**, con contraseña, IRRF swing y day trade separados, costos "C" y verificación contra "Líquido para". Solo Gorila y Kinvo hacen algo así.
- **Colombia:** CDT a renta fija con causación (tasas nominales convertidas a E.A.), extractos PDF y GMF. Ningún competidor lo tiene.
- **Confirmación explícita de formatos por archivo y por fila.** Ningún competidor la ofrece.
- **Deduplicación por cuenta con absorción uno a uno**, sin falsos positivos en mis 6 casos.
- **Privacidad:** todo en el navegador o en un servidor propio. El token de IBKR se guarda cifrado con AES-GCM y nunca vuelve al cliente.

## Peor que la competencia

- Sin conexión a B3, sin correo y sin agregadores. La sincronización IBKR no tiene interfaz.
- Sin un corpus de documentos reales. PP valida más de 100 importadores PDF con su comunidad, y Sharesight y Gorila procesan millones de documentos.
- Catálogo de nomes de pregão limitado frente al reconocimiento completo de Gorila y Kinvo.

## Brechas abiertas

### I2 — media — La sincronización existe en el servidor pero no llega al usuario

**Lo que funciona:**
- `createIbkrFlexSyncHandler`: 401 sin usuario; el token queda sellado en el store; 404 cuando bob usa la credencial de alice; 400 con JSON inválido o acción desconocida; el sync devuelve un `ImportResult` sin el token.
- `apps/server` lo monta (`/api/sync/ibkr-flex`, inbox y rutina diaria con `IBKR_FLEX_DAILY`).

**Lo que falta:**
- `apps/web` no llama a `/api/sync` ni muestra el inbox. Configurarlo exige variables de entorno, curl y el token de administrador.
- Siguen ausentes la Área do Investidor de B3 (Gorila, Kinvo), el buzón de correo (Sharesight) y los agregadores (Pluggy, Belvo, Salt Edge).

Parte de esto es trabajo de la web.

### I30 — media — Catálogo de nomes de pregão corto y desactualizado

**Evidencia:**
- La tabla tiene 120 emisores, 11 ETF y 22 BDR, frente a cientos de acciones, FII y BDR listados.
- "ISA ENERGIA PN N1" (ISAE4 desde 2024) da `UNKNOWN_SECURITY` con `suggestions: []`, y la tabla aún mapea `'tran paulist'`→TRPL.
- Los FII sin ticker en la especificação se preguntan.

No hay errores silenciosos, pero sí fricción en cada nota.

**Arreglo:** cadastro de B3 o catálogo de market-data como fuente, y persistir los `securityMap` del usuario.

### I31 — media — Sin validación con documentos reales

Los analizadores PDF (SINACOR, extractos colombianos y CDT) y el lector BIFF8 solo se probaron con archivos generados por el propio paquete. Mis PDF adversariales usan el mismo escritor (Helvetica, un `Tj` por celda), y el LibreOffice del contenedor no tiene Writer ni Calc para generar documentos independientes.

**Arreglo:** un corpus anonimizado (XP, BTG, Inter, Nu, Ágora, Trii, tyba, Bancolombia, Davivienda) y un `.xls` guardado por Excel real, como pruebas de regresión. Hasta entonces, la confianza "media" de SINACOR es optimista.

### I20 — baja — La conciliación todavía mezcla dos cuentas IBKR

**Evidencia:** historial de U1111111 (account='U1111111') y un Activity Statement de U2222222. La conciliación reporta:
- `KO: reportado 0, calculado 30`;
- `USD: reportado 149, calculado 3.349`.

Pasa lo mismo si el historial no trae cuenta. La causa es que `accountIds` incluye el genérico "Interactive Brokers" y la familia IBKR. Además, los movimientos importados del Activity no llevan el número U…, así que dos cuentas IBKR no se distinguen.

Con Schwab ya está corregido.

### I32 — baja — BDR: se ignora la letra de clase después de DRN

**Evidencia:** "ALPHABET DRN C" → GOGL34 sin aviso. Si la especificação distingue las clases A y C (GOGL34 frente a GOGL35), queda en el BDR equivocado.

**Arreglo:** si hay tokens después de DRN que no sean marcas conocidas (ED, EJ, N1, N2, NM), preguntar.

### I33 — baja — Spin-off pendiente sin posición nueva

**Evidencia:** Flex type SO (MMM → 2,5 SOLV) queda en `corporateActions` con `CORPORATE_ACTION_PENDING`. SOLV no existe en la valoración mensual hasta que el usuario use el asistente.

**Arreglo:** proponer las patas (entrada de SOLV y reparto de base) listas para confirmar.

## Prioridad para la ronda 4

1. I2: pantalla para guardar el token, sincronizar y revisar el inbox (en la web).
2. I31: un corpus real mínimo (3 notas SINACOR de corretoras distintas y 2 extractos colombianos).
3. I30: cadastro de B3 y persistencia de `securityMap`.
4. I20, I32 e I33.
