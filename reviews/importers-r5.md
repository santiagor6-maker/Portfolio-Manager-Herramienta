# Revisión de importadores (`packages/importers`), ronda 5

**Revisor:** independiente y de solo lectura. No edité `packages/importers`.

**Cómo verifiqué:**
- Volví a ejecutar todos mis lotes anteriores (`t1`–`t14`) y comparé cada salida con la de la ronda 4 (`out4/` frente a `out5/`).
- Escribí 4 lotes nuevos:
  - **`t16.ts`:**
    - notas SINACOR con un dígito válido pero mal leído por OCR (`180` en lugar de `100`), `3S,00`, `PETR0BRAS`, una etiqueta de costo desconocida, 1 centavo de redondeo, 20 operaciones con 0,08 de diferencia y `acceptNotes`;
    - 60 etiquetas de corredor y 12 pares difíciles;
    - ataques al receptor de correo: DKIM no alineado, Authentication-Results falsificado, From con comentario, encoded-word, From duplicado, sin secreto, 40 MB sin content-length, 1.500 adjuntos y un PDF bomba FlateDecode (150 KB → 150 MB).
  - **`t17.ts`:** extracto Davivienda propio con la retención en la columna Valor o dentro del texto, y colisiones de nombres de corredor.
  - **`t18.ts`:** `brokerId` en las transacciones y su efecto en la deduplicación.
  - **`t15.ts`:** alias de market-data derivados de `@pm/core`.

**Línea base:**
- `npx vitest run packages/importers` pasa: 9 archivos y 270 pruebas.
- `npx tsc -p packages/importers --noEmit` termina sin errores.

## Veredicto

**Puntaje: 7,5/10 (r4: 8). Competidor: Sharesight, 8/10. NO APROBADO**, por dos brechas **altas** nuevas, encontradas atacando justo lo que el coordinador pidió:
1. **I40:** un dígito mal leído por OCR (`180` en lugar de `100`) pasa la verificación de la nota y se importa en silencio. No se valida cantidad × precio = valor por línea.
2. **I41:** el receptor de correo, ya montado en `apps/server`, acepta remitentes falsificados de 5 formas distintas.

Además, el procesamiento de adjuntos no tiene límites: un PDF bomba o miles de adjuntos pueden tumbar el servidor (I42).

El puntaje baja medio punto respecto a la ronda 4 porque el código nuevo, ya montado en el servidor, introduce un riesgo de seguridad real, aunque las brechas de la ronda 4 se corrigieron bien.

**Regresiones: ninguna.** Las diferencias con la ronda 4 son las esperadas:
- mi nota de `t5`, cuyo "Líquido para" no cuadra a propósito, ahora queda en espera, que es lo correcto;
- ELET6 → AXIA6;
- NATURA ON de 2019 → NATU3;
- consolidado IBKR por cuenta;
- `SECURITY_ANSWER_CONFLICT`.

## Corregidas (verificadas)

| ID | Evidencia |
|---|---|
| I34 | Activity consolidado: cada movimiento lleva U1111111 o U2222222 y la conciliación queda vacía (antes, dos falsos -10). |
| I35 | `1OO` → `UNPARSED_LINE` con la nota en espera, con o sin "Líquido para". `6S,00` igual. En el PDF con varias notas, solo se retiene la nota afectada: XP y BTG se importan. |
| I36 | `TICKER_EVENTS` en `@pm/core`. Market-data deriva de ahí sus alias: TRPL4→ISAE4 y ELET6→AXIA6 resuelven. El código reutilizado NATU3 no tiene alias, así que el NATU3 vigente no se manda a NTCO3. |
| I37 | 10/06/2019 → NATU3; 01/07/2025 → NTCO3; 02/07/2025 → NATU3. |
| I38 | Retención y comisión en la columna Valor de la línea siguiente → `taxes` 9.437 y `fees` 8.533 con `CONTINUATION_MERGED`. |
| I39 | GGBR4 aprendido frente a GOAU4 de la tabla → `SECURITY_ANSWER_CONFLICT`. |

