import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { importFile, type ImportOptions, type ImportResult } from '../../src';

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');

export function fixture(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(fixturesDir, name)));
}

export function importFixture(name: string, opts: Partial<ImportOptions> = {}): Promise<ImportResult> {
  return importFile({ data: fixture(name), fileName: name }, { portfolioId: 'p1', ...opts });
}

export function byLine(r: ImportResult, line: number) {
  const row = r.rows.find((x) => x.line === line);
  if (!row) throw new Error(`no row at line ${line}`);
  return row;
}
