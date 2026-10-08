import type { VisualErrorCode, VisualIssue } from '@/domain/vision/visualAnalysis';

type IssueCode = VisualIssue['code'];

/** What went wrong with the visual evidence stage, in plain language. Fixed text only: provider output never reaches the UI. */
export function visualFailureCopy(code: IssueCode): { title: string; body: string; tone: 'danger' | 'info' } {
  const still = 'Your media is still stored and ready.';
  switch (code) {
    case 'provider-unavailable': return { tone: 'info', title: 'Visual analysis is not enabled on this server', body: `${still} The administrator can turn it on in the server settings.` };
    case 'server-busy': return { tone: 'danger', title: 'SafeWatch is busy looking at other videos', body: `${still} Try again in a moment.` };
    case 'server-unreachable': return { tone: 'danger', title: 'We lost contact with the SafeWatch server', body: `${still} Upload again to continue.` };
    case 'timeout': return { tone: 'danger', title: 'Looking at the frames took too long', body: `${still} Try a shorter video.` };
    case 'cancelled': return { tone: 'danger', title: 'Visual analysis was cancelled', body: still };
    case 'invalid-frame': return { tone: 'danger', title: 'The sampled frames could not be read', body: `${still} Try uploading the video again.` };
    case 'frame-missing': return { tone: 'danger', title: 'The sampled frames are no longer available', body: `${still} Upload the video again.` };
    case 'resource-limit': return { tone: 'danger', title: 'The frames are too large to analyze', body: `${still} Try a lower-resolution video.` };
    default: return { tone: 'danger', title: 'The frames could not be analyzed', body: `${still} Try uploading the video again.` };
  }
}

/** Why a single frame has no observations. */
export function frameNote(error: VisualErrorCode | null, skipped: boolean): string {
  if (skipped) return 'not analyzed (this video has more frames than the analysis limit)';
  switch (error) {
    case 'invalid-frame': return 'could not be read as an image';
    case 'frame-missing': return 'is no longer available';
    case 'timeout': return 'took too long to analyze';
    case 'resource-limit': return 'is too large to analyze';
    case 'cancelled': return 'analysis was cancelled';
    default: return 'could not be analyzed';
  }
}

export function warningText(code: IssueCode, count: number): string {
  if (code === 'no-frames') return 'No frames were sampled from this video.';
  if (code === 'observations-dropped') return `${count} unusable ${count === 1 ? 'observation was' : 'observations were'} left out.`;
  return `${count} ${count === 1 ? 'frame' : 'frames'} ${frameNote(code as VisualErrorCode, false)}.`;
}
