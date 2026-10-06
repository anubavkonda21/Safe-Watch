import { primaryLanguage } from '../speech/trackSelection';
import { normalizeForMatching, tokenize } from './normalizeForMatching';
import type { TextEvent } from './textEvent';

export interface AlignmentLink {
  speechEventId: string;
  subtitleEventIds: string[];
  /** Token-overlap similarity (Dice coefficient) in [0, 1] between the speech text and the linked subtitle text. */
  similarity: number;
}

export interface AlignmentResult {
  /** The timeline with `evidence` set: both / speech-only / subtitle-only. Same order as the input. */
  events: TextEvent[];
  links: AlignmentLink[];
  counts: { both: number; speechOnly: number; subtitleOnly: number };
}

export interface AlignmentOptions {
  /** Minimum token similarity to call two texts the same evidence. Conservative default. */
  minSimilarity?: number;
  /** Subtitles and speech are rarely perfectly in sync: how far apart (seconds) they may be and still be compared. */
  toleranceSeconds?: number;
}

const tokensOf = (text: string) => tokenize(normalizeForMatching(text, { fold: true }));
/** Container tags are often three letters ("eng") while speech models report two ("en"): compare by primary language. */
const languagesCompatible = (a: string | null, b: string | null) => {
  const x = primaryLanguage(a);
  const y = primaryLanguage(b);
  return x === null || y === null || x === y;
};

/** Dice coefficient over token multisets: 2·|A∩B| / (|A|+|B|). Order-insensitive, so cue splitting does not matter. */
export function textSimilarity(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 || b.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const t of a) counts.set(t, (counts.get(t) ?? 0) + 1);
  let shared = 0;
  for (const t of b) {
    const n = counts.get(t) ?? 0;
    if (n > 0) { shared += 1; counts.set(t, n - 1); }
  }
  return (2 * shared) / (a.length + b.length);
}

const overlaps = (a: TextEvent, b: TextEvent, tol: number) => a.startSeconds < b.endSeconds + tol && b.startSeconds < a.endSeconds + tol;

/**
 * Deterministic, conservative speech ↔ subtitle alignment. NOT semantic AI:
 * a speech event and subtitle cue(s) are linked only when they are close in
 * time (within `toleranceSeconds`), in compatible languages, AND their words
 * overlap strongly (`minSimilarity`). A speech event is compared with all
 * nearby cues together (cues often split a sentence) and, failing that, with
 * each cue alone; subtitle cues that cover several speech segments are
 * linked by the reverse pass. Anything not linked stays single-sourced
 * (`speech-only` / `subtitle-only`): the absence of a link means "not
 * corroborated by the other source", never "wrong".
 */
export function alignText(timeline: readonly TextEvent[], options: AlignmentOptions = {}): AlignmentResult {
  const minSimilarity = options.minSimilarity ?? 0.6;
  const tol = options.toleranceSeconds ?? 1.0;
  const speech = timeline.filter((e) => e.source === 'speech');
  const subs = timeline.filter((e) => e.source === 'subtitle');
  const speechTokens = new Map(speech.map((e) => [e.id, tokensOf(e.text)]));
  const subTokens = new Map(subs.map((e) => [e.id, tokensOf(e.text)]));

  const linkedSpeech = new Set<string>();
  const linkedSubs = new Set<string>();
  const links = new Map<string, { subs: Set<string>; similarity: number }>();
  const addLink = (speechId: string, subIds: string[], similarity: number) => {
    const entry = links.get(speechId) ?? { subs: new Set<string>(), similarity: 0 };
    subIds.forEach((s) => entry.subs.add(s));
    entry.similarity = Math.max(entry.similarity, similarity);
    links.set(speechId, entry);
    linkedSpeech.add(speechId);
    subIds.forEach((s) => linkedSubs.add(s));
  };

  // Pass 1: each speech event against the cues around it.
  for (const s of speech) {
    const near = subs.filter((c) => overlaps(s, c, tol) && languagesCompatible(s.language, c.language));
    if (near.length === 0) continue;
    const sTokens = speechTokens.get(s.id)!;
    const together = textSimilarity(sTokens, near.flatMap((c) => subTokens.get(c.id)!));
    if (together >= minSimilarity) { addLink(s.id, near.map((c) => c.id), together); continue; }
    let best: { id: string; sim: number } | null = null;
    for (const c of near) {
      const sim = textSimilarity(sTokens, subTokens.get(c.id)!);
      if (sim >= minSimilarity && (best === null || sim > best.sim)) best = { id: c.id, sim };
    }
    if (best) addLink(s.id, [best.id], best.sim);
  }

  // Pass 2: each still-unlinked cue against the speech around it (one cue spanning several segments).
  for (const c of subs) {
    if (linkedSubs.has(c.id)) continue;
    const near = speech.filter((s) => overlaps(s, c, tol) && languagesCompatible(s.language, c.language));
    if (near.length === 0) continue;
    const sim = textSimilarity(subTokens.get(c.id)!, near.flatMap((s) => speechTokens.get(s.id)!));
    if (sim >= minSimilarity) near.forEach((s) => addLink(s.id, [c.id], sim));
  }

  const events = timeline.map((e): TextEvent => {
    const both = e.source === 'speech' ? linkedSpeech.has(e.id) : linkedSubs.has(e.id);
    return { ...e, evidence: both ? 'both' : e.source === 'speech' ? 'speech-only' : 'subtitle-only' };
  });
  const counts = {
    both: events.filter((e) => e.evidence === 'both').length,
    speechOnly: events.filter((e) => e.evidence === 'speech-only').length,
    subtitleOnly: events.filter((e) => e.evidence === 'subtitle-only').length,
  };
  return {
    events,
    links: [...links.entries()].map(([speechEventId, v]) => ({ speechEventId, subtitleEventIds: [...v.subs].sort(), similarity: Math.round(v.similarity * 1000) / 1000 })),
    counts,
  };
}
