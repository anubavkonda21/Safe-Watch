import type { SpeechSkipReason, TextAnalysisIssueCode } from '@/domain/text/textAnalysis';

/** What went wrong with the speech/subtitle evidence stage, in plain language. Fixed text only: provider output never reaches the UI. */
export function textFailureCopy(code: TextAnalysisIssueCode): { title: string; body: string } {
  const still = 'Your media is still stored and ready.';
  switch (code) {
    case 'server-busy': return { title: 'SafeWatch is busy transcribing other videos', body: `${still} Try again in a moment.` };
    case 'server-unreachable': return { title: 'We lost contact with the SafeWatch server', body: `${still} Upload again to continue.` };
    case 'timeout': return { title: 'Reading the speech took too long', body: `${still} Try a shorter video.` };
    case 'cancelled': return { title: 'Text analysis was cancelled', body: still };
    default: return { title: 'The transcript could not be prepared', body: `${still} Try uploading the video again.` };
  }
}

/** Notes about a single audio track that could not be (or was not) transcribed. */
export function trackNote(failure: TextAnalysisIssueCode | null, skip: SpeechSkipReason | null): string {
  if (skip === 'not-selected') return 'not transcribed (another audio track was selected)';
  if (skip === 'duplicate') return 'not transcribed (same audio as another track)';
  if (skip === 'speech-disabled') return 'not transcribed (speech recognition is not enabled on this server)';
  switch (failure) {
    case 'unavailable': return 'speech recognition is not available on this server';
    case 'timeout': return 'transcription took too long';
    case 'resource-limit': return 'the audio is too long or too large to transcribe';
    case 'unsupported-audio': return 'the audio could not be read for transcription';
    case 'unsupported-language': return 'the language is not supported';
    case 'invalid-response': return 'speech recognition returned an unusable result';
    case 'cancelled': return 'transcription was cancelled';
    default: return 'transcription failed';
  }
}

export function warningText(code: TextAnalysisIssueCode): string {
  switch (code) {
    case 'no-text': return 'No speech or subtitle text was found in this video.';
    case 'subtitle-unavailable': return 'A subtitle track could not be read.';
    default: return trackNote(code, null).replace(/^./, (c) => c.toUpperCase()) + '.';
  }
}