**También bien:**
- 1 centavo de redondeo pasa sin retener la nota.
- `acceptNotes` libera la nota.
- La normalización acierta en los pares peligrosos: Inter ≠ Interactive Brokers, XP ≠ Clear ≠ Rico, U1234567 ≠ DU1234567, Toro ≠ Toronto, Nu ≠ Nuvemshop, Modal = Modalmais, Davivienda = Davivienda Corredores.
- El receptor de correo responde 401 sin secreto.

## Brechas abiertas

### I40 — alta — SINACOR no valida cantidad × precio = valor por línea

**Evidencia:** la nota 8001 trae `PETROBRAS PN N2  180  37,00  3.700,00  D`, un 100 leído por OCR como 180, y su "Líquido para" es consistente (3.700,93).
- Resultado: `BUY BVMF:PETR4 180 × 37 = 3.700`, `ok`, **0 avisos**. La posición queda inflada un 80 %.
- La verificación contra "Líquido para" (I35) usa el valor impreso, así que no lo ve. El mismo hueco aparece si un layout desplaza columnas.

**Arreglo:** validar cada línea con `|cantidad × precio − valor|` pequeño (dentro del redondeo de 2 decimales del valor y de los decimales del precio). Si falla, error `QTY_PRICE_VALUE_MISMATCH` con la lectura alternativa (cantidad = valor / precio = 100) y la nota en espera.

### I41 — alta — Receptor de correo: la autenticación del remitente se puede saltar

**Evidencia:** los 5 mensajes siguientes devolvieron **200 y quedaron guardados como borrador**:

| Ataque | Por qué pasa |
|---|---|
| `dkim=pass header.d=evil.com; dmarc=fail header.from=xpi.com.br` con From @xpi.com.br | No hay alineación DMARC: vale cualquier dkim/spf=pass |
| Authentication-Results del proveedor con `fail`, más uno falsificado abajo con `pass` | Se concatenan **todos** los encabezados A-R |
| `From: attacker@evil.com (XP <noreply@xpi.com.br>)` | El regex toma el primer `<…>`, que está dentro del comentario |
| `From: =?UTF-8?B?PG5vcmVwbHlAeHBpLmNvbS5icj4=?= <attacker@evil.com>` | Se decodifica el nombre visible antes de extraer la dirección |
| Dos encabezados `From` | No se rechaza |

El daño requiere conocer el token del destinatario y que el usuario apruebe el borrador. Aun así, la barrera que se documenta (lista de remitentes + SPF/DKIM) no protege. Además, habilita I42 a cualquiera que conozca la dirección.

**Arreglo:**
- Extraer la dirección con un parser RFC 5322 sobre el encabezado crudo, sin decodificar, y rechazar mensajes con varios From.
- Confiar solo en el primer Authentication-Results cuyo authserv-id sea el del proveedor configurado.
- Exigir `dmarc=pass`, o `dkim=pass` con `header.d` alineado al dominio del From.

### I42 — media — Sin límites de recursos

**Evidencia:**
- **PDF bomba:** 150 KB que se inflan a 150 MB → `importFile` tarda 6,3 s y sube el RSS en 316 MB. Con el bodyLimit de 10 MB del servidor se pueden inflar del orden de 10 GB.
- **Adjuntos:** un correo de 349 KB con 1.500 CSV se procesa entero (4,2 s) y no hay tope.
- **Cuerpo sin content-length:** 40 MB se leen completos antes del 413 (+168 MB). El bodyLimit de `apps/server` lo mitiga.
- **Secreto en la URL:** se acepta `?secret=`, que queda en los logs.

**Arreglo:** tope de adjuntos y de bytes descomprimidos, timeout por adjunto, pdf.js en un worker con memoria limitada, y el secreto solo por cabecera.

