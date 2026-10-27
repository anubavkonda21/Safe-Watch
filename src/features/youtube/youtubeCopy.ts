import type { AnalysisPhase, PlayerErrorKind, PlayerPhase, YouTubeSourceState } from '@/domain/youtube/sourceState';

export type StageKey = 'source' | 'player' | 'captions' | 'analysis';
export type StageTone = 'done' | 'active' | 'idle' | 'problem';

export const STAGE_LABEL: Record<StageKey, string> = { source: 'Source', player: 'Player', captions: 'Captions', analysis: 'Analysis' };

const PLAYER_TEXT: Record<PlayerPhase, string> = {
  idle: 'Not started',
  'source-validated': 'Waiting to load',
  'player-loading': 'Loading the YouTube player…',
  'player-ready': 'Player loaded',
  'player-error': 'Player could not load the video',
};

const ANALYSIS_TEXT: Record<AnalysisPhase, string> = {
  unavailable: 'Unavailable: no caption file, and no other permitted source',
  pending: 'Pending',
  'in-progress': 'In progress…',
  partial: 'Partial: your phrases were checked in your captions only',
  complete: 'Complete',
  failed: 'Failed: the captions could not be checked',
};

const ANALYSIS_TONE: Record<AnalysisPhase, StageTone> = { unavailable: 'idle', pending: 'active', 'in-progress': 'active', partial: 'done', complete: 'done', failed: 'problem' };

/** One plain line and a tone for each step of the YouTube workflow, from the source state. No numbers: nothing was measured. */
export function stageOf(state: YouTubeSourceState): Record<StageKey, { text: string; tone: StageTone }> {
  return {
    source: { text: state.videoId ? 'Link validated' : 'No link yet', tone: state.videoId ? 'done' : 'idle' },
    player: {
      text: PLAYER_TEXT[state.player],
      tone: state.player === 'player-ready' ? 'done' : state.player === 'player-error' ? 'problem' : state.player === 'player-loading' ? 'active' : 'idle',
    },
    captions: { text: state.captions ? `${state.captions.cueCount} captions from your file` : 'None provided', tone: state.captions ? 'done' : 'idle' },
    analysis: { text: ANALYSIS_TEXT[state.analysis], tone: ANALYSIS_TONE[state.analysis] },
  };
}

export function playerErrorCopy(kind: PlayerErrorKind): { title: string; body: string } {
  switch (kind) {
    case 'not-found-or-private': return { title: 'This video is not available', body: 'It may have been removed, or it is private. Check the link and try again.' };
    case 'embedding-disabled': return { title: 'This video cannot be played here', body: 'YouTube gives the same answer when the owner does not allow playback outside YouTube and, as seen in testing, when the video does not exist or is unavailable. SafeWatch does not work around it. Check the link, watch it on YouTube, or use a local file you own.' };
    case 'invalid-parameter': return { title: 'YouTube did not accept this video id', body: 'The link looked valid but the player refused it. Check the link and try again.' };
    case 'html5-error': return { title: 'The player had a problem with this video', body: 'YouTube’s player reported an error while preparing the video. Trying again sometimes helps.' };
    case 'client-identification': return { title: 'YouTube could not identify this page', body: 'The player needs the page address to be sent along, and it was not. Check that the page is opened from its normal address.' };
    case 'timeout': return { title: 'The player took too long to load', body: 'YouTube did not answer in time. Check your connection, any content blockers, and try again.' };
    case 'network': return { title: 'The YouTube player could not be loaded', body: 'The connection to YouTube failed or was blocked (for example by an extension or a network rule). SafeWatch does not load it any other way.' };
    default: return { title: 'The video could not be loaded', body: 'YouTube’s player reported an error that SafeWatch does not recognise. Try again, or use a local file.' };
  }
}
