/** Lowercase, strip accents and punctuation (keeps ^ for index symbols). */
export function normalizeText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9^+]+/g, ' ')
    .trim();
}
