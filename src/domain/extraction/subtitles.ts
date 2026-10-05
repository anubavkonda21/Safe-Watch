import type { SubtitleCue, SubtitleKind, TrackDisposition } from './extraction';

/** Subtitle codecs (FFmpeg names) whose payload is text. */
const TEXT_CODECS = new Set([
  'subrip', 'srt', 'ass', 'ssa', 'webvtt', 'mov_text', 'text', 'subviewer', 'subviewer1', 'microdvd',
  'sami', 'realtext', 'jacosub', 'mpl2', 'pjs', 'vplayer', 'stl', 'ttml',
]);
/** Subtitle codecs that are bitmaps: reading them as text would require OCR, which is not implemented. */
const IMAGE_CODECS = new Set(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub']);

/** Classifies a subtitle codec. Anything not known to be text or image is `unknown` (never assumed to be text). */
export function classifySubtitleCodec(codec: string | null): SubtitleKind {
  if (!codec) return 'unknown';
  if (TEXT_CODECS.has(codec)) return 'text';
  if (IMAGE_CODECS.has(codec)) return 'image';
  return 'unknown';
}

const MAX_CUE_TEXT = 4000;
const MAX_TITLE = 200;

// Control characters (except newline/tab) and bidirectional/zero-width controls that can disguise text.
// eslint-disable-next-line no-control-regex -- matching control characters is the purpose of this expression
const CONTROL = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2060-\u2069\uFEFF]/g;
// Formatting markup only: HTML-style tags that subtitle formats use. Other angle-bracket text (e.g. "<laughs>") is kept.
const FORMAT_TAG = /<\/?(?:b|i|u|s|em|strong|font|c|v|lang|ruby|rt|rp|span|p|br)(?:[\s.][^>]*)?\/?>/gi;
const ASS_OVERRIDE = /\{\\[^}]*\}/g;
const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&nbsp;': ' ', '&lrm;': '', '&rlm;': '' };

/**
 * Conservative cue-text normalisation:
 *  - strips subtitle formatting markup (<i>, <b>, <font ...>, {\an8}, ...),
 *  - decodes the basic WebVTT/HTML entities,
 *  - turns literal "\\N" / "\\n" (ASS) into line breaks,
 *  - removes control, zero-width and bidi-override characters,
 *  - trims each line and collapses runs of spaces; blank lines are dropped,
 *  - caps the length (4000 characters).
 * Words, punctuation, casing and line structure are otherwise preserved.
 * The result is plain text and must never be interpreted as HTML.
 */
export function normalizeCueText(raw: string): string {
  const text = raw
    .replace(/\r\n?/g, '\n')
    .replace(ASS_OVERRIDE, '')
    .replace(/\\[Nn]/g, '\n')
    .replace(FORMAT_TAG, '')
    .replace(/&(?:amp|lt|gt|quot|nbsp|lrm|rlm);/g, (m) => ENTITIES[m] ?? m)
    .replace(CONTROL, '');
  const lines = text.split('\n').map((l) => l.replace(/[ \t]+/g, ' ').trim()).filter((l) => l.length > 0);
  return lines.join('\n').slice(0, MAX_CUE_TEXT);
}

/** Sanitises a track title or similar metadata: plain text, no control characters, capped. */
export function sanitizeMetadataText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(CONTROL, '').replace(/\s+/g, ' ').trim().slice(0, MAX_TITLE);
  return cleaned.length > 0 ? cleaned : null;
}

/** ISO 639-style language tag, or null (including FFmpeg's "und"). */
export function normalizeLanguage(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const tag = raw.trim().toLowerCase();
  if (tag === '' || tag === 'und' || tag === 'unk' || tag === 'zxx') return null;
  return /^[a-z]{2,3}(-[a-z0-9]{1,8})?$/.test(tag) ? tag : null;
}

export interface RawCue {
  startSeconds: number;
  endSeconds: number;
  text: string;
}

/**
 * Normalises a track's cues: cleans text, drops empty cues and cues with
 * invalid timing, removes exact duplicates (same start, end and text), orders
 * by time (stable for equal starts) and numbers them. Timing is preserved
 * exactly as given.
 */
export function normalizeCues(raw: readonly RawCue[]): SubtitleCue[] {
  const seen = new Set<string>();
  const kept: RawCue[] = [];
  for (const cue of raw) {
    if (!Number.isFinite(cue.startSeconds) || !Number.isFinite(cue.endSeconds)) continue;
    if (cue.startSeconds < 0 || cue.endSeconds <= cue.startSeconds) continue;
    const text = normalizeCueText(cue.text);
    if (text === '') continue;
    const key = `${cue.startSeconds}|${cue.endSeconds}|${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push({ startSeconds: cue.startSeconds, endSeconds: cue.endSeconds, text });
  }
  return kept
    .map((c, i) => ({ c, i }))
    .sort((a, b) => a.c.startSeconds - b.c.startSeconds || a.i - b.i)
    .map(({ c }, index) => ({ index, ...c }));
}

const TIMESTAMP = /^(\d{1,3}):(\d{2}):(\d{2})[,.](\d{1,3})$/;

export function parseTimestamp(raw: string): number | null {
  const m = TIMESTAMP.exec(raw.trim());
  if (!m) return null;
  const [, h, min, s, ms] = m;
  if (Number(min) > 59 || Number(s) > 59) return null;
  return Math.round((Number(h) * 3600 + Number(min) * 60 + Number(s) + Number((ms ?? '0').padEnd(3, '0')) / 1000) * 1000) / 1000;
}

/**
 * Parses SubRip text (as produced by FFmpeg's srt muxer) into raw cues.
 * Tolerant: blocks that do not parse are skipped. Pure and bounded by the
 * input size; callers cap the input.
 */
export function parseSrt(input: string): RawCue[] {
  const cues: RawCue[] = [];
  const blocks = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n');
    const timeLineIndex = lines.findIndex((l) => l.includes('-->'));
    if (timeLineIndex < 0 || timeLineIndex > 1) continue;
    const [a, b] = (lines[timeLineIndex] ?? '').split('-->');
    const start = parseTimestamp(a ?? '');
    // The end timestamp may be followed by position settings (WebVTT-style): keep the first token.
    const end = parseTimestamp((b ?? '').trim().split(/\s+/)[0] ?? '');
    if (start === null || end === null) continue;
    cues.push({ startSeconds: start, endSeconds: end, text: lines.slice(timeLineIndex + 1).join('\n').replace(/\n+$/, '') });
  }
  return cues;
}

export const noDisposition = (): TrackDisposition => ({ default: false, forced: false, original: false, hearingImpaired: false, commentary: false });
