import { normalizeForMatching, tokenize } from './normalizeForMatching';

/**
 * What a user asked SafeWatch to detect. Detection only: a filter says WHAT
 * to look for, never what to do about it (muting/censoring is a later feature).
 *
 * Match modes (all operate on text normalised by `normalizeForMatching`):
 *  - exact            case-sensitive substring.
 *  - case-insensitive substring ignoring case (may match inside a longer word).
 *  - word-boundary    whole word(s), ignoring case: "art" does not match "party".
 *  - phrase           whole words ignoring case, tolerant of spacing and punctuation
 *                     between words: "ice cream" ~ "ice-cream"; "SafeWatch" ~ "safe watch".
 */
export const MATCH_MODES = ['exact', 'case-insensitive', 'word-boundary', 'phrase'] as const;
export type MatchMode = (typeof MATCH_MODES)[number];

export const MATCH_MODE_LABEL: Record<MatchMode, string> = {
  'word-boundary': 'Whole word',
  phrase: 'Phrase',
  'case-insensitive': 'Contains',
  exact: 'Exact case',
};

export interface CustomFilter {
  id: string;
  /** What the user typed, cleaned (NFC, no control characters, single spaces). Untrusted plain text. */
  phrase: string;
  /** NFKC, case-folded form used for matching and duplicate detection. */
  normalizedPhrase: string;
  matchMode: MatchMode;
  enabled: boolean;
  /** ISO-8601. */
  createdAt: string;
}

export const MAX_PHRASE_LENGTH = 200;
export const MAX_FILTERS = 100;

export type FilterRejection = 'empty' | 'too-long' | 'no-words' | 'duplicate' | 'limit-reached';

export type FilterResult = { ok: true; filter: CustomFilter } | { ok: false; reason: FilterRejection };

export function createCustomFilter(
  rawPhrase: string,
  matchMode: MatchMode,
  existing: readonly CustomFilter[],
  env: { id: string; now: string },
): FilterResult {
  if (existing.length >= MAX_FILTERS) return { ok: false, reason: 'limit-reached' };
  const phrase = normalizeForMatching(rawPhrase.normalize('NFC'));
  if (phrase === '') return { ok: false, reason: 'empty' };
  if (phrase.length > MAX_PHRASE_LENGTH) return { ok: false, reason: 'too-long' };
  const normalizedPhrase = normalizeForMatching(phrase, { fold: true });
  if (tokenize(normalizedPhrase).length === 0) return { ok: false, reason: 'no-words' };
  if (existing.some((f) => f.normalizedPhrase === normalizedPhrase && f.matchMode === matchMode)) return { ok: false, reason: 'duplicate' };
  return { ok: true, filter: { id: env.id, phrase, normalizedPhrase, matchMode, enabled: true, createdAt: env.now } };
}

/** Defensive check for filters read back from storage: anything malformed is discarded, never trusted. */
export function parseStoredFilters(raw: unknown): CustomFilter[] {
  if (!Array.isArray(raw)) return [];
  const out: CustomFilter[] = [];
  for (const item of raw.slice(0, MAX_FILTERS)) {
    if (typeof item !== 'object' || item === null) continue;
    const f = item as Record<string, unknown>;
    if (typeof f.id !== 'string' || typeof f.phrase !== 'string' || typeof f.createdAt !== 'string') continue;
    if (!(MATCH_MODES as readonly string[]).includes(f.matchMode as string)) continue;
    const result = createCustomFilter(f.phrase, f.matchMode as MatchMode, out, { id: f.id.slice(0, 64), now: f.createdAt.slice(0, 40) });
    if (result.ok) out.push({ ...result.filter, enabled: f.enabled !== false });
  }
  return out;
}
