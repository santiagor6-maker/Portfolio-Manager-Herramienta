import { describe, expect, it } from 'vitest';
import { decodeShare, encodeShare, isEncryptedShare, sanitizeReportHtml } from '../lib/share';

const payload = { v: 1 as const, t: 'Informe · Mi portafolio · 2026', h: '<section><h1>Informe</h1><table><tr><td>$ 1.234</td></tr></table></section>'.repeat(40), g: '2026-10-13T12:00:00Z', lang: 'es' };

describe('read-only share links (W10)', () => {
  it('round-trips a compressed report through the URL fragment', async () => {
    const frag = await encodeShare(payload);
    expect(frag.startsWith('p1.')).toBe(true);
    expect(frag).toMatch(/^[\w.-]+$/); // URL-safe
    expect(frag.length).toBeLessThan(payload.h.length / 4); // compressed
    expect(await decodeShare(`#${frag}`)).toEqual(payload);
  });

  it('encrypts with a passphrase and rejects a wrong one', async () => {
    const frag = await encodeShare(payload, 'clave segura');
    expect(isEncryptedShare(frag)).toBe(true);
    expect(frag).not.toContain('Informe');
    await expect(decodeShare(frag)).rejects.toThrow('needs_passphrase');
    await expect(decodeShare(frag, 'otra')).rejects.toThrow('wrong_passphrase');
    expect((await decodeShare(frag, 'clave segura')).t).toBe(payload.t);
  });

  it('rejects damaged links and strips anything executable', async () => {
    await expect(decodeShare('#p1.AAAA')).rejects.toThrow('invalid_link');
    await expect(decodeShare('#x9.foo')).rejects.toThrow('invalid_link');
    expect(sanitizeReportHtml('<div onclick="steal()">a</div><script>alert(1)</script><a href="javascript:x">b</a>')).toBe('<div>a</div><a href="x">b</a>');
  });
});
