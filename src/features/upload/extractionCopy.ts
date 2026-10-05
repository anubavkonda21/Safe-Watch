import type { ExtractionErrorCode, ExtractionPhase } from '@/domain/extraction/extraction';

export const PHASE_LABEL: Record<ExtractionPhase, string> = {
  preparing: 'Preparing',
  'extracting-audio': 'Extracting audio',
  'extracting-subtitles': 'Extracting subtitles',
  'sampling-frames': 'Sampling frames',
  finalizing: 'Finalizing',
};

/** What failed and what it means for the user. Only fixed text; tool output never reaches the UI. */
export function extractionFailureCopy(code: ExtractionErrorCode): { title: string; body: string } {
  const still = 'Your media is still stored and ready.';
  switch (code) {
    case 'timeout':
      return { title: 'Preparing analysis assets took too long', body: `The extraction was stopped to protect the server. ${still} Try a shorter video.` };
    case 'limit-exceeded':
      return { title: 'This video is too large to prepare', body: `It exceeds an extraction limit (for example audio length or total frame size). ${still} Try a shorter video.` };
    case 'server-busy':
      return { title: 'SafeWatch is busy preparing other videos', body: `${still} Try again in a moment.` };
    case 'server-unreachable':
      return { title: 'We lost contact with the SafeWatch server', body: `${still} Check your connection and upload again to continue.` };
    case 'invalid-media':
      return { title: 'The video could not be read for extraction', body: `${still} The file may be damaged.` };
    case 'cancelled':
      return { title: 'Preparing analysis assets was cancelled', body: still };
    default:
      return { title: 'Analysis assets could not be prepared', body: `${still} Try uploading the video again.` };
  }
}

export function warningCopy(code: ExtractionErrorCode): string {
  switch (code) {
    case 'limit-exceeded': return 'skipped: over a size or count limit';
    case 'track-unavailable': return 'could not be read';
    case 'frame-unavailable': return 'a sampled moment had no frame';
    case 'duration-unknown': return 'video length unknown: only the first moment was sampled';
    default: return 'a problem occurred';
  }
}

/** "eng" → "English" when the platform knows it, otherwise the upper-cased tag. */
export function languageLabel(tag: string | null): string {
  if (!tag) return 'Unknown language';
  try {
    const name = new Intl.DisplayNames(['en'], { type: 'language' }).of(tag);
    if (name && name.toLowerCase() !== tag.toLowerCase()) return name;
  } catch {
    // fall through
  }
  return tag.toUpperCase();
}
