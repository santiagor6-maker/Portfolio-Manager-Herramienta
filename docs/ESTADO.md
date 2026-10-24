# Estado del proyecto (24-oct-2026)

Cada parte la construyó un agente y la revisó otro agente independiente que la comparó con las
mejores herramientas del mercado. Una parte se aprueba solo si supera al mejor competidor y no le
quedan brechas de severidad alta.

## Notas finales (nuestra nota vs. mejor competidor)

| Parte | Ronda 1 | Última revisión | Estado |
|---|---|---|---|
| Motor de cálculo (`packages/core`) | 5,5 vs Portfolio Performance 8 | R8: 8,3 vs 8 | Aprobado |
| Datos de mercado (`packages/market-data`, `apps/server`) | 5 vs Portfolio Performance 7 | R6: 8 vs 7 | Aprobado |
| Impuestos (`packages/tax`) | 6 vs Gorila 7 | R9: 8,5 vs 7 | Aprobado · congelado por decisión del usuario |
| Importación (`packages/importers`) | 5 vs Sharesight 8 | R5: 7,5 vs 8 | Congelado en 7,5 por decisión del usuario |
| Aplicación web (`apps/web`) | 6 vs Sharesight 8 | R9: 8,3 vs 8 | Aprobado |

Las revisiones completas están en `reviews/*.md` y `reviews/*.json`. El tablero de avance está en
https://claude.ai/artifact/ES31K9FBMS5RzYngpuvZux.

## Últimas rondas de la web (R6–R9)

- Cifras KPI en una sola línea, con tamaño mínimo y notación compacta local (es-CO, pt-BR, en).
- Splits, grupamentos y proventos pendientes se avisan en el Resumen, con registro en un clic.
- Todas las escrituras son idempotentes (doble clic, deduplicación en la base de datos).
- Grupamentos de B3 de cualquier tamaño (AMER3 1:100, IRBR3 1:30, BHIA3 1:25) y bonificações con
  la razón correcta, más una migración para las ya guardadas.
- La vista «Todos» usa lotes, caja y método de costo por portafolio (`isolatePortfolios`,
  `portfolioCostMethods` en el motor): cuadra exactamente con la suma de los portafolios.

## Pendientes conocidos

- W71 (media): corregida tras la aprobación (método de costo por portafolio en «Todos»), con
  pruebas unitarias y e2e; sin revisión formal.
- W72 (baja): impuestos consolidados en «Todos» aproximados para efectivo por fracciones y fusiones
  (el paquete de impuestos está congelado).
- W10: sin sincronización entre dispositivos ni conexión directa con corredores o B3.
- Importación: brechas abiertas I40 e I41 (altas) y otras; congelada en 7,5.
- Motor y datos de mercado: brechas medias y bajas listadas en sus últimas revisiones.

## Pruebas

- Web: 155 unitarias y 70 e2e (1 omitida: la prueba en vivo contra el servidor real).
- Resto del monorepo: 1.319 pruebas (19 omitidas).

## Cómo probarlo

```bash
npm install
npm run dev:server   # API de precios en http://127.0.0.1:8787
npm run dev:web      # aplicación en http://localhost:5173
npx vitest run       # pruebas unitarias
```
