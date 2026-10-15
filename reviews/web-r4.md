# Revisión web — ronda 4 (`apps/web`)

- **Revisor:** agente revisor (solo lectura).
- **Fecha:** 14–15 de octubre de 2026.
- **Evidencia:** scripts, capturas, PDF y XLSX en `RW = /tmp/claude-0/-home-user-Portfolio-Manager-Herramienta/8b757dea-bb3a-58bd-aa07-26758394d338/scratchpad/review-web/`. Scripts `r4-*.mjs`, `impspa.mjs` e `imp4.mjs`; capturas y archivos en `RW/shots4/`.

## Veredicto

**No aprobado, pero muy cerca.**

Las brechas altas de la ronda 3 están cerradas y verificadas a mano en un build hecho con el árbol actual:

- La importación de PDF y `.eml` funciona: nota SINACOR con panel de notas en revisión, XP con 16 operaciones, `.eml` de Nu, extracto Trii y CDT Bancolombia.
- Ya no aparecen precios del ejemplo en el portafolio real.
- La referencia se elige por moneda: Ibovespa y CDI para BRL, sin caer en el IBR.
- La DARF tiene un diálogo de pago.
- El área de impuestos ya está completa: Bens e Direitos, «em trânsito» con decisión, exterior, IRPFM y Formularios 210/160, con exportación XLSX/CSV/PDF.
- Hay enlace de solo lectura, con o sin contraseña, y la PWA funciona sin conexión.

Queda **una brecha alta nueva** que toca la promesa central multimoneda. **Cambiar la moneda de reporte a una divisa sin serie FX ya descargada muestra 0 en todo** (KPIs, tabla mensual, gráficos, informe) y compara contra índices sobre esos ceros. La app no descarga el par que falta.

| | Puntaje |
|---|---|
| **Portafolio Pro web (nuestro)** | **7,8 / 10** (rondas anteriores: 6,0 → 7,3 → 7,5) |
| **Mejor competidor: Sharesight** | **8,0 / 10** |

Con W40 corregida y W41–W42 pulidas, la nota esperada es ≈8,4. Eso supera a Sharesight en el caso Colombia–Brasil, porque Sharesight no tiene impuestos de Colombia ni de Brasil, ni seguimiento mensual con efecto precio/divisa, ni lectura de notas de corretagem.

Comparación con los demás competidores (conocimiento previo, sin verificación en vivo en esta ronda):

| Competidor | Puntaje | Dónde nos sigue ganando |
|---|---|---|
| Kubera | ≈7,5 | Sincronización y patrimonio total |
| Gorila / Kinvo | ≈7,5 | Lectura automática de B3 y app nativa |
| Snowball | ≈7 | Dividendos |

## Cómo se probó

- **Verificaciones previas:** `tsc --noEmit -p apps/web` sin errores. `npm test -w @pm/web`: **78/78** (14 archivos). Los e2e del constructor no se volvieron a ejecutar.
- **Build y servidores:** se reconstruyó con el árbol actual, que incluye la tarjeta «Importar por correo» y el core R8. Build en `RW/dist4`, servido con `vite preview` en :4187. Servidor de datos sin *watch* en :8797 (`CORS_ORIGIN=http://localhost:4187`, `RATE_LIMIT_PER_MIN=600`). Datos reales de Yahoo, TRM, IPC, IBR y UVR. En este contenedor no responden BCB, IBGE, FRED ni BCE, así que CDI, IPCA, Selic, CPI y HICP fallan. Los servidores quedaron detenidos al terminar.
- **Primer render** (perfil vacío, ejemplo): KPIs visibles a los **848 ms**, con **746 kB** de JS/CSS antes de los KPIs y **1.314 kB** en total a los 8 s (ECharts pesa 568 kB y se pide después). El worker de PDF (1,3 MB) se emite pero no se carga.
- **Brasileño** (perfil `r4br`, navegador pt-BR, interfaz en pt automática):
  - asistente en BRL, aporte de R$ 100.000 el 02-01-2023 en XP;
  - importación de `b3-negociacao.xlsx`, `nota-sinacor.pdf` (la nota 99887766 queda en revisión con diferencia −10,00 y botones Aceitar, Lançar e Ignorar), `nota-xp-2024-03-08.pdf` (16 operaciones, day trade marcado y cambios de código EMBR3→EMBJ3, CCRO3→MOTV3 y TRPL4→ISAE4) y `nota-nu.eml`;
  - operación swing de 2.000 PETR4 que genera una DARF;
  - BTC comprado y transferido a una billetera externa (en tránsito);
  - Resumen y Mensual en BRL, COP y USD;
  - Impostos 2025 y 2026, diálogo de DARF, «mantido» y XLSX.
