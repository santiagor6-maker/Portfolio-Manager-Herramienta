# Portafolio Pro — Arquitectura

Herramienta de seguimiento de portafolios para inversionistas de mercados emergentes con
posiciones en Colombia (BVC), Brasil (B3), Europa y EE.UU., en varias divisas, con foco en el
seguimiento mensual.

## Paquetes (npm workspaces, TypeScript estricto)

| Ruta | Paquete | Responsabilidad |
|---|---|---|
| `packages/core` | `@pm/core` | Contrato de tipos (`types.ts`) y motor de cálculo puro: lotes (FIFO/promedio), caja multi-divisa, valoración, TWR/MWR, tabla mensual, descomposición precio vs. divisa, riesgo, asignación. Sin I/O. |
| `packages/market-data` | `@pm/market-data` | Proveedores de precios y tasas de cambio (Yahoo Finance para BVC `.CL`, B3 `.SA`, EE.UU., Europa; TRM Banco de la República vía datos.gov.co; PTAX BCB; BCE), caché, cierres mensuales, búsqueda de tickers. Cliente HTTP para la web. |
| `packages/importers` | `@pm/importers` | Importación de movimientos desde CSV/XLSX de brokers (genérico con mapeo de columnas + formatos de brokers) con de-duplicación. |
| `packages/tax` | `@pm/tax` | Reportes fiscales: Colombia (patrimonio al 31-dic con TRM, ganancia ocasional, dividendos), Brasil (IR mensal, isenção R$20 mil, DARF, preço médio, JCP), EE.UU. retención a no residentes. |
| `apps/server` | `@pm/server` | API HTTP (Hono) que expone market-data con caché; evita CORS en el navegador. |
| `apps/web` | `@pm/web` | App React + Vite: local-first (IndexedDB), es/pt/en, tablero, posiciones, movimientos, tabla mensual, divisas, dividendos, impuestos, importación. |

## Reglas de convivencia

- `packages/core/src/types.ts` y `api.ts` son el contrato. Solo cambios aditivos.
- Cada paquete tiene pruebas `vitest` (`npm test` en la raíz).
- Fechas `YYYY-MM-DD`, meses `YYYY-MM`, dinero siempre acompañado de su moneda.
