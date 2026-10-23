/**
 * W46: at most `max` evenly spaced points (first and last kept). The report chart is 1000 units wide,
 * so more points only add bytes to the PDF and the share link.
 */
export function downsample<T>(data: T[], max = 160): T[] {
  if (data.length <= max) return data;
  const step = (data.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, i) => data[Math.round(i * step)]!);
}
