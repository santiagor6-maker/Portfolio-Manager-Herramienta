/**
 * At most `max` evenly spaced points (first and last kept): chart data tables and the report chart
 * (W46: it is 1000 units wide, so more points only add bytes to the PDF and the share link).
 */
export function downsample<T>(data: T[], max = 160): T[] {
  if (data.length <= max) return data;
  const step = (data.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => data[Math.round(i * step)]!);
}

/** Round axis ticks (steps of 1, 2 or 5 × 10^n), about five of them, covering [lo, hi]. */
export function niceTicks(lo: number, hi: number, count = 5): number[] {
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return [0, 1];
  if (hi === lo) hi = lo + (Math.abs(lo) || 1);
  const raw = (hi - lo) / (count - 1);
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = ([1, 2, 5, 10].find((m) => m * pow >= raw) ?? 10) * pow;
  const start = Math.floor(lo / step) * step;
  const out: number[] = [];
  for (let v = start; v < hi + step * 0.999; v += step) out.push(Math.round(v / step) * step);
  return out;
}
