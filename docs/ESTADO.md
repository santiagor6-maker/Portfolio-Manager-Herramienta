# Estado del proyecto (pausa por límite semanal de uso, 7-oct-2026)

El trabajo quedó en pausa hasta que se restablezca el límite semanal (11-oct-2026, 17:00 UTC).
Todo está guardado en esta rama. Pruebas: 680 pasan, 5 fallan (motor, cambios a medio hacer de la ronda 3).

## Notas de las revisiones (nuestra nota vs. mejor competidor)

| Parte | Ronda 1 | Última revisión | Estado |
|---|---|---|---|
| Motor de cálculo (`packages/core`) | 5,5 vs Portfolio Performance 8 | R2: 7 vs 8 (20/21 arreglos verificados) | Ronda 3 a medias: C22–C35 |
| Datos de mercado (`packages/market-data`, `apps/server`) | 5 vs Portfolio Performance 7 | R2: 7 vs 7 (14 arreglos verificados) | Ronda 3 por empezar: M23 (fusiones) y resto |
| Impuestos (`packages/tax`) | 6 vs Gorila 7 | R2: 7,5 vs 7 (18/21 verificados) | Ronda 3 hecha (135 pruebas); falta la revisión R3 |
| Importación (`packages/importers`) | 5 vs Sharesight 8 | — | Ronda 2 casi terminada (PDF, IBKR Flex, ambigüedades) |
| Aplicación web (`apps/web`) | 6 vs Sharesight 8 | — | Ronda 2 a medias (informe PDF, tabla mensual, rentabilidad real) |

Las revisiones completas están en `reviews/*.md` y `reviews/*.json`.

## Siguientes pasos al reanudar

1. Motor: terminar ronda 3 (C22 split + flujo el mismo día, C23 caché segura, C24 vencimiento de CDT,
   C25–C35) y dejar las 5 pruebas en verde.
2. Motor: aceptar la propuesta de datos de mercado —
   `CorporateAction {type:'DIVIDEND', subtype:'COUPON'}` se registra como INTEREST (cupones NTN-B/NTN-F);
   fusiones como `{type:'SPLIT', subtype:'MERGER', ratio, targetInstrumentId}` más un
   `{type:'DIVIDEND', subtype:'EXTRAORDINARY'}` para el efectivo por acción (CPLE6 → R$0,7749).
3. Datos de mercado: ronda 3 (M23 y demás brechas de `reviews/market-data-r2.md`).
4. Web e importación: terminar ronda 2 y pasar a revisión R2.
5. Impuestos: revisión R3.
6. Revisión final integrada del producto completo contra Sharesight / Portfolio Performance / Kubera / Gorila / Kinvo.

## Cómo probarlo hoy

```bash
npm install
npm run dev:server   # API de precios en http://127.0.0.1:8787
npm run dev:web      # aplicación en http://localhost:5173
npx vitest run       # pruebas
```
