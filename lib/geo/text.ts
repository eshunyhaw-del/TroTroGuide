// Diacritic folding for OFFLINE search (mirrors Postgres unaccent() for Latin text).

// Combining diacritical marks block: U+0300–U+036F.
const COMBINING_MARKS = new RegExp('[\\u0300-\\u036f]', 'g');

export function fold(s: string): string {
  return (s ?? '')
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .trim();
}
