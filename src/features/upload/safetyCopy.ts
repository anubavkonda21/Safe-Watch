import type { AbstentionReason, FindingWarning, SafetyWarningCode } from '@/domain/safety/finding';
import type { CategoryReport } from '@/domain/safety/finding';

/** Fixed, plain-language copy for the safety-classification foundation. It states what was and was not checked; it never issues a verdict. */
export function categoryStatusText(c: CategoryReport): string {
  switch (c.evaluation) {
    case 'not-supported': return 'Not supported yet. SafeWatch does not check this.';
    case 'abstained': return abstainText(c.reason);
    case 'partial': return `${c.findingCount === 0 ? 'No flagged terms found' : `${c.findingCount} ${c.findingCount === 1 ? 'finding' : 'findings'}`} in ${c.modalities.evaluated.map(modalityName).join(' and ')} only. ${c.modalities.missing.map(modalityName).join(' and ')} could not be checked.`;
    case 'evaluated': return c.findingCount === 0
      ? `No flagged terms found in ${c.modalities.evaluated.map(modalityName).join(' and ')}. This covers only what was transcribed or subtitled.`
      : `${c.findingCount} ${c.findingCount === 1 ? 'finding' : 'findings'} in ${c.modalities.evaluated.map(modalityName).join(' and ')}.`;
  }
}

const modalityName = (m: string) => (m === 'subtitle' ? 'subtitles' : m);

export function abstainText(reason: AbstentionReason | null): string {
  switch (reason) {
    case 'no-terms-configured': return 'Not checked: no flagged terms are listed. Add words under Custom filters to check for them.';
    case 'text-unavailable': return 'Not checked: speech and subtitles are both unavailable, so nothing can be said about flagged terms.';
    case 'classifier-failed': return 'Not checked: the classifier failed.';
    case 'speech-unavailable': return 'Speech could not be checked.';
    case 'subtitles-unavailable': return 'Subtitles could not be checked.';
    default: return 'Not checked.';
  }
}

export function warningText(w: FindingWarning): string {
  switch (w) {
    case 'low-source-confidence': return 'Speech recognition was unsure about these words.';
    case 'subtitle-disagrees': return 'The subtitles shown at that time do not contain the term.';
    case 'speech-did-not-confirm': return 'The recognized speech at that time does not contain the term.';
    case 'coarse-timing': return 'Timing covers the whole line, not the single word.';
  }
}

export function analysisWarningText(code: SafetyWarningCode, count: number): string {
  return code === 'findings-truncated' ? `Only the first ${count.toLocaleString()} matches were examined.` : `${count} unusable ${count === 1 ? 'finding was' : 'findings were'} left out.`;
}
