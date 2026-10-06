/**
 * Normalised speech transcript. Provider-neutral: nothing here knows which
 * model produced it. All times are MEDIA time in seconds (the same timeline
 * as the video), rounded to whole milliseconds. Frame numbers are never used.
 *
 * Confidence is `null` when the provider did not supply one: it is never
 * invented. Word timestamps are optional (`words: null`) because not every
 * provider or segment has reliable ones.
 */
export interface TranscriptWord {
  startSeconds: number;
  endSeconds: number;
  text: string;
  /** Provider-reported probability in [0, 1], or null when unknown. Not calibrated. */
  confidence: number | null;
}

export interface TranscriptSegment {
  index: number;
  startSeconds: number;
  endSeconds: number;
  /** Normalised text (NFC, no control/bidi characters, single spaces). Untrusted plain text. */
  text: string;
  /** The provider's text, kept only when normalisation changed it. */
  originalText: string | null;
  confidence: number | null;
  words: TranscriptWord[] | null;
}

export type TranscriptIssueCode =
  | 'invalid-timestamp'
  | 'empty-segment'
  | 'duplicate-segment'
  | 'overlapping-segments'
  | 'words-unreliable'
  | 'text-truncated';

/** Counts of things normalisation had to handle. Surfaced so nothing is repaired silently. */
export interface TranscriptIssue {
  code: TranscriptIssueCode;
  count: number;
}

export interface Transcript {
  mediaId: string;
  /** AudioAsset id this transcript was produced from (e.g. `aud-0`). */
  audioTrackId: string;
  /** Index of the stream in the source container. */
  streamIndex: number;
  /** Language the provider detected or was told to use (ISO 639-1 where known); null if unknown. */
  language: string | null;
  languageConfidence: number | null;
  /** Length of the audio that was transcribed. */
  durationSeconds: number;
  segments: TranscriptSegment[];
  hasWordTimestamps: boolean;
  /**
   * How word times were obtained, i.e. how far to trust them:
   *  - `alignment`: the engine aligned words to the audio (e.g. DTW). Word START times are the reliable part;
   *    a word's END is an upper bound (the next word's start) and neighbouring words may share a start time.
   *  - `decoder`: heuristic decoder timestamps. These can be seconds off around pauses and silence.
   *  - null: no word timestamps.
   */
  wordTiming: 'alignment' | 'decoder' | null;
  provider: { name: string; model: string };
  issues: TranscriptIssue[];
}

export const TIME_PRECISION_DIGITS = 3;
export const roundTime = (seconds: number): number => Math.round(seconds * 10 ** TIME_PRECISION_DIGITS) / 10 ** TIME_PRECISION_DIGITS;

/** Structural checks future consumers rely on. Returns problems (empty when valid). */
export function validateTranscript(t: Transcript): string[] {
  const problems: string[] = [];
  let prevStart = -1;
  t.segments.forEach((s, i) => {
    if (s.index !== i) problems.push(`segment ${i}: index ${s.index}`);
    if (!(s.startSeconds >= 0) || !(s.endSeconds > s.startSeconds)) problems.push(`segment ${i}: invalid timing`);
    if (s.startSeconds < prevStart) problems.push(`segment ${i}: out of order`);
    if (t.durationSeconds > 0 && s.startSeconds > t.durationSeconds + 1) problems.push(`segment ${i}: starts after the audio ends`);
    if (s.text === '') problems.push(`segment ${i}: empty text`);
    if (s.confidence !== null && !(s.confidence >= 0 && s.confidence <= 1)) problems.push(`segment ${i}: confidence out of range`);
    let prevWordEnd = -1;
    for (const w of s.words ?? []) {
      if (!(w.endSeconds >= w.startSeconds) || w.startSeconds < 0) problems.push(`segment ${i}: invalid word timing`);
      if (w.startSeconds + 0.05 < prevWordEnd) problems.push(`segment ${i}: words overlap`);
      if (w.confidence !== null && !(w.confidence >= 0 && w.confidence <= 1)) problems.push(`segment ${i}: word confidence out of range`);
      if (w.text === '') problems.push(`segment ${i}: empty word`);
      prevWordEnd = w.endSeconds;
    }
    prevStart = s.startSeconds;
  });
  if (t.hasWordTimestamps !== t.segments.some((s) => s.words !== null && s.words.length > 0)) problems.push('hasWordTimestamps does not match segments');
  return problems;
}
