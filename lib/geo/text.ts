// Diacritic folding for OFFLINE search (mirrors Postgres unaccent() for Latin
// text). The DB normalizes with unaccent at write time via a trigger; the client
// has no Postgres, so it folds here. Keeping both sides consistent is what makes
// "Lapaz"/"La Paz"/"Lapazz" resolve to the same thing on- and offline.

// Combining diacritical marks block: U+0300–U+036F. Built via RegExp() so the
// source file stays plain ASCII (no encoding surprises across tools/editors).
const COMBINING_MARKS = new RegExp('[\\u0300-\\u036f]', 'g');

export function fold(s: string): string {
  return (s ?? '')
    .normalize('NFD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .trim();
}
