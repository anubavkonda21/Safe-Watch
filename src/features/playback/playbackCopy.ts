import type { CoordinatorEvent } from '@/domain/playback/coordinator';
import type { ActionCandidate, UnavailableReason } from '@/domain/playback/planning';
import type { SafetyAnalysis } from '@/domain/safety/finding';
import { formatTimecode } from '@/domain/media/format';

const tc = (ms: number) => formatTimecode(ms / 1000);
export const range = (c: { startMs: number; endMs: number }) => `${tc(c.startMs)} to ${tc(c.endMs)}`;

export const TIMING_LABEL: Record<ActionCandidate['timing']['quality'], string> = {
  word: 'Word timing, approximate',
  cue: 'Subtitle cue, exact line',
  segment: 'Speech segment, coarse',
};

export function unavailableText(reason: UnavailableReason | null): string {
  switch (reason) {
    case 'zero-length': return 'No automatic action: the finding has no duration, so there is nothing to mute or skip.';
    case 'outside-media': return 'No automatic action: the finding lies outside this video.';
    case 'invalid-duration': return 'No automatic action: the video length is not valid.';
    case 'unsupported-category': return 'No automatic action: this category is not supported.';
    case 'invalid-finding': return 'No automatic action: the finding’s timing is not valid.';
    case 'invalid-interval': return 'No automatic action: the finding’s interval is not valid.';
    default: return 'No automatic action is available for this finding.';
  }
}

/** The line announced after something happened. Names the category, the term (the user's own) and the finding. */
export function eventText(e: CoordinatorEvent, termOf: (findingId: string) => string | null): string {
  const terms = [...new Set(e.findingIds.map((id) => termOf(id)).filter((t): t is string => t !== null))].map((t) => `“${t}”`).join(', ');
  const what = `flagged term ${terms || ''}`.trim();
  switch (e.type) {
    case 'mute-started': return `Muted at ${tc(e.atMs)}: ${what}.`;
    case 'mute-ended': return `Sound restored at ${tc(e.atMs)}.`;
    case 'mute-released-by-user': return 'You turned the sound back on, so SafeWatch will not mute again until the next muted part.';
    case 'skipped': return `Skipped ${tc(e.fromMs)} to ${tc(e.toMs)}: ${what}.`;
    case 'skip-gave-up': return `Could not skip at ${tc(e.atMs)} (the player stopped short), so playback continues normally.`;
  }
}

export function analysisNote(safety: { state: 'loading' | 'unavailable' | 'ready'; analysis?: SafetyAnalysis }, candidates: readonly ActionCandidate[]): string | null {
  if (safety.state === 'loading') return 'Waiting for the safety analysis. Nothing is acted on until it arrives.';
  if (safety.state === 'unavailable' || !safety.analysis) return 'Safety findings are not available, so there is nothing to act on. Playback is not affected.';
  const a = safety.analysis;
  if (a.status === 'not-evaluated') return 'Nothing was evaluated, so there are no findings to act on. List words under Custom filters to check for them.';
  const prefix = a.status === 'partial' ? 'The analysis is partial (speech or subtitles could not be checked); actions apply only to the findings that were found. ' : '';
  if (candidates.length === 0) return `${prefix}No findings, so there are no automatic actions.`;
  if (!candidates.some((c) => c.availability === 'available')) return `${prefix}No finding can be acted on automatically.`;
  return prefix === '' ? null : prefix.trim();
}
