export function newId(prefix = ''): string {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  const raw =
    c && typeof c.randomUUID === 'function'
      ? c.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}-${Math.random().toString(36).slice(2, 10)}`;
  return prefix ? `${prefix}_${raw}` : raw;
}

export function todayIso(now = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, (d ?? 1) + days));
  return dt.toISOString().slice(0, 10);
}

export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number);
  const dt = new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1 + n, 1));
  return dt.toISOString().slice(0, 7);
}

/** Last calendar day of a `YYYY-MM` month. */
export function monthEnd(month: string): string {
  const [y, m] = month.split('-').map(Number);
  const dt = new Date(Date.UTC(y ?? 1970, m ?? 1, 0));
  return dt.toISOString().slice(0, 10);
}

export function monthsBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let cur = from.slice(0, 7);
  const end = to.slice(0, 7);
  let guard = 0;
  while (cur <= end && guard++ < 1200) {
    out.push(cur);
    cur = addMonths(cur, 1);
  }
  return out;
}
