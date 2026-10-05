import type { RawCue } from '@/domain/extraction/subtitles';
import type { AudioStreamInfo, ExtractionLimits, SubtitleStreamInfo, StreamInventory } from './extractionTypes';
import type { ExtractionWorkspace, MediaInput } from './ports';

export type { AudioStreamInfo, ExtractionLimits, SubtitleStreamInfo, StreamInventory };

/** Per-job context handed to the extractor. Nothing in it is shared between jobs. */
export interface ExtractionContext {
  input: MediaInput;
  workspace: ExtractionWorkspace;
  /** Aborts every running FFmpeg process of the job (timeout or cancellation). */
  signal: AbortSignal;
  limits: ExtractionLimits;
  /** Mutable counters the adapter updates, used for metrics. */
  stats: { processes: number };
}

export interface ExtractedAudio {
  artifact: string;
  sizeBytes: number;
  durationSeconds: number;
  /** SHA-256 of the file, used to avoid storing bit-identical tracks twice. */
  sha256: string;
}

export interface ExtractedFrame {
  artifact: string;
  width: number;
  height: number;
  sizeBytes: number;
}

/**
 * Port: single, deterministic extraction operations. The application decides
 * *what* to extract and enforces policy; the adapter (FFmpeg) only knows
 * *how*. Results are normalised values: no tool output, command lines or
 * paths cross this boundary. Failures are thrown as `ExtractionError`.
 */
export interface MediaExtractor {
  inspect(input: MediaInput, signal: AbortSignal): Promise<StreamInventory>;
  /** 16 kHz mono PCM WAV of one audio stream. */
  extractAudio(ctx: ExtractionContext, stream: AudioStreamInfo, ordinal: number): Promise<ExtractedAudio>;
  /** Raw (not yet normalised) cues of one text subtitle stream. */
  extractSubtitleCues(ctx: ExtractionContext, stream: SubtitleStreamInfo): Promise<RawCue[]>;
  /** One JPEG at `timestampSeconds`, or null when the video has no frame there. */
  sampleFrame(ctx: ExtractionContext, timestampSeconds: number, index: number): Promise<ExtractedFrame | null>;
}
