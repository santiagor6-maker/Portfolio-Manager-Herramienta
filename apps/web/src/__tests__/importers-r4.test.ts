import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { db, resetDbInstance } from '../db/schema';
import { runImport, unresolvedSecurities } from '../services/importers';
import type { ImportResult } from '@pm/importers';

let n = 0;
beforeEach(() => resetDbInstance(`imp-r4-${++n}`));
afterEach(async () => {
  await db.delete();
});

function eml(csv: string): string {
  const b64 = Buffer.from(csv, 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
  return [
    'From: Trii <noreply@trii.co>',
    'Subject: Extracto mensual',
    'Date: Mon, 5 Oct 2026 10:00:00 -0500',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="XYZ"',
    '',
    '--XYZ',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Adjunto su extracto.',
    '--XYZ',
    'Content-Type: text/csv; name="extracto.csv"',
    'Content-Disposition: attachment; filename="extracto.csv"',
    'Content-Transfer-Encoding: base64',
    '',
    b64,
    '--XYZ--',
    '',
  ].join('\r\n');
}

describe('importers round 4 wiring', () => {
  it('imports the attachments of a dropped .eml file into one preview', async () => {
    // resolved from this file, not the cwd (the root `vitest run` starts in the repo root)
    const csv = readFileSync(new URL('../../e2e/fixtures/extracto-trii.csv', import.meta.url), 'utf8');
    const file = new File([eml(csv)], 'extracto.eml', { type: 'message/rfc822' });
    const r = await runImport({ file, portfolioId: 'p1', locale: 'es' });
    expect(r.transactions.length).toBeGreaterThan(0);
    expect(r.detection.presetLabel).toContain('Extracto mensual');
    expect(r.rows.length).toBeGreaterThanOrEqual(r.transactions.length);
  });

  it('lists unknown broker-note names and BDR classes with ranked suggestions', () => {
    const r = {
      errors: [],
      warnings: [],
      rows: [{ line: 3, status: 'error', issues: [{ code: 'BDR_CLASS_UNCERTAIN', severity: 'error', message: '', params: { spec: 'ALPHABET DRN A' } }] }],
      unknownSecurities: [
        { key: 'ALPHABET DRN A', lines: [3], suggestions: ['GOGL34', 'GOGL35'] },
        { key: 'MINERVA ON NM', lines: [4], suggestions: ['BEEF3'] },
      ],
    } as unknown as ImportResult;
    expect(unresolvedSecurities(r)).toEqual([
      { key: 'ALPHABET DRN A', code: 'BDR_CLASS_UNCERTAIN', suggestions: ['GOGL34', 'GOGL35'] },
      { key: 'MINERVA ON NM', code: 'UNKNOWN_SECURITY', suggestions: ['BEEF3'] },
    ]);
  });
});