### I43 — media — Notas en espera demasiado estrictas, y al aceptarlas se pierde el residuo

**Evidencia:**
- Nota de Nu con "Taxa de Transf. de Ativos 0,50" (legítima) → `pending`. Al aceptarla, los costos quedan en 0,93: **se pierden los 0,50** que el "Líquido para" confirma.
- 20 operaciones con 0,08 de diferencia → en espera, porque la tolerancia es fija en 0,05.

**Arreglo:**
- Al aceptar, prorratear el residuo como "otros costos" si tiene el signo de un costo y es pequeño.
- Tolerancia proporcional al número de líneas.
- Más etiquetas de costo.

### I44 — media — Los eventos de `TICKER_EVENTS` no se aplican ni se proponen

**Evidencia:**
- Una compra de NATURA ON de 2019 → NATU3, correcto, pero no se propone el canje NATU3→NTCO3 del 18/12/2019, y ni core ni la web aplican `TICKER_EVENTS`.
- Según el comentario de market-data, la serie NATU3 de Yahoo está plana en 36,86 entre 2020 y 2025, así que esa posición queda congelada 5 años en la tabla mensual.
- Igual con BRFS3→MBRF3 (0,8521) y CPLE6→CPLE5→CPLE3 + R$ 0,7749 para quien solo importa notas o Negociação.

**Arreglo:** el importador ya genera propuestas (I33). Debería emitir `corporateActions` para cada evento conocido que afecte una posición existente o importada.

### I45 — baja — La normalización de corredores agrupa por la primera palabra

**Evidencia:**
- "Global Investimentos" (BR) → `global`, known=true, nombre visible **"Global Securities"** (CO). Su compra quedó `possible_duplicate` frente a una de Global Securities.
- `sameBroker` da `true` en "Casa de Bolsa" / "Casa de Valores" y en "Credicorp Capital Colombia" / "Perú".
- Faltan alias: Banco do Brasil / BB Investimentos, DEGIRO / flatexDEGIRO Bank, Bancolombia / Grupo Cibest.

### I46 — baja — Detalles de PDF

- En un PDF con varias notas, las líneas de la nota BM&F (WIN J24) salen como `UNPARSED_LINE` (errores que el usuario no puede corregir) en lugar de `UNSUPPORTED_ASSET`.
- El "Periodo: 01/03/2024 al 31/03/2024" del extracto no se usa como evidencia de DD/MM, y se pide confirmación.
- La retención escrita dentro del texto ("Retención 7% $ 9.437") no se suma; solo funciona si el monto está en la columna Valor.

### I2 — baja — Sin B3 ni agregadores

El correo (con borradores) y la sincronización IBKR con pantalla ya funcionan de punta a punta. Falta la Área do Investidor de B3 y Pluggy o Belvo, que requieren contrato. Es la ventaja estructural de Gorila y Kinvo.

### I31 — baja — Todavía sin documentos reales

I40 muestra que el ruido real todavía no está cubierto por el corpus real-like.

## Frente a la competencia

**Mejor que Sharesight, PP y Gorila en:**
- B3 completo por archivos;
- SINACOR con contraseña, retención de notas dudosas y respuestas aprendidas;
- Colombia (extractos PDF, CDT, GMF, cambios a Cibest);
- conciliación por cuenta IBKR;
- formatos regionales sin errores silenciosos.

**Peor en:**
- Validación por línea de las notas, que Gorila y Kinvo tienen.
- Seguridad y robustez del buzón de correo: Sharesight lo opera a escala con verificación real del remitente.
- Ausencia de B3 conectado y de documentos reales.

## Prioridad para la ronda 6

1. I41 (alineación DMARC, From y A-R) e I40 (cantidad × precio = valor): ambas son baratas.
2. I42 (límites de recursos).
3. I43 e I44.
4. I45, I46 e I31.
