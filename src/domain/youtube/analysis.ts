import { buildContextAnalysis } from '../context/contextAnalysis';
import type { SubtitleCue, SubtitleTrack } from '../extraction/extraction';
import { noDisposition } from '../extraction/subtitles';
import { analyzeSafety } from '../safety/analyze';
import type { SafetyAnalysis } from '../safety/finding';
import { alignText } from '../text/alignment';
import type { CustomFilter } from '../text/customFilter';
import type { TextAnalysis } from '../text/textAnalysis';
import { buildTimeline, eventsFromSubtitleTrack } from '../text/textEvent';
import { isYouTubeVideoId } from './url';

/**
 * Phrase matching over captions the user supplied for a YouTube video, using the SAME context builder and the SAME flagged-term
 * classifier as local files (no second engine). The inputs are described honestly: the only text source is the user's caption
 * file; no speech was recognised (there is no audio source) and no frames were analysed (there is no visual source), so the
 * context reports speech and visual as "not enabled" and the safety result comes out PARTIAL by construction.
 */
export const youTubeMediaId = (videoId: string): string => `yt-${videoId}`;

export interface CaptionAnalysisInput {
  videoId: string;
  cues: readonly SubtitleCue[];
  terms: readonly CustomFilter[];
  /** The player's duration in ms, when known. Not used to change any timing. */
  durationMs: number | null;
}

export async function analyzeCaptions(input: CaptionAnalysisInput): Promise<SafetyAnalysis> {
  if (!isYouTubeVideoId(input.videoId)) throw new Error('invalid video id');
  const mediaId = youTubeMediaId(input.videoId);
  const track: SubtitleTrack = {
    id: 'captions-user', ordinal: 0, streamIndex: 0, language: null, title: 'Captions provided by the user', codec: null, kind: 'text',
    textExtraction: 'extracted', disposition: noDisposition(), cueCount: input.cues.length, cues: [...input.cues],
  };
  const timeline = buildTimeline(eventsFromSubtitleTrack(track));
  const aligned = alignText(timeline);
  const now = new Date(0).toISOString();
  const text: TextAnalysis = {
    mediaId, status: 'ready', phase: null,
    // One synthetic, clearly labelled entry: speech recognition was not run because there is no audio source for this video.
    speech: [{ audioTrackId: 'youtube-no-audio', streamIndex: 0, containerLanguage: null, status: 'skipped', skipReason: 'speech-disabled', error: null, transcript: null, processingMs: null }],
    timeline: aligned.events, alignment: { links: aligned.links, counts: aligned.counts }, provider: null,
    createdAt: now, startedAt: now, completedAt: now, issues: [], metrics: null,
  };
  const context = buildContextAnalysis({
    mediaId, extractionStatus: 'completed', mediaDurationSeconds: input.durationMs === null ? null : input.durationMs / 1000,
    text, visual: null, frameStepSeconds: null,
  });
  return analyzeSafety({ mediaId, context, text, terms: input.terms });
}
