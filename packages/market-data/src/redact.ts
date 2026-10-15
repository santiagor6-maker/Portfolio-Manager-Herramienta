/**
 * Secret redaction (review R6, M38). Provider keys travel in query strings (FMP `apikey`, EODHD
 * `api_token`, Alpha Vantage `apikey`, stooq `apikey`, brapi `token`, CoinGecko
 * `x_cg_demo_api_key`, FRED `api_key`, Socrata `$$app_token`), so any URL that ends up in an error
 * message or detail must go through `sanitizeUrl`. `redactSecrets` is the second line of defence:
 * it sanitizes every URL inside a text and removes any configured secret value wherever it appears.
 */

const MASK = '***';

/** Query-parameter names that carry credentials (compared without case, `_`, `-` or `$`). */
export function isSecretParam(name: string): boolean {
  const n = name.toLowerCase().replace(/[^a-z]/g, '');
  return /(key|token|secret|password|passwd|signature|credential)$/.test(n) || n === 'sig' || n === 'auth' || n === 'apikey';
}

/** The URL with credential query parameters and user-info replaced by `***`. Never throws. */
export function sanitizeUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.username) u.username = MASK;
    if (u.password) u.password = MASK;
    for (const name of [...new Set(u.searchParams.keys())]) if (isSecretParam(name)) u.searchParams.set(name, MASK);
    return redactKnown(u.toString().replace(/%2A%2A%2A/g, MASK));
  } catch {
    return redactKnown(url.replace(/([?&;][^=&\s]*(?:key|token|secret|password|sig)[^=&\s]*=)[^&\s#]*/gi, `$1${MASK}`));
  }
}

const known = new Set<string>();

/** Register configured secret values (provider keys); values shorter than 6 chars are ignored. */
export function registerSecrets(values: readonly (string | undefined)[]): void {
  for (const v of values) if (v && v.length >= 6) known.add(v);
}

function redactKnown(text: string): string {
  let out = text;
  for (const v of known) {
    if (out.includes(v)) out = out.split(v).join(MASK);
    const enc = encodeURIComponent(v);
    if (enc !== v && out.includes(enc)) out = out.split(enc).join(MASK);
  }
  return out;
}

/** Sanitize every URL in a free text and drop any registered secret value. */
export function redactSecrets(text: string): string {
  const urls = text.replace(/https?:\/\/[^\s"'<>]+/g, (u) => sanitizeUrl(u));
  // `apikey=...` echoed outside a URL (an upstream error body quoting the query).
  const pairs = urls.replace(/([\w$-]+)=([^&\s"'<>,;]+)/g, (m, name: string) => (isSecretParam(name) ? `${name}=${MASK}` : m));
  return redactKnown(pairs);
}

/** Deep copy of `x` with every string passed through `redactSecrets` (error details). */
export function redactDeep<T>(x: T, depth = 0): T {
  if (typeof x === 'string') return redactSecrets(x) as T;
  if (depth > 8 || x === null || typeof x !== 'object') return x;
  if (Array.isArray(x)) return x.map((v) => redactDeep(v, depth + 1)) as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(x as Record<string, unknown>)) out[k] = isSecretParam(k) && typeof v === 'string' ? MASK : redactDeep(v, depth + 1);
  return out as T;
}
