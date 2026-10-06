import type { CustomFilter } from './customFilter';
import { normalizeForMatching, tokenize } from './normalizeForMatching';
import type { TextEvent, TextSource } from './textEvent';

/**
 * A detected occurrence of a custom term in speech or subtitle text. This is
 * EVIDENCE with timing: it does not mute, censor, hide or judge anything.
 */
export interface TextMatch {
  id: string;
  filterId: string;
  phrase: string;
  source: TextSource;
  trackId: string;
  eventId: string;
  startSeconds: number;
  endSeconds: number;
  /** The matched words (normalised text, whole words even in substring modes). */
  matchedText: string;
  /** Lowest known word confidence of the matched words; null if unknown (never invented). Always null for subtitles. */
  confidence: number | null;
  /** `word`: timestamps are the matched words'. `segment`/`cue`: the whole speech segment / subtitle cue (no word timing available). */
  granularity: 'word' | 'segment' | 'cue';
  matchMode: CustomFilter['matchMode'];
}

export const MAX_MATCHES = 10_000;
const MAX_PHRASE_WORDS = 12;

interface Unit { text: string; folded: string; start: number; end: number; confidence: number | null }

function unitsOf(event: TextEvent): { units: Unit[]; granularity: TextMatch['granularity'] } {
  const units: Unit[] = [];
  if (event.words && event.words.length > 0) {
    for (const w of event.words) {
      for (const token of tokenize(normalizeForMatching(w.text))) {
        units.push({ text: token, folded: token.toLowerCase(), start: w.startSeconds, end: w.endSeconds, confidence: w.confidence });
      }
    }
    return { units, granularity: 'word' };
  }
  for (const token of tokenize(normalizeForMatching(event.text))) {
    units.push({ text: token, folded: token.toLowerCase(), start: event.startSeconds, end: event.endSeconds, confidence: event.confidence });
  }
  return { units, granularity: event.source === 'speech' ? 'segment' : 'cue' };
}

/** Finds non-overlapping unit ranges [from, to) matching the filter. */
function findRanges(filter: CustomFilter, units: readonly Unit[]): Array<[number, number]> {
  const phraseTokens = tokenize(normalizeForMatching(filter.phrase));
  const folded = phraseTokens.map((t) => t.toLowerCase());
  if (folded.length === 0 || units.length === 0) return [];
  const ranges: Array<[number, number]> = [];

  switch (filter.matchMode) {
    case 'word-boundary': {
      for (let i = 0; i + folded.length <= units.length; ) {
        if (folded.every((t, k) => units[i + k]!.folded === t)) { ranges.push([i, i + folded.length]); i += folded.length; } else i += 1;
      }
      break;
    }
    case 'phrase': {
      // Compare with spacing removed, on whole-word boundaries: "safe watch" ~ "SafeWatch".
      const target = folded.join('');
      for (let i = 0; i < units.length; ) {
        let acc = '';
        let j = i;
        let hit = -1;
        while (j < units.length && j - i < MAX_PHRASE_WORDS && acc.length < target.length) { acc += units[j]!.folded; j += 1; }
        if (acc === target) hit = j;
        if (hit > 0) { ranges.push([i, hit]); i = hit; } else i += 1;
      }
      break;
    }
    case 'case-insensitive':
    case 'exact': {
      const caseSensitive = filter.matchMode === 'exact';
      const needle = tokenize(normalizeForMatching(filter.phrase, { fold: !caseSensitive })).join(' ');
      // Units are joined with single spaces; remember where each unit starts and ends in the joined string.
      const starts: number[] = [];
      const ends: number[] = [];
      let joined = '';
      for (const u of units) {
        const t = caseSensitive ? u.text : u.folded;
        starts.push(joined.length === 0 ? 0 : joined.length + 1);
        joined += (joined.length === 0 ? '' : ' ') + t;
        ends.push(joined.length);
      }
      let from = 0;
      for (let idx = needle.length > 0 ? joined.indexOf(needle, from) : -1; idx >= 0; idx = joined.indexOf(needle, from)) {
        const first = starts.findIndex((_s, k) => ends[k]! > idx);
        let last = first;
        while (last + 1 < units.length && starts[last + 1]! < idx + needle.length) last += 1;
        if (first >= 0) ranges.push([first, last + 1]);
        from = idx + needle.length;
      }
      break;
    }
  }
  return ranges;
}

/**
 * Finds every enabled filter's matches in speech and subtitle events. Pure,
 * deterministic and bounded (`MAX_MATCHES`). Speech uses word timestamps when
 * available; otherwise the whole segment's time span, reported honestly as
 * `granularity: 'segment'`. Results are ordered by time, then filter, then id.
 */
export function findTextMatches(filters: readonly CustomFilter[], events: readonly TextEvent[]): TextMatch[] {
  const found: Array<{ match: TextMatch; position: number }> = [];
  const active = filters.filter((f) => f.enabled);
  if (active.length === 0) return [];

  outer: for (const event of events) {
    const { units, granularity } = unitsOf(event);
    if (units.length === 0) continue;
    for (const filter of active) {
      for (const [from, to] of findRanges(filter, units)) {
        const hit = units.slice(from, to);
        const known = hit.map((u) => u.confidence).filter((c): c is number => c !== null);
        found.push({ position: from, match: {
          id: `${filter.id}:${event.id}:${from}`,
          filterId: filter.id,
          phrase: filter.phrase,
          source: event.source,
          trackId: event.trackId,
          eventId: event.id,
          startSeconds: Math.min(...hit.map((u) => u.start)),
          endSeconds: Math.max(...hit.map((u) => u.end)),
          matchedText: hit.map((u) => u.text).join(' '),
          confidence: event.source === 'subtitle' || known.length === 0 ? null : Math.min(...known),
          granularity,
          matchMode: filter.matchMode,
        } });
        if (found.length >= MAX_MATCHES) break outer;
      }
    }
  }
  // Total order: time, then filter, then event, then position inside the event (numeric, not string order).
  const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return found
    .sort((a, b) => a.match.startSeconds - b.match.startSeconds || a.match.endSeconds - b.match.endSeconds || cmp(a.match.filterId, b.match.filterId) || cmp(a.match.eventId, b.match.eventId) || a.position - b.position)
    .map((f) => f.match);
}