- **Colombiano** (perfil `r4co2`, es):
  - asistente en COP, aporte de 30 M el 02-01-2024;
  - «Importar extracto»: `extracto-trii.pdf`, `cdt-bancolombia.pdf` (CDT por causación) y `extracto-trii.csv`, uno detrás de otro sin recargar;
  - precios reales de ISA, PFCIBEST, CIBEST, ECOPETROL e ICOLCAP;
  - Mensual en COP, BRL y USD;
  - Informe PDF y enlace de solo lectura (sin y con contraseña, contraseña errónea, enlace dañado);
  - Impuestos 2024/2025 con XLSX de 7 hojas (Formulario 210, 160, Patrimonio, Ventas, Ingresos, Diferencia en cambio, Alertas), CSV y PDF.
- **Otros:**
  - PWA sin conexión (`setOffline`): las cinco rutas se pintan desde la caché;
  - teléfono a 390 px (Resumen, Mensual, Impuestos, Informe) sin scroll horizontal;
  - ejemplo: WEGE3 en abr-2024 da +5,11 % en el mes, sin el ×2 de C52 (corregido en core R8).

## Brechas anteriores

| ID | Estado | Evidencia |
|---|---|---|
| W30 | **Cerrada** | Los cinco PDF y el `.eml` se importan. Hay panel de notas con «Líquido da nota −2.010,60 / Calculado −2.000,60 / Diferença −10,00». |
| W31 | **Cerrada** | Tras tres importaciones seguidas, todas las series son reales (`demo=false`). ISA 29.100 y PFCIBEST 77.100 a 14-oct. No quedan series del ejemplo en IndexedDB. |
| W32 | **Cerrada** | En BRL: «CDI não disponível», índice Ibovespa y no hay «Real (vs —)». En COP: COLCAP e IBR. |
| W33 | **Cerrada** | Las cuentas XP se unen. Las compras en Nu sin aporte ofrecen «Usar a conta «XP»» además de «Criar aporte». |
| W34 | **Cerrada** | Hay diálogo con fecha y monto, y la KPI pasa a R$ 0,00 · 0 DARF tras pagar. Ver W44. |
| W35 | **Cerrada** | Con un navegador pt-BR, la app arranca en pt. |
| W36 | **Cerrada** | No aparecen `config.meta` ni `creditEstimatedIrrf`. |
| W37 | **Cerrada** | Una sola fila «Total» en la tabla mensual del PDF. |
| W38, W39 | **Cerradas según el README** | No se volvieron a probar a mano (IBKR necesita token real). |
| W20 | **Parcial (baja)** | 746 kB antes de los KPIs y 1,31 MB en total. |
| W10 | **Parcial (baja)** | El enlace de solo lectura funciona y está bien cifrado; sigue sin haber sincronización entre dispositivos. |

## Mejor que la competencia

1. **Notas de corretagem en PDF con conciliación.**
   - Líquido de la nota frente a lo calculado, diferencia y sugerencia.
   - Costos prorrateados.
   - Day trade marcado.
   - Cambios de código (EMBJ3, MOTV3, ISAE4).
   - Posibles duplicados frente a B3.

   Ni Gorila ni Kinvo muestran la conciliación.
2. **Impuestos de los dos países en una sola app:**
   - DARF con estado, multa y Selic, y diálogo de pago;
   - Bens e Direitos con código de grupo, CNPJ (parcial) y decisión sobre cripto en tránsito (`alienado` / `mantido`);
   - IRPFM y Lei 14.754;
   - Formularios 210 y 160 con XLSX para el contador.
3. **Enlace de solo lectura sin servidor:**
   - el informe va en el fragmento `#`, opcionalmente cifrado con AES-GCM;
   - una contraseña errónea dice «Contraseña incorrecta» y un enlace dañado dice «El enlace está incompleto o dañado»;
   - el visor no crea portafolios en su navegador.
4. **Seguimiento mensual con calidad del dato:** «Aporte implícito», «Precio atípico» y acciones como «Usar la cuenta», «Crear aporte» y «Registrar split».
5. **Local-first + PWA sin conexión + tres idiomas automáticos.**

## Peor que la competencia

1. **Cambio de moneda de reporte frágil** (W40). Sharesight, Kubera y Ghostfolio siempre muestran el valor convertido.
2. **Sin sincronización ni lectura automática del corredor o de B3** (Gorila, Kinvo, Sharesight y Kubera la tienen). La conexión IBKR y el buzón de correo requieren configurar el servidor.
3. **Pulido:**
   - avisos del Resumen en inglés crudo (W41);
   - patrimonio fiscal de Colombia incoherente con un CDT vencido (W42);
   - nombres de notas sin enriquecer (W43).

## Brechas nuevas

### W40 — alta — Cambiar la moneda de reporte muestra 0 en todo cuando falta la serie FX y no la descarga

**Pasos:**
1. Portafolio colombiano (sus FX descargados: solo USD/COP) → elegir **BRL** en la barra.
2. Portafolio brasileño (solo USD/BRL) → elegir **COP**.

**Resultado** (`r4-co3.mjs`, `r4-ccy.mjs`, `shots4/br-cop-switch.png`):

