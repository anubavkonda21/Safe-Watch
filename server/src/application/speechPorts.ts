import type { RawTranscription } from '@/domain/speech/normalize';
import type { SpeechErrorCode } from '@/domain/text/textAnalysis';
import type { LocalMediaFile } from './ports';

/** Failure of speech-to-text, classified. Never carries provider output, command lines, paths or stack traces. */
export class SpeechError extends Error {
  readonly code: SpeechErrorCode;
  constructor(code: SpeechErrorCode) {
    super(code);
    this.name = 'SpeechError';
    this.code = code;
  }
}

export interface SpeechInput {
  /** A 16 kHz mono WAV, valid only inside the storage callback that produced it. */
  file: LocalMediaFile;
  durationSeconds: number;
}

export interface SpeechRequest {
  /** Two-letter code to force, or null to detect the spoken language. Speech is never translated. */
  language: string | null;
  /** Aborts the transcription and must stop any inference process it started. */
  signal: AbortSignal;
}

/**
 * Port: turns speech audio into a raw, provider-neutral transcription.
 * The application never depends on which engine, model, runtime or API is
 * behind it. Adapters throw `SpeechError`; they never leak engine details.
 * The returned value is untrusted: it is normalised and validated by the
 * domain (`normalizeTranscription`) before anything uses it.
 */
export interface SpeechToTextProvider {
  /** Engine and model labels for the transcript metadata (no paths, no versions). */
  readonly info: { name: string; model: string };
  isAvailable(): Promise<boolean>;
  transcribe(input: SpeechInput, request: SpeechRequest): Promise<RawTranscription>;
}
