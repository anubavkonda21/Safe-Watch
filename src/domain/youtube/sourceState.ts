import { isYouTubeVideoId } from './url';

/**
 * The state of ONE YouTube source: the player and the analysis are tracked separately because they are independent facts
 * (a video can play with no analysis at all). Pure reducer; the interface only renders it.
 *
 * Player:   idle → source-validated → player-loading → player-ready | player-error
 * Analysis: unavailable (no authorised source yet) → pending → in-progress → partial | complete | failed
 *
 * `complete` is reserved for a source that covers everything SafeWatch supports for this video. Today no YouTube source can:
 * captions come from a file the user supplies (they may be incomplete) and there is no audio or frame source, so a finished
 * analysis is always `partial`. The reducer enforces that: `complete` needs an explicit full-coverage claim from the caller.
 */
export type PlayerPhase = 'idle' | 'source-validated' | 'player-loading' | 'player-ready' | 'player-error';
export type AnalysisPhase = 'unavailable' | 'pending' | 'in-progress' | 'complete' | 'partial' | 'failed';

export type PlayerErrorKind =
  | 'invalid-parameter' | 'html5-error' | 'not-found-or-private' | 'embedding-disabled' | 'client-identification' | 'network' | 'timeout' | 'unknown';

export interface CaptionSource {
  /** Display only (never a path, never sent anywhere). */
  fileName: string;
  format: 'srt' | 'vtt';
  cueCount: number;
  firstStartSeconds: number;
  lastEndSeconds: number;
}

export interface YouTubeSourceState {
  videoId: string | null;
  player: PlayerPhase;
  playerError: PlayerErrorKind | null;
  captions: CaptionSource | null;
  analysis: AnalysisPhase;
}

export type YouTubeSourceAction =
  | { type: 'validated'; videoId: string }
  | { type: 'player-loading' }
  | { type: 'player-ready' }
  | { type: 'player-error'; kind: PlayerErrorKind }
  | { type: 'captions-added'; captions: CaptionSource }
  | { type: 'captions-removed' }
  | { type: 'analysis-started' }
  | { type: 'analysis-finished'; fullCoverage?: boolean }
  | { type: 'analysis-failed' }
  | { type: 'reset' };

export const INITIAL_YOUTUBE_STATE: YouTubeSourceState = { videoId: null, player: 'idle', playerError: null, captions: null, analysis: 'unavailable' };

export function youTubeSourceReducer(state: YouTubeSourceState, action: YouTubeSourceAction): YouTubeSourceState {
  switch (action.type) {
    case 'reset': return INITIAL_YOUTUBE_STATE;
    case 'validated':
      // A different video never inherits the previous video's captions, player state or analysis.
      if (!isYouTubeVideoId(action.videoId)) return state;
      return { ...INITIAL_YOUTUBE_STATE, videoId: action.videoId, player: 'source-validated' };
    case 'player-loading': return state.videoId === null ? state : { ...state, player: 'player-loading', playerError: null };
    case 'player-ready': return state.player === 'player-loading' ? { ...state, player: 'player-ready' } : state;
    case 'player-error': return state.videoId === null ? state : { ...state, player: 'player-error', playerError: action.kind };
    case 'captions-added':
      return state.videoId === null ? state : { ...state, captions: action.captions, analysis: 'pending' };
    case 'captions-removed': return { ...state, captions: null, analysis: 'unavailable' };
    case 'analysis-started': return state.captions === null ? state : { ...state, analysis: 'in-progress' };
    case 'analysis-finished':
      if (state.analysis !== 'in-progress') return state;
      return { ...state, analysis: action.fullCoverage === true ? 'complete' : 'partial' };
    case 'analysis-failed': return state.analysis === 'in-progress' || state.analysis === 'pending' ? { ...state, analysis: 'failed' } : state;
  }
}

export type CapabilityStatus = 'available' | 'unavailable' | 'unsupported';

export interface Capability {
  id: 'captions-phrases' | 'speech-phrases' | 'scene-categories' | 'warnings' | 'actions';
  label: string;
  status: CapabilityStatus;
  /** Where the input comes from, and how it is read. */
  source: string;
  /** Why it is limited or unavailable, in plain words. */
  limits: string;
}

/**
 * What can be done for this source, with the real source and limits of each. Nothing here is a score or a percentage.
 * Honest by construction: speech and scenes are never "available" for a YouTube video, because no permitted audio or frame
 * source exists (the embedded player does not hand them to the page).
 */
export function youTubeCapabilities(state: YouTubeSourceState): Capability[] {
  const haveCaptions = state.captions !== null;
  const analysed = state.analysis === 'partial' || state.analysis === 'complete';
  return [
    {
      id: 'captions-phrases', label: 'Your phrases in captions',
      status: haveCaptions ? 'available' : 'unavailable',
      source: haveCaptions ? `A caption file you provided (${state.captions!.cueCount} captions, read in this browser)` : 'No caption file provided',
      limits: haveCaptions
        ? 'Only what the file contains. Captions may be missing, wrong or incomplete, and may not match this video. The file is not checked against YouTube.'
        : 'SafeWatch cannot read captions from YouTube: YouTube only releases caption files to the video’s owner. Add an SRT or WebVTT file you already have for this video.',
    },
    {
      id: 'speech-phrases', label: 'Your phrases in speech',
      status: 'unavailable',
      source: 'None: the YouTube player does not give SafeWatch the audio, and downloading it is not allowed',
      limits: 'To check speech, upload the video file you own with the local file option.',
    },
    {
      id: 'scene-categories', label: 'Scene categories (sexual content, violence, graphic injury, drugs)',
      status: 'unsupported',
      source: 'None: not supported for any source yet, and the YouTube player does not give SafeWatch the picture',
      limits: 'Titles, thumbnails and object labels are never used to guess at scenes.',
    },
    {
      id: 'warnings', label: 'Warnings before a flagged phrase',
      status: analysed ? 'available' : 'unavailable',
      source: analysed ? 'Findings from your caption file, timed to the YouTube playhead' : 'Needs findings first',
      limits: 'A warning can only appear ahead of time if the captions were checked before playback reached that point.',
    },
    {
      id: 'actions', label: 'Mute or skip a flagged phrase',
      status: analysed ? 'available' : 'unavailable',
      source: 'The YouTube player’s own mute and seek commands, only if you choose them',
      limits: 'Muting silences the whole player (the sound is not edited). Timing is only as exact as your captions and the player’s time readings.',
    },
  ];
}