- **KPIs:** quedan en «Valor total R$ 0,00 · Este mes R$ 0,00 · Ganancia total R$ 0,00» y siguen así después de 40 s.
- **Tabla mensual** con ceros y comparaciones falsas contra esos ceros:
  - «Sept de 2026 … 0,00 % · Ibovespa +5,03 % · Diferencia −5,03 %»;
  - «Total … Ibovespa +53,90 % · Diferencia −53,90 %»;
  - en el portafolio BR: «Real −21,82 %», «0% do IBR» y «Proventos ISAE4 COP 0».
- **Gráfico** «Valor vs. aportado» plano en 0.
- **Avisos:** «O motor encontrou 121 erros…» y «Falta a taxa de câmbio para BRL».

En cambio, USD funciona porque es la moneda pivote.

**Causa:** el plan de actualización (`services/marketData.ts`, `buildPlan`) solo pide `USD/<moneda>` en la actualización automática, que tiene un límite de 2 a 5 min. Cambiar de moneda no fuerza la descarga, y el motor convierte el FX faltante en ceros (gap C8 de core). La web debería protegerse en todo caso.

**Corrección:**
- al cambiar de moneda, pedir de inmediato el par que falta (`refreshMarketData({ force: true, fx: [...] })`);
- mientras tanto, mostrar «Convirtiendo a BRL…» con *skeletons*, y nunca 0;
- si no hay tasa, poner «—» y un aviso claro en KPIs, tabla e informe, sin calcular diferencias contra el índice.

### W41 — media — Los avisos del Resumen muestran errores del motor en inglés crudo

Ejemplo, en pt (`r4-misc.mjs`): «SELL of 20 BVMF:VALE3 on 2023-01-02 exceeds holding of 0», «SELL of 150 BVMF:BBSE3 on 2024-03-08…». El panel de Diagnóstico ya los traduce («Venda maior que a posição…»), pero la tarjeta Avisos no usa esas plantillas.

**Corrección:** reutilizar `describeDiagnostic` en Avisos.

### W42 — media — El patrimonio fiscal de Colombia ignora la redención del CDT vencido

El CDT Bancolombia vencido el 09-01-2025 sigue en el patrimonio al 31-dic-2025 a costo ($ 10.000.000), con la nota «Sin precio … valor de mercado no disponible».

El efectivo no incluye la redención (capital + intereses ≈ $ 11,1 M). El patrimonio fiscal sale idéntico en 2024 y 2025 ($ 33.117.970). Mientras tanto, Posiciones ya muestra el CDT redimido y el efectivo en $ 27,5 M (`tax-co-2025.png`, `tax-co.xlsx`, hoja Patrimonio).

Para 2024 tampoco se incluyen los intereses causados por cobrar del CDT.

**Corrección:** pasar a `colombiaTaxPack` los flujos estimados del motor (redención y causación), o pedirle al usuario que registre el pago real con un aviso en Impuestos.

### W43 — baja — Nombres de las notas sin enriquecer y CNPJ incompleto

- Bens e Direitos y «Maiores variações» usan el texto de la nota: «SID NACIONAL ON», «TRAN PAULIST PN N1», «CCR SA ON NM» (para MOTV3), «ITAUUNIBANCO PN EJ N1».
- Falta el CNPJ en 10 de 15 bens (`tax-br-bens.png`).

**Corrección:** resolver contra el catálogo como en el CSV y completar la tabla de CNPJ de las emisoras más comunes.

### W44 — baja — El diálogo de DARF no recalcula el monto al cambiar la fecha

El monto viene prellenado a hoy (R$ 4.488,67). Al poner como fecha de pago el 20-05-2026 se guardó ese mismo monto, aunque lo debido a esa fecha era R$ 3.815,63 (20 días de atraso), así que quedó registrado un pago de más.

**Corrección:** recalcular la multa y la Selic al cambiar la fecha, salvo que el usuario haya editado el monto.

### W45 — baja — Alertas fiscales repetidas y con formato inconsistente

- «Saída de BTC-USD sem conta atribuída…» y «0.05 BTC-USD saíram…» aparecen dos veces.
- Usan punto decimal en pt («0.05»).
- «Sem PTAX compra/venda separada» se repite cada año.

### W46 — baja — Enlace compartido largo y cambio de `#` sin recargar

- El enlace mide 8,6 kB (15,5 kB con contraseña). Algunos mensajeros y clientes de correo lo cortan.
- Si en la misma pestaña se pega otro enlace que solo cambia el `#`, se sigue mostrando el informe anterior hasta recargar (`r4-share.mjs`, primera corrida).

### W47 — baja — Informe en pantalla: la tabla mensual se desborda a 1440 px

En pantalla, la columna «COLCAP (ICOLCAP)» y sus cifras se cortan a la derecha del recuadro del informe (`shots4/offline.png`). El PDF sale bien.

### W48 — baja — El informe no lleva las marcas de calidad del dato

Los meses con «Precio atípico» o «Aporte implícito» se marcan en Mensual, pero el informe y el enlace compartido los presentan sin ninguna marca. Quien lo recibe (asesor, familia) no sabe que esos meses están en duda.

## Matriz

Ver `web-r4.json`. La información de los competidores sale de su documentación pública y de conocimiento previo, sin verificación en vivo en esta ronda.
