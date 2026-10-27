import type { SubtitleCue } from '../extraction/extraction';
import { normalizeCues, parseSrt, type RawCue } from '../extraction/subtitles';

/**
 * Caption files the USER provides for a YouTube video (SubRip .srt or WebVTT .vtt). SafeWatch never fetches captions from
 * YouTube: no authorised way exists for videos the user does not own (see the architecture document). Parsing is pure and
 * bounded; the text is untrusted and is never interpreted as HTML.
 */
export const MAX_CAPTION_CHARS = 2_000_000;
export const MAX_CAPTION_CUES = 20_000;

export type CaptionFormat = 'srt' | 'vtt';
export type CaptionRejection = 'empty' | 'too-large' | 'unrecognized' | 'no-cues' | 'too-many-cues';

export type ParsedCaptions =
  | { ok: true; format: CaptionFormat; cues: SubtitleCue[]; dropped: number; firstStartSeconds: number; lastEndSeconds: number }
  | { ok: false; reason: CaptionRejection };

// WebVTT timestamps: hours are optional ("01:02.500" or "00:01:02.500").
const VTT_TIME = /^(?:(\d{1,3}):)?(\d{2}):(\d{2})\.(\d{1,3})$/;

function vttSeconds(raw: string): number | null {
  const m = VTT_TIME.exec(raw.trim());
  if (!m) return null;
  const [, h, min, s, ms] = m;
  if (Number(min) > 59 || Number(s) > 59) return null;
  return Math.round((Number(h ?? 0) * 3600 + Number(min) * 60 + Number(s) + Number((ms ?? '0').padEnd(3, '0')) / 1000) * 1000) / 1000;
}

export function parseWebVtt(input: string): RawCue[] {
  const cues: RawCue[] = [];
  const blocks = input.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split(/\n{2,}/);
  for (const block of blocks) {
    const lines = block.split('\n');
    const first = (lines[0] ?? '').trim();
    if (/^(WEBVTT|NOTE|STYLE|REGION)(\s|$)/.test(first)) continue;
    const timeIndex = lines.findIndex((l) => l.includes('-->'));
    if (timeIndex < 0 || timeIndex > 1) continue;
    const [a, b] = (lines[timeIndex] ?? '').split('-->');
    const start = vttSeconds(a ?? '');
    const end = vttSeconds((b ?? '').trim().split(/\s+/)[0] ?? ''); // cue settings may follow the end time
    if (start === null || end === null) continue;
    cues.push({ startSeconds: start, endSeconds: end, text: lines.slice(timeIndex + 1).join('\n') });
  }
  return cues;
}

export function parseCaptionFile(text: string): ParsedCaptions {
  if (typeof text !== 'string' || text.trim() === '') return { ok: false, reason: 'empty' };
  if (text.length > MAX_CAPTION_CHARS) return { ok: false, reason: 'too-large' };
  const body = text.replace(/^\uFEFF/, '');
  const isVtt = /^WEBVTT(?:[ \t\n\r]|$)/.test(body);
  if (!isVtt && !body.includes('-->')) return { ok: false, reason: 'unrecognized' };
  const raw = isVtt ? parseWebVtt(body) : parseSrt(body);
  if (raw.length > MAX_CAPTION_CUES) return { ok: false, reason: 'too-many-cues' };
  const cues: SubtitleCue[] = normalizeCues(raw);
  if (cues.length === 0) return { ok: false, reason: 'no-cues' };
  return {
    ok: true, format: isVtt ? 'vtt' : 'srt', cues, dropped: raw.length - cues.length,
    firstStartSeconds: cues[0]!.startSeconds, lastEndSeconds: Math.max(...cues.map((c) => c.endSeconds)),
  };
}

export function describeCaptionRejection(reason: CaptionRejection): string {
  switch (reason) {
    case 'empty': return 'The file is empty.';
    case 'too-large': return 'The file is too large to be a caption file.';
    case 'unrecognized': return 'That does not look like an SRT or WebVTT caption file.';
    case 'no-cues': return 'No usable captions were found in the file.';
    case 'too-many-cues': return 'The file has too many captions to check.';
  }
}
