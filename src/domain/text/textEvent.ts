import type { SubtitleTrack } from '../extraction/extraction';
import type { Transcript, TranscriptWord } from '../speech/transcript';

/**
 * Speech and subtitles are two kinds of EVIDENCE about what is said in a
 * video. A TextEvent is the common shape both are reduced to, so later stages
 * (custom-term matching, and eventually safety classifiers) treat them
 * uniformly. Evidence only: nothing here decides whether media is safe.
 */
export type TextSource = 'speech' | 'subtitle';

/** Which evidence sources contain this text, decided by alignment. Initially the event's own source. */
export type Evidence = 'speech-only' | 'subtitle-only' | 'both';

export interface TextEvent {
  /** Unique within a media item: `spe-<trackId>-<n>` or `sub-<trackId>-<n>`. */
  id: string;
  source: TextSource;
  startSeconds: number;
  endSeconds: number;
  /** Untrusted plain text. Never interpret as HTML. */
  text: string;
  language: string | null;
  /** AudioAsset id (speech) or SubtitleTrack id (subtitle). */
  trackId: string;
  streamIndex: number;
  /** Provider confidence for speech when known; always null for subtitles. */
  confidence: number | null;
  /** Word timestamps when the provider supplied reliable ones (speech only). */
  words: TranscriptWord[] | null;
  evidence: Evidence;
}

export function eventsFromTranscript(t: Transcript): TextEvent[] {
  return t.segments.map((s) => ({
    id: `spe-${t.audioTrackId}-${s.index}`,
    source: 'speech' as const,
    startSeconds: s.startSeconds,
    endSeconds: s.endSeconds,
    text: s.text,
    language: t.language,
    trackId: t.audioTrackId,
    streamIndex: t.streamIndex,
    confidence: s.confidence,
    words: s.words,
    evidence: 'speech-only' as const,
  }));
}

/** Only text tracks whose text was extracted contribute events. Image/unsupported/failed tracks contribute none. */
export function eventsFromSubtitleTrack(track: SubtitleTrack): TextEvent[] {
  if (track.textExtraction !== 'extracted') return [];
  return track.cues.map((c) => ({
    id: `sub-${track.id}-${c.index}`,
    source: 'subtitle' as const,
    startSeconds: c.startSeconds,
    endSeconds: c.endSeconds,
    text: c.text,
    language: track.language,
    trackId: track.id,
    streamIndex: track.streamIndex,
    confidence: null,
    words: null,
    evidence: 'subtitle-only' as const,
  }));
}

/** Deterministic order: start, end, source (speech first), id. */
export function buildTimeline(events: readonly TextEvent[]): TextEvent[] {
  return [...events].sort((a, b) =>
    a.startSeconds - b.startSeconds || a.endSeconds - b.endSeconds || (a.source === b.source ? 0 : a.source === 'speech' ? -1 : 1) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
