/**
 * Deterministic text normalisation for custom-term matching. Policy:
 *  - Unicode NFKC (compatibility forms: fullwidth Latin \u2192 ASCII, ligatures \u2192 letters; Devanagari and other scripts are preserved);
 *  - control, zero-width and bidi-override characters removed;
 *  - curly apostrophes/quotes \u2192 straight ones, so "don\u2019t" equals "don't";
 *  - whitespace runs \u2192 one space; trimmed;
 *  - optional case folding via `toLowerCase()` (locale-independent).
 * Deliberately NOT done: stripping diacritics ("r\u00E9sum\u00E9" \u2260 "resume"), removing
 * punctuation inside the text (tokenisation handles that), stemming, or
 * transliteration. Legitimate words are never corrupted.
 */
// eslint-disable-next-line no-control-regex -- matching control characters is the purpose of this expression
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;

export function normalizeForMatching(text: string, options: { fold?: boolean } = {}): string {
  const base = text
    .normalize('NFKC')
    .replace(CONTROL, '')
    .replace(/[\u2018\u2019\u02BC\u2032]/g, "'")
    .replace(/[\u201C\u201D\u2033]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
  return options.fold ? base.toLowerCase() : base;
}

/** Word tokens: runs of letters/marks/digits, allowing inner apostrophes ("don't"). Works for any script. */
const TOKEN = /[\p{L}\p{M}\p{N}]+(?:'[\p{L}\p{M}\p{N}]+)*/gu;

export function tokenize(normalized: string): string[] {
  return normalized.match(TOKEN) ?? [];
}
