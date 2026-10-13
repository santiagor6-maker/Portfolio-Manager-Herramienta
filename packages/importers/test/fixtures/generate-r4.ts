/**
 * Round-4 "real-like" corpus (I31): SINACOR notes of XP, Clear, BTG, Inter and Nu Invest, a Davivienda-style
 * extract, a Trii-style app statement and an Excel-saved .xls (1900 and 1904 date systems).
 * Layouts follow the public structure of each document; data and identifiers are placeholders.
 * Run: npx tsx packages/importers/test/fixtures/generate-r4.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildDaviviendaPdf, buildExcelXls, buildTriiPdf } from './real-like/colombia';
import { buildNote, NOTES } from './real-like/sinacor';

const dir = join(dirname(fileURLToPath(import.meta.url)), 'real-like');
mkdirSync(dir, { recursive: true });
const out = (name: string, data: Uint8Array) => writeFileSync(join(dir, name), data);

out('nota-xp-2024-03-08.pdf', buildNote(NOTES.xp));
out('nota-clear-2022-11-10.pdf', buildNote(NOTES.clear));
out('nota-btg-2024-05-14-senha-123.pdf', buildNote(NOTES.btg));
out('nota-inter-2024-03-07.pdf', buildNote(NOTES.inter));
out('nota-nu-2024-07-02-senha-012.pdf', buildNote(NOTES.nu));
out('nota-nu-2025-08-05.pdf', buildNote(NOTES.nu2025));
out('extracto-davivienda-2024-03.pdf', buildDaviviendaPdf());
out('extracto-trii-2024-03.pdf', buildTriiPdf());
out('movimientos-acciones-valores.xls', buildExcelXls());
out('movimientos-mac-1904.xls', buildExcelXls({ date1904: true }));
