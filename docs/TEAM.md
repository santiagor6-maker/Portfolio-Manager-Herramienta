# Reglas del equipo (para todos los agentes)

Producto: **Portafolio Pro**, seguimiento de portafolios de inversión para inversionistas de mercados
emergentes (principalmente Colombia y Brasil) con posiciones en Colombia (BVC), Brasil (B3), Europa y
EE.UU., en varias divisas (COP, BRL, USD, EUR, y también MXN, CLP, PEN, GBP, CHF). El caso central es el
**seguimiento mensual**: cuánto valía el portafolio cada fin de mes, cuánto aporté/retiré, cuánto gané,
rentabilidad mensual (TWR) y acumulada, en la moneda que el usuario elija, separando cuánto vino del
precio y cuánto de la divisa.

Meta: estar al nivel o por encima de las mejores herramientas del mundo: Sharesight, Portfolio
Performance, Ghostfolio, Snowball Analytics, Kubera, Morningstar Portfolio Manager, Empower, Delta,
Stock Events, Kinvo y Gorila (Brasil), Status Invest, Simply Wall St, Wealthfolio.

Reglas de trabajo en el repositorio compartido (otros agentes trabajan AL MISMO TIEMPO en otras carpetas):

1. Trabaja solo dentro de tu carpeta asignada. No edites archivos de otros paquetes.
2. El contrato es `packages/core/src/types.ts` y `packages/core/src/api.ts`. No los cambies; si necesitas
   algo nuevo, crea tus propios tipos en tu paquete o pídeselo a `main` con SendMessage.
3. NO ejecutes `npm install` (instalaciones simultáneas rompen `node_modules`). Si necesitas una
   dependencia, pídesela a `main` con SendMessage indicando paquete y workspace, y sigue con otra cosa.
4. NO hagas `git commit`, `git add` ni ningún cambio de git. El coordinador hace los commits.
5. Prueba todo con vitest (`npx vitest run <tu carpeta>`) y typecheck (`npx tsc -p <tu carpeta> --noEmit`).
6. Red: el contenedor solo llega a algunos hosts. Yahoo Finance (`query1/query2.finance.yahoo.com`,
   con User-Agent de navegador) y `www.datos.gov.co` funcionan; BCB, BCE, frankfurter, stooq, brapi NO
   desde aquí (pero sí funcionarán en la máquina del usuario). Las pruebas unitarias no deben depender
   de la red: usa fixtures grabados.
7. Código y comentarios en inglés; textos de interfaz en español (con traducciones pt y en).
8. Al terminar, deja un `README.md` en tu carpeta y responde con un resumen: qué hiciste, cómo se prueba,
   qué quedó pendiente.
