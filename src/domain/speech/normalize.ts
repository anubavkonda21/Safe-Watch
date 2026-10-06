import { normalizeLanguage } from '../extraction/subtitles';
import {
  roundTime, type Transcript, type TranscriptIssue, type TranscriptIssueCode, type TranscriptSegment, type TranscriptWord,
} from './transcript';

/** What a provider adapter returns. Loosely typed on purpose: it is untrusted until normalised. */
export interface RawWord { start: unknown; end: unknown; text: unknown; confidence?: unknown }
export interface RawSegment { start: unknown; end: unknown; text: unknown; confidence?: unknown; words?: readonly RawWord[] | null }
export interface RawTranscription {
  language?: unknown;
  languageConfidence?: unknown;
  /** How the adapter obtained word times; see Transcript.wordTiming. */
  wordTiming?: 'alignment' | 'decoder';
  segments: readonly RawSegment[];
}

export interface NormalizeContext {
  mediaId: string;
  audioTrackId: string;
  streamIndex: number;
  durationSeconds: number;
  provider: { name: string; model: string };
}

const MAX_SEGMENT_TEXT = 2000;
const MAX_SEGMENTS = 20_000;
/** Words may sit this far outside their segment before the whole word list is considered unreliable. */
const WORD_SLACK_SECONDS = 0.25;
/** Adjacent words may overlap by this much (providers round to centiseconds). */
const WORD_OVERLAP_SECONDS = 0.05;

// Control, zero-width and bidi-override characters that can disguise text. Intentional control-character match.
// eslint-disable-next-line no-control-regex -- matching control characters is the purpose of this expression
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;

/** Deterministic text normalisation: NFC, controls removed, whitespace collapsed. Words, casing and punctuation are untouched. */
export function normalizeTranscriptText(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.normalize('NFC').replace(CONTROL, '').replace(/\s+/g, ' ').trim();
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const prob = (v: unknown): number | null => (finite(v) && v >= 0 && v <= 1 ? v : null);

/**
 * Turns provider output into a SafeWatch Transcript.
 *  - times rounded to milliseconds; segments need finite, non-negative start and end > start, else dropped (counted);
 *  - text normalised, the provider's original kept when it differed;
 *  - empty segments dropped; exact duplicates (same time and text) dropped; ordering by start time (stable);
 *  - overlapping segments are KEPT and counted, never edited;
 *  - word timestamps kept only if valid, ordered and inside their segment (\u00B1 slack); otherwise `words: null` for that segment (counted);
 *  - confidence preserved when provided and in [0, 1], otherwise null.
 * Throws if the response has no usable shape at all.
 */
export function normalizeTranscription(raw: RawTranscription, ctx: NormalizeContext): Transcript {
  if (!raw || !Array.isArray(raw.segments)) throw new TypeError('invalid transcription');
  const counts = new Map<TranscriptIssueCode, number>();
  const bump = (code: TranscriptIssueCode) => counts.set(code, (counts.get(code) ?? 0) + 1);

  const kept: Array<Omit<TranscriptSegment, 'index'>> = [];
  const seen = new Set<string>();
  for (const seg of raw.segments.slice(0, MAX_SEGMENTS)) {
    if (!finite(seg.start) || !finite(seg.end) || seg.start < 0 || seg.end <= seg.start) { bump('invalid-timestamp'); continue; }
    const providerText = typeof seg.text === 'string' ? seg.text : '';
    let text = normalizeTranscriptText(providerText);
    if (text === '') { bump('empty-segment'); continue; }
    if (text.length > MAX_SEGMENT_TEXT) { text = text.slice(0, MAX_SEGMENT_TEXT); bump('text-truncated'); }
    const startSeconds = roundTime(seg.start);
    const endSeconds = roundTime(seg.end);
    const key = `${startSeconds}|${endSeconds}|${text}`;
    if (seen.has(key)) { bump('duplicate-segment'); continue; }
    seen.add(key);

    let words: TranscriptWord[] | null = null;
    if (seg.words && seg.words.length > 0) {
      words = normalizeWords(seg.words, startSeconds, endSeconds);
      if (words === null) bump('words-unreliable');
    }
    kept.push({ startSeconds, endSeconds, text, originalText: providerText === text ? null : providerText.slice(0, MAX_SEGMENT_TEXT), confidence: prob(seg.confidence), words });
  }

  const ordered = kept.map((s, i) => ({ s, i })).sort((a, b) => a.s.startSeconds - b.s.startSeconds || a.i - b.i).map(({ s }, index) => ({ index, ...s }));
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i]!.startSeconds < ordered[i - 1]!.endSeconds - 0.001) bump('overlapping-segments');
  }

  const language = normalizeLanguage(raw.language);
  return {
    mediaId: ctx.mediaId,
    audioTrackId: ctx.audioTrackId,
    streamIndex: ctx.streamIndex,
    language,
    languageConfidence: language === null ? null : prob(raw.languageConfidence),
    durationSeconds: roundTime(ctx.durationSeconds),
    segments: ordered,
    hasWordTimestamps: ordered.some((s) => s.words !== null && s.words.length > 0),
    wordTiming: ordered.some((s) => s.words !== null && s.words.length > 0) ? (raw.wordTiming === 'alignment' ? 'alignment' : 'decoder') : null,
    provider: ctx.provider,
    issues: [...counts.entries()].map(([code, count]): TranscriptIssue => ({ code, count })),
  };
}

function normalizeWords(raw: readonly RawWord[], segStart: number, segEnd: number): TranscriptWord[] | null {
  const words: TranscriptWord[] = [];
  let prevEnd = -1;
  for (const w of raw) {
    const text = normalizeTranscriptText(w.text);
    if (text === '') continue;
    if (!finite(w.start) || !finite(w.end) || w.start < 0 || w.end < w.start) return null;
    const startSeconds = roundTime(w.start);
    const endSeconds = roundTime(w.end);
    if (startSeconds < segStart - WORD_SLACK_SECONDS || endSeconds > segEnd + WORD_SLACK_SECONDS) return null;
    if (startSeconds + WORD_OVERLAP_SECONDS < prevEnd) return null;
    words.push({ startSeconds, endSeconds, text, confidence: prob(w.confidence) });
    prevEnd = endSeconds;
  }
  return words.length > 0 ? words : null;
}
